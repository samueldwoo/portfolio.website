/**
 * POST /api/us/thinking — one tap. "I was thinking of you."
 *
 * ---------------------------------------------------------------------------
 * THE ENDPOINT HAS NO FIELDS, AND THAT IS THE FEATURE
 *
 * There is no body to parse. No text, no mood, no emoji key, no id. The request
 * carries exactly one bit of information — that somebody pressed it — and the
 * identity of the presser comes from a cookie they cannot forge. That is the whole
 * protocol, and it must stay that way: the moment this grows a `message` field it
 * becomes another thing you have to have words for, and the entire reason it exists
 * is the days when neither of them does.
 *
 * Consequently this file does something no other endpoint in the wing does: it never
 * reads the request body at all. Nothing is parsed, so nothing can be malformed, so
 * there is no 400 for bad input on the happy path. A form POST with fields is
 * accepted and its fields are ignored.
 *
 * ---------------------------------------------------------------------------
 * EITHER OF THEM MAY SEND, AND THE TWO IDENTITIES ARE NOT COLLAPSED
 *
 * This is the FIRST endpoint in the wing that accepts both cookies and cares which
 * one it got. /api/us/react, /api/us/reply, /api/us/mark and /api/us/letter all
 * accept the session cookie ONLY and explicitly refuse my admin token, because a
 * reaction I could write as her is worthless. /api/us/song accepts admin only.
 *
 * Here both are real senders, so the question is not "may you write" but "who are
 * you", and getting that wrong would print "she was thinking of you" on her own
 * screen about herself. So identity is resolved by together.ts's identify() — one
 * implementation, shared with the other endpoint and with the hub that renders the
 * result — and never re-derived here. Read the PART ZERO comment in together.ts
 * before changing anything about this; the admin-wins-when-both-present rule is
 * load-bearing and the reasoning is not obvious.
 *
 * The middleware's default-deny already means an anonymous caller never reaches this
 * file (it is not in PUBLIC_API, so it needs a token from the moment it exists). But
 * the middleware's check accepts EITHER token and cannot tell us apart, so identify()
 * is what makes the attribution real, and re-verifying here is also defence in depth:
 * a future routing mistake up there degrades to "the endpoint says no" rather than
 * "anyone can tap as either of us".
 *
 * ---------------------------------------------------------------------------
 * THE LIMIT IS A COALESCE, NOT A REFUSAL
 *
 * A second tap inside THINKING_DEBOUNCE_MS (thirty minutes) returns **200** with
 * `sent: false` and the time of the one that did land. It is deliberately NOT a 429
 * and it deliberately does not say "slow down", because being told to slow down for
 * saying you are thinking about somebody is an genuinely unpleasant thing for
 * software to do. The tap is simply already sent, and the page says so warmly.
 *
 * See the PART TWO header in together.ts for why thirty minutes rather than ten a
 * minute or one a day. That comment is where the decision lives; this file only
 * carries it out.
 *
 * ---------------------------------------------------------------------------
 * IT WORKS WITH JAVASCRIPT OFF
 *
 * A real <form method="post"> that 303s back to the hub with a fragment. The hub's
 * script upgrades it to a fetch for one reason that is not cosmetic: this is a
 * one-tap gesture, and making it cost a full page navigation — losing her scroll
 * position on the way — would make the lightest thing in the wing feel like the
 * heaviest. Both paths go through the same exit function so they cannot drift.
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../lib/us/config';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import { wingDate } from '../../../lib/us/kv';
import {
  HER_TZ,
  HIS_TZ,
  crossSite,
  identify,
  sendThinking,
  warmAgo,
  type Who,
} from '../../../lib/us/together';

export const prerender = false;

/**
 * A bound on a runaway loop, and NOT this feature's limit.
 *
 * The real limit is the thirty-minute debounce in the store, which means the most a
 * well-behaved client can usefully send in a ten-minute window is ONE. Twenty is
 * therefore enormous headroom, and that is the point: this number must never be the
 * thing that stops a real person, because the failure it produces (a 429 on an
 * affectionate gesture) is worse than the abuse it prevents.
 *
 * BE HONEST ABOUT WHAT IT BUYS, because the obvious claim is false — mark.ts makes
 * the same correction and it applies verbatim here. It is tempting to write "this
 * bounds writes to the R2 document". That cannot be true: together.ts selects the R2
 * tier only when hasKV() is false, and ratelimit.ts selects its durable Upstash
 * limiter only when the same two variables ARE set. So every deployment on the R2
 * tier is necessarily one where hit() falls through to a per-instance in-memory
 * bucket — best-effort, N instances, N times the stated ceiling — and the Upstash
 * path additionally fails OPEN by design.
 *
 * What it actually is: a courtesy brake on one client and a cheap bound on a bug in
 * our own script. The real bounds here are structural — there is no body to grow, the
 * key space is exactly two keys, and the debounce caps the useful rate at one per
 * half hour regardless of how fast anybody asks.
 */
const RATE_LIMIT = 20;
const RATE_WINDOW_SEC = 600;

/** Where a no-JavaScript form submission lands afterwards. */
const HUB_PAGE = '/stronger/vault';

/** The block on the hub this belongs to, so a 303 lands on it and not at the top. */
const FRAGMENT = '#thinking';

/**
 * Applied to EVERY exit from this endpoint, the 303 included.
 *
 * Repeated here rather than relying on src/middleware.ts, for the reason
 * /api/us/mark and /api/us/photo/[id] both repeat them: a future routing change that
 * takes this path out of the middleware's scope must not also make this indexable or
 * leak a referrer. Hoisted into a constant so the JSON and redirect exits cannot
 * drift — in mark.ts they had, and only the JSON one carried them.
 */
const PRIVACY: Record<string, string> = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...PRIVACY },
  });
}

/** See admin.ts and react.ts: the response shape follows the request shape. */
function isJsonRequest(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').toLowerCase().includes('application/json');
}

/** Whose clock the relative phrase is rendered in. See warmAgo's tz argument. */
function tzOf(who: Who): string {
  return who === 'her' ? HER_TZ : HIS_TZ;
}

export const POST: APIRoute = async ({ request, cookies, clientAddress, redirect, url }) => {
  const wantsJson = isJsonRequest(request);

  /**
   * One exit point, so the fetch and no-JS paths can never drift apart.
   *
   * 303 forces a GET, so a refresh does not re-send, and the Location carries a
   * fragment so a form submission puts her back on the block she pressed rather than
   * at the top of a long hub.
   */
  const answer = (
    ok: boolean,
    status: number,
    code: string | null,
    extra: Record<string, unknown> = {},
  ): Response => {
    if (wantsJson) return json({ ok, ...(code ? { code } : {}), ...extra }, status);
    /* `ok` and `e` are separate parameters rather than one `code`, because the hub
       renders a success and a failure in different elements with different wording,
       and a single parameter would make it guess from the value. */
    const query = ok ? `?ok=${encodeURIComponent(code ?? 'sent')}` : `?e=${encodeURIComponent(code ?? 'no')}`;
    /* The privacy headers go on THIS exit too, not just the JSON one. Response
       redirects are immutable-headered in some runtimes, hence build-a-new-one rather
       than mutate; Astro's redirect() is a plain Response, so this is cheap. */
    const res = redirect(`${HUB_PAGE}${query}${FRAGMENT}`, 303);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(PRIVACY)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  /* Identity FIRST, before anything else is touched. identify() returns null when
     US_SESSION_SECRET is missing, which is the fail-closed direction: without a
     signing key we cannot tell either of them from a stranger, and the only safe
     answer to that is nobody. The two cases are split apart only so the log line is
     useful — a misconfiguration and an expired cookie need different fixes. */
  const who = identify(cookies, url);
  if (!who) {
    /* SESSION_SECRET() from config.ts, and NOT `import.meta.env.US_SESSION_SECRET`.
       config.ts's env() comment is the reason and it is not a style preference: Vite
       statically replaces the DOTTED form at build time, so on Vercel that bakes in
       the build container's value — `undefined` — forever, and this branch would
       report "unconfigured" on every single 401 in production. The accessor does a
       real lookup at request time. */
    if (!SESSION_SECRET()) {
      console.error('[us] thinking called but US_SESSION_SECRET is missing.');
      return answer(false, 503, 'unconfigured');
    }
    return answer(false, 401, 'unauthorized');
  }

  /* Request forgery. Checked AFTER the cookie so an unauthenticated cross-site probe
     learns nothing it did not already know. There is no body to protect here, but the
     WRITE still needs protecting: without this, any page on any host under the same
     registrable domain could make her tap on her behalf, and a signal whose entire
     meaning is "she chose to send this" must not be forgeable. */
  if (crossSite(request, url)) {
    console.warn('[us] refused a cross-site thinking-of-you.');
    return answer(false, 403, 'cross-site');
  }

  const limit = await hit(
    `thinking:${clientKey(request, clientAddress)}`,
    RATE_LIMIT,
    RATE_WINDOW_SEC,
  );
  if (!limit.ok) return answer(false, 429, 'rate', { retryAfter: limit.retryAfter });

  /* ONE clock reading for the whole request, taken here and passed down. Same
     discipline as kv.ts's derivations: the store must not read the clock itself, or
     the timestamp it writes and the day it files it under could straddle midnight and
     disagree. */
  const nowMs = Date.now();
  const today = wingDate(new Date(nowMs));

  let result: { sent: boolean; record: { last: number } };
  try {
    result = await sendThinking(who, nowMs, today);
  } catch (err) {
    /* LOUD. together.ts's header explains the policy: a tap that silently did not
       send is a tap she believes I received, which is worse than an error she can see
       and press again. Note this is the one place the R2 tier deliberately throws on
       a lost If-Match race rather than shrugging it off — see sendThinking's comment
       about why a button somebody pressed is not a visit counter. */
    console.error(`[us] thinking could not write for ${who}:`, err);
    return answer(false, 502, 'store');
  }

  /**
   * The relative phrase, rendered SERVER-SIDE and returned as a string.
   *
   * Returning presentation from an API is unusual and it is the right call here for
   * the reason letters.astro gives about handing control back to the server: the
   * alternative is a second implementation of warmAgo in the hub's inline script,
   * which would have to know both timezones, the part-of-day bands and the wing
   * calendar — and would disagree with the server version at exactly the boundaries
   * nobody tests. One implementation, one answer, and the client only ever assigns it
   * to `textContent`.
   *
   * Rendered in the SENDER's timezone, because the reader of this particular string
   * is the sender: it is their own outgoing state ("you already sent one, half an
   * hour ago"). The other side's copy is rendered on the hub in the other side's
   * zone. See warmAgo's header for why the zone matters at all.
   */
  const ago = warmAgo(result.record.last, nowMs, tzOf(who));

  /* `sent: false` IS A SUCCESS. 200, `ok: true`, and a code that tells the page to
     say "you already did" rather than "that failed". The debounce is not an error
     condition and must never be presented as one. */
  return answer(true, 200, result.sent ? 'sent' : 'already', { sent: result.sent, ago });
};

/** Anything other than POST. Explicit, so a stray GET is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, code: 'method-not-allowed' }, 405);
