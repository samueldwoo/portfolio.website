/**
 * POST /api/us/mark — she leaves a mark on a memory.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ENDPOINT EXISTS
 *
 * The room was read-only. Thirteen photographs, a note behind each one, and no
 * way for her to answer any of it — so the room could not tell, afterwards, that
 * she had ever been in it. This is the same argument /api/us/react makes about
 * the song: a card she reads is a broadcast, a tap that comes back is a
 * conversation, and over a year of long distance the difference between those two
 * is the entire point.
 *
 * Three actions, deliberately of three different weights:
 *
 *   keep  `{ action: 'keep', id, on }`   — one tap. Idempotent, undoable, no text.
 *   note  `{ action: 'note', id, note }` — her words back, under mine.
 *   seen  `{ action: 'seen', id }`       — incidental; the room fires it when she
 *                                          actually reaches a note, so I can tell
 *                                          "she opened the room" from "she read
 *                                          the thing I wrote".
 *
 * ---------------------------------------------------------------------------
 * SESSION ONLY — NOT ADMIN
 *
 * Same rule, and the same reasoning, as /api/us/react: this is the second
 * endpoint in the wing that refuses my own admin token. Every other private route
 * accepts either so that I am not locked out of her rooms. Here, being able to
 * keep a memory AS HER would make the mark meaningless — its whole value is that
 * it can only have come from her. If I want to test the round trip I answer the
 * three questions like anyone else.
 *
 * That distinction has to be made HERE and cannot be delegated: src/middleware.ts
 * default-denies everything under /api/us that is not allowlisted (and this file
 * is not, so it is guarded the moment it exists), but its check accepts EITHER
 * token, so it cannot tell us apart. The verify() below is what makes the rule
 * real. It is also defence in depth — a future routing mistake in the middleware
 * degrades to "the endpoint says no" rather than "anyone can write in her room".
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENT BY CONSTRUCTION, EXCEPT WHERE IT MUST NOT BE
 *
 * `keep` and `note` state a desired END STATE rather than an action, so a
 * double-tap on a laggy phone, a retried fetch and a browser replaying a request
 * on wake all converge on the same stored value. That is also what makes a keep
 * takeable-back, which matters more than it sounds: a mark you cannot undo is one
 * she has to think about before giving, and thinking about it is exactly what this
 * is meant to avoid.
 *
 * `seen` is the exception — it is a counter, so it is NOT idempotent by design.
 * It is therefore the one action the client fires at most once per reveal, and it
 * is fire-and-forget: nothing in the room's behaviour depends on its response.
 *
 * ---------------------------------------------------------------------------
 * TWO CLIENTS, ONE HANDLER
 *
 * A `fetch` with JSON gets JSON. A plain <form> gets a 303 back to the room. The
 * second is not a courtesy: the static fallback grid in room.astro is the page
 * whenever WebGL, JavaScript or hydration fails, and a keep button that only
 * works with the island running would mean the accessible version of the room is
 * read-only while the pretty one is not. 303 forces a GET, so a refresh does not
 * resubmit, and the redirect carries a fragment so she lands back on the card she
 * was standing on instead of at the top of the page.
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../lib/us/config';
import { readCookie, verify } from '../../../lib/us/session';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import {
  MARK_NOTE_MAX,
  bumpSeen,
  isMarkId,
  setKept,
  setNote,
  tidyNote,
} from '../../../lib/us/marks';

export const prerender = false;

/**
 * Generous, because turning keeps on and off while she decides is normal
 * behaviour and being told "slow down" for it would be absurd.
 *
 * Higher than react.ts's 90 because `seen` fires automatically on every reveal —
 * thirteen memories plus her deciding about them is already most of a hundred in
 * a single sitting, and the limiter must not turn a thorough visit into an error.
 *
 * BE HONEST ABOUT WHAT THIS BUYS, because the obvious claim is false. It would be
 * natural to write "this bounds the work on the R2 tier, where every write is a
 * read-modify-write of the whole document". That sentence cannot be true: marks.ts
 * selects the R2 tier only when hasKV() is false, and ratelimit.ts selects its
 * durable Upstash limiter only when the same two variables ARE set. So every
 * deployment on the R2 tier is, necessarily, one where hit() falls through to its
 * per-instance in-memory bucket — best-effort, N instances, N x the stated ceiling
 * — and the Upstash path additionally fails OPEN by design.
 *
 * What the limit actually is, then: a courtesy brake on one client, and a cheap
 * bound on a runaway loop in our own island. It is NOT a defence, and treating it
 * as one is how you end up with no real bound anywhere. The real bounds are
 * elsewhere and they are structural: isMarkId() caps the key space at thirteen,
 * MARK_NOTE_MAX caps each value, and the session cookie is what actually decides
 * who may write at all.
 */
const RATE_LIMIT = 150;
const RATE_WINDOW_SEC = 600;

/**
 * Same-origin check.
 *
 * This is a cookie-authenticated POST that accepts `application/x-www-form-
 * urlencoded` — a CORS-simple content type, so a cross-site form submission needs
 * no preflight and no cooperation from us.
 *
 * CORRECTION. An earlier version of this comment said `security.checkOrigin` was
 * NOT protecting this endpoint, reasoning that `output: 'static'` makes Astro's
 * `checkOrigin && buildOutput === "server"` resolve false. The source reading was
 * right; the conclusion was wrong. `buildOutput` is "server" HERE precisely
 * because several routes set `prerender = false`. Measured two ways: the built
 * manifest in .vercel/output carries `checkOrigin: true`, and a cross-origin form
 * POST to a sibling endpoint returns 403 before the handler runs.
 *
 * So the form path IS origin-checked by the framework, and this guard is defence
 * in depth rather than the only wall. It is still worth keeping, for two reasons:
 * checkOrigin does NOT cover `application/json` (a cross-origin JSON post is not
 * blocked — measured), and the framework's protection is contingent on something
 * unrelated. Delete the last `prerender = false` route and `buildOutput` flips to
 * "static", checkOrigin silently becomes false, and every form endpoint loses its
 * origin check with nothing failing and no warning. That fragility is recorded in
 * astro.config.mjs next to the adapter.
 *
 * Without this, the only thing standing between a cross-site page and her data is
 * `sameSite: 'lax'` in session.ts — a cookie attribute set in a different file
 * whose own comment explains at length why it must not be 'strict'. One future fix
 * for "she arrives from an in-app browser and gets the gate again" would make both
 * this endpoint and /api/us/react fully forgeable, with nothing here to notice.
 * And Lax is site-scoped rather than origin-scoped, so any host under the same
 * registrable domain can already post today.
 *
 * REJECT ONLY ON A POSITIVE MISMATCH, never on absence. Every browser that can run
 * this room sends `Origin` on a POST and `Sec-Fetch-Site` on every request, so a
 * real forgery is always caught; but failing closed on a MISSING header would risk
 * breaking the no-JavaScript form path, which is the accessible route and the one
 * that must never regress. A missing header means "cannot tell", and the cookie is
 * still doing the authorization either way.
 *
 * `Sec-Fetch-Site` FIRST, because it is the only one of the two that needs no
 * server-side knowledge of our own address: the browser computes it, and it is
 * unforgeable from script. The Origin comparison is the fallback for Safari before
 * 16.4, which does not send Sec-Fetch-Site.
 *
 * AND THE ORIGIN COMPARISON IS HOST-ONLY, NOT FULL-ORIGIN. That is a deliberate
 * refusal to bet on the protocol. `Astro.url` is built from the incoming request's
 * own URL (@astrojs/vercel's entrypoint passes `request` straight through, and the
 * platform derives it from the Host header), so the host is reliable — but a proxy
 * hop that handed the function `http://` while the browser used `https://` would
 * make a full-origin comparison fail on EVERY write, turning a security control
 * into an outage. The host is what carries the security property anyway: an
 * attacker on evil.example has a different host no matter what scheme they use.
 */
function crossSite(request: Request, url: URL): boolean {
  const site = request.headers.get('sec-fetch-site');
  // 'none' is a direct navigation (typed URL, bookmark) — not a cross-site post.
  if (site) return site !== 'same-origin' && site !== 'none';

  const origin = request.headers.get('origin');
  if (!origin) return false; // cannot tell; the cookie is still the authorization
  /* A literal `null` Origin — a sandboxed iframe, or some redirect chains — is an
     OPAQUE origin and is therefore never ours. It also does not parse, so it would
     land in the catch below regardless; naming it is what stops somebody "fixing"
     that by treating an unparseable Origin as absent. */
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true;
  }
}

/** Where a no-JavaScript form submission lands afterwards. */
const ROOM_PAGE = '/samdrea/vault/room';

/**
 * Applied to EVERY exit from this endpoint, the 303 included.
 *
 * Repeated here rather than relying on src/middleware.ts, for the same reason
 * /api/us/photo/[id] repeats them: a future routing change that takes this path out
 * of the middleware's scope must not also make her notes indexable or leak a
 * referrer. Hoisted into a constant so the JSON and redirect exits cannot drift —
 * they had, and only the JSON one carried them.
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

/**
 * Read a boolean off the wire.
 *
 * A urlencoded form can only send strings, so `'0'`, `'false'` and `''` all have
 * to mean false — and crucially an ABSENT field means TRUE. That default is what
 * lets the simplest possible no-JS markup work: a form carrying only the action
 * and the id keeps the memory. Un-keeping is always explicit. Lifted verbatim
 * from react.ts's readOn so the two endpoints cannot drift.
 */
function readOn(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === '');
}

/** The three things she may do. An allowlist, so a typo is a 400 and not a no-op. */
type Action = 'keep' | 'note' | 'seen';
const ACTIONS = new Set<Action>(['keep', 'note', 'seen']);
function isAction(value: unknown): value is Action {
  return typeof value === 'string' && ACTIONS.has(value as Action);
}

export const POST: APIRoute = async ({ request, cookies, clientAddress, redirect, url }) => {
  const wantsJson = isJsonRequest(request);

  /* ---- WHICH CARD TO LAND HER BACK ON --------------------------------------
     The no-JS redirect carries a `#m-<id>` fragment so a form submission puts her
     back on the card she pressed rather than at the top of a thirteen-card page.

     The id therefore has to be known BEFORE the body is parsed, and it cannot come
     from the body: authorization and rate limiting both answer before the body is
     read (deliberately — nothing untrusted gets parsed until the caller has proven
     it is her), and those are exactly the failures where losing her place is most
     annoying. Verified: a rate-limited form submission redirected to the bare page.

     So the forms in room.astro carry it in the QUERY STRING as `?m=<id>`, which is
     readable with no body at all. It is validated against the manifest anyway and
     is used for NOTHING except this fragment — it never selects a record and never
     builds a key, so there is no path from it to the store. The redirect target is
     a fixed constant path, so this is not an open redirect either.

     The body's `id` overwrites it below when we get that far, so the query string is
     a hint and the body remains the source of truth. */
  const fromQuery = url.searchParams.get('m');
  let landOn = isMarkId(fromQuery) ? fromQuery : '';

  /** One exit point, so the fetch and no-JS paths cannot drift apart. */
  const answer = (
    ok: boolean,
    status: number,
    error: string | null,
    extra: Record<string, unknown> = {},
  ): Response => {
    if (wantsJson) return json({ ok, ...(error ? { error } : {}), ...extra }, status);
    const frag = landOn ? `#m-${encodeURIComponent(landOn)}` : '';
    const query = ok ? '' : `?e=${encodeURIComponent(error ?? 'no')}`;
    /* The privacy headers go on THIS exit too, not just the JSON one.
       This is the browser-visible path and its Location carries `#m-<id>` — the id
       of a card in her private gallery — so leaving it to src/middleware.ts alone
       meant the "repeated here so a future routing change cannot make her notes
       indexable or leak a referrer" claim was only half true. Response.redirect
       produces immutable headers in some runtimes, hence build-a-new-one rather
       than mutate; Astro's redirect() is a plain Response, so this is cheap. */
    const res = redirect(`${ROOM_PAGE}${query}${frag}`, 303);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(PRIVACY)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  const secret = SESSION_SECRET();
  if (!secret) {
    // Fail closed. Without a signing secret we cannot tell her from anyone else,
    // and the only safe answer to that is no.
    console.error('[us] mark called but US_SESSION_SECRET is missing.');
    return answer(false, 503, 'unconfigured');
  }

  // Session, and only session. See the header.
  if (!verify(secret, 'session', readCookie(cookies, 'session', url))) {
    return answer(false, 401, 'unauthorized');
  }

  /* Request forgery. Checked AFTER the cookie so an unauthenticated cross-site
     probe learns nothing it did not already know, and BEFORE the body is parsed. */
  if (crossSite(request, url)) {
    console.warn('[us] refused a cross-site mark write.');
    return answer(false, 403, 'cross-site');
  }

  const limit = await hit(`mark:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!limit.ok) return answer(false, 429, 'rate', { retryAfter: limit.retryAfter });

  // ---- parse --------------------------------------------------------------
  let action: unknown = '';
  let id = '';
  /**
   * `null` means the field was ABSENT, which is different from ''.
   *
   * It was `''`, and that default was quietly the most destructive thing in this
   * file: `{ action: 'note', id: 'm01' }` with no `note` at all would CLEAR her
   * note. Combined with a cookie-authenticated form POST, one cross-site page with
   * thirteen auto-submitting forms could have erased every note she had left, and
   * every one of those requests would have looked perfectly well-formed.
   *
   * So clearing a note is now something a caller has to ASK for, by sending an
   * empty string. Absence is a 400. That is worth having even with the same-origin
   * check above, because the two failures are independent and this one costs a
   * line: a destructive DEFAULT is a bad idea regardless of who can reach it.
   */
  let note: string | null = null;
  let on = true;
  try {
    const fields: Record<string, unknown> = wantsJson
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries(await request.formData());

    action = typeof fields.action === 'string' ? fields.action.trim() : '';
    id = typeof fields.id === 'string' ? fields.id.trim() : '';
    note = typeof fields.note === 'string' ? fields.note : null;
    on = readOn(fields.on);
    landOn = id;
  } catch {
    return answer(false, 400, 'bad-request');
  }

  if (!isAction(action)) return answer(false, 400, 'bad-action');
  /* Rejected, not coerced. An unknown id is checked against the manifest rather
     than against a shape — see isMarkId(). The point is not traversal (nothing
     here builds a key from input) but a BOUNDED store: without the check a caller
     could post ten thousand distinct ids and grow the R2 document until reading
     it times out and her room stops rendering marks entirely. */
  if (!isMarkId(id)) return answer(false, 404, 'no-such-memory');

  /* ---- the note ----------------------------------------------------------
     Absence is an ERROR, not a clear. See the declaration of `note` above for the
     cross-site note-wipe that default enabled. */
  let cleanNote = '';
  if (action === 'note') {
    if (note === null) return answer(false, 400, 'note-missing');

    /* MEASURED AFTER NORMALISATION BUT BEFORE THE CAP — tidyNote, not
       normalizeNote. Both halves of that sentence are a bug that was found and
       fixed, in that order.

       It was `note.trim().length`, the RAW wire length. HTML form submission
       converts every newline to CRLF when it builds the entry list, so a textarea
       whose own `maxlength` counted 280 characters arrives here as 281 the moment
       she presses Enter once: she types exactly what the box allowed, submits, and
       is told "that note was longer than 280 characters, so it was not saved" with
       her words gone from the re-rendered box. On the no-JS path, which is the one
       route this check exists to serve.

       The obvious fix — measure normalizeNote(note) — is silently WORSE, and the
       test harness caught it: normalizeNote TRUNCATES to MARK_NOTE_MAX, so its
       result can never exceed it and the 413 becomes unreachable. A 400-character
       note would then be quietly cut to 280, which is the exact outcome this
       refusal exists to prevent.

       tidyNote is normalizeNote without the cap: CRLF folded, control characters
       stripped, blank-line walls collapsed, trimmed. So this measures what she
       actually MEANT, and compares it against what will fit. */
    cleanNote = tidyNote(note);
    if (cleanNote.length > MARK_NOTE_MAX) {
      /* Refused rather than silently truncated: she would send four hundred
         characters, see three hundred, and have no idea which end went missing.
         normalizeNote caps it too, so this is the ERROR and not the enforcement. */
      return answer(false, 413, 'note-too-long', { max: MARK_NOTE_MAX });
    }
  }

  try {
    const mark =
      action === 'keep'
        ? await setKept(id, on)
        : action === 'note'
          ? await setNote(id, cleanNote)
          : await bumpSeen(id);

    /* THE STATE THAT IS NOW STORED — not an optimistic echo of the request.
       Upstash re-reads after the write; R2 returns the document whose conditional
       If-Match PUT succeeded, which is a stronger guarantee than a re-read (see
       marks.ts's mutateDoc). Either way this is what lets the island repaint from
       one response instead of trusting its own guess.

       NARROWED before it goes out. `Mark` also carries `id` (redundant — the client
       asked for it) and `at`, an epoch timestamp of when she last touched this
       memory. room.astro strips both for the same reason on the page-render path,
       and shipping them here would have quietly undone that. */
    return answer(true, 200, null, {
      mark: { kept: mark.kept, note: mark.note, seen: mark.seen },
    });
  } catch (err) {
    // Writes fail LOUD (marks.ts's header explains why): a note she typed that
    // silently did not save is the worst outcome available here.
    console.error(`[us] mark could not write ${action} for ${id}:`, err);
    return answer(false, 502, 'store');
  }
};

/** Anything other than POST. Explicit, so a stray GET is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
