/**
 * POST /api/us/react — one of them tells the other they heard it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ENDPOINT EXISTS AT ALL
 *
 * The song is the excuse. This is the payload. A card you read is a broadcast; a
 * tap that comes back is a conversation, and over a year of long distance the
 * difference between those two is the entire feature.
 *
 * ---------------------------------------------------------------------------
 * IT GOES BOTH WAYS NOW, AND THAT IS THE BUG THIS REVISION FIXES
 *
 * The old rule was `who === 'her'` and one key space: she could react to his song,
 * and that was the only reaction that existed. Tested on a real phone, that read
 * as two separate faults in one sentence — "I can only react to Sam's songs, even
 * if I'm logged in as Sam":
 *
 *   1. Signed in as HIM, the only reaction bar on the page was on HIS OWN song, so
 *      the endpoint's `who === 'her'` check refused it. A button that is always
 *      refused is worse than no button.
 *   2. HER song could not be reacted to by anybody, ever. Half of a feature whose
 *      whole subject is symmetry.
 *
 * THE NEW RULE, IN ONE LINE: you may react to the OTHER one's song, and never to
 * your own. Reacting to your own song is not a permission we are withholding, it is
 * a thing that does not mean anything — a receipt you wrote yourself. So it is
 * refused with its own code (`own-song`) rather than quietly ignored, because a
 * button that silently does nothing is a bug report.
 *
 * The old header argued that a reaction "only means something because exactly one
 * person can write it". That is still true and it is still what makes this work:
 * each of the two key spaces has exactly one legal author. What changed is that
 * there are now two of them.
 *
 *   us:react:<date>        reactions ON HIS song   <- only 'her' may write
 *   us:react-hers:<date>   reactions ON HER song   <- only 'him' may write
 *
 * See kv.ts's key-space comment for why the first one keeps its old name and how
 * the data already in it is migrated.
 *
 * ---------------------------------------------------------------------------
 * `who` COMES FROM THE COOKIE. `side` COMES FROM THE BODY. THAT ASYMMETRY IS THE
 * WHOLE SECURITY MODEL HERE.
 *
 * identify() reads the signed cookies and nothing else, so WHO is making the
 * request cannot be changed by editing a form field. WHICH SONG the reaction is for
 * is a fact about the page, not about the caller, so it does travel in the body —
 * and it is then checked against `who`. The two together mean the only thing a
 * hand-made request can do is get itself a 403.
 *
 * `side` ABSENT DEFAULTS TO THE ONE THE CALLER IS ALLOWED TO WRITE. Not laziness:
 * her phone keeps a tab alive for a week, so a page rendered before this deploy is
 * still posting `{date, reaction, on}` with no side at all. Defaulting to the only
 * legal value cannot grant anything (it is what the check would have permitted
 * anyway) and it stops an old tab from silently 400ing forever.
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
 * THE VOCABULARY IS OPEN NOW, SO THE WIRE FORMAT IS AN EMOJI
 *
 * It used to be a KEY (`heart`, `loop`, ...) validated against a list of five, and
 * the old header gave two good reasons for that: an emoji is not one character, and
 * a database key should be something a person can type into a Redis console.
 *
 * Both reasons are still true and both are now outweighed. The five keys meant the
 * only way to say something the list did not cover was a deploy. So the field is an
 * emoji, and the cost is paid honestly:
 *
 *   * isReaction() in kv.ts does the work — a length cap, a grammar that spells out
 *     the three shapes a single emoji takes, and Intl.Segmenter confirming it is
 *     exactly ONE grapheme cluster. A letter, a word, a script tag, an empty
 *     string and two emoji at once are all refused with `bad-emoji`.
 *   * The variation-selector problem the old header named is handled by a fold in
 *     kv.ts rather than by avoiding emoji: U+2764 and U+2764 U+FE0F are one
 *     reaction for comparison and deletion.
 *   * MAX_REACTIONS_PER_DAY bounds a day, checked BEFORE the write, because an open
 *     vocabulary with no ceiling is a key an authenticated phone can grow in a loop.
 *
 * Nothing is coerced, defaulted or sanitized into the nearest valid value. The one
 * normalization is a trim, and a value that is only valid after trimming was valid.
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../lib/us/config';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import { crossSite, identify, type Who } from '../../../lib/us/together';
import {
  MAX_REACTIONS_PER_DAY,
  MAX_REACTION_UNITS,
  getReactions,
  isReaction,
  isWingDate,
  putReaction,
  wingDate,
  type Side,
} from '../../../lib/us/kv';

export const prerender = false;

/**
 * Generous, because tapping reactions on and off while deciding is normal
 * behaviour and being told "slow down" for it would be absurd. It is here only to
 * bound the work: on the R2 tier every tap is a read-modify-write of the whole
 * document, so a stuck loop somewhere should hit a ceiling rather than a bill.
 */
const RATE_LIMIT = 90;
const RATE_WINDOW_SEC = 600;

/** Where a no-JavaScript form submission lands afterwards. */
const TODAY_PAGE = '/samdrea/vault/today';

/**
 * WHICH SONG EACH OF THEM MAY REACT TO. The authorization rule, as a table.
 *
 * One expression rather than an `if` in the handler, so "you react to the other
 * one's song" is stated once and cannot be half-changed. It is deliberately NOT
 * written as otherOne(who) mapped to a side: `Who` and `Side` are different
 * vocabularies ('her'/'him' versus 'hers'/'his') and a clever mapping between two
 * near-identical string unions is exactly how a security check gets inverted by a
 * typo that still compiles.
 */
const MAY_REACT_TO: Record<Who, Side> = {
  her: 'his',
  him: 'hers',
};

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
 * the reaction adds it. Turning one off is always explicit, and it is what makes
 * the free-choice input a form with no hidden state in it at all.
 */
function readOn(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === '');
}

/** 'his' | 'hers', or null. Never inferred from anything but this exact string. */
function readSide(value: unknown): Side | null {
  return value === 'his' || value === 'hers' ? value : null;
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
    /* 303 forces a GET, so the page she lands on re-renders from the store and a
       refresh does not resubmit the tap.

       BOTH OUTCOMES CARRY A CODE, and the failure path is the reason: this returns
       303 whether the tap was stored or refused, so a caller reading only the
       status cannot tell a success from a 403. The code in the query string is the
       signal, and the page has a sentence for every one of them. `ok=` on success
       exists so the no-JavaScript path gets confirmation at all — with the script
       off there is no aria-live region to write into, and a page that looks
       identical before and after a tap is a page you tap again.

       THE SUCCESS CODE IS CALLED `outcome` AND NOT `ok`, WHICH IS NOT A STYLE
       CHOICE. `extra` is spread over the JSON body after the `ok` boolean, so an
       `extra.ok` of 'reacted' silently replaced `ok: true` — and the page's script
       tests `data.ok !== true`, so every successful tap reported itself as a
       failure and painted "that did not save" over a reaction that had just
       saved. Caught by reading the response body rather than the status. */
    const code = encodeURIComponent((ok ? String(extra.outcome ?? 'reacted') : error) ?? 'no');
    return redirect(`${TODAY_PAGE}?${ok ? 'ok' : 'e'}=${code}`, 303);
  };

  const secret = SESSION_SECRET();
  if (!secret) {
    console.error('[us] react called but US_SESSION_SECRET is missing.');
    return answer(false, 503, 'unconfigured');
  }

  /* WHICH ONE OF THEM, not merely "someone with a session".

     From the COOKIE, never from the body — see the header. The gate is the only
     credential in the wing now, so identity is a label (see whoami.ts) and this is
     the only thing that can tell the two of them apart. Verified before this: a
     him-cookie POST was accepted as hers, filing one person's tap under the other's
     name on the page whose entire subject is whose is whose. */
  const who = identify(cookies, url);
  if (!who) {
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
  const mine = MAY_REACT_TO[who];
  let date = '';
  let reaction = '';
  let side: Side | null = null;
  let sideGiven = false;
  let on = true;
  try {
    const fields: Record<string, unknown> = wantsJson
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries(await request.formData());

    // Defaulting to today is a real convenience for the common case, but the date
    // is still validated below — it is a primary key, and "today" is only the
    // default, never an override for something invalid.
    date = typeof fields.date === 'string' && fields.date.trim() ? fields.date.trim() : wingDate();
    /* Trimmed, because a urlencoded field and an iOS keyboard both like to bring a
       space along, and the SIZE is capped before anything looks at the value.
       slice() before validate rather than reject-on-long so that the regex and the
       segmenter are never handed an unbounded string. */
    reaction =
      typeof fields.reaction === 'string'
        ? fields.reaction.slice(0, MAX_REACTION_UNITS + 1).trim()
        : '';
    sideGiven = fields.side !== undefined && fields.side !== null && fields.side !== '';
    side = sideGiven ? readSide(fields.side) : mine;
    on = readOn(fields.on);
  } catch {
    return answer(false, 400, 'bad-request');
  }

  if (!isWingDate(date)) return answer(false, 400, 'bad-date');
  // A `side` that was sent but is neither word is a bug in a caller, not a
  // permission problem, so it is a 400 and not the 403 below.
  if (!side) return answer(false, 400, 'bad-side');

  /* THE ONE RULE. You react to the other one's song.

     Placed BEFORE the emoji check on purpose: "that one is yours" is the more
     useful answer than "that is not an emoji" when both are true, and it is the
     answer the reporter of this bug needed. */
  if (side !== mine) {
    return answer(false, 403, 'own-song');
  }

  /* Rejected, not ignored, and this is the check that stands between an arbitrary
     string and the store. See isReaction() in kv.ts for the grammar. Silently
     accepting something unrenderable would let a typo in the page's markup look
     like a working button forever — and silently accepting something that is NOT
     one emoji would put attacker-chosen text in the store. */
  if (!isReaction(reaction)) return answer(false, 400, 'bad-emoji');

  // Reacting to a day with no song is harmless but meaningless, and allowing it
  // would let the reactions map grow keys that no archive row will ever render.
  // Not checked against the store, though: that would cost an extra round trip to
  // prevent something only our own markup can cause.

  try {
    /* THE CAP, CHECKED BEFORE THE WRITE.

       One extra read, and only on the ADD path — taking a reaction back can never
       push a day over a ceiling. The vocabulary is open now, so without this a
       single authenticated phone in a loop could put unbounded distinct fields in
       one hash. `already` is what makes re-tapping something that is already on
       still work at the ceiling: it is not adding anything.

       Honest about the cost: on the R2 tier this makes an add three whole-document
       reads (this, the read-modify-write, the read-back). Two people, once a
       morning. It stops being acceptable the moment there is a third writer, which
       is the same caveat kv.ts's header already gives for that tier. */
    if (on) {
      const before = await getReactions([date]);
      const current = (side === 'his' ? before[date]?.onHis : before[date]?.onHers) ?? [];
      const already = current.includes(reaction);
      if (!already && current.length >= MAX_REACTIONS_PER_DAY) {
        return answer(false, 409, 'too-many');
      }
    }

    await putReaction(date, side, reaction, on);
    // Read back rather than assume. On the R2 tier this write was a
    // read-modify-write that could in principle have raced another one, so
    // echoing the store's actual state is the only honest answer — and it is what
    // lets the client repaint every button on that side from one response.
    const after = await getReactions([date]);
    const list = (side === 'his' ? after[date]?.onHis : after[date]?.onHers) ?? [];
    return answer(true, 200, null, {
      date,
      side,
      reactions: list,
      // Which sentence the no-JS page shows. Not derived from `on` by the page,
      // because the page does not know what was asked for — only what happened.
      // NOT named `ok`: see the comment in answer().
      outcome: on ? 'reacted' : 'unreacted',
    });
  } catch (err) {
    console.error('[us] react could not write to the store:', err);
    return answer(false, 502, 'store');
  }
};

/** Anything other than POST. Explicit, so a stray GET is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
