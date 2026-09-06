/**
 * /api/us/comment — say something under a photograph.
 *
 * ---------------------------------------------------------------------------
 * ONE ENDPOINT FOR BOTH OF THEM, WHICH IS THE OPPOSITE OF song/reply
 *
 * The song has TWO endpoints, `song.ts` for him and `reply.ts` for her, and
 * reply.ts's header argues that at length: one endpoint per identity is what makes
 * "this half came from her" a fact rather than a caption, and neither may ever
 * choose its key space from a request field.
 *
 * That argument does not apply here and following it would be cargo cult. A song
 * day has exactly two slots and each belongs to one person, so the key space IS
 * the identity. A comment thread has one slot that both of them write into — that
 * is what a conversation is. The author is a FIELD on the record, minted from the
 * cookie, and the thread it lands in is chosen by which photograph is being
 * discussed. There is no per-identity key space to protect.
 *
 * WHAT STILL PROTECTS IT: `identify()` resolves the author from the signed cookie
 * and the request cannot influence it. `by` is never read off the wire. So he
 * cannot post as her by editing a form field — there is no field to edit.
 *
 * ---------------------------------------------------------------------------
 * WHICH PHOTOGRAPH, AND WHY THAT IS NOT AN OPEN DOOR
 *
 * The body carries `date` and `whose` — the day and whose picture it is. Both are
 * validated to a closed shape (`isWingDate`, and `her`|`him`) before they reach the
 * store, so the key is built from two enumerated values and a date, never from
 * caller text. `../../etc` cannot address anything: it fails `isWingDate` and the
 * key is a template over the validated pair.
 *
 * A thread for a photograph that does not exist is a thread nobody can see, because
 * the page only renders threads for frames it is displaying. So this deliberately
 * does NOT verify the frame exists: that would be a second store read on every
 * comment to prevent writing a record with no reader.
 *
 * ---------------------------------------------------------------------------
 * THE TEXT NEVER REACHES A LOG, STRUCTURALLY
 *
 * `trace()` refuses any string that is not in its STRING_KEYS allowlist and prints
 * `key=len:87` instead. `text` is not in that list and MUST NOT BE ADDED: a comment
 * is two people talking, which is the exact content trace.ts exists to be unable to
 * print. The trace below carries the outcome, the action and lengths only.
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../lib/us/config';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import { isWingDate } from '../../../lib/us/kv';
import { notify } from '../../../lib/us/push';
import { timer, trace } from '../../../lib/us/trace';
import { crossSite, identify, isWho, type Who } from '../../../lib/us/together';
import { TEXT_MAX, isCommentId, type ThreadRef } from '../../../lib/us/comment-thread';
import { addComment, deleteComment, editComment } from '../../../lib/us/comments';

export const prerender = false;

const PAGE = '/samdrea/vault/day';

/**
 * A ceiling on a conversation, not a security control.
 *
 * 40 in ten minutes. A real back-and-forth is a handful of messages; forty is far
 * beyond any of them and far below what a stuck retry loop or a form-resubmitting
 * browser could cost. Higher than the photograph's 6 because a comment is a
 * sentence and an upload is four megabytes, and higher than a song's 20 because
 * replying twice is normal here and re-posting a song is not.
 */
const RATE_LIMIT = 40;
const RATE_WINDOW_SEC = 600;

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

/** See admin.ts, react.ts and mark.ts: the response shape follows the request shape. */
function isJsonRequest(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').toLowerCase().includes('application/json');
}

/** An allowlist, so a typo is a 400 rather than a silent no-op. */
type Action = 'add' | 'edit' | 'delete';
const ACTIONS = new Set<Action>(['add', 'edit', 'delete']);
function isAction(value: unknown): value is Action {
  return typeof value === 'string' && ACTIONS.has(value as Action);
}

export const POST: APIRoute = async ({ request, cookies, clientAddress, redirect, url }) => {
  const wantsJson = isJsonRequest(request);
  const t = timer();

  /* ---- WHERE TO LAND HER BACK, KNOWN BEFORE THE BODY IS PARSED --------------

     Exactly the problem mark.ts documents: authorization and the rate limit answer
     BEFORE the body is read — deliberately, since nothing untrusted is parsed until
     the caller has proven who they are — and those are precisely the failures where
     being dumped at the top of the page is worst.

     So the frame being discussed is carried in the QUERY STRING as well, readable
     with no body at all. It is used for NOTHING but the fragment: it never selects a
     record and never builds a store key, and the redirect path is a fixed constant,
     so there is no open redirect and no path from it to the store. The BODY remains
     the source of truth and overwrites it below. */
  const hintWhose = url.searchParams.get('whose');
  let landOn = isWho(hintWhose) ? `#frame-${hintWhose}` : '';

  /* For the log only. Null until the body is validated, which is the honest reading
     of an early exit: we genuinely do not yet know what was asked. */
  let act: Action | null = null;
  /* THROUGH A MUTABLE BINDING, never by closing over a `const` — see CLAUDE.md. An
     exit can fire before identity is resolved, and a helper that closed over the
     const would be a TDZ ReferenceError the day somebody adds an earlier one. */
  let who: Who | null = null;

  /** One exit, so the fetch and no-JavaScript paths cannot drift apart. */
  const answer = (
    ok: boolean,
    status: number,
    code: string | null,
    extra: Record<string, unknown> = {},
  ): Response => {
    /* ONE LINE PER OUTCOME. `who` is the author and is worth having: "her comment
       would not save" is a different report from his. Neither the text nor the
       comment id appears — the id is not in STRING_KEYS and the text must never be
       (see the header). */
    trace('comment.post', { ok, status, code, kind: act, who, ms: t.total() });
    if (wantsJson) return json({ ok, ...(code ? { code } : {}), ...extra }, status);
    const query = ok ? `?ok=${encodeURIComponent(code ?? 'said')}` : `?e=${encodeURIComponent(code ?? 'no')}`;
    const res = redirect(`${PAGE}${query}${landOn}`, 303);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(PRIVACY)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  const secret = SESSION_SECRET();
  if (!secret) {
    console.error('[us] comment called but US_SESSION_SECRET is missing.');
    return answer(false, 503, 'unconfigured');
  }

  /* Defence in depth. src/middleware.ts is default-deny for everything under
     /api/us that is not explicitly allowlisted, so this branch is unreachable
     today — and it stays, because the cost of a routing change upstairs must be
     "the endpoint says no" and never "either of them can post as the other". */
  who = identify(cookies, url);
  if (!who) return answer(false, 401, 'unauthorized');

  /* Astro's security.checkOrigin is off by design; crossSite() replaces it, because
     iOS Safari omits Origin on same-origin form posts. See together.ts. */
  if (crossSite(request, url)) return answer(false, 403, 'cross-site');

  /* NAMESPACED, like every other endpoint in the wing. This one read
     `clientKey(...)` bare, so its bucket was `us:rl:<ip>` while all thirteen others
     are `us:rl:<name>:<ip>` — no collision today precisely because everyone else is
     prefixed, which makes it one careless omission away from two endpoints sharing a
     40-per-10-minutes budget. Only visible on the Upstash tier: the in-process
     limiter locally never comes near the limit. */
  const gate = await hit(`comment:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!gate.ok) return answer(false, 429, 'rate', { retryAfter: gate.retryAfter });

  /* ---- the body, and only now ---- */
  let fields: Record<string, unknown>;
  try {
    if (wantsJson) {
      fields = (await request.json()) as Record<string, unknown>;
    } else {
      const form = await request.formData();
      fields = Object.fromEntries([...form.entries()]);
    }
  } catch {
    return answer(false, 400, 'bad-request');
  }

  const action = fields.action;
  if (!isAction(action)) return answer(false, 400, 'bad-action');
  act = action;

  const date = typeof fields.date === 'string' ? fields.date : '';
  const whose = fields.whose;
  if (!isWingDate(date)) return answer(false, 400, 'bad-date');
  if (!isWho(whose)) return answer(false, 400, 'bad-frame');
  const ref: ThreadRef = { date, whose };
  // The body is the source of truth; the query hint above was only a fallback.
  landOn = `#frame-${whose}`;

  if (action === 'add') {
    let result;
    try {
      result = await addComment(ref, who, fields.text);
    } catch (err) {
      console.error(`[us] could not add a comment for ${who}:`, err);
      return answer(false, 502, 'store');
    }
    /* A REFUSAL IS NOT AN ERROR AND NOT A 500. 409 is honest: the request was fine,
       the current state will not take it. The page turns each code into a sentence
       with a reason in it — see together.ts's list for the same shape. */
    if ('refused' in result) {
      return answer(false, 409, result.refused, { max: TEXT_MAX });
    }

    /* AWAITED, like every other notify in this wing: a serverless function that
       returns before its outbound work lands does not do it. notify() is bounded and
       cannot throw, and the write has already succeeded regardless.

       NEITHER THE TEXT NOR THE PHOTOGRAPH IS PASSED. notify() takes an event name and
       nothing else, which is the property push.ts's header argues for: a notification
       is read by whoever is standing next to the phone. */
    await notify(who, 'comment');
    return answer(true, 200, 'said', { id: result.comment.id });
  }

  /* Both remaining actions are keyed by a comment id. Shape-checked here so a
     malformed one never becomes a store command argument — and it is only a
     pre-filter: the store additionally requires the id to SELECT a record that
     belongs to this person. An id selects a record; it never builds a key. */
  const id = fields.id;
  if (!isCommentId(id)) return answer(false, 404, 'no-such-comment');

  if (action === 'edit') {
    let updated;
    try {
      updated = await editComment(ref, id, who, fields.text);
    } catch (err) {
      console.error(`[us] could not edit a comment for ${who}:`, err);
      return answer(false, 502, 'store');
    }
    /* ONE ANSWER FOR THREE CASES, on purpose: the id selected nothing, it belongs to
       the other person, or the new text was empty. Telling them apart would let each
       of them discover which ids exist in the other's name, and 404 is the honest
       answer to "change this thing you may not change". No notification — an edit is
       a typo fix, and buzzing her phone for a comma is how a good feature becomes an
       annoying one. */
    if (!updated) return answer(false, 404, 'no-such-comment');
    return answer(true, 200, 'edited', { id: updated.id });
  }

  let removed: boolean;
  try {
    removed = await deleteComment(ref, id, who);
  } catch (err) {
    console.error(`[us] could not delete a comment for ${who}:`, err);
    return answer(false, 502, 'store');
  }
  if (!removed) return answer(false, 404, 'no-such-comment');
  return answer(true, 200, 'removed', { id });
};

/** Anything but POST. Explicit, so a stray GET is a 405 and not a blank 200. */
export const ALL: APIRoute = async () => json({ ok: false, code: 'method-not-allowed' }, 405);
