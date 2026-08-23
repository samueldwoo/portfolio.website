/**
 * POST /api/us/together — the daily question, and the shared list.
 *
 * ---------------------------------------------------------------------------
 * FOUR ACTIONS IN ONE FILE, AND WHY THEY BELONG TOGETHER
 *
 *   answer  `{ action: 'answer', date, text }`  — one side of one day's question
 *   add     `{ action: 'add', text }`           — a line on the list
 *   tick    `{ action: 'tick', id, on }`        — done / not done
 *   remove  `{ action: 'remove', id }`          — retract your own line
 *
 * Four rather than four files, following /api/us/mark, which carries three actions
 * for the same reason: they share every single thing that is hard about this
 * endpoint. One identity rule, one same-origin check, one rate limiter, one
 * exit function that has to behave identically for a fetch and for a no-JS form.
 * Splitting them would mean four copies of that preamble and four chances for one of
 * them to drift — and drift in the identity rule specifically is how one person's
 * words get filed under the other's name.
 *
 * They also write ONE document. On the R2 tier every write here is a
 * read-modify-write of `data/together.json`, so putting them behind one module and
 * one endpoint is what lets together.ts's mutateDoc own the If-Match discipline for
 * all four. Two endpoints writing one document with separate retry logic is the shape
 * that loses a write.
 *
 * ---------------------------------------------------------------------------
 * THE REVEAL IS ENFORCED ON THE WRITE PATH TOO, NOT ONLY ON THE PAGE
 *
 * This is the part worth reading twice. The response to `answer` is built by
 * together.ts's visibleDay(), the SAME function the hub renders from — it is never
 * built from what putAnswer returned.
 *
 * The reason: putAnswer resolves to the whole stored DayRecord, which contains BOTH
 * answers. Echoing that back would mean the act of answering handed the caller the
 * other person's answer — and it would do it on the one code path where the page
 * itself is not involved and nobody would think to look. The seal would be intact in
 * the HTML and broken in the JSON, which is the worst of both worlds: it would look
 * enforced.
 *
 * So: `putAnswer` writes, and then the record goes through visibleDay(who) before one
 * byte of it is serialised. If answering did not complete the pair, `theirs` is not
 * hidden in the response — it is absent from it. Same discipline letters.ts applies to
 * a sealed body, same reason: a page cannot leak what it was never given, and neither
 * can an API.
 *
 * `frozen` exists for the other half of the same promise. Once both have answered, an
 * answer can no longer be replaced — see VisibleDay.editable in together.ts. Without
 * it, "answer, read hers, rewrite mine" is a two-request path to retro-fitting my own
 * answer to hers, and every coincidence the feature exists to produce becomes
 * unfalsifiable.
 *
 * ---------------------------------------------------------------------------
 * BOTH OF THEM MAY WRITE EVERYTHING HERE, EXCEPT RETRACTING
 *
 * Unlike /api/us/mark and /api/us/letter — which refuse my admin token outright,
 * because a mark I could leave as her is meaningless — every action here is genuinely
 * two-sided. So identity is not an authorization question, it is an ATTRIBUTION
 * question, and it is resolved once by together.ts's identify(). Read its PART ZERO
 * comment before touching this; the admin-wins-when-both-cookies-are-present rule is
 * load-bearing and the reasoning is not obvious.
 *
 * `remove` is the one asymmetry: only the person who added a line may retract it, and
 * ownership is checked against the STORED `by` field inside the store, never against
 * anything the request claims. See the PART FOUR header in together.ts for why
 * ticking is shared and retracting is not.
 *
 * ---------------------------------------------------------------------------
 * IT ALL WORKS WITH JAVASCRIPT OFF
 *
 * Every action is reachable as a real <form method="post"> that 303s back to the hub
 * with a fragment. `tick` and `remove` are single-button forms; `add` and `answer`
 * carry one field each. 303 forces a GET, so a refresh never re-submits.
 *
 * The hub upgrades ONLY `answer` to a fetch, and only because a native submit that
 * fails has already navigated away and taken up to four hundred characters with it.
 * `add`, `tick` and `remove` stay native: they are cheap, they lose nothing on
 * failure, and every line of script that is not there is a line that cannot break the
 * accessible path.
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../lib/us/config';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import { isWingDate, wingDate } from '../../../lib/us/kv';
import {
  ANSWER_MAX,
  ITEM_MAX,
  LATE_ANSWER_DAYS,
  OPEN_CAP,
  TOTAL_CAP,
  addItem,
  crossSite,
  emptyDay,
  getAll,
  identify,
  isItemIdShape,
  putAnswer,
  removeItem,
  setItemDone,
  tidyAnswer,
  tidyItem,
  visibleDay,
} from '../../../lib/us/together';

export const prerender = false;

/**
 * Forty in ten minutes.
 *
 * Sized against the heaviest action rather than the lightest, which is `answer`: on
 * the R2 tier one accepted answer is a read-modify-write of a document that holds
 * every answer either of them has ever written. Nobody answers a daily question forty
 * times in ten minutes; a stuck retry loop does, and this is what stops it before it
 * spends forty invocations rewriting one object.
 *
 * Higher than /api/us/letter's twelve because `tick` lives here too, and ticking six
 * things off a list in one sitting is completely normal behaviour that must not
 * collide with a limiter. Lower than /api/us/mark's hundred and fifty because nothing
 * here fires automatically — every request is a deliberate press.
 *
 * The same honesty mark.ts insists on applies: this is a courtesy brake on one client,
 * not a defence. together.ts selects the R2 tier only when hasKV() is false, and
 * ratelimit.ts selects its durable Upstash limiter only when those same variables ARE
 * set — so on the R2 tier hit() is necessarily a per-instance in-memory bucket, and on
 * the Upstash path it fails OPEN by design. The real bounds here are structural:
 * ANSWER_MAX and ITEM_MAX cap every value, OPEN_CAP and TOTAL_CAP cap the list's key
 * space, isWingDate caps the day key space to real calendar days, and the cookie is
 * what actually decides who may write at all.
 */
const RATE_LIMIT = 40;
const RATE_WINDOW_SEC = 600;

const HUB_PAGE = '/samdrea/vault';

/** Which block on the hub a 303 should land on, per action. */
const FRAGMENTS: Record<Action, string> = {
  answer: '#question',
  add: '#list',
  tick: '#list',
  remove: '#list',
};

/**
 * Applied to EVERY exit, the 303 included. Repeated here rather than relying on
 * src/middleware.ts for the reason /api/us/mark repeats them: a future routing change
 * that takes this path out of the middleware's scope must not also make what they
 * wrote to each other indexable or leak a referrer.
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

/** The four things they may do. An allowlist, so a typo is a 400 and not a no-op. */
type Action = 'answer' | 'add' | 'tick' | 'remove';
const ACTIONS = new Set<Action>(['answer', 'add', 'tick', 'remove']);
function isAction(value: unknown): value is Action {
  return typeof value === 'string' && ACTIONS.has(value as Action);
}

/**
 * Read a boolean off the wire.
 *
 * A urlencoded form can only send strings, so `'0'`, `'false'` and `''` all have to
 * mean false — and crucially an ABSENT field means TRUE. That default is what lets the
 * simplest possible no-JS markup work: a form carrying only the action and the id
 * ticks the item. Unticking is always explicit. Lifted verbatim from react.ts's and
 * mark.ts's readOn so the three cannot drift.
 */
function readOn(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === '');
}

export const POST: APIRoute = async ({ request, cookies, clientAddress, redirect, url }) => {
  const wantsJson = isJsonRequest(request);

  /* ---- WHICH BLOCK TO LAND BACK ON ----------------------------------------
     The no-JS redirect needs a fragment, and the fragment depends on the action —
     which is in the BODY, and the body is deliberately not read until the caller has
     proven who they are and passed the limiter. Those are exactly the failures where
     landing at the top of a long page is most annoying.

     So the forms on the hub also carry the action in the QUERY STRING as `?a=`, which
     is readable with no body at all. It is validated against the allowlist and used
     for NOTHING except choosing a fragment — it never selects a record, never builds a
     key, and the redirect target is a fixed constant path, so this is not an open
     redirect either. The body's `action` overwrites it below when we get that far, so
     the query string is a hint and the body remains the source of truth. This is
     exactly the trick mark.ts plays with `?m=<id>`. */
  const hinted = url.searchParams.get('a');
  let landOn: Action | null = isAction(hinted) ? hinted : null;

  /** One exit point, so the fetch and no-JS paths can never drift apart. */
  const answer = (
    ok: boolean,
    status: number,
    code: string | null,
    extra: Record<string, unknown> = {},
  ): Response => {
    if (wantsJson) return json({ ok, ...(code ? { code } : {}), ...extra }, status);
    const frag = landOn ? FRAGMENTS[landOn] : '';
    const query = ok
      ? `?ok=${encodeURIComponent(code ?? 'done')}`
      : `?e=${encodeURIComponent(code ?? 'no')}`;
    /* Privacy headers on THIS exit too, not just the JSON one. Response redirects are
       immutable-headered in some runtimes, hence build-a-new-one rather than mutate. */
    const res = redirect(`${HUB_PAGE}${query}${frag}`, 303);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(PRIVACY)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  /* Identity FIRST. identify() returns null when US_SESSION_SECRET is missing, which
     is the fail-closed direction. SESSION_SECRET() and never the dotted
     `import.meta.env.US_SESSION_SECRET` — Vite statically replaces the dotted form at
     build time, so on Vercel it would bake in the build container's `undefined` and
     this branch would claim "unconfigured" on every 401 forever. */
  const who = identify(cookies, url);
  if (!who) {
    if (!SESSION_SECRET()) {
      console.error('[us] together called but US_SESSION_SECRET is missing.');
      return answer(false, 503, 'unconfigured');
    }
    return answer(false, 401, 'unauthorized');
  }

  /* Request forgery. AFTER the cookie so an unauthenticated cross-site probe learns
     nothing, and BEFORE the body is parsed so nothing untrusted is read until the
     caller has proven it is one of them. */
  if (crossSite(request, url)) {
    console.warn('[us] refused a cross-site together write.');
    return answer(false, 403, 'cross-site');
  }

  const limit = await hit(
    `together:${clientKey(request, clientAddress)}`,
    RATE_LIMIT,
    RATE_WINDOW_SEC,
  );
  if (!limit.ok) return answer(false, 429, 'rate', { retryAfter: limit.retryAfter });

  // ---- parse ---------------------------------------------------------------
  let action: unknown = '';
  let date = '';
  let id = '';
  /**
   * `null` means the field was ABSENT, which is different from ''.
   *
   * mark.ts shipped `''` as the default here and it was quietly the most destructive
   * thing in that file: an `action: 'note'` request with no `note` at all would CLEAR
   * her note, so one cross-site page with thirteen auto-submitting forms could have
   * erased everything she had written. The same trap is available here twice —
   * `answer` with no text, `add` with no text — so absence is a 400 in both cases and
   * clearing is something a caller would have to ask for explicitly. It is worth
   * having even with the same-origin check above, because the two failures are
   * independent and a destructive DEFAULT is a bad idea regardless of who can reach
   * it.
   */
  let text: string | null = null;
  let on = true;
  try {
    const fields: Record<string, unknown> = wantsJson
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries(await request.formData());

    action = typeof fields.action === 'string' ? fields.action.trim() : '';
    date = typeof fields.date === 'string' ? fields.date.trim() : '';
    id = typeof fields.id === 'string' ? fields.id.trim() : '';
    text = typeof fields.text === 'string' ? fields.text : null;
    on = readOn(fields.on);
    if (isAction(action)) landOn = action;
  } catch {
    return answer(false, 400, 'bad-request');
  }

  if (!isAction(action)) return answer(false, 400, 'bad-action');

  const nowMs = Date.now();
  const today = wingDate(new Date(nowMs));

  /* ======================================================================
     ANSWER — one side of one day's question
     ====================================================================== */
  if (action === 'answer') {
    /* An absent date defaults to TODAY rather than being rejected, because that is
       what the overwhelmingly common form submission means and making the markup
       carry a hidden field it could get wrong is worse. An INVALID date is still a
       400: `2026-02-31` passes a shape test and would become a permanent unreachable
       key, so isWingDate's round-trip-through-Date check is what stands between the
       store and a day that does not exist. */
    const forDay = date === '' ? today : date;
    if (!isWingDate(forDay)) return answer(false, 400, 'bad-date');

    if (text === null) return answer(false, 400, 'text-missing');

    /* MEASURED WITH tidyAnswer, NOT normalizeAnswer, and both halves of that matter.
       normalizeAnswer TRUNCATES, so `normalizeAnswer(x).length > ANSWER_MAX` is
       permanently false and this 413 would be unreachable — the exact bug marks.ts
       shipped and had to split two functions to fix. She would send six hundred
       characters, see four hundred, and have no way to know which end went missing.

       It also counts AFTER newline normalisation. HTML form submission converts every
       LF to CRLF on the wire, so measuring the raw body would count each line break
       she typed as two characters against a textarea `maxlength` that counted it as
       one — and an answer that fit in the box would be refused by the server, on the
       no-JS path, which is the one this check exists to serve. */
    const clean = tidyAnswer(text);
    if (!clean) {
      /* Empty is a REJECTION, not a delete. The realistic accident is a stray Enter
         or a resubmitted page, and the cost of reading that as "clear it" is
         destroying what she wrote. The realistic need — changing her answer — is
         served by sending a different one, which replaces it. Same call letter.ts
         makes and for the same reason. */
      return answer(false, 400, 'empty', { date: forDay });
    }
    if (clean.length > ANSWER_MAX) {
      return answer(false, 413, 'too-long', { date: forDay, max: ANSWER_MAX, was: clean.length });
    }

    /* ---- THE GATE ON THE WRITE ----------------------------------------
       Read the day BEFORE writing, and decide from visibleDay() rather than from the
       raw record. Two states are refused and they are refused for different reasons:

         frozen  both have already answered, so replacing mine now would be rewriting
                 an answer I gave blind, in the light of hers. That is the mechanic,
                 not a storage rule. See VisibleDay.editable.
         closed  past LATE_ANSWER_DAYS. Nothing to answer any more.

       Read through getAll rather than a single-day getter because together.ts's Store
       interface deliberately has no single-day read — its header sets the bar that a
       seventh operation must justify itself three times over, once per tier, and
       saving a few hundred bytes on one request does not clear it. The window is 1, so
       this is the cheapest read the interface offers. */
    let before;
    try {
      const snap = await getAll(today, 1);
      before = snap.days[forDay] ?? emptyDay(forDay);
    } catch (err) {
      /* A read failure here fails CLOSED, and that is deliberate. The alternative —
         write anyway because we could not check — would mean a store blip is a path
         around the freeze, and the freeze is the mechanic. She retries. */
      console.error('[us] together could not read the day before answering:', err);
      return answer(false, 502, 'store', { date: forDay });
    }

    const stateBefore = visibleDay(before, who, today);
    if (stateBefore.revealed) {
      return answer(false, 403, 'frozen', { date: forDay });
    }
    if (stateBefore.age > LATE_ANSWER_DAYS) {
      return answer(false, 403, 'closed', { date: forDay, days: LATE_ANSWER_DAYS });
    }

    let record;
    try {
      record = await putAnswer(forDay, who, clean);
    } catch (err) {
      /* LOUD. together.ts's header: an answer she typed that silently did not save is
         the worst outcome this feature has available — she would believe I had it and
         I would never see it. The hub's script keeps her text in the textarea on this
         path. */
      console.error(`[us] together could not write ${who}'s answer for ${forDay}:`, err);
      return answer(false, 502, 'store', { date: forDay });
    }

    /* THROUGH visibleDay(), NEVER the raw record. See this file's header — echoing
       `record` back would hand the caller the other person's answer on the one code
       path where the page is not involved, and the seal would be enforced in the HTML
       and broken in the JSON. `theirs` below is absent rather than hidden whenever
       `revealed` is false. */
    const state = visibleDay(record, who, today);
    return answer(true, 200, state.revealed ? 'revealed' : 'answered', {
      date: state.date,
      revealed: state.revealed,
      theyAnswered: state.theyAnswered,
      mine: state.mine,
      /* Only ever populated when `revealed` is true, by construction — this is
         visibleDay's output and not a second decision made here. */
      theirs: state.theirs,
      editable: state.editable,
    });
  }

  /* ======================================================================
     ADD — a line on the list
     ====================================================================== */
  if (action === 'add') {
    if (text === null) return answer(false, 400, 'text-missing');

    // tidyItem, not normalizeItem, for the same reason as tidyAnswer above: the
    // normaliser truncates, so measuring its output makes the 413 unreachable.
    const clean = tidyItem(text);
    if (!clean) return answer(false, 400, 'empty');
    if (clean.length > ITEM_MAX) {
      return answer(false, 413, 'too-long', { max: ITEM_MAX, was: clean.length });
    }

    let result;
    try {
      result = await addItem(clean, who, nowMs);
    } catch (err) {
      console.error(`[us] together could not add a list item for ${who}:`, err);
      return answer(false, 502, 'store');
    }

    /* A REFUSAL IS NOT AN ERROR, and it is not a 500 either. The caps exist so that
       hitting one is a sentence with a reason in it — "tick something off first" —
       rather than the oldest thing they wrote silently disappearing to make room. 409
       Conflict is the honest status: the request was fine, the current state will not
       accept it. See the PART FOUR header in together.ts for why nothing is ever
       auto-deleted to stay under a cap. */
    if ('refused' in result) {
      return answer(false, 409, result.refused, {
        openCap: OPEN_CAP,
        totalCap: TOTAL_CAP,
      });
    }
    return answer(true, 200, 'added', { id: result.item.id, text: result.item.text });
  }

  /* ======================================================================
     TICK / REMOVE — both keyed by an item id
     ====================================================================== */

  /* Shape-checked here so a malformed id never becomes a store command argument. It
     is only a pre-filter: the store additionally requires the id to SELECT an
     existing record, which is the discipline marks.ts's isMarkId() and letters.ts's
     isLetterId() both describe — an id selects a record, it never builds a key. So
     `../../.env` is not merely rejected, it could not have addressed anything. */
  if (!isItemIdShape(id)) return answer(false, 404, 'no-such-item');

  if (action === 'tick') {
    let item;
    try {
      item = await setItemDone(id, on, who, nowMs);
    } catch (err) {
      console.error(`[us] together could not tick ${id}:`, err);
      return answer(false, 502, 'store');
    }
    // null means the id selected nothing. 404, and nothing was created — a tick must
    // never bring an item into existence.
    if (!item) return answer(false, 404, 'no-such-item');
    return answer(true, 200, item.done ? 'ticked' : 'unticked', {
      id: item.id,
      done: item.done,
      doneBy: item.doneBy,
    });
  }

  // action === 'remove'
  let removed: boolean;
  try {
    removed = await removeItem(id, who);
  } catch (err) {
    console.error(`[us] together could not remove ${id}:`, err);
    return answer(false, 502, 'store');
  }
  /* false is EITHER "no such item" OR "not yours", and they are deliberately not
     distinguished in the response. Ownership is checked against the stored `by` inside
     the store, and telling a caller "that exists but is not yours" would leak that an
     id exists — which is a small thing here, but the honest reason is simpler: from
     her side both outcomes mean "that line is not mine to take back", and one message
     is truer than two. */
  if (!removed) return answer(false, 404, 'not-removable');
  return answer(true, 200, 'removed', { id });
};

/** Anything other than POST. Explicit, so a stray GET is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, code: 'method-not-allowed' }, 405);
