/**
 * POST /api/us/react — she tells me she heard it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ENDPOINT EXISTS AT ALL
 *
 * The song is the excuse. This is the payload. A card she reads is a broadcast;
 * a tap that comes back to me is a conversation, and over a year of long distance
 * the difference between those two is the entire feature.
 *
 * ---------------------------------------------------------------------------
 * SESSION ONLY — NOT ADMIN
 *
 * This is the one endpoint in the wing that deliberately REFUSES my admin token.
 * Every other private route accepts either, so that I am not locked out of her
 * rooms. Here, being able to write a reaction as her would make the reaction
 * meaningless — the whole value of the tap is that it can only have come from her.
 * If I want to test the round trip, I answer the three questions like anyone else.
 *
 * The cookie is verified here with verify() rather than trusted from middleware.ts,
 * which is what makes that distinction real: the middleware's default-deny accepts
 * EITHER token, so it cannot tell us apart.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONE THING IN THE FEATURE THAT IS STILL ONE-DIRECTIONAL, AND IT STAYS
 *
 * The two halves of a day are peers now — same shape, same card, same weight, one
 * endpoint each. Reactions are not: she can react to my song and I cannot react to
 * hers. That is not an oversight and it is not laziness, it is the honest cost of
 * the rule above. A reaction only means something because exactly one person can
 * write it, so "make it symmetric" here does not mean relaxing this check — it
 * means a SECOND endpoint that names the admin cookie and writes a THIRD key space
 * (`us:react-his:*`), mirroring how the two posting endpoints are separate.
 *
 * Worth doing, deliberately not done here: it is a new write path with a new key
 * space, which is a feature rather than a reframing, and it wants its own
 * verification pass. Until then the pages state whose reaction it is rather than
 * implying a mutual mechanism, and DayPair.reactions sits beside `his` in the type
 * so nobody reads it as per-side.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENT BY CONSTRUCTION
 *
 * The request states a desired END STATE (`on: true|false`) rather than an action
 * ("increment"). A double-tap on a laggy phone, a retried fetch, a browser
 * replaying a form on wake — all of them converge on the same stored value. That
 * is also why a reaction is a hash field and not a counter: a count would make
 * every one of those a different number, and none of them the truth.
 *
 * It also means a reaction can be TAKEN BACK, which matters more than it sounds.
 * A reaction you cannot undo is a reaction you have to think about before giving,
 * and thinking about it is precisely the thing this is meant to avoid.
 *
 * ---------------------------------------------------------------------------
 * THE EMOJI ARE AN ALLOWLIST, AND THE LIST IS TINY
 *
 * The wire format is a KEY (`heart`, `loop`, ...), never an emoji. Two reasons,
 * both practical: an emoji is not one character — U+2764 U+FE0F and a bare U+2764
 * are different strings that look identical, so a client that dropped the
 * variation selector would fail an allowlist check for no visible reason and be
 * impossible to debug. And the stored value becomes a database key, so it should
 * be something a person can type into a Redis console. Anything not in
 * REACTIONS is rejected with a 400; nothing is coerced, defaulted or sanitized
 * into the nearest valid value.
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../lib/us/config';
import { readCookie, verify } from '../../../lib/us/session';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import { crossSite } from '../../../lib/us/together';
import {
  getReactions,
  isReactionKey,
  isWingDate,
  putReaction,
  wingDate,
} from '../../../lib/us/kv';

export const prerender = false;

/**
 * Generous, because tapping five reactions on and off while deciding is normal
 * behaviour and being told "slow down" for it would be absurd. It is here only to
 * bound the work: on the R2 tier every tap is a read-modify-write of the whole
 * document, so a stuck loop somewhere should hit a ceiling rather than a bill.
 */
const RATE_LIMIT = 90;
const RATE_WINDOW_SEC = 600;

/** Where a no-JavaScript form submission lands afterwards. */
const TODAY_PAGE = '/stronger/vault/today';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** See admin.ts: the response shape follows the request shape. */
function isJsonRequest(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').toLowerCase().includes('application/json');
}

/**
 * Read a boolean off the wire.
 *
 * A urlencoded form can only send strings, so `'0'`, `'false'` and `''` all have
 * to mean false — and crucially, an ABSENT field means true. That default is what
 * lets the simplest possible no-JS markup work: a form carrying only the date and
 * the reaction adds it. Turning one off is always explicit.
 */
function readOn(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === '');
}

export const POST: APIRoute = async ({ request, cookies, clientAddress, redirect, url }) => {
  const wantsJson = isJsonRequest(request);

  /** One exit point, so the fetch and no-JS paths cannot drift apart. */
  const answer = (
    ok: boolean,
    status: number,
    error: string | null,
    extra: Record<string, unknown> = {},
  ): Response => {
    if (wantsJson) return json({ ok, ...(error ? { error } : {}), ...extra }, status);
    // 303 forces a GET, so the page she lands on re-renders from the store and a
    // refresh does not resubmit the tap. The error code rides in the query string
    // for the page to translate into a sentence.
    return redirect(ok ? TODAY_PAGE : `${TODAY_PAGE}?e=${encodeURIComponent(error ?? 'no')}`, 303);
  };

  const secret = SESSION_SECRET();
  if (!secret) {
    console.error('[us] react called but US_SESSION_SECRET is missing.');
    return answer(false, 503, 'unconfigured');
  }

  // Session, and only session. See the header.
  if (!verify(secret, 'session', readCookie(cookies, 'session', url))) {
    return answer(false, 401, 'unauthorized');
  }

  /* CROSS-SITE. Checked AFTER the cookie, so an unauthenticated probe learns
     nothing it did not already know.
  
     This was absent here while frame.ts, mark.ts, thinking.ts and together.ts all
     had it. That gap was real, not theoretical: Astro's own origin check exempts
     `application/json` entirely (see origin-check.js — a non-form content type
     returns early), and `sameSite: 'lax'` is SITE-scoped rather than
     origin-scoped, so any host under the same registrable domain could make a
     JSON POST carrying her cookie. The 'cross-site' sentence the pages already
     had for this could never fire. */
  if (crossSite(request, url)) {
    console.warn('[us] refused a cross-site reaction.');
    return answer(false, 403, 'cross-site');
  }

  const limit = await hit(`react:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!limit.ok) return answer(false, 429, 'rate', { retryAfter: limit.retryAfter });

  // ---- parse ------------------------------------------------------------
  let date = '';
  let reaction = '';
  let on = true;
  try {
    const fields: Record<string, unknown> = wantsJson
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries(await request.formData());

    // Defaulting to today is a real convenience for the common case, but the date
    // is still validated below — it is a primary key, and "today" is only the
    // default, never an override for something invalid.
    date = typeof fields.date === 'string' && fields.date.trim() ? fields.date.trim() : wingDate();
    reaction = typeof fields.reaction === 'string' ? fields.reaction.trim() : '';
    on = readOn(fields.on);
  } catch {
    return answer(false, 400, 'bad-request');
  }

  if (!isWingDate(date)) return answer(false, 400, 'bad-date');
  // Rejected, not ignored. Silently accepting an unknown key would let a typo in
  // the page's markup look like a working button forever.
  if (!isReactionKey(reaction)) return answer(false, 400, 'bad-reaction');

  // Reacting to a day with no song is harmless but meaningless, and allowing it
  // would let the reactions map grow keys that no archive row will ever render.
  // Not checked against the store, though: that would cost an extra round trip to
  // prevent something only our own markup can cause.

  try {
    await putReaction(date, reaction, on);
    // Read back rather than assume. On the R2 tier this write was a
    // read-modify-write that could in principle have raced another one, so
    // echoing the store's actual state is the only honest answer — and it is what
    // lets the client repaint all five buttons from one response.
    const after = await getReactions([date]);
    return answer(true, 200, null, { date, reactions: after[date] ?? [] });
  } catch (err) {
    console.error('[us] react could not write to the store:', err);
    return answer(false, 502, 'store');
  }
};

/** Anything other than POST. Explicit, so a stray GET is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
