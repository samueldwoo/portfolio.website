/**
 * POST /api/us/letter — she writes back.
 *
 * ---------------------------------------------------------------------------
 * ONE VERB, AND IT IS HERS
 *
 * This endpoint stores her reply to one letter. That is all it does. It cannot
 * create a letter, edit a letter, unseal a letter or mark one read, and those are
 * not four omissions — they are the shape of the feature:
 *
 *   A LETTER BODY IS NOT STORABLE. src/lib/us/letters.ts has no field for one, no
 *   command that writes one and no code path that could. Letters arrive as authored
 *   content in `US_LETTERS`; the store holds read receipts and her replies. So the
 *   rule /api/us/reply enforces with a cookie check — her session must never be able
 *   to write as me — is enforced HERE by the absence of the capability. A bug in
 *   this file cannot forge a letter from Sam, because forging one would require a
 *   feature nothing in this repository implements.
 *
 *   UNSEALING IS NOT A REQUEST. A sealed letter's body never reaches the browser at
 *   all (see visibleLetter()), so there is nothing for an endpoint to unlock. The
 *   only thing that opens a letter is the calendar.
 *
 *   THE READ RECEIPT IS RECORDED BY THE PAGE, not by a fetch from the client. That
 *   is a deliberate trade and letters.astro documents it: recording it server-side
 *   on render is the only version that works with JavaScript switched off, which the
 *   whole wing insists on, and the cost is that a browser which prefetched the link
 *   would mark a letter read early.
 *
 * ---------------------------------------------------------------------------
 * SESSION ONLY — NOT ADMIN
 *
 * Same rule as /api/us/react and /api/us/reply, for the same reason: a reply I could
 * write as her is a reply that means nothing. If I want to see the round trip work,
 * I answer the three questions like anybody else.
 *
 * The cookie is verified HERE with verify(), not merely trusted from
 * src/middleware.ts. The middleware is default-deny for everything under /api/us
 * that is not explicitly allowlisted — which is why this file needed no middleware
 * change to be protected the moment it existed — but its default check accepts
 * EITHER token, so it cannot tell us apart. Only this file knows which of us is
 * allowed to write here.
 *
 * Note the third argument to readCookie: `url`. Without it, the reader refuses the
 * plain dev cookie name and this endpoint would 401 forever under `astro dev`.
 *
 * ---------------------------------------------------------------------------
 * IT WORKS WITH JAVASCRIPT OFF
 *
 * A real <form method="post"> that 303s back to the letter, exactly like the
 * reaction and reply forms. Astro's `security.checkOrigin` is on by default, which
 * gives form-encoded POSTs origin checking for free; it does NOT cover
 * `application/json`, which is the other reason the cookie is verified in here
 * rather than assumed from the middleware.
 *
 * The page's script upgrades this to a fetch for ONE reason that is not cosmetic: a
 * native submit that fails has already navigated away and taken several hundred
 * words with it, and retyping a letter is the difference between answering and not.
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../lib/us/config';
import { readCookie, verify } from '../../../lib/us/session';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import { crossSite } from '../../../lib/us/together';
import { wingDate } from '../../../lib/us/kv';
import {
  REPLY_MAX,
  findLetter,
  getStatesSafe,
  isSealed,
  setReply,
  tidyReply,
} from '../../../lib/us/letters';

export const prerender = false;

/**
 * A ceiling on her writing, not a security control.
 *
 * Twelve in ten minutes. Lower than /api/us/reply's twenty, and much lower than
 * /api/us/react's ninety, because the unit of work here is the largest in the wing:
 * on the R2 tier each accepted reply is a read-modify-write of a document that can
 * hold every reply she has ever written. Nobody sends a considered letter twelve
 * times in ten minutes; a stuck retry loop does, and this is what stops it.
 */
const RATE_LIMIT = 12;
const RATE_WINDOW_SEC = 600;

/** Where a no-JavaScript form submission lands afterwards. */
const LETTERS_PAGE = '/samdrea/vault/letters';

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

export const POST: APIRoute = async ({ request, cookies, clientAddress, redirect, url }) => {
  const wantsJson = isJsonRequest(request);

  /**
   * One exit point, so the fetch and no-JS paths can never drift apart.
   *
   * The no-JS redirect carries the letter id so she lands back on the LETTER she was
   * answering rather than on the shelf. 303 forces a GET, which means the page
   * re-renders from the store and a refresh does not resubmit what she wrote.
   */
  const answer = (
    ok: boolean,
    status: number,
    error: string | null,
    extra: Record<string, unknown> = {},
  ): Response => {
    if (wantsJson) return json({ ok, ...(error ? { error } : {}), ...extra }, status);
    const id = typeof extra.id === 'string' ? extra.id : '';
    const where = id ? `${LETTERS_PAGE}?read=${encodeURIComponent(id)}` : LETTERS_PAGE;
    const query = ok ? '&sent=1' : `&e=${encodeURIComponent(error ?? 'no')}`;
    // A failure with no usable id has nowhere better to go than the shelf, and it
    // still has to carry its error code, so the separator depends on the path.
    return redirect(id ? `${where}${query}` : `${where}?${query.slice(1)}`, 303);
  };

  const secret = SESSION_SECRET();
  if (!secret) {
    console.error('[us] letter called but US_SESSION_SECRET is missing.');
    return answer(false, 503, 'unconfigured');
  }

  // Session, and only session. My admin token is refused here — see the header.
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
    console.warn('[us] refused a cross-site letter reply.');
    return answer(false, 403, 'cross-site');
  }

  const limit = await hit(
    `letter:${clientKey(request, clientAddress)}`,
    RATE_LIMIT,
    RATE_WINDOW_SEC,
  );
  if (!limit.ok) return answer(false, 429, 'rate', { retryAfter: limit.retryAfter });

  /* ---- parse ------------------------------------------------------------
     Rate-limited BEFORE the body is read, on purpose: reading a 4000-character
     form body is the expensive part of an abusive request, and there is no reason
     to pay for it after deciding to refuse. */
  let id = '';
  let raw = '';
  try {
    const fields: Record<string, unknown> = wantsJson
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries(await request.formData());
    id = typeof fields.id === 'string' ? fields.id.trim() : '';
    raw = typeof fields.reply === 'string' ? fields.reply : '';
  } catch {
    return answer(false, 400, 'bad-request');
  }

  /* findLetter() SELECTS from the authored list; it never builds a key from what
     arrived. An id that is not in the list is not a letter, so there is nothing to
     reply to and nothing to write — which is also what bounds the store: without
     this check a caller could file replies under ten thousand invented ids and grow
     data/letters.json until the read refuses it. */
  const letter = findLetter(id);
  if (!letter) return answer(false, 404, 'no-such-letter');

  /* Refused rather than silently allowed. She cannot have read a sealed letter, so a
     reply to one is either a stale form from before it was resealed (impossible, but
     cheap to rule out) or a hand-made request — and either way, accepting it would
     write state for a letter whose card must show nothing at all. Re-checked here
     rather than trusted from the page: the seal is the promise, so it is verified
     everywhere it matters. */
  /* THE THIRD ARGUMENT IS LOAD-BEARING, AND OMITTING IT BROKE A WHOLE FEATURE.
     isSealed(letter, today, opened) treats an `openWhen` letter as sealed until
     `opened` is true, and `opened` DEFAULTS TO FALSE. That default is the correct
     failure direction for a renderer that has not been taught about this seal, and
     exactly wrong here. This endpoint was calling it with two arguments, so EVERY
     "open when..." letter was permanently unrepliable:

       she opens the 3am letter, reads it, writes back, presses send
         -> 303 ?e=sealed   "that one is still sealed. It opens on its own."

     ...about the open letter in front of her. With JavaScript off her words were
     gone. The read receipt IS the opened receipt, so the fact needed was one store
     read away the whole time.

     getStatesSafe, not getStates: a dead store must not turn "reply" into
     "sealed". It resolves to {} on failure, which makes `opened` false again — the
     same fail-toward-the-seal direction, and still right, because refusing to
     write into a store we cannot read is correct anyway. */
  const states = await getStatesSafe();
  const opened = (states[letter.id]?.firstReadAt ?? 0) > 0;
  if (isSealed(letter, wingDate(), opened)) {
    return answer(false, 403, 'sealed', { id: letter.id });
  }

  /* MEASURED WITH tidyReply, NOT normalizeReply. normalizeReply truncates, so
     `normalizeReply(x).length > REPLY_MAX` is permanently false and this 413 would
     be unreachable — the exact bug marks.ts shipped and had to split two functions
     to fix. She would send five thousand characters, see four thousand, and have no
     way to know which end went missing.

     Also note this counts AFTER newline normalisation. A form POST converts every
     LF to CRLF on the wire, so measuring the raw body would count each line break
     she typed as two characters against a textarea maxlength that counted it as
     one — and a reply that fit in the box would be rejected by the server. */
  const cleaned = tidyReply(raw);
  if (!cleaned) {
    /* Empty is a REJECTION, not a delete, and that is a deliberate decision rather
       than a missing feature. The realistic accident is submitting the form blank
       (a stray Enter, a resubmitted page) and the cost of treating that as "clear
       it" is destroying several hundred words she wrote. The realistic need —
       changing what she said — is already served by sending a new reply, which
       replaces the old one. If she genuinely wants it gone she can replace it with
       one word, and that is a much better failure mode than the alternative. */
    return answer(false, 400, 'empty', { id: letter.id });
  }
  if (cleaned.length > REPLY_MAX) {
    return answer(false, 413, 'too-long', { id: letter.id, max: REPLY_MAX, was: cleaned.length });
  }

  let state;
  try {
    /* Overwrites any earlier reply to this letter, on purpose. One reply per letter
       is what keeps the page readable as a letter and an answer rather than as a
       thread, and the realistic mistake — sending before she was finished — has to
       be fixable from the same phone. setReply normalises again on the way in, so
       the cap is a property of the store and not of this file's diligence. */
    state = await setReply(letter.id, cleaned);
  } catch (err) {
    /* Loud, and reported as a failure. The one outcome that must never happen here
       is a page that says "sent" over a write that did not land — she would believe
       I had her answer and I would never see it. The client keeps her text in the
       textarea on this path. */
    console.error('[us] letter reply could not write to the store:', err);
    return answer(false, 502, 'store');
  }

  return answer(true, 200, null, { id: letter.id, reply: state.reply, repliedAt: state.repliedAt });
};

/** Anything other than POST. Explicit, so a stray GET is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
