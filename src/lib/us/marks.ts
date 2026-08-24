/**
 * marks.ts — the store behind the marks SHE leaves in the room.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * Until now the room was read-only. She could look at thirteen photographs and
 * the room could not tell, afterwards, that she had ever been in it. Everything
 * flowed one way: I write, she looks. For a wing built to carry a year of long
 * distance that is the wrong shape — the whole value of the reaction buttons on
 * the song is that a tap comes BACK, and the gallery had no equivalent.
 *
 * So there are three marks, and each one is a different weight of "I was here":
 *
 *   KEPT   one tap (or a hold taken past max tension — see FULL RANGE OF MOTION
 *          in StudioRoom.tsx). The lightest possible signal. No text, no
 *          decision, undoable.
 *   NOTE   her words back on a specific memory, under mine. The heaviest, and
 *          the only one that needs a keyboard.
 *   SEEN   incidental. Counted every time she actually reaches a note, so I can
 *          tell "she opened the room" from "she read the thing I wrote".
 *
 * Plus one room-level fact, VISITS, which is what lets the room say "the 7th
 * time you've been in here" instead of greeting her identically forever.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN kv.ts
 *
 * kv.ts owns songs and reactions and is being worked on in parallel. More
 * importantly the two stores have genuinely different keys, different documents
 * and different lifetimes: a song is keyed by DAY and expires from relevance in
 * one, a mark is keyed by MEMORY and is meant to outlive everything. Merging them
 * would mean one JSON object whose two halves change at completely different
 * rates, and on the R2 tier — where a write is a read-modify-write of the WHOLE
 * document — that turns every reaction tap into a chance to lose a note.
 *
 * What IS deliberately copied from kv.ts is every hard-won operational detail,
 * because those were learned the expensive way and re-deriving them here would
 * mean re-learning them: `region: 'auto'`, `retries: 1` (the library defaults to
 * TEN, with exponential backoff, which will spend a whole serverless function's
 * budget on a bucket that is down), a hard request deadline, per-segment key
 * encoding, three tiers chosen from whatever credentials exist, and a document
 * that is boring enough to read in the Cloudflare dashboard at 2am.
 *
 * The R2 object key is `data/marks.json`. kv.ts uses `data/songs.json`. They must
 * not collide: two whole-object writers on one key is not a race, it is data loss
 * on a schedule.
 *
 * ---------------------------------------------------------------------------
 * FAILURE POLICY: SPLIT, ON PURPOSE
 *
 * WRITES FAIL LOUD. A note she typed that silently did not save is the worst
 * outcome available here — she would believe she left it, I would never see it,
 * and nothing anywhere would say so. A transport error is a thrown MarkError and
 * the endpoint turns it into a 502 she can retry.
 *
 * READS FAIL SOFT, and this is the one place this file deliberately disagrees
 * with kv.ts. Marks are DECORATION on a room that must render regardless: if the
 * bucket is unreachable, showing her the gallery with no keep-badges is fine and
 * showing her an error page instead of the gallery is not. So the page-render
 * path calls the `*Safe` wrappers, which log and degrade to empty. The endpoint
 * calls the throwing ones, because a write is not decoration.
 * ---------------------------------------------------------------------------
 */

import { AwsClient } from 'aws4fetch';
import { hasKV, hasR2, kvConfig, r2Config, r2Endpoint } from './config';
import { MEMORIES } from './photos';
import { countCommands, timer } from './trace';

/** Thrown for transport problems only. A missing mark is a DEFAULT, not an error. */
export class MarkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MarkError';
  }
}

export type Tier = 'upstash' | 'r2' | 'memory';

/**
 * 2500ms on every network call.
 *
 * Longer than kv.ts's 2000 for one specific reason: a mark write happens while
 * she is standing in the room waiting for a button to confirm, and a spurious
 * "could not save" on a slow connection is worse here than the extra half second
 * — she would retype the note. Still a HARD deadline, because this runs inside a
 * serverless function that is itself on a budget and a hung fetch with no signal
 * burns the whole invocation before failing.
 *
 * ALWAYS AS AbortSignal.timeout(), never as an AbortController cleared in a
 * `finally`. It was the latter, and an adversarial review was right that this made
 * the deadline a lie: `fetch` resolves as soon as the response HEADERS arrive, so
 * clearing the timer before reading the body leaves the DOWNLOAD unbounded, and a
 * server that answers 200 and then stalls hangs the whole invocation — exactly the
 * thing this constant exists to prevent. A timeout signal stays armed through the
 * body read and aborts it.
 *
 * The leak that motivated the controller was imaginary: AbortSignal.timeout uses an
 * UNREF'D timer, so it never holds the event loop open. kv.ts had this right and
 * diverging from it bought nothing.
 */
const TIMEOUT_MS = 2500;

/* ============================================================================
   THE RECORDS
   ========================================================================= */

export interface Mark {
  /** The memory this is about. Always a real id from the manifest. */
  id: string;
  /** She kept it. The lightest signal in the room. */
  kept: boolean;
  /** Her words back, or ''. Trimmed and capped — see MARK_NOTE_MAX. */
  note: string;
  /** How many times she has actually reached this memory's note. */
  seen: number;
  /** Epoch millis of the last change. For "she was in here on..." and debugging. */
  at: number;
}

export interface Visits {
  /** How many distinct visits have been counted. See countVisit's debounce. */
  count: number;
  /** Epoch millis of the first counted visit. 0 before there is one. */
  first: number;
  /**
   * Epoch millis of the visit she is IN. Not "the last time she was here".
   *
   * Precise wording matters because the debounce below means this value does not
   * move while she is browsing: countVisit stamps it once when a visit begins and
   * then returns it unchanged for the next twenty minutes. So after countVisit
   * has run, `last` is always the start of the CURRENT visit.
   */
  last: number;
  /**
   * Epoch millis of the visit BEFORE the current one. 0 when there isn't one.
   *
   * ---------------------------------------------------------------------------
   * THIS FIELD IS THE WHOLE REASON "NEW SINCE YOUR LAST VISIT" CAN WORK
   *
   * The hub wants one number: the instant her previous visit began, so it can ask
   * the song store "what has been written since then". The obvious way to get it
   * is to snapshot `last` in the page before calling countVisit, and that way is
   * WRONG in a way that only shows up on the second page view:
   *
   *   render 1  stored last = Monday. Page snapshots Monday, countVisit writes
   *             last = now. Baseline is Monday. Correct.
   *   render 2  she refreshes four minutes later. Page snapshots `last`, which is
   *             now FOUR MINUTES AGO, because render 1 wrote it. countVisit is
   *             inside the debounce so it changes nothing and reports nothing.
   *             Baseline is four minutes ago. Every marker vanishes, and she has
   *             not clicked a thing.
   *
   * There is no in-page fix for that: once `last` has been overwritten, Monday is
   * simply gone, and a snapshot taken during render 2 cannot recover a value that
   * is no longer stored anywhere. The snapshot has to be DURABLE, which makes it a
   * field, not a local.
   *
   * With it, the rule collapses to one line with no branching at all — after
   * countVisit has run, the baseline is `prev`, whether this render counted a new
   * visit or was swallowed by the debounce. That is exactly the invariant `last`
   * documents above: `last` is the current visit, `prev` is the one before it.
   *
   * 0 IS "NO BASELINE", AND CALLERS MUST TREAT IT AS SUPPRESS-EVERYTHING RATHER
   * THAN AS THE EPOCH. It is 0 on her very first visit (nothing preceded it) and
   * on the first render after this field shipped, because records written before
   * then have no `prev` and parseVisits defaults it. Reading 0 as a timestamp
   * means "since 1970", i.e. everything ever written is new, i.e. the loudest
   * possible false alarm on exactly the two occasions we know least. It self-heals
   * on her next genuine visit, when countVisit writes a real value.
   */
  prev: number;
}

/**
 * How long her note may be.
 *
 * This is the only thing standing between the store and an unbounded write: on the
 * R2 tier the whole document is one object, so thirteen unbounded notes is the
 * entire budget. isMarkId() bounds the number of keys; this bounds their size.
 *
 * IT IS ENFORCED IN THREE PLACES AND ONLY TWO OF THEM CAN IMPORT IT.
 *   - normalizeNote(), here. The real enforcement.
 *   - room.astro's `maxlength={MARK_NOTE_MAX}`, which imports this constant.
 *   - StudioRoom.tsx's `NOTE_MAX`, which CANNOT: it is a client island, and this
 *     module pulls in aws4fetch and reads process.env through config.ts.
 *
 * So the third one is a restated literal that will desync silently. An earlier
 * comment here claimed "the only way those three agree forever is if they all read
 * this constant", which was simply false of the third. What actually keeps them
 * honest is an assertion that greps both files and compares the two numbers; the
 * note on StudioRoom.tsx's NOTE_MAX says the same thing from the other side.
 */
export const MARK_NOTE_MAX = 280;

/** The default for a memory she has not touched. Never null, so callers never branch. */
export function emptyMark(id: string): Mark {
  return { id, kept: false, note: '', seen: 0, at: 0 };
}

export const NO_VISITS: Visits = { count: 0, first: 0, last: 0, prev: 0 };

/* ============================================================================
   VALIDATION

   Everything a request can touch goes through here, and the shape of the check
   is copied from photos.ts's findMemory() on purpose: an id SELECTS a record, it
   never BUILDS a key. `../../.env` cannot select anything, so it is simply not a
   mark id.
   ========================================================================= */

const KNOWN_IDS = new Set(MEMORIES.map((m) => m.id));

/**
 * Is this the id of a memory that actually exists?
 *
 * Checked against the manifest rather than against a regex, because the failure
 * this prevents is not traversal (there is no path here) — it is UNBOUNDED KEYS.
 * Without it, a caller could POST ten thousand distinct ids and grow the R2
 * document until the read times out and her room stops rendering marks at all.
 * The manifest is thirteen entries, so the store has a hard ceiling by
 * construction.
 */
export function isMarkId(value: unknown): value is string {
  return typeof value === 'string' && KNOWN_IDS.has(value);
}

/**
 * Her note, cleaned up enough to store and no further.
 *
 * Deliberately NOT sanitized for HTML. Nothing in this repo ever interpolates a
 * mark into markup — Astro escapes by default and the island writes it through
 * `textContent` — so escaping here would mean storing `&amp;` and rendering
 * `&amp;` forever, which is the classic double-escape bug. The right place to
 * escape is the moment of rendering, and that place already does it.
 *
 * What IS done: normalise the newlines a phone keyboard produces (CRLF and CR
 * both become LF, so the stored string is the same whatever typed it), collapse
 * a wall of blank lines, cap the length, and trim. Control characters other than
 * newline and tab are dropped because they are invisible in every editor and
 * would make a stored note impossible to debug by looking at it.
 */
/**
 * Everything normalizeNote does EXCEPT the length cap.
 *
 * Split out because the endpoint needs to answer a different question from the
 * store. The store’s job is “make this fit”; the endpoint’s job is “was this too
 * long to accept” — and those two cannot share one function, which is a bug I
 * shipped and the test harness caught. After normalizeNote learned to truncate,
 * `normalizeNote(note).length > MARK_NOTE_MAX` became permanently false, so the 413
 * was unreachable and a 400-character note was silently cut to 280 instead. That is
 * the exact outcome the 413 exists to prevent: she sends four hundred characters,
 * sees three hundred, and has no idea which end went missing.
 *
 * So: tidyNote answers “how long is what you actually mean”, normalizeNote answers
 * “what will be stored”.
 */
export function tidyNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    // CRLF and CR both fold to LF, so a note is the same string whatever typed it.
    // This one is load-bearing for the length check: HTML form submission converts
    // every LF to CRLF, so measuring before this runs counts a phone’s line break
    // as two characters against a textarea maxlength that counted it as one.
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- deliberate: strip invisibles
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** tidyNote, then capped at MARK_NOTE_MAX. What actually gets stored. */
export function normalizeNote(raw: unknown): string {
  const cleaned = tidyNote(raw);
  if (cleaned.length <= MARK_NOTE_MAX) return cleaned;
  const cut = cleaned.slice(0, MARK_NOTE_MAX);
  /* slice() counts UTF-16 CODE UNITS, and an emoji is two of them — so cutting at
     exactly MARK_NOTE_MAX can land between a surrogate pair and store a LONE HIGH
     SURROGATE, which every renderer draws as U+FFFD. Dropping the orphan costs one
     character from a note that was already being truncated, against a visible
     replacement glyph at the end of it. */
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Coerce anything read back out of a store into a valid Mark. Never throws. */
function parseMark(id: string, raw: unknown): Mark {
  const base = emptyMark(id);
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // A hand-edit in the Upstash console at 1am must degrade to "no mark", not
      // throw inside a page render. Same reasoning as kv.ts's parseTrack.
      console.error(`[us] a stored mark for ${id} is not JSON — ignoring it.`);
      return base;
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return base;

  return {
    id,
    // `'1'` as well as `true`, because the Upstash tier stores hash fields as
    // strings and a bare `Boolean('0')` is true.
    kept: obj.kept === true || obj.kept === '1' || obj.kept === 1,
    note: normalizeNote(obj.note),
    seen: count(obj.seen),
    at: count(obj.at),
  };
}

/**
 * A non-negative integer, or 0. Rejects Infinity and NaN.
 *
 * `Math.max(0, Math.floor(Number(v)) || 0)` — which is what this replaced — passes
 * INFINITY straight through: `JSON.parse('{"seen":1e999}')` yields Infinity,
 * Math.floor(Infinity) is Infinity, and `Infinity || 0` is Infinity. It then
 * survives `seen += 1`, and JSON.stringify writes it as `null`, which reads back as
 * 0. So a hand-edited value silently resets the counter on the next write — in
 * exactly the hand-edit-at-1am scenario the parser exists to harden against.
 */
function count(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseVisits(raw: unknown): Visits {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ...NO_VISITS };
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return { ...NO_VISITS };
  return {
    count: count(obj.count),
    first: count(obj.first),
    last: count(obj.last),
    // Absent on every record written before `prev` existed, and count() turns that
    // into 0 — which the field's own comment defines as "no baseline, suppress
    // everything" rather than as the epoch. That is the safe direction: a returning
    // visitor sees no markers for one render instead of being told the entire
    // archive is new.
    prev: count(obj.prev),
  };
}

/* ============================================================================
   THE VISIT DEBOUNCE

   A "visit" has to survive a refresh, an accidental back-forward, and iOS
   restoring the tab in the morning — otherwise "the 7th time you've been in
   here" is really "the 7th time the page rendered", which is a different and
   much less interesting sentence.

   Twenty minutes: long enough that reloading to look at a photo again is the
   same visit, short enough that coming back after dinner is a new one. The
   debounce lives in the STORE rather than in the page, so every future caller
   inherits it and cannot accidentally double-count.

   ONE CONSEQUENCE WORTH STATING, because the hub's "new since your last visit"
   markers ride on it: the window is measured from the START of a visit, not from
   her last click. So a session that runs past twenty minutes ends with a page view
   that opens a NEW visit, `prev` advances to this session's own start, and the
   markers go quiet mid-session even though she never left.

   That is accepted, not overlooked. The alternative — sliding the window forward
   on every page view — would mean an afternoon of browsing never ends, so a genuine
   return after dinner would not count as a visit and the markers would then be
   stale in the other direction. Twenty minutes of markers is plenty of invitation,
   and going quiet after twenty minutes IN the room is a defensible thing for them
   to do.
   ========================================================================= */
export const VISIT_DEBOUNCE_MS = 20 * 60 * 1000;

/**
 * "the 7th time you've been in here", from a count.
 *
 * Presentation, but it lives here beside the number it describes because the
 * edge cases are about the DATA and not about the styling: 0 must produce
 * nothing at all rather than "the 0th time", 1 has to read like a welcome and
 * not like a statistic, and 11/12/13 are the ordinals every hand-rolled `n + th`
 * gets wrong ("11st"). Returns '' when there is nothing worth saying, so the
 * caller's test is `if (line)` and never a count comparison.
 */
export function visitLine(count: number): string {
  const n = Math.floor(count);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n === 1) return 'first time in here.';
  if (n === 2) return "second time you've been in here.";
  const mod100 = n % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? 'th'
      : n % 10 === 1
        ? 'st'
        : n % 10 === 2
          ? 'nd'
          : n % 10 === 3
            ? 'rd'
            : 'th';
  return `the ${n}${suffix} time you've been in here.`;
}

/* ============================================================================
   THE INTERFACE

   Six operations. Each one has to be implemented three times, so a seventh has
   to justify itself three times over — the same bar kv.ts set.

   Every mutator returns the RESULTING mark rather than void, so the endpoint can
   answer with real state instead of the client trusting its own optimistic guess.

   BE PRECISE ABOUT WHAT "REAL STATE" MEANS PER TIER, because an earlier version of
   this comment claimed a read-back that two of the three tiers did not perform:

     upstash  a genuine re-read (HGETALL) after the write, because HSET and HINCRBY
              return nothing useful.
     r2       the value from the document whose CONDITIONAL PUT succeeded. Not a
              re-read, and stronger than one would be: a re-read could observe a
              third party's later write and report a value that was never ours,
              whereas an If-Match PUT that returned 200 proves these exact bytes are
              what is stored.
     memory   the object itself. There is nothing between it and the caller.
   ========================================================================= */

export interface Store {
  readonly tier: Tier;
  getMarks(): Promise<Record<string, Mark>>;
  setKept(id: string, on: boolean): Promise<Mark>;
  setNote(id: string, note: string): Promise<Mark>;
  bumpSeen(id: string): Promise<Mark>;
  getVisits(): Promise<Visits>;
  /** Count a visit if the debounce allows it. Returns the state either way. */
  countVisit(nowMs: number): Promise<Visits>;
}

/** Every known id present, so a caller never checks for undefined. */
function fullMap(partial: Record<string, Mark>): Record<string, Mark> {
  const out: Record<string, Mark> = {};
  for (const m of MEMORIES) out[m.id] = partial[m.id] ?? emptyMark(m.id);
  return out;
}

/* ============================================================================
   TIER 1 — UPSTASH REDIS over REST

   One hash PER MEMORY rather than one hash for all of them, which looks like the
   wasteful choice and is not. With a field-per-memory hash, flipping `kept` means
   reading the memory's JSON, editing it and writing it back — a read-modify-write,
   in the one tier that does not need one. A hash per memory makes every mutation
   a single atomic command: HSET for kept, HSET for the note, HINCRBY for seen.
   Reading all of them is thirteen HGETALLs in ONE pipelined round trip, which is
   the same wire cost as one HGETALL and buys real atomicity.
   ========================================================================= */

/** `us:` prefix matches ratelimit.ts's `us:rl:` and kv.ts's `us:song:`. */
const MARK_KEY = (id: string) => `us:mark:${id}`;
const VISITS_KEY = 'us:visits';

type Command = (string | number)[];

/** One HTTP round trip for N commands. Verbatim shape from kv.ts's redis(). */
async function redis(url: string, token: string, cmds: Command[]): Promise<unknown[]> {
  if (cmds.length === 0) return [];

  const t = timer();
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map((c) => c.map(String))),
      /* AbortSignal.timeout, matching kv.ts, and NOT an AbortController cleared in
         a `finally` — which is what this was. `fetch` resolves on response HEADERS,
         so clearing the timer before `res.json()` leaves the body download with no
         deadline at all: a server that answers 200 and then stalls would hang the
         invocation, which is the one failure TIMEOUT_MS exists to prevent. A
         timeout signal stays armed through the body read. */
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // An abort is indistinguishable from a network failure to every caller, so
    // both become one error type.
    throw new MarkError('upstash unreachable', { cause: err });
  }

  /* THE COMMAND COUNT. getMarks() is one HGETALL per memory in the manifest, so the
     gallery costs as many commands as there are photographs on it — a number that grows
     silently every time one is added. See countCommands in trace.ts. */
  countCommands('marks', cmds.length, res.status, t.total());

  if (!res.ok) throw new MarkError(`upstash HTTP ${res.status}`);

  let parsed: Array<{ result?: unknown; error?: string }>;
  try {
    parsed = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  } catch (err) {
    // Reached when the timeout fires mid-body, or when the response is not JSON.
    throw new MarkError('upstash response body did not arrive or was not JSON', { cause: err });
  }
  if (!Array.isArray(parsed) || parsed.length !== cmds.length) {
    throw new MarkError('upstash returned a malformed pipeline response');
  }

  return parsed.map((entry, i) => {
    // A per-command error is a bug in this file, not a runtime condition, so it
    // is fatal. Only the command NAME is logged — the arguments are her notes.
    if (entry?.error) throw new MarkError(`upstash ${String(cmds[i][0])} failed: ${entry.error}`);
    return entry?.result ?? null;
  });
}

/**
 * Upstash returns a hash as a FLAT array `[field, value, field, value]`, not as
 * an object. Folding it here rather than at each call site is what stops one of
 * the three getters quietly reading `raw.kept` off an array and always seeing
 * undefined.
 */
function foldHash(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
  } else if (raw && typeof raw === 'object') {
    // Some Upstash responses are already objects. Accept both rather than
    // depending on which.
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  }
  return out;
}

function upstashStore(url: string, token: string): Store {
  const run = (cmds: Command[]) => redis(url, token, cmds);
  const ids = MEMORIES.map((m) => m.id);

  async function readOne(id: string): Promise<Mark> {
    const [raw] = await run([['HGETALL', MARK_KEY(id)]]);
    return parseMark(id, foldHash(raw));
  }

  return {
    tier: 'upstash',

    async getMarks() {
      const results = await run(ids.map((id) => ['HGETALL', MARK_KEY(id)]));
      const out: Record<string, Mark> = {};
      ids.forEach((id, i) => {
        out[id] = parseMark(id, foldHash(results[i]));
      });
      return fullMap(out);
    },

    async setKept(id, on) {
      // Two fields, one command, no read. This is the atomicity a hash-per-memory
      // buys: I cannot clobber a note she is typing by toggling a keep.
      await run([['HSET', MARK_KEY(id), 'kept', on ? '1' : '0', 'at', String(Date.now())]]);
      return readOne(id);
    },

    async setNote(id, note) {
      await run([['HSET', MARK_KEY(id), 'note', note, 'at', String(Date.now())]]);
      return readOne(id);
    },

    async bumpSeen(id) {
      // A real atomic increment, which the other two tiers cannot offer. Worth
      // having in the tier that can.
      await run([['HINCRBY', MARK_KEY(id), 'seen', 1], ['HSET', MARK_KEY(id), 'at', String(Date.now())]]);
      return readOne(id);
    },

    async getVisits() {
      const [raw] = await run([['HGETALL', VISITS_KEY]]);
      return parseVisits(foldHash(raw));
    },

    async countVisit(nowMs) {
      const [raw] = await run([['HGETALL', VISITS_KEY]]);
      const before = parseVisits(foldHash(raw));
      if (before.count > 0 && nowMs - before.last < VISIT_DEBOUNCE_MS) return before;
      const first = before.first > 0 ? before.first : nowMs;
      /* HINCRBY, so two tabs cannot land on the same NUMBER. But be honest about
         what that does and does not buy: the DEBOUNCE above is a read-then-decide
         and is not a lock, so two tabs opening in the same instant both pass the
         window test and both increment — the room then says "the 8th time" when it
         was the 7th. An earlier comment here claimed HINCRBY prevented that; it
         prevents a different, harmless thing. A cosmetic off-by-one in a decorative
         sentence is not worth a lock on the path that renders her room. */
      const [counted] = await run([
        ['HINCRBY', VISITS_KEY, 'count', 1],
        /* `prev` is written from `before.last` IN THE SAME COMMAND that overwrites
           `last`, which is the point: the value being replaced is the one the hub
           needs, and after this HSET it exists nowhere else. On her first ever visit
           before.last is 0, which is correctly "there was no previous visit". */
        ['HSET', VISITS_KEY, 'last', String(nowMs), 'first', String(first), 'prev', String(before.last)],
      ]);
      return {
        count: Math.max(1, Number(counted) || before.count + 1),
        first,
        last: nowMs,
        prev: before.last,
      };
    },
  };
}

/* ============================================================================
   TIER 2 — CLOUDFLARE R2, one JSON object

   Read the whole document, change one field, write the whole document back.
   Everything about this tier follows from that sentence.

   IT IS STILL NOT A TRANSACTION, and it must not be described as one. But it is
   also no longer the silent-loss race kv.ts documents for its own songs document,
   and the difference is one header: every PUT here carries `If-Match: <etag>` from
   the GET it was built on, so a write that lost a race comes back 412 instead of
   quietly clobbering. mutateDoc re-reads and retries once; a second conflict is a
   thrown MarkError and a 502 she can retry.

   THE REASON THAT WAS WORTH BUILDING, rather than accepting the race the way kv.ts
   does: songs have exactly one writer, me, roughly once a morning. Marks have a
   writer that fires TWICE ON ONE GESTURE — reveal a note and the island posts
   `seen`, keep holding and OVERHOLD_SEC later it posts `keep` — so two overlapping
   read-modify-writes of this document are the NORMAL case here, not the unlucky
   one. An adversarial review walked the exact sequence; see writeDoc.

   The document is deliberately boring and self-describing so that opening it in
   the Cloudflare dashboard at 2am is a useful thing to do, and NOTHING in it is
   ever discarded — see MarksDoc.orphans and MarksDoc.extra for the two silent
   data-loss bugs that rule exists to prevent.
   ========================================================================= */

/** Must not be `data/songs.json`. See the header. */
const R2_DOC_KEY = 'data/marks.json';

interface MarksDoc {
  /** Schema version. Present from day one so a future migration has a hinge. */
  v: 1;
  /** memory id -> mark, for ids that are in the CURRENT manifest. */
  marks: Record<string, Mark>;
  visits: Visits;
  /**
   * Marks whose id is NOT in the current manifest, carried through byte-for-byte.
   *
   * An adversarial review caught the bug this exists to prevent, and it was the
   * worst kind: silent, permanent, and triggered by a page view rather than by a
   * write. The first version pruned unknown ids on READ and returned the pruned
   * document as valid — after which every writer persisted the pruned version.
   * countVisit() writes on any page view past the debounce, so the sequence was:
   * rename one memory in photos.ts (the likeliest future edit to that file — the
   * thirteenth photo getting a real id instead of `still-one-more`), deploy, let
   * her open the room once, and her note on that memory was gone from the bucket
   * with no error and no log line.
   *
   * kv.ts deliberately passes its `songs` map through wholesale for the same
   * reason. Pruning was mine, and it was wrong. Presentation-level filtering
   * belongs at the OUTPUT boundary, which fullMap() already is.
   */
  orphans: Record<string, unknown>;
  /**
   * Any other top-level field, carried through and never interpreted.
   *
   * Same class of bug, one level up: a document rebuilt from only the fields THIS
   * deploy knows about means an older instance silently erases whatever a newer
   * schema added. Two versions of a serverless function overlap for minutes after
   * every deploy, so this is not hypothetical.
   */
  extra: Record<string, unknown>;
}

const EMPTY_DOC: MarksDoc = { v: 1, marks: {}, visits: { ...NO_VISITS }, orphans: {}, extra: {} };

/**
 * Refuse to read a document larger than this.
 *
 * The real ceiling is arithmetic: thirteen manifest ids times a MARK_NOTE_MAX note
 * plus a little bookkeeping is a few kilobytes. 256KB is two orders of magnitude
 * past that, so anything bigger is not a big document, it is the wrong object —
 * and reading it would spend the whole invocation on bytes we would then throw
 * away. Checked against Content-Length BEFORE the body is read, because the point
 * is to not download it.
 */
const MAX_DOC_BYTES = 256 * 1024;

/**
 * A client per process, not per call.
 *
 * `retries: 1` is a deliberate override of aws4fetch's default of 10. Those
 * retries use exponential backoff from 50ms — 50+100+200+...+25600, about 51
 * seconds — and would happily spend this whole serverless invocation on a bucket
 * that is down. One retry absorbs a blip; ten absorb an outage by hanging.
 *
 * `region: 'auto'` because R2 has no regions but SigV4 requires one in the
 * credential scope, and 'auto' is the value Cloudflare documents for its S3 API.
 * Passed explicitly rather than left to aws4fetch's hostname sniff, for the
 * reason photos.ts spells out: relying on a heuristic for the two values that go
 * into the credential scope is a silent 403 waiting for the day it changes.
 */
let r2Client: AwsClient | null = null;
/**
 * Fingerprint of the credential the cached client was built with.
 *
 * BOTH halves, not just the key id. A secret-only rotation — same
 * R2_ACCESS_KEY_ID, new R2_SECRET_ACCESS_KEY — is a perfectly ordinary thing to
 * do, and keying only on the id would leave a warm instance signing every request
 * with the dead secret. The symptom is a 403 surfaced as `502 store` on one
 * instance and nowhere else, which is close to undiagnosable.
 */
let r2ClientFingerprint: string | null = null;

function r2(): { client: AwsClient; base: string } {
  const { accessKeyId, secretAccessKey, bucket } = r2Config();
  const endpoint = r2Endpoint();
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) {
    throw new MarkError('r2 selected but not fully configured');
  }
  // NUL as the separator so `ab` + `c` and `a` + `bc` cannot collide. Written as
  // an ESCAPE, not a literal: a raw control byte is invisible in a diff and one
  // editor mangling it would silently change the fingerprint. Same rule as answers.mjs.
  const fingerprint = `${accessKeyId}\u0000${secretAccessKey}`;
  if (!r2Client || r2ClientFingerprint !== fingerprint) {
    r2Client = new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: 's3',
      region: 'auto',
      retries: 1,
    });
    r2ClientFingerprint = fingerprint;
  }
  // Path-style addressing: R2's S3 endpoint is per-account and the bucket is the
  // first path segment. Virtual-host style would need a different hostname.
  return { client: r2Client, base: `${endpoint}/${encodeURIComponent(bucket)}` };
}

/**
 * Key -> the path to actually put in the URL, encoded PER SEGMENT so `/` survives
 * as a separator.
 *
 * `data/marks.json` contains nothing that needs escaping today, so this looks
 * like ceremony. It is not: photos.ts documents an entire class of
 * SignatureDoesNotMatch that comes from aws4fetch canonicalising with
 * encodeURIComponent while sending the raw character, and the day somebody
 * renames this key to something with an `@` or a space in it, the failure is a
 * 403 that looks exactly like a credentials problem. Encoding up front means that
 * day never comes.
 */
function encodeKeyForUrl(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * Shape-check a document read from the bucket. Returns null when unusable.
 *
 * NOTHING IS DISCARDED. Fields this deploy understands are normalised; everything
 * else — unknown mark ids, unknown top-level keys — is carried into `orphans` and
 * `extra` and written back verbatim. See the comments on those two fields for the
 * silent-data-loss bug that taught this.
 */
function parseDoc(text: string): MarksDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const marks = obj.marks && typeof obj.marks === 'object' ? (obj.marks as Record<string, unknown>) : null;
  if (!marks) return null;

  const out: MarksDoc = {
    v: 1,
    marks: {},
    visits: parseVisits(obj.visits),
    orphans: {},
    extra: {},
  };
  for (const [id, value] of Object.entries(marks)) {
    if (isMarkId(id)) out.marks[id] = parseMark(id, value);
    else out.orphans[id] = value;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key !== 'v' && key !== 'marks' && key !== 'visits') out.extra[key] = value;
  }
  if (Object.keys(out.orphans).length > 0) {
    // Loud, once per read, because the ONLY way an orphan exists is that an id
    // left photos.ts — so this is telling Sam that a memory he renamed still has
    // her marks sitting under its old name, waiting to be re-pointed by hand.
    console.warn(
      `[us] ${R2_DOC_KEY} holds marks for ${Object.keys(out.orphans).length} id(s) that are ` +
        `no longer in the manifest: ${Object.keys(out.orphans).join(', ')}. They are being ` +
        'preserved, not deleted. Re-point them in photos.ts or remove them by hand.',
    );
  }
  return out;
}

/** The document as it goes back on the wire. Orphans and extras restored. */
function serialiseDoc(doc: MarksDoc): string {
  return JSON.stringify({
    ...doc.extra,
    v: 1,
    marks: { ...doc.orphans, ...doc.marks },
    visits: doc.visits,
  });
}

/** Read the document, plus the ETag needed to write it back conditionally. */
async function readDoc(): Promise<{ doc: MarksDoc; corrupt: boolean; etag: string | null }> {
  const { client, base } = r2();
  let res: Response;
  try {
    res = await client.fetch(`${base}/${encodeKeyForUrl(R2_DOC_KEY)}`, {
      method: 'GET',
      /* AbortSignal.timeout, NOT an AbortController cleared in a `finally`.
         That is what this was, and an adversarial review was right that it made the
         deadline a lie: `fetch` resolves as soon as the response HEADERS arrive, so
         clearing the timer before `res.text()` leaves the BODY download with no
         deadline at all — a bucket that answers 200 and then stalls would hang the
         whole invocation, which is precisely the failure TIMEOUT_MS exists to
         prevent. A timeout signal stays armed through the body read and aborts it.
         The leak that motivated the controller was imaginary: AbortSignal.timeout
         uses an unref'd timer, so it never holds the event loop open. kv.ts had
         this right and I diverged from it for no reason. */
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new MarkError('r2 unreachable', { cause: err });
  }

  // 404 is the normal first-run state, not an error: she has not marked anything.
  // etag null then means "there must be no object", which writeDoc turns into
  // If-None-Match: * so two cold instances cannot both create it.
  if (res.status === 404) return { doc: structuredClone(EMPTY_DOC), corrupt: false, etag: null };
  if (!res.ok) throw new MarkError(`r2 GET HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOC_BYTES) {
    // Not read, not parsed, and deliberately NOT treated as corrupt-and-empty:
    // that path is a read-degrades-to-empty, and degrading to empty for an object
    // we never even looked at would let a write replace it with a small one.
    throw new MarkError(`r2 GET returned ${declared} bytes for ${R2_DOC_KEY}; refusing to read it`);
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // Reached when the timeout signal fires mid-body, which is the whole point of
    // using a signal that outlives the header exchange.
    throw new MarkError('r2 response body did not arrive', { cause: err });
  }

  /* STRIP THE WEAK-ETAG PREFIX, or every conditional write fails forever.
     R2 returns this document's validator as a WEAK ETag — `W/"8f5f9145..."`.
     RFC 7232 §3.1 says If-Match uses the strong comparison function, and a weak
     validator never matches under it, so passing R2's header through verbatim
     made every PUT a guaranteed 412. mutateDoc then burned its one retry, hit a
     second 412 and threw, and the endpoint answered 502 — so `keep`, `note` and
     `seen` were 100% broken against the real bucket while every unit test passed.

     Why the tests missed it: the R2 tier was verified against a stubbed S3 that
     issued STRONG ETags. Weakness is not something you would think to stub, and
     a fresh small object in R2 really does come back strong, which is why a
     hand probe of If-Match also succeeds. Only this document, at this size, is
     weak — so nothing short of writing to the live bucket would have shown it.

     Stripping `W/` is safe HERE specifically because R2's validator is derived
     from the object's content, so the remaining opaque value still changes
     whenever the bytes change — which is the only property optimistic
     concurrency needs. It is not a general-purpose weak-to-strong promotion. */
  const rawEtag = res.headers.get('etag');
  const etag = rawEtag ? rawEtag.replace(/^W\//, '') : null;
  const parsed = parseDoc(text);
  if (!parsed) {
    // Reads degrade to empty so her room still renders. Writes do NOT (below):
    // overwriting an object we could not understand is how a bad deploy turns
    // into a deleted year of her notes.
    console.error(`[us] ${R2_DOC_KEY} exists but is not a marks document — reading as empty.`);
    return { doc: structuredClone(EMPTY_DOC), corrupt: true, etag };
  }
  return { doc: parsed, corrupt: false, etag };
}

/**
 * Write the document back, but ONLY if it has not changed since we read it.
 *
 * This is the difference between "the race is theoretical" and "the race cannot
 * silently lose a write", and it turned out to matter far more than I first
 * assumed. The losing sequence is not adversarial and needs no second device — it
 * is the room's own primary gesture:
 *
 *   1. She holds a panel. At max tension the note is revealed, and the island
 *      fires an unawaited `seen` write. GET, then PUT.
 *   2. OVERHOLD_SEC later, still on the same hold, FULL RANGE OF MOTION fires a
 *      `keep` write. GET (same document), PUT (document + kept).
 *   3. Step 1's PUT lands last, from its older snapshot. The keep is gone, and the
 *      endpoint has already answered `ok: true`.
 *
 * Swap `note` for `keep` in step 2 — she reads the note, then writes back, which
 * is the designed flow — and her words are the thing that disappears while the
 * room says "saved." That is the exact outcome this file's header calls "the worst
 * outcome available here", so leaving it as a documented race was not good enough.
 *
 * If-Match makes a lost race a 412 instead. mutateDoc retries once from a fresh
 * read; a second 412 throws, which the endpoint turns into a 502 she can retry.
 * The client also serialises its own writes now, so in practice the 412 path is a
 * backstop for two devices rather than for one room.
 *
 * If-None-Match: * on first creation, so two cold instances racing to create the
 * object cannot both "succeed" with one of them silently overwritten.
 */
async function writeDoc(doc: MarksDoc, etag: string | null): Promise<{ ok: true } | { conflict: true }> {
  const { client, base } = r2();
  let res: Response;
  try {
    res = await client.fetch(`${base}/${encodeKeyForUrl(R2_DOC_KEY)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
      },
      body: serialiseDoc(doc),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new MarkError('r2 unreachable', { cause: err });
  }
  // 412 Precondition Failed (If-Match lost) and 409 (some S3 implementations
  // answer a failed If-None-Match this way) are both "somebody else got there".
  if (res.status === 412 || res.status === 409) return { conflict: true };
  if (!res.ok) throw new MarkError(`r2 PUT HTTP ${res.status}`);
  return { ok: true };
}

/**
 * Read, apply, write conditionally, and retry ONCE on a conflict.
 *
 * One retry, not a loop: with two humans a conflict is already surprising, and an
 * unbounded retry against a document somebody is writing in a tight loop is how a
 * serverless function times out instead of failing. A second conflict is a thrown
 * MarkError, which the endpoint answers as 502 — she taps again, and the whole
 * thing is idempotent by construction so tapping again is safe.
 *
 * NOTE ON WHAT THE RETURNED MARK MEANS. It is the value from the document whose
 * conditional PUT SUCCEEDED, so it is the value that is now durably stored — not
 * an optimistic guess, and stronger than a read-back would be (a read-back could
 * observe a third party's later write and report something that was never ours).
 */
async function mutateDoc<T>(apply: (doc: MarksDoc) => T): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential by nature: attempt 2
    // must read whatever attempt 1 lost to.
    const { doc, corrupt, etag } = await readDoc();
    if (corrupt) {
      throw new MarkError(
        `refusing to overwrite ${R2_DOC_KEY}: it exists but is not a valid marks document`,
      );
    }
    const result = apply(doc);
    // eslint-disable-next-line no-await-in-loop -- same
    const wrote = await writeDoc(doc, etag);
    if ('ok' in wrote) return result;
    console.warn(`[us] ${R2_DOC_KEY} changed under a write; re-reading and trying once more.`);
  }
  throw new MarkError(
    `${R2_DOC_KEY} is being written concurrently; gave up after two attempts rather than ` +
      'overwriting somebody else\'s change',
  );
}

function r2Store(): Store {
  /** The entry to mutate, created on demand. */
  const entry = (doc: MarksDoc, id: string): Mark => (doc.marks[id] ??= emptyMark(id));

  return {
    tier: 'r2',

    async getMarks() {
      const { doc } = await readDoc();
      return fullMap(doc.marks);
    },

    async setKept(id, on) {
      return mutateDoc((doc) => {
        const m = entry(doc, id);
        m.kept = on;
        m.at = Date.now();
        return { ...m };
      });
    },

    async setNote(id, note) {
      return mutateDoc((doc) => {
        const m = entry(doc, id);
        m.note = note;
        m.at = Date.now();
        return { ...m };
      });
    },

    async bumpSeen(id) {
      return mutateDoc((doc) => {
        const m = entry(doc, id);
        m.seen += 1;
        m.at = Date.now();
        return { ...m };
      });
    },

    async getVisits() {
      const { doc } = await readDoc();
      return doc.visits;
    },

    async countVisit(nowMs) {
      /* Read first WITHOUT a write, so the overwhelmingly common case — a refresh
         inside the debounce — costs one GET and no PUT at all. Going through
         mutateDoc would PUT the document back unchanged on every single page view,
         and this runs on every page view.

         The debounce here is BEST-EFFORT and is not a lock: two tabs opening at the
         same instant both read the old `last`, both pass the window test, and both
         increment. The consequence is that the room occasionally says "the 8th time"
         when it was the 7th, which is a cosmetic error in a decorative sentence.
         (An earlier comment claimed HINCRBY on the Upstash tier prevented this. It
         does not — it prevents two writers landing on the same NUMBER, which was
         never the failure mode.) Serialising this properly would mean a lock on the
         path that renders her room, which is a much worse trade. */
      const { doc, corrupt, etag } = await readDoc();
      if (corrupt) return { ...NO_VISITS };
      if (doc.visits.count > 0 && nowMs - doc.visits.last < VISIT_DEBOUNCE_MS) {
        return doc.visits;
      }
      /* Snapshotted BEFORE the mutation, and that is not tidiness — it is the
         difference between reporting what was stored and reporting what was lost.
         `doc.visits = next` replaces the object, so returning `doc.visits` on the
         conflict path would return `next`: the very count whose write had just
         failed. Caught by the test harness, which asserted "a conflicted tick is
         dropped" and got the incremented number back. */
      const unchanged = doc.visits;
      const next: Visits = {
        count: unchanged.count + 1,
        first: unchanged.first > 0 ? unchanged.first : nowMs,
        last: nowMs,
        // The value `last` is about to lose, kept because the hub's "new since your
        // last visit" baseline is exactly this number and nothing else stores it.
        prev: unchanged.last,
      };
      doc.visits = next;
      /* A conflict here is IGNORED rather than retried or thrown. The other writer
         was either another tab counting the same visit — in which case the count is
         already right and ours would double it — or a real mark write, whose data
         matters infinitely more than this counter. Losing a visit tick is the
         cheapest possible outcome and it must never be able to fail a page render. */
      const wrote = await writeDoc(doc, etag);
      return 'ok' in wrote ? next : unchanged;
    },
  };
}


/* ============================================================================
   TIER 3 — IN-PROCESS MAP

   Non durable, per instance. Implemented directly against a Map rather than by
   emulating Redis, because a fake Redis is a second thing that can be subtly
   wrong and this tier's only job is to be obviously correct for one developer on
   one laptop.
   ========================================================================= */

const memory = {
  marks: new Map<string, Mark>(),
  visits: { ...NO_VISITS } as Visits,
};

function memoryStore(): Store {
  const entry = (id: string): Mark => {
    const existing = memory.marks.get(id);
    if (existing) return existing;
    const fresh = emptyMark(id);
    memory.marks.set(id, fresh);
    return fresh;
  };

  return {
    tier: 'memory',

    async getMarks() {
      const out: Record<string, Mark> = {};
      for (const [id, m] of memory.marks) out[id] = { ...m };
      return fullMap(out);
    },

    async setKept(id, on) {
      const m = entry(id);
      m.kept = on;
      m.at = Date.now();
      return { ...m };
    },

    async setNote(id, note) {
      const m = entry(id);
      m.note = note;
      m.at = Date.now();
      return { ...m };
    },

    async bumpSeen(id) {
      const m = entry(id);
      m.seen += 1;
      m.at = Date.now();
      return { ...m };
    },

    async getVisits() {
      return { ...memory.visits };
    },

    async countVisit(nowMs) {
      if (memory.visits.count > 0 && nowMs - memory.visits.last < VISIT_DEBOUNCE_MS) {
        return { ...memory.visits };
      }
      memory.visits = {
        count: memory.visits.count + 1,
        first: memory.visits.first > 0 ? memory.visits.first : nowMs,
        last: nowMs,
        /* Same as the other two tiers: carry the outgoing `last` forward. This
           reads the OLD value because the whole object literal is evaluated before
           the assignment lands — which is fine, but it is the kind of thing a later
           refactor to `memory.visits.last = nowMs` (mutating in place instead of
           replacing) would silently break, so it is worth saying out loud. */
        prev: memory.visits.last,
      };
      return { ...memory.visits };
    },
  };
}

/* ============================================================================
   SELECTION
   ========================================================================= */

/**
 * Which tier is live.
 *
 * Resolved per call rather than cached at module load, matching config.ts's
 * reasoning: `import.meta.env` is read at request time on Vercel, and a value
 * frozen during the build container's module evaluation would be the build
 * container's answer forever.
 */
export function marksTier(): Tier {
  if (hasKV()) return 'upstash';
  if (hasR2()) return 'r2';
  return 'memory';
}

/**
 * Announced ONCE per process, the first time the store is touched.
 *
 * Not decoration. The failure this prevents is the quiet one: a production deploy
 * that silently landed on the memory tier because an environment variable was
 * renamed, where every symptom is "the keeps she leaves sometimes vanish" and no
 * log line ever says why. One line at cold start makes that a five-second
 * diagnosis.
 */
let announced = false;
function announce(tier: Tier): void {
  if (announced) return;
  announced = true;
  if (tier === 'memory') {
    console.warn(
      '[us] marks store: IN-PROCESS MEMORY. Non-durable and per-instance — nothing ' +
        'she keeps or writes here survives a restart, and the visit counter resets ' +
        'to zero on every cold start. Set UPSTASH_REDIS_REST_URL/_TOKEN or the R2_* ' +
        'variables before this is real.',
    );
  } else {
    console.log(`[us] marks store: ${tier}`);
  }
}

function store(): Store {
  const tier = marksTier();
  announce(tier);
  if (tier === 'upstash') {
    const { url, token } = kvConfig();
    return upstashStore(url!, token!);
  }
  if (tier === 'r2') return r2Store();
  return memoryStore();
}

/* ============================================================================
   THE PUBLIC SURFACE

   Free functions rather than "get the store, then call it", so that no caller
   ever holds a backend-specific object and none of them can accidentally grow a
   branch on which tier is live.

   Two flavours, and choosing between them is the caller's one real decision:

     THROWING  (getMarks, setKept, ...)  — for the endpoint. A write that failed
               has to be a 502 she can retry.
     SAFE      (getMarksSafe, ...)       — for a page render. Marks are decoration
               on a room that must render regardless, so a dead bucket costs her
               the keep-badges and not the gallery.
   ========================================================================= */

export function getMarks(): Promise<Record<string, Mark>> {
  return store().getMarks();
}

export function setKept(id: string, on: boolean): Promise<Mark> {
  // Thrown rather than no-opped: the caller is expected to have validated, so
  // reaching here with an unknown id is a bug worth surfacing, not a silent write
  // to a key nothing will ever read.
  if (!isMarkId(id)) throw new MarkError(`setKept: ${JSON.stringify(id)} is not a memory id`);
  return store().setKept(id, on);
}

export function setNote(id: string, note: string): Promise<Mark> {
  if (!isMarkId(id)) throw new MarkError(`setNote: ${JSON.stringify(id)} is not a memory id`);
  // Normalised HERE as well as at the endpoint, so the cap is a property of the
  // store and not of one caller's diligence.
  return store().setNote(id, normalizeNote(note));
}

export function bumpSeen(id: string): Promise<Mark> {
  if (!isMarkId(id)) throw new MarkError(`bumpSeen: ${JSON.stringify(id)} is not a memory id`);
  return store().bumpSeen(id);
}

export function getVisits(): Promise<Visits> {
  return store().getVisits();
}

export function countVisit(nowMs: number = Date.now()): Promise<Visits> {
  return store().countVisit(nowMs);
}

/* ---- the soft-failing wrappers, for page renders --------------------------- */

/** Marks for every memory, or all-empty if the store is unreachable. */
export async function getMarksSafe(): Promise<Record<string, Mark>> {
  try {
    return await getMarks();
  } catch (err) {
    console.error('[us] could not read marks; rendering the room without them.', err);
    return fullMap({});
  }
}

/**
 * Count this visit, or shrug.
 *
 * A visit counter is the single least important thing on the page and it sits on
 * the critical path of rendering it, so it must never be able to 500 her room.
 * Returns count 0 on failure, which visitLine() turns into no line at all.
 */
export async function countVisitSafe(nowMs: number = Date.now()): Promise<Visits> {
  try {
    return await countVisit(nowMs);
  } catch (err) {
    console.error('[us] could not count this visit; the room does not need it.', err);
    return { ...NO_VISITS };
  }
}

/**
 * Test seam. Not called in production; exported so a suite can start from empty.
 *
 * BE HONEST ABOUT WHAT USES IT: this repo has no committed test runner and no
 * `*.test.ts` anywhere, which an adversarial review correctly pointed out means
 * every claim in this file was, at one point, verified by nothing executable. Three
 * spec files were written against it — one per tier, plus one driving
 * /api/us/mark's handler directly with real HMAC-signed cookies and a stubbed S3
 * that implements ETags and conditional PUTs — and between them they found four
 * real bugs in this module. They are not committed, because adding a test
 * infrastructure to a repo that has deliberately avoided one is not a decision to
 * make in passing. If they are not brought in, treat this export as decoration and
 * treat the comments above as unverified.
 */
export function __resetMemoryTier(): void {
  memory.marks.clear();
  memory.visits = { ...NO_VISITS };
}
