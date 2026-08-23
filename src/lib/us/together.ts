/**
 * together.ts — the three things that need BOTH of them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * Everything in the wing up to now flows one way and then answers back. I post a
 * song, she reacts. I write a letter, she replies. I hang thirteen photographs,
 * she keeps one. Every single feature has an author and an audience, and the
 * audience is always her.
 *
 * That shape is wrong for the year this was built for. It means the wing only ever
 * has something in it when I have done something, so a week where I am buried at
 * work is a week where the room is empty and the emptiness is my fault and she can
 * see it. And it means she has no way to reach ME through it at all — her half is
 * always a response to a prompt I set.
 *
 * So: three features where neither of us is the author.
 *
 *   THINKING OF YOU   One tap. No text, no composing, no decision. The other side
 *                     sees that it happened and roughly when. This is the one that
 *                     works on the days when neither of us has words, which is the
 *                     whole reason it is first.
 *
 *   THE DAILY QUESTION  One prompt a day, the same for both of us, and NEITHER
 *                     answer is revealed until BOTH have answered. That constraint
 *                     is the entire feature: it makes the thing an exchange rather
 *                     than a comment thread, and it means her answer cannot be a
 *                     reaction to mine.
 *
 *   THE LIST          Things to do when we are in the same place. Both add, either
 *                     ticks off, and the list survives the year.
 *
 * Plus one piece of pure presentation with no store behind it at all: HER CLOCK
 * next to his, because nine hours is the actual texture of this and a wing that
 * does not know what time it is where she is has missed something.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE THREE ARE ONE FILE
 *
 * Because they are one DOCUMENT. On the R2 tier a write is a read-modify-write of
 * the whole object, and marks.ts's header spells out what two whole-object writers
 * on one key costs: "not a race, data loss on a schedule." Splitting these into
 * three modules would either mean three R2 objects (three GETs to render one page)
 * or three modules writing one object with no shared If-Match discipline. One
 * module, one document, one mutateDoc.
 *
 * They also share the thing that is genuinely new here and must not be implemented
 * twice: WHO IS SPEAKING. See PART ZERO.
 *
 * OWN KEY SPACE, OWN DOCUMENT: `us:together:*` on Upstash, `data/together.json` on
 * R2. kv.ts owns `us:song:*` / `data/songs.json`; marks.ts owns `us:mark:*` /
 * `data/marks.json`; letters.ts owns `us:letter:*` / `data/letters.json`. Nothing
 * here may touch any of those.
 *
 * Every hard-won operational detail is COPIED from kv.ts, marks.ts and letters.ts
 * rather than re-derived, because re-deriving them means re-learning them the
 * expensive way: `region: 'auto'`, `retries: 1` (aws4fetch defaults to TEN with
 * exponential backoff, which will spend a whole serverless invocation on a bucket
 * that is down), a hard `AbortSignal.timeout` that stays armed through the body
 * read, per-segment key encoding, a Content-Length pre-check, orphan and
 * unknown-field preservation, and — the one that cost real debugging time —
 * stripping the `W/` prefix off R2's ETag so `If-Match` can actually match. See
 * `readDoc()`.
 *
 * ---------------------------------------------------------------------------
 * FAILURE POLICY: SPLIT, THE SAME WAY marks.ts AND letters.ts SPLIT IT
 *
 * WRITES FAIL LOUD. An answer she typed that silently did not save is the worst
 * outcome available here, and a tap that silently did not send is close behind —
 * she would believe I knew she was thinking of me. A transport error is a thrown
 * TogetherError and the endpoint turns it into a 502 she can retry.
 *
 * READS FAIL SOFT. All of this renders on the hub, which is the front door. A dead
 * store must cost her the three blocks, never the door. The `*Safe` wrapper is
 * what the page calls; the endpoints call the throwing ones.
 * ---------------------------------------------------------------------------
 */

import { AwsClient } from 'aws4fetch';
import { SESSION_SECRET, hasKV, hasR2, kvConfig, r2Config, r2Endpoint } from './config';
/* The wing's calendar, imported rather than re-implemented. kv.ts's WING_TZ comment
   explains why one fixed zone exists at all; the point here is that "today's
   question" and "today's song" MUST agree about when today starts, because they
   render a few hundred pixels apart on the same page. Two implementations of that
   would disagree twice a year at the DST boundaries, and the symptom would be a new
   question appearing an hour before or after the new song. */
import { isWingDate, wingDate, wingDateLabel } from './kv';
import { readCookie, verify } from './session';

/** Thrown for transport problems only. A day nobody answered is a DEFAULT. */
export class TogetherError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TogetherError';
  }
}

export type Tier = 'upstash' | 'r2' | 'memory';

/**
 * 2500ms on every network call, matching marks.ts and letters.ts rather than kv.ts's
 * 2000.
 *
 * Same reasoning: these writes happen while somebody is looking at a button waiting
 * for it to confirm, and a spurious "that didn't send" on a train connection is
 * worse here than half a second of waiting. Still a HARD deadline, because this runs
 * inside a serverless function on its own budget.
 *
 * ALWAYS `AbortSignal.timeout()`, never an AbortController cleared in a `finally`.
 * `fetch` resolves as soon as the response HEADERS arrive, so clearing the timer
 * before reading the body leaves the download unbounded, and a server that answers
 * 200 then stalls hangs the whole invocation — precisely what this constant exists
 * to prevent. marks.ts documents the same mistake at length; it is not repeated.
 */
const TIMEOUT_MS = 2500;

/* ============================================================================
   PART ZERO — WHO IS SPEAKING

   This is the genuinely new thing in this file and it is the one rule that must
   hold IDENTICALLY in three places: both endpoints, and the hub that renders what
   they wrote. If the hub decides "him" and the endpoint decides "her", the page
   does not merely look wrong — it attributes one person's tap to the other, which
   is the single worst bug this feature can have. So there is one implementation,
   here, and nothing recomputes it.

   TWO COOKIES, NEVER COLLAPSED INTO ONE IDENTITY

   Her authorization is the SESSION cookie (she answered the three questions).
   Mine is the ADMIN cookie (I typed the admin passcode). kv.ts's header makes the
   same split for songs versus replies and gives the reason: her session cookie
   lives for thirty days on a phone that goes to the gym, so anything it can write
   must be bounded to "things she is allowed to say".

   ADMIN WINS WHEN BOTH COOKIES ARE PRESENT, AND THAT DIRECTION IS DELIBERATE.

   It is a state that really happens: I know the answers to my own questions, so I
   can mint myself a session cookie any time, and I hold an admin cookie as well.
   One of the two has to win, and the reasoning is asymmetric:

     - A session cookie proves the holder answered three questions about me. I can
       do that. So a session cookie does NOT prove the holder is her.
     - An admin cookie proves the holder typed the admin passcode, which is a single
       secret that exists only in my head and in Vercel's environment. She does not
       have it. So an admin cookie DOES prove the holder is me.

   Admin is therefore the STRONGER claim, and the failure modes are not
   symmetrical either. "Session wins" would attribute my own taps to her and print
   "she was thinking of you" on my own screen about myself — a lie the page tells
   without hesitating. "Admin wins" has no corresponding failure, because there is
   no way for her to hold an admin token without me having given her the passcode,
   at which point the threat model in PLAN.md §2 has already been abandoned on
   purpose.

   NOTE WHAT THIS DOES NOT DO: it does not grant access to anything. The hub still
   demands a `session` token before it renders one byte, exactly as it did before —
   my admin token cannot open her vault and this does not change that. identify()
   only ever relabels a caller who is already through the door.
   ========================================================================= */

/** The two of them. Persisted verbatim in every record, so never rename these. */
export type Who = 'her' | 'him';

/**
 * Exactly what readCookie() accepts, DERIVED rather than restated.
 *
 * session.ts declares its own minimal `CookieJar` and does not export it, so the
 * obvious move is to write a matching interface here. That was the first version and
 * it did not compile: session.ts's shape requires `set` and `delete` as well as
 * `get`, and a hand-written read-only copy is not assignable to it.
 *
 * Extracting the parameter type is better than fixing the copy, because a copy that
 * compiles today is a copy that silently diverges the day session.ts's signature
 * changes. This cannot diverge — if readCookie's first parameter changes shape, this
 * changes with it, and the failure is a type error at the call site rather than a
 * cookie that is quietly never read. No Astro import either way.
 */
type CookieJar = Parameters<typeof readCookie>[0];

/** The other one. Exists so no caller writes `who === 'her' ? 'him' : 'her'` twice. */
export function otherOne(who: Who): Who {
  return who === 'her' ? 'him' : 'her';
}

export function isWho(value: unknown): value is Who {
  return value === 'her' || value === 'him';
}

/**
 * Which of them is this request, or null when it is neither.
 *
 * `url` is not optional here, unlike readCookie's third argument, and that is on
 * purpose: readCookie defaults to the hardened `__Host-` name when it is missing,
 * which is the safe direction for a security check but would make every one of
 * these endpoints 401 forever under `astro dev`. A required argument means the
 * mistake is a type error rather than a mystery.
 */
export function identify(cookies: CookieJar, url: URL): Who | null {
  const secret = SESSION_SECRET();
  // Fail closed. Without a signing secret we cannot tell either of them from
  // anyone else, and the only safe answer to that is nobody.
  if (!secret) return null;
  // ADMIN FIRST. See the section header for why this order is the whole rule.
  if (verify(secret, 'admin', readCookie(cookies, 'admin', url))) return 'him';
  if (verify(secret, 'session', readCookie(cookies, 'session', url))) return 'her';
  return null;
}

/**
 * Same-origin check. Lifted from /api/us/mark.ts, comment and all, because the
 * analysis is not obvious and re-deriving it would mean re-deriving the reason.
 *
 * These are cookie-authenticated POSTs that accept `application/x-www-form-
 * urlencoded` — a CORS-simple content type, so a cross-site form submission needs
 * no preflight and no cooperation from us. Astro's own `security.checkOrigin` is
 * NOT protecting them: astro.config.mjs sets `output: 'static'`, and Astro only
 * installs its origin-check middleware when the build output is `server`, so the
 * flag resolves to false for this project.
 *
 * Without this, the only thing standing between a cross-site page and these writes
 * is `sameSite: 'lax'` in session.ts — and Lax is site-scoped rather than
 * origin-scoped, so any host under the same registrable domain can already post.
 *
 * REJECT ONLY ON A POSITIVE MISMATCH, never on absence. Every browser that can run
 * this page sends `Origin` on a POST and `Sec-Fetch-Site` on every request, so a
 * real forgery is always caught; failing closed on a MISSING header would risk
 * breaking the no-JavaScript form path, which is the accessible route and the one
 * that must never regress.
 *
 * `Sec-Fetch-Site` FIRST, because the browser computes it and it is unforgeable
 * from script. The Origin comparison is the fallback for Safari before 16.4.
 *
 * AND THE ORIGIN COMPARISON IS HOST-ONLY, NOT FULL-ORIGIN — a deliberate refusal to
 * bet on the protocol. A proxy hop that handed the function `http://` while the
 * browser used `https://` would make a full-origin comparison fail on EVERY write,
 * turning a security control into an outage. The host carries the security property
 * anyway: an attacker on evil.example has a different host whatever scheme it uses.
 *
 * It lives in this file rather than being copied into two endpoints for the same
 * reason identify() does: a rule that must hold identically in two places is one
 * implementation, or it is eventually two behaviours.
 */
export function crossSite(request: Request, url: URL): boolean {
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

/* ============================================================================
   ===  PART ONE — THE TWO CLOCKS  ============================================

   ===  SAM: THESE ARE THE TWO LINES TO EDIT WHEN SHE MOVES  ==================

   No store, no state, no I/O. Two IANA timezone names and the arithmetic that
   turns them into two numbers on a strip.

   THEY ARE SOURCE, NOT DATA, and that is the same call status.ts makes about
   NEXT_TIME: she moves once, maybe twice, and each time it is one line and a
   deploy. An admin UI, an environment variable and a store record are all three
   more moving parts than the problem has.

   WHY NOT WING_TZ: because WING_TZ (America/New_York) is a CALENDAR — it decides
   when a day rolls over so that a song and a question agree about "today", and
   kv.ts explains at length why it must be exactly one fixed zone. These two are
   LOCATIONS. Neither of them lives in New York, so the wing's midnight is nobody's
   midnight, and a clock strip that showed New York would be showing a third city
   that has nothing to do with either of them.

   That distinction has one visible consequence, stated here so it is not a
   surprise: "today's question" rolls over on New York's midnight, while "it is
   6:42 in the morning where she is" is her actual clock. Those are different
   facts and the page says them in different words.
   ========================================================================= */

/**
 * Where she is. An IANA timezone name — `Europe/Paris` today, and
 * `America/Los_Angeles` when she moves back to the west coast, at which point
 * both clocks read the same and the two-clock line stops earning its space.
 * That is the only change needed: this one line.
 *
 * Paris is CONFIRMED, not inferred. It was a guess (Lisbon) until Sam said so
 * on 2026-08-22.
 *
 * A name Intl does not recognise does NOT throw — see zone(). It degrades to UTC
 * and says so loudly in the log, because a typo here would otherwise 500 the hub,
 * and a wrong clock is a much smaller failure than a missing front door.
 */
export const HER_TZ = 'Europe/Paris';

/** Where he is. US west coast. */
export const HIS_TZ = 'America/Los_Angeles';

/**
 * A timezone name we have actually confirmed Intl accepts.
 *
 * Checked ONCE per name per process and cached, because the check is a constructor
 * call and this runs on every hub render. `Intl.DateTimeFormat` throws RangeError
 * on an unknown timeZone, so without this a one-character typo in the constant
 * above would throw inside a page render and take the whole hub down — for a
 * decorative clock. Degrading to UTC keeps the door open and makes the mistake
 * obvious rather than fatal.
 */
const zoneCache = new Map<string, string>();
function zone(tz: string): string {
  const cached = zoneCache.get(tz);
  if (cached) return cached;
  let resolved = tz;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    console.error(
      `[us] together.ts: ${JSON.stringify(tz)} is not a timezone Intl recognises. ` +
        'Falling back to UTC so the hub still renders. Fix HER_TZ / HIS_TZ — the ' +
        'value must be an IANA name like "Europe/Paris", not a city or an offset.',
    );
    resolved = 'UTC';
  }
  zoneCache.set(tz, resolved);
  return resolved;
}

interface ZonedParts {
  /** `YYYY-MM-DD` in that zone. Sortable, and comparable as text. */
  date: string;
  /** 0-23. */
  hour: number;
  minute: number;
  second: number;
  /** `Sat`. */
  weekday: string;
}

/**
 * One instant, as a wall clock in one zone.
 *
 * `formatToParts` rather than string-splitting a formatted date, because the
 * separator, the order and the padding of a formatted date are all locale
 * decisions and any of them changing would silently produce a wrong hour. Parts
 * are named.
 *
 * `hourCycle: 'h23'` and not `hour12: false`: the latter produces hour `24` for
 * midnight in several engines, which would make every comparison against a
 * 0-23 range wrong for exactly one hour a day. The `% 24` after it is belt and
 * braces for the same reason.
 */
function zonedParts(tz: string, at: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone(tz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday'),
  };
}

/**
 * Minutes east of UTC for a zone at an instant. Handles DST because it asks Intl
 * rather than assuming.
 *
 * The trick: format the instant as a wall clock in the zone, then rebuild that wall
 * clock AS IF it were UTC and subtract. The difference is the offset. Anchored to
 * whole seconds on both sides so a sub-second remainder cannot round the result to
 * the wrong minute.
 */
function tzOffsetMinutes(tz: string, at: Date): number {
  const p = zonedParts(tz, at);
  const [y, m, d] = p.date.split('-').map(Number);
  const asIfUtc = Date.UTC(y, m - 1, d, p.hour, p.minute, p.second);
  const instant = Math.floor(at.getTime() / 1000) * 1000;
  return Math.round((asIfUtc - instant) / 60_000);
}

export interface Clock {
  who: Who;
  /** The IANA name actually used, after zone() validated it. */
  tz: string;
  /** `18:42`. Twenty-four hour — see the comment on clocks(). */
  time: string;
  /** `Sat`. */
  weekday: string;
  /** `YYYY-MM-DD` in that zone, for comparing the two days. */
  date: string;
  /**
   * A real `<time datetime>` value: the same instant, expressed with that zone's
   * offset — `2026-08-22T18:42+01:00`.
   *
   * Worth doing properly rather than emitting a bare `18:42`, which as a datetime
   * value means "18:42 in an unspecified zone" and is therefore a different fact
   * from the one on screen.
   */
  iso: string;
}

export interface TwoClocks {
  her: Clock;
  him: Clock;
  /** Her offset minus his, in minutes. Positive means she is ahead. */
  apartMinutes: number;
  /** True when the two zones are on different calendar days right now. */
  differentDay: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function offsetSuffix(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function faceFor(who: Who, tz: string, at: Date): Clock {
  const p = zonedParts(tz, at);
  const offset = tzOffsetMinutes(tz, at);
  return {
    who,
    tz: zone(tz),
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    weekday: p.weekday,
    date: p.date,
    iso: `${p.date}T${pad(p.hour)}:${pad(p.minute)}${offsetSuffix(offset)}`,
  };
}

/**
 * Both clocks from one instant.
 *
 * TWENTY-FOUR HOUR ON BOTH, which is a real decision and not an oversight. The
 * point of the strip is comparing two numbers, and `6:42 pm` next to `10:42 am`
 * makes the reader do am/pm bookkeeping before the comparison is even possible.
 * Twenty-four hour is unambiguous in both directions and it is what she is used
 * to anyway. One format on one strip; mixing them to suit each local idiom would
 * be politeness that costs legibility.
 *
 * ONE INSTANT, PASSED IN. Same discipline as status.ts and kv.ts's derivations:
 * nothing here reads the clock, so "what does this look like at 23:59" is a
 * question that can be answered without waiting until 23:59.
 */
export function clocks(atMs: number = Date.now()): TwoClocks {
  const at = new Date(atMs);
  const her = faceFor('her', HER_TZ, at);
  const him = faceFor('him', HIS_TZ, at);
  return {
    her,
    him,
    apartMinutes: tzOffsetMinutes(HER_TZ, at) - tzOffsetMinutes(HIS_TZ, at),
    differentDay: her.date !== him.date,
  };
}

/**
 * "nine hours behind you", from the viewer's side.
 *
 * The sentence has to know who is reading it, so the perspective is an argument
 * rather than baked in — the hub renders for whichever of them is holding the
 * cookie, so a fixed "she is ahead" would be backwards half the time.
 *
 * Half-hour zones are real (India, Adelaide) and quarter-hour ones exist
 * (Kathmandu, Chatham), so this does not assume whole hours. Anything that is not
 * a whole hour or a clean half falls back to digits, which is honest and rare.
 */
export function apartLine(c: TwoClocks, viewer: Who): string {
  const minutes = viewer === 'her' ? -c.apartMinutes : c.apartMinutes;
  if (minutes === 0) return 'the same hour as you, for once.';

  const ahead = minutes > 0;
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;

  let span: string;
  if (rest === 0) span = `${spell(hours)} ${hours === 1 ? 'hour' : 'hours'}`;
  else if (rest === 30) span = `${spell(hours)} and a half hours`;
  else span = `${hours}h ${rest}m`;

  return `${span} ${ahead ? 'ahead of' : 'behind'} you.`;
}

/* ============================================================================
   THE OVERLAP WINDOW

   ---------------------------------------------------------------------------
   THE TWO CLOCKS SAY WHERE EACH OF YOU IS. THIS SAYS WHEN YOU CAN BOTH BE HERE.

   Nine hours is the kind of gap where the actual problem is not knowing the
   other person's time — it is arithmetic. She looks at 03:29 and 18:29 and has
   to work out, from two numbers and a bedtime she is guessing at, whether
   messaging him now reaches a person or a phone on a nightstand. Everybody in a
   long-distance relationship does this sum several times a day and gets it wrong
   often enough to have learned not to try.

   So the site does the sum. Two states, and only two:

       you are both awake — for the next three hours
       he is asleep. you overlap again in four hours, for six and a half

   That second sentence is the one that matters. "He is asleep" on its own is a
   closed door; the same fact with a time attached is a plan.

   ---------------------------------------------------------------------------
   NO STORAGE, NO ENDPOINT, NO INPUT

   Everything here is derived from HER_TZ, HIS_TZ and the awake window below.
   Nothing is written, nothing is read, and there is nothing either of them can
   set — which is why this is the cheapest feature in the wing and also why it
   cannot break in a way that loses data.

   ---------------------------------------------------------------------------
   WHY AN INTEGER SWEEP AND NOT INTERVAL ARITHMETIC

   Both windows wrap midnight in at least one of the two zones (hers, in his
   time, runs 23:00 to 14:30), the two can overlap in TWO separate bands a day,
   and the bands are different lengths. Closed-form interval intersection across
   a wrap is the kind of code that is correct for the case you tested and off by
   a day for the other one.

   So: read each person's local wall clock ONCE — from clocks(), which the hub
   has already computed — and then step a pure integer minute counter forward.
   `(m + step) % 1440` needs no timezone database and no Intl call, so the sweep
   costs nothing measurable and is auditable by reading it.

   The one imprecision: a DST shift between now and a boundary moves that
   boundary by an hour, because the sweep assumes each zone's offset holds for
   the length of the window. Twice a year, "for the next three hours" is off by
   one. That is a fair price for not shipping wrap-around interval arithmetic.
   ========================================================================= */

/**
 * When each of them is reachable, as local minutes from midnight.
 *
 * ONE WINDOW FOR BOTH, deliberately: two windows invites tuning it into a
 * timetable, and the honest precision available here is "roughly daytime".
 * 08:00 to 23:30 is a guess about two people, and it is the only guess in this
 * block — everything else is derived. If it reads wrong, this is the line.
 *
 * It is intentionally generous at the end. The failure that matters is telling
 * her he is asleep when he is awake, so the window errs toward "reachable".
 */
export const AWAKE_FROM_MIN = 8 * 60;
export const AWAKE_UNTIL_MIN = 23 * 60 + 30;

/** How far ahead to look for the next overlap before giving up. */
const OVERLAP_HORIZON_MIN = 48 * 60;
/** Sweep granularity. Matches the resolution of the sentence it produces. */
const OVERLAP_STEP_MIN = 15;

export interface Overlap {
  /** True when both wall clocks are inside the awake window right now. */
  bothAwake: boolean;
  /**
   * Minutes of shared time left, when `bothAwake`. Zero otherwise.
   *
   * Counted to whichever window closes FIRST, which is the whole point — the
   * shared time ends when either of them goes, not when the reader does.
   */
  remainingMin: number;
  /**
   * Minutes until THE OTHER PERSON's window opens, when they are outside it.
   * Zero when they are already inside.
   *
   * Deliberately not "minutes until the next time both windows intersect". That
   * was the first version and it was wrong in a way worth recording: with nine
   * hours between them the two windows intersect in two separate bands a day, and
   * the nearer band is THIRTY MINUTES long (her 08:00 is his 23:00). So at 02:00
   * her time the honest intersection answer was "you overlap again in six hours,
   * for 30 minutes" — accurate, and useless. She would have planned around it and
   * found him going to bed.
   *
   * The other person waking up is the fact she can actually act on, it is never a
   * sliver, and it needs no forward search at all.
   */
  theirsOpensInMin: number;
  /** Who is outside the window. Empty when both are inside. */
  asleep: Who[];
}

/** `18:29` -> 1109. The clock face is already computed, so this is free. */
function minuteOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h % 24) * 60 + (m % 60);
}

function insideWindow(minute: number): boolean {
  const m = ((minute % 1440) + 1440) % 1440;
  return m >= AWAKE_FROM_MIN && m < AWAKE_UNTIL_MIN;
}

/** Minutes from `minute` forward to the next AWAKE_FROM_MIN. */
function untilOpens(minute: number): number {
  const m = ((minute % 1440) + 1440) % 1440;
  return ((AWAKE_FROM_MIN - m) % 1440 + 1440) % 1440;
}

/**
 * The shared-time facts, from two wall clocks and nothing else.
 *
 * Takes `TwoClocks` rather than an instant so that the hub computes the pair
 * once and both the clock strip and this line describe the SAME moment. Two
 * independent Date.now() calls a few milliseconds apart would almost always
 * agree and would disagree exactly at a boundary, which is the only time anybody
 * would be looking closely.
 */
export function overlap(c: TwoClocks): Overlap {
  const herNow = minuteOfDay(c.her.time);
  const himNow = minuteOfDay(c.him.time);

  const herIn = insideWindow(herNow);
  const himIn = insideWindow(himNow);

  const asleep: Who[] = [];
  if (!herIn) asleep.push('her');
  if (!himIn) asleep.push('him');

  let remainingMin = 0;
  if (herIn && himIn) {
    // Sweep to the FIRST close rather than computing two remainders and trusting
    // the smaller — the window wraps midnight in at least one of the two zones,
    // and `(m + step) % 1440` needs no timezone database to get that right.
    let step = 0;
    while (step < OVERLAP_HORIZON_MIN) {
      const next = step + OVERLAP_STEP_MIN;
      if (!insideWindow(herNow + next) || !insideWindow(himNow + next)) break;
      step = next;
    }
    remainingMin = step + OVERLAP_STEP_MIN;
  }

  return {
    bothAwake: herIn && himIn,
    remainingMin,
    // Filled in per-reader by overlapLine, which is the only thing that knows
    // which of the two "the other person" is.
    theirsOpensInMin: 0,
    asleep,
  };
}

/**
 * Minutes as something you would say out loud: `three hours`, `six and a half
 * hours`, `forty minutes`.
 *
 * Rounds to the half hour above an hour, because "3h 12m" is a measurement and
 * this is meant to be a remark. Under an hour it stays in minutes, where the
 * precision is the useful part.
 */
export function spanWords(min: number): string {
  if (min < 60) {
    const rounded = Math.max(5, Math.round(min / 5) * 5);
    return `${rounded} minutes`;
  }
  const halves = Math.round(min / 30);
  const hours = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  const name = hours <= 12 ? spell(hours) : String(hours);
  if (half) return `${name} and a half hours`;
  return `${name} ${hours === 1 ? 'hour' : 'hours'}`;
}

/**
 * The sentence, from the reader's side.
 *
 * THE READER IS AWAKE. They are holding a phone, looking at this. So the line
 * never tells them anything about their own state that they could see by looking
 * up — the four cases are about the other person, except the one case where
 * being up at 03:00 is itself the remark.
 *
 * Needs the clocks again because "when does he wake up" is a fact about HIS wall
 * clock, and which of the two that is depends on who is reading.
 */
export function overlapLine(o: Overlap, c: TwoClocks, viewer: Who): string {
  const them = otherOne(viewer);
  const theirName = them === 'her' ? 'she' : 'he';
  const theirClock = them === 'her' ? c.her : c.him;

  if (o.bothAwake) {
    return `you are both awake — for the next ${spanWords(o.remainingMin)}`;
  }

  const theyAreAsleep = o.asleep.includes(them);
  const youAreUp = !o.asleep.includes(viewer);

  if (theyAreAsleep) {
    const opens = untilOpens(minuteOfDay(theirClock.time));
    const wake = `${theirName} is up again in ${spanWords(opens)}`;
    // Both outside the window: she is reading this at 03:00, which is the more
    // interesting half of the sentence, so it leads.
    return youAreUp ? `${theirName} is asleep. ${wake}.` : `you are both up too late. ${wake}.`;
  }

  // They are awake and the reader is outside the window — up late, or up early.
  const hour = minuteOfDay(viewer === 'her' ? c.her.time : c.him.time) / 60;
  const late = hour >= AWAKE_UNTIL_MIN / 60 || hour < 5;
  return late
    ? `${theirName} is up. you are the one who should be asleep.`
    : `${theirName} is up, and you are up early.`;
}

/* ============================================================================
   PART TWO — "THINKING OF YOU"

   ---------------------------------------------------------------------------
   THE WHOLE FEATURE IS THAT IT ASKS FOR NOTHING

   One tap. No text field, no emoji picker, no "how are you feeling" scale, no
   decision of any kind. The other person sees that it happened and roughly when.

   That is not minimalism for its own sake. Every other channel in this wing
   requires you to have something to say — a song you can defend, a note under a
   photograph, four hundred words back. On a bad Tuesday all of those are work, and
   the day you most want to reach someone is exactly the day you have the least to
   say. This is the feature for that day, so it must never grow a text field.

   ---------------------------------------------------------------------------
   IT ACCUMULATES **AND** IT HAS A LATEST STATE, AND BOTH ARE LOAD-BEARING

   The brief for this was "decide whether it accumulates or is a single latest
   state." It is both, deliberately, because the two carry different information
   and dropping either one loses something real:

     THE LATEST STATE IS THE MESSAGE. "he was thinking of you — this morning" is
     the sentence. It is what the hub leads with, it is what she actually reads,
     and it is the only part that would survive if this had to be one number.

     THE COUNT IS THE INTENSITY, and only when it is more than one. Three taps in
     a day is not three notifications, it is a different day: it says somebody kept
     coming back. Collapsing that to "he was thinking of you" throws away the one
     signal in this feature that can be loud, and the days it would be loud on are
     the days that matter most.

   So the record holds `last` (the message) and `today` (the intensity), and the
   copy only mentions the count when it is greater than one — see thinkingLine().
   A "1" is never printed anywhere. There is no badge.

   THE COUNT'S DAY IS THE WING DAY, and that is a deliberate inconsistency with
   PART ONE's clocks. "three times today" here means three times inside the same
   New York calendar day, which is not exactly either of their days. It is chosen
   for agreement rather than accuracy: the same page says "today's question"
   meaning the wing day, and one page with two definitions of "today" is worse than
   one page whose "today" is slightly nobody's. The cost is a tap at 3am her time
   filing under the previous day's count. It is a decorative number; it can be
   slightly wrong. The TIMESTAMP, which is the part she reads, is exact.

   ---------------------------------------------------------------------------
   THE LIMIT IS A DEBOUNCE, NOT A REFUSAL, AND THAT IS THE DESIGN

   THINKING_DEBOUNCE_MS is thirty minutes. The reasoning, since the brief asked
   for it:

     TEN A MINUTE makes it meaningless — at that rate it is a fidget, and a signal
     that arrives forty times an hour stops being read at all.

     ONE A DAY makes it a chore AND, worse, makes it SCARCE. A once-a-day tap is a
     resource you have to spend wisely: if you use it at 9am you have nothing left
     at 11pm, so you start holding it back for the right moment. Holding back is the
     precise opposite of what this is for.

     THIRTY MINUTES is "a different part of the day". Two taps ten minutes apart
     are one thought. Breakfast, lunch and midnight are three, and all three should
     land. The practical ceiling is ~48 a day and the realistic count is two or
     three, which is exactly the shape wanted: never rationed, never noise.

   AND IT IS ENFORCED AS A COALESCE, NOT AS AN ERROR. A second tap inside the
   window returns 200 with `sent: false` and the time of the one that did land. It
   is not a 429 and it does not say "slow down", because being told to slow down for
   saying you are thinking about somebody is a genuinely unpleasant thing for a
   piece of software to do. The tap is simply already sent, and the page says so.

   The endpoint keeps a real rate limit on top of this, but only as a bound on a
   runaway loop in our own client — it is not this feature's limit. See the comment
   on RATE_LIMIT in /api/us/thinking.ts, which is honest about what a limiter in
   this deployment can and cannot buy.
   ========================================================================= */

export interface Thinking {
  /** Epoch millis of the most recent one that landed. 0 means never. */
  last: number;
  /** The WING date `last` fell on. '' when there is none. Scopes `today`. */
  day: string;
  /** How many landed on `day`. 0 when there are none. Never printed as "1". */
  today: number;
  /** How many have ever landed. Not displayed anywhere; kept because it is free. */
  total: number;
}

export const NO_THINKING: Thinking = { last: 0, day: '', today: 0, total: 0 };

/** Thirty minutes. See the section header — this is the feature's real limit. */
export const THINKING_DEBOUNCE_MS = 30 * 60 * 1000;

/**
 * How stale a tap may be before the hub stops mentioning it at all.
 *
 * Ten days. This signal is entirely about recency: "he was thinking of you — on
 * 14 May" is not a message, it is an archive entry, and leaving it on the page
 * forever would turn a live thing into a monument to the last time either of them
 * bothered. Ten days is long enough to cover a bad week or a holiday and short
 * enough that the line going quiet means something.
 *
 * Past it, thinkingLine() returns '' and the page renders the empty state — which
 * is a real sentence with a button under it, not a blank space. See the hub.
 */
export const THINKING_STALE_MS = 10 * 24 * 60 * 60 * 1000;

function parseThinking(raw: unknown): Thinking {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // A hand-edit in the Upstash console at 1am must degrade to "never", not
      // throw inside a page render. Same reasoning as kv.ts's parseTrack.
      console.error('[us] a stored `thinking` record is not JSON — ignoring it.');
      return { ...NO_THINKING };
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return { ...NO_THINKING };
  return {
    last: count(obj.last),
    day: isWingDate(obj.day) ? obj.day : '',
    today: count(obj.today),
    total: count(obj.total),
  };
}

/**
 * How long ago, in words somebody would actually say.
 *
 * ---------------------------------------------------------------------------
 * THE PART-OF-DAY PHRASES ARE COMPUTED IN THE READER'S OWN TIMEZONE, AND THAT IS
 * THE WHOLE REASON THIS TAKES A `tz` ARGUMENT
 *
 * "this morning" is a claim about the reader's morning. He taps at 23:00 Pacific;
 * for her that is 08:00 and it genuinely was this morning. Computing it in the wing
 * timezone would produce "last night" on her screen about something that happened
 * while she was eating breakfast — a sentence that is wrong for both of them at
 * once, which is the worst available answer.
 *
 * We know both zones (PART ONE), so there is no excuse for guessing. The elapsed
 * phrases ("half an hour ago") need no zone at all and are used first, which is
 * also why a wrong HER_TZ degrades gracefully: the recent cases, which are the
 * common ones, are unaffected.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER PRINTS A NUMBER OF HOURS
 *
 * "5 hours ago" is arithmetic; "this afternoon" is how people talk. The bands are
 * coarse on purpose and get coarser as they recede, exactly as kv.ts's agoLabel
 * does, because precision that nobody asked for reads as instrumentation.
 */
export function warmAgo(atMs: number, nowMs: number, tz: string): string {
  if (!(atMs > 0)) return '';
  /* A negative elapsed means the stored timestamp is in the future — a clock skew
     between two serverless instances, or a hand-edit. "just now" is the honest
     reading and it is certainly better than "in 3 minutes". */
  const elapsed = Math.max(0, nowMs - atMs);

  const MIN = 60_000;
  if (elapsed < 3 * MIN) return 'just now';
  if (elapsed < 15 * MIN) return 'a few minutes ago';
  if (elapsed < 40 * MIN) return 'half an hour ago';
  if (elapsed < 75 * MIN) return 'an hour ago';

  const then = zonedParts(tz, new Date(atMs));
  const now = zonedParts(tz, new Date(nowMs));
  const dayDelta = wholeDaysBetween(then.date, now.date);

  if (dayDelta <= 0) {
    if (then.hour < 5) return 'in the small hours';
    if (then.hour < 12) return 'this morning';
    if (then.hour < 17) return 'this afternoon';
    if (then.hour < 21) return 'this evening';
    return 'tonight';
  }
  if (dayDelta === 1) {
    // 21:00-04:59 the previous day is "last night" to anybody who has ever said it.
    if (then.hour >= 21 || then.hour < 5) return 'last night';
    if (then.hour < 12) return 'yesterday morning';
    if (then.hour < 17) return 'yesterday afternoon';
    return 'yesterday evening';
  }
  /* Inside the last week a weekday NAMES the day, which is how people refer to
     recent things. Past that a weekday is ambiguous ("on Tuesday" — which one?) so
     it becomes a date. */
  if (dayDelta <= 6) return `on ${weekdayName(tz, atMs)}`;
  return `on ${wingDateLabel(then.date)}`;
}

function weekdayName(tz: string, atMs: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone(tz), weekday: 'long' }).format(
    new Date(atMs),
  );
}

/**
 * The one sentence the hub leads with, or '' for "say nothing".
 *
 * '' is a real answer and callers must treat it as render-nothing rather than as an
 * empty string in a paragraph — it is what happens when the other person has never
 * tapped, or has not tapped inside THINKING_STALE_MS. The hub has a written empty
 * state for that; a blank line would read as a fault.
 *
 * `who` is the SENDER, so the pronoun comes from the record and not from the
 * caller's guess about which side of the page it is on.
 */
export function thinkingLine(input: {
  /** Whose record this is. */
  who: Who;
  record: Thinking;
  /** Now, in epoch millis. Passed, never read from the clock. */
  nowMs: number;
  /** The READER's timezone — see warmAgo. */
  readerTz: string;
  /** Today in WING_TZ, to scope the count. */
  today: string;
}): string {
  const { record, nowMs } = input;
  if (!(record.last > 0)) return '';
  if (nowMs - record.last > THINKING_STALE_MS) return '';

  const pronoun = input.who === 'her' ? 'she' : 'he';
  const when = warmAgo(record.last, nowMs, input.readerTz);
  const head = `${pronoun} was thinking of you — ${when}`;

  /* The count only ever appears above one, and only for the day it belongs to. A
     stale `today` from a previous day is silently ignored rather than relabelled:
     "three times today" about yesterday is a lie, and there is no shorter true
     version of it worth printing. */
  if (record.day === input.today && record.today > 1) {
    return `${head}. ${sentence(spell(record.today))} times today.`;
  }
  return `${head}.`;
}

/** Her own outgoing state, so a tap visibly landed. '' when she has not sent one. */
export function sentLine(record: Thinking, nowMs: number, readerTz: string): string {
  if (!(record.last > 0)) return '';
  if (nowMs - record.last > THINKING_STALE_MS) return '';
  return `you sent one ${warmAgo(record.last, nowMs, readerTz)}.`;
}

/* ============================================================================
   PART THREE — THE DAILY QUESTION

   ---------------------------------------------------------------------------
   THE MECHANIC IS THE WHOLE FEATURE, AND IT IS ENFORCED ON THE SERVER

   One prompt a day, the same for both of them, and NEITHER answer is visible
   until BOTH have answered.

   That single constraint is what separates this from a comment thread. Without
   it, whoever answers second is answering the first person rather than the
   question: they have read the other answer, so their own becomes agreement,
   contrast, or a joke about it. With it, both answers are written blind and the
   reveal is the moment you find out whether you were thinking the same thing.
   That moment is the entire point, and it only exists because of the seal.

   THE SEAL IS `visibleDay()`, AND IT WORKS EXACTLY LIKE letters.ts's
   `visibleLetter()`: an unrevealed answer is not hidden, not collapsed, not behind
   a class — it is ABSENT from the object the page is holding. The page cannot leak
   what it was never given. A CSS-hidden answer is not a mechanic, it is a devtools
   puzzle, and she has a phone and knows how to use it.

   The endpoint enforces it too, on the write path: /api/us/together returns the
   day through visibleDay() rather than returning what it stored, so answering does
   not hand back the other side's text unless answering just revealed it.

   ---------------------------------------------------------------------------
   THE DAY ROLLS OVER ON WING_TZ MIDNIGHT

   Same key, same calendar, same reason kv.ts gives: a question keyed by the same
   day-string as a song means the page cannot show today's song beside yesterday's
   question. In practice the new question appears at 6am for her and 9pm for him,
   which is to say she wakes up to it and he gets it after dinner. That asymmetry is
   inherent to nine hours and cannot be designed away; what CAN be avoided is two
   different definitions of midnight on one page, and it is.

   ---------------------------------------------------------------------------
   AN UNANSWERED DAY DOES NOT BLOCK TOMORROW, AND IT IS NOT LOST EITHER

   Every day is an independent record, so tomorrow's question arrives whether or not
   today's was answered. Nothing queues, nothing is owed.

   But a day where only one of them answered would otherwise be a dead end with her
   words locked inside it forever, so: A PAST DAY CAN STILL BE ANSWERED LATE, for
   LATE_ANSWER_DAYS, and answering it reveals both halves exactly as it would have
   on the day. This preserves the mechanic perfectly — you still have to answer to
   see — while meaning a bad week costs nothing.

   AFTER THAT WINDOW THE DAY CLOSES AND STAYS HALF-OPEN FOREVER, and the one answer
   in it is never revealed to the other person. That is a real cost and it is the
   right one: the alternative is that waiting long enough is a way to read her
   answer without writing one, which would make the seal optional and therefore
   fake. What she can always see is HER OWN answer — you never lose your own words,
   on any day, revealed or not.
   ========================================================================= */

/**
 * How long a past day stays answerable.
 *
 * Seven days. A week is "recently": a work crunch, a flight, a stomach bug all fit
 * inside it, and none of them should cost an exchange. Beyond a week, answering
 * Monday-before-last's question is homework rather than a conversation, and the
 * prompt has stopped being about anything.
 *
 * It also bounds the write surface: at most eight day records are mutable at any
 * moment, so the document's hot region is small no matter how long this runs.
 */
export const LATE_ANSWER_DAYS = 7;

/**
 * How long an answer may be.
 *
 * 400 characters, sitting deliberately between marks.ts's MARK_NOTE_MAX (280, a
 * caption under a photograph) and letters.ts's REPLY_MAX (4000, actual prose). A
 * daily question wants the answer you would give out loud: a sentence, maybe two,
 * with one specific detail in it. 400 is about seventy words, which is comfortably
 * more than anybody types on a phone at breakfast and far too little to write an
 * essay in — and the shortness is a feature, because a question you have to find
 * twenty minutes for is a question that goes unanswered.
 *
 * ENFORCED IN THREE PLACES, ALL OF WHICH IMPORT THIS CONSTANT — normalizeAnswer()
 * here (the real enforcement), the endpoint's 413, and the textarea's `maxlength`
 * on the hub. marks.ts documents a fourth place that could NOT import its constant
 * because it was a client island; nothing here is one, so there is no restated
 * literal to drift.
 */
export const ANSWER_MAX = 400;

/**
 * THE PROMPTS.
 *
 * ---------------------------------------------------------------------------
 * THIS LIST IS COMMITTED AND REAL, WHICH IS THE OPPOSITE OF letters.ts
 *
 * letters.ts ships `[bracketed lowercase]` placeholders because a letter is
 * intimate by definition and this repository is PUBLIC, so a placeholder that
 * could be mistaken for something Sam wrote is the failure to design against.
 *
 * A daily question is different in kind: it is a prompt, not a disclosure. "what's
 * the best thing you ate this week" is not private, it is not embarrassing to
 * publish, and it works perfectly on day one with nothing configured. So the
 * committed list is genuine and usable, and this feature has no placeholder state
 * to fall out of.
 *
 * WHAT THE LIST IS SCREENED FOR, since it is world-readable:
 *   - Nothing that names a person, a place, a date or an event from their life.
 *   - Nothing whose ANSWER would be private even if the question is not — no
 *     questions about money, family conflict, health, or anybody's body.
 *   - Nothing that only makes sense to one of them, because a prompt that lands
 *     for one side and not the other breaks the symmetry the mechanic depends on.
 *   - Everything answerable in one sentence, by either of them, on a bad day.
 *
 * IF SAM WANTS PROMPTS THAT TRADE ON SHARED HISTORY, they go in `US_PROMPTS` —
 * base64(JSON) of `string[]`, which replaces this list WHOLESALE. Exactly the
 * mechanism `US_LETTERS` and `US_QUESTIONS` already use, for exactly the same
 * reason, and questions.mjs's header says the same thing about hints: if publishing
 * it would cost something, it belongs in an environment variable.
 *
 * A malformed `US_PROMPTS` falls back to this list and says so loudly. It
 * deliberately does not fall back to nothing: an empty prompt list means no
 * question today, which is indistinguishable from a broken feature.
 *
 * ---------------------------------------------------------------------------
 * ORDER MATTERS — see promptFor(). Adding to the END is free; inserting in the
 * MIDDLE shifts which day gets which prompt from that point on, which is harmless
 * but will mean today's question changes under them mid-day. Append.
 */
export const DEFAULT_PROMPTS: readonly string[] = [
  "what's the best thing you ate this week?",
  "what song has been stuck in your head?",
  "what's something small that went right today?",
  'what would you do with a free Saturday and no plans?',
  "what's the last thing that made you laugh out loud?",
  "what are you better at than you were a year ago?",
  "what's a place you keep meaning to go back to?",
  "what's the most useless thing you know a lot about?",
  'what would you order right now if you could have anything?',
  "what's something you're looking forward to that isn't a big deal?",
  "who crossed your mind today that you haven’t spoken to in ages?",
  "what's the last thing you saved a photo of?",
  "what's a habit you have quietly picked up?",
  'what would your ideal Tuesday morning look like?',
  "what's something you have changed your mind about?",
  "what's the best advice you were given that you actually took?",
  'what smell takes you straight back somewhere?',
  "what's the last thing you finished — book, show, anything?",
  "what do you do when you can’t sleep?",
  "what's a rule you have that nobody else would understand?",
  'what would you spend a whole afternoon on if nobody could interrupt?',
  "what's the nicest thing a stranger has done for you?",
  "what's your most-used app that isn't the obvious one?",
  "what's something you own that you would be sad to lose?",
  "what's a food you loved as a kid and would still eat now?",
  "what's the last thing you learned by accident?",
  "what's the weather doing where you are, and how do you feel about it?",
  "what's a small luxury worth every penny?",
  "what's the furthest you have walked in one go?",
  'what did you want to be when you were ten?',
  "what's a compliment you would like to be given?",
  "what's the last thing you fixed instead of replacing?",
  "what's a film you would happily watch again tonight?",
  "what's a word you love the sound of?",
  "what's something you are stubborn about?",
  'what would you put in a room if you got to design one?',
  "what's the best thing about where you are living right now?",
  "what's the worst haircut you have had?",
  'what do you always pack and never need?',
  "what's something you do that your family also does?",
  "what's a skill you would learn if it took a week instead of a year?",
  "what's the last thing you did for the first time?",
  "what's your move when you want to feel better fast?",
  "what's something you find beautiful that most people walk past?",
  "what's the last thing someone said that stuck with you?",
  'what would you do first with an extra hour today?',
  "what's a small thing you would like to be doing this time next year?",
  "what's the best thing that has happened this week, however small?",
] as const;

/**
 * Read one environment variable.
 *
 * A fourth copy of config.ts's `env()` — after ratelimit.ts's and letters.ts's —
 * and the duplication is deliberate for the reason both of those give: the lookup
 * ORDER has to match, or two files disagree about whether something is configured.
 * Bracket access on a VARIABLE, never `import.meta.env.US_PROMPTS`, because Vite
 * statically replaces the dotted form at build time and on Vercel that bakes in the
 * build container's answer — `undefined` — forever.
 */
function env(name: string): string | undefined {
  const fromMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromNode = typeof process !== 'undefined' ? process.env : undefined;
  const value = fromMeta?.[name] ?? fromNode?.[name];
  // Empty string is absent. Vercel's UI happily saves a blank value.
  return value && value.length > 0 ? value : undefined;
}

/* Cached against the RAW env string, not against a boolean, for letters.ts's two
   reasons: this runs on every render, and keying on the raw value means a changed
   variable is picked up by a warm instance on its next request rather than sticking
   until the instance is recycled. */
let promptsCacheKey: string | null = null;
let promptsCache: readonly string[] = DEFAULT_PROMPTS;

/** The prompts, validated. `US_PROMPTS` replaces the committed list wholesale. */
export function loadPrompts(): readonly string[] {
  const rawEnv = env('US_PROMPTS');
  const key = rawEnv ?? '';
  if (promptsCacheKey === key) return promptsCache;

  let out: readonly string[] = DEFAULT_PROMPTS;

  if (rawEnv) {
    let decoded: unknown = null;
    try {
      decoded = JSON.parse(Buffer.from(rawEnv, 'base64').toString('utf8'));
    } catch {
      console.error(
        '[us] US_PROMPTS is set but is not valid base64-encoded JSON — falling back ' +
          'to the committed prompt list.',
      );
    }
    if (Array.isArray(decoded)) {
      const cleaned = decoded
        .map((p) => (typeof p === 'string' ? oneLine(p, 200) : ''))
        .filter((p) => p.length > 0);
      if (cleaned.length > 0) out = cleaned;
      else
        console.error(
          '[us] US_PROMPTS decoded but held no usable strings — falling back to the ' +
            'committed prompt list.',
        );
    } else if (decoded !== null) {
      console.error('[us] US_PROMPTS decoded but is not an array — falling back.');
    }
  }

  /* A LIST WHOSE LENGTH IS A MULTIPLE OF SEVEN LOSES PROMPTS ENTIRELY.
     Sunday's slot is taken by WEEK_PROMPT, and prompt `i` is served on the days
     where `dayNumber ≡ i (mod n)`. When n and 7 share a factor those days do not
     walk through the weekdays — they land on the SAME weekday forever. So with
     n divisible by 7, every prompt at a Sunday index is never asked once, and no
     amount of waiting fixes it.
     Logged rather than corrected: silently dropping or duplicating one of his
     own prompts to make the arithmetic work would be a worse surprise than a
     line in the build output. */
  if (out.length > 0 && out.length % 7 === 0) {
    console.error(
      `[us] the prompt list has ${out.length} entries, a multiple of 7. Because ` +
        'Sunday is the week prompt, every 7th prompt would never be asked. Add or ' +
        'remove one.',
    );
  }

  promptsCacheKey = key;
  promptsCache = out;
  return promptsCache;
}

/** Days since the epoch for a wing date. The rotation's index. */
function dayNumber(date: string): number {
  const at = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(at) ? 0 : Math.floor(at / 86_400_000);
}

/**
 * 0 = Sunday. 1970-01-01 was a Thursday, hence the +4.
 *
 * Derived from `dayNumber` rather than from `new Date(date).getDay()`, which
 * would read the SERVER's timezone and put the week boundary in a third place —
 * neither Paris nor Los Angeles nor the wing's New York.
 */
function weekdayIndex(date: string): number {
  return ((dayNumber(date) + 4) % 7 + 7) % 7;
}

/**
 * THE WEEK, IN FIVE WORDS.
 *
 * ---------------------------------------------------------------------------
 * A SEVENTH OF THE DAILY QUESTION, NOT A SECOND FEATURE
 *
 * "Tell each other about the week" wants to be its own thing: its own key space,
 * its own record, its own seal, its own archive, its own endpoint, and the same
 * three storage tiers as everything else in this file. That is several hundred
 * lines to ask one question once a week.
 *
 * But it IS a question that both of them answer and then both of them see. That
 * is precisely what the daily question already is. So Sunday's slot in the
 * rotation simply becomes this instead, and the feature costs a constant and two
 * small functions: it gets the existing seal, the existing edit-until-revealed
 * rule, the existing late window, the existing archive table and the existing
 * endpoint, all for free and all already tested.
 *
 * What it costs is Sunday's ordinary prompt. That is not a loss. A week has one
 * day that is for looking back at the other six, and now the wing has one too.
 *
 * ---------------------------------------------------------------------------
 * THE ROTATION SURVIVES IT
 *
 * `promptFor` indexes the list by `dayNumber % list.length`, so skipping Sundays
 * skips whichever prompt would have landed there. Because prompt `i` appears on
 * days where `dayNumber ≡ i (mod 48)` and 48 and 7 are coprime, those days walk
 * through every weekday in turn — so each prompt loses one appearance in seven,
 * evenly, and NO prompt is ever permanently unreachable. If the list length ever
 * becomes a multiple of 7, that stops being true and some prompts would never be
 * asked at all, so loadPrompts() warns when a list is a multiple of 7.
 *
 * ---------------------------------------------------------------------------
 * FIVE WORDS IS AN INVITATION, NOT A VALIDATION
 *
 * There is deliberately no shorter cap and no word counting. The server ceiling
 * stays ANSWER_MAX for every day, because a second cap would mean either
 * `normalizeAnswer` taking a date — which it does not need for anything else —
 * or a `maxlength` on the textarea that disagrees with what the endpoint accepts.
 * A form that silently truncates at 60 and an endpoint that allows 400 is the
 * exact divergence the comment on maxlength in index.astro warns about.
 *
 * And if she answers in seven words, seven words is the right answer. This is a
 * gift, not a form. The brevity is the prompt's job.
 */
export const WEEK_PROMPT = 'your week, in five words';

/** True on Sundays in WING_TZ, where the week prompt replaces the rotation. */
export function isWeekPrompt(date: string): boolean {
  return weekdayIndex(date) === 0;
}

/**
 * Today's prompt. Deterministic, identical for both of them, stable all day.
 *
 * A SEQUENTIAL ROTATION, not a hash of the date, and the difference is worth the
 * sentence: `hash(date) % n` is what kv.ts's resurface() uses and it is right
 * there, because it is picking from a pool where repetition is fine. Here
 * repetition is the failure — a hash will serve the same prompt twice in a
 * fortnight and skip others for months, which reads as broken. Walking the list one
 * day at a time guarantees every prompt is asked before any is asked twice, so
 * forty-eight prompts is forty-eight days.
 *
 * Anchored to the epoch rather than to a start date so it needs no state and no
 * migration, and double-modulo so a pre-1970 date (impossible, but free to guard)
 * cannot produce a negative index.
 */
export function promptFor(date: string): string {
  // Sunday looks back at the other six. See WEEK_PROMPT for why this is a
  // seventh of this feature rather than a feature of its own.
  if (isWeekPrompt(date)) return WEEK_PROMPT;

  const list = loadPrompts();
  if (list.length === 0) return '';
  const i = ((dayNumber(date) % list.length) + list.length) % list.length;
  return list[i] ?? '';
}

/** One day's exchange, as STORED. Never handed to a page — see visibleDay(). */
export interface DayRecord {
  /** `YYYY-MM-DD` in WING_TZ. Also the primary key. */
  date: string;
  /** Her answer, or ''. */
  her: string;
  /** Epoch millis she answered. 0 when she has not. */
  herAt: number;
  him: string;
  himAt: number;
}

export function emptyDay(date: string): DayRecord {
  return { date, her: '', herAt: 0, him: '', himAt: 0 };
}

/**
 * One day as it is ALLOWED to reach the browser.
 *
 * THIS TYPE IS THE SEAL. Compare letters.ts's VisibleLetter: the field that must
 * not be sent is not blanked at render time, it is absent from the object. There is
 * no code path from a DayRecord to a page — everything goes through visibleDay().
 */
export interface VisibleDay {
  date: string;
  /** The question. Never secret; it is in a public repository. */
  prompt: string;
  /** MY answer. Always mine to read, revealed or not. '' when I have not answered. */
  mine: string;
  mineAt: number;
  /**
   * THEIR answer, and ONLY when both of us have answered. '' otherwise, and '' here
   * means ABSENT rather than empty: an unrevealed answer never enters this object.
   */
  theirs: string;
  theirsAt: number;
  /**
   * Have they answered yet?
   *
   * Safe to expose while sealed, and necessary: "she answered, yours is missing" is
   * the entire call to action, and it leaks nothing about WHAT she said. The same
   * judgement letters.ts makes about `teaser` — one fact is allowed out because its
   * whole contract is being safe to read early.
   */
  theyAnswered: boolean;
  /** Both answered. The only state in which `theirs` is populated. */
  revealed: boolean;
  /** May I still answer this one? False once it is past LATE_ANSWER_DAYS. */
  canAnswer: boolean;
  /** Nobody can answer it any more and it never got its second half. */
  closed: boolean;
  /**
   * May I REPLACE what I already wrote?
   *
   * ---------------------------------------------------------------------------
   * EDITABLE UNTIL THE REVEAL, FROZEN AFTER IT. THIS IS PART OF THE MECHANIC.
   *
   * Before both of us have answered there is nothing to react to, so changing my
   * answer is fixing a typo or finishing a sentence — and refusing that would mean a
   * mistyped answer is stuck on the page for a day. Harmless, so it is allowed.
   *
   * AFTER the reveal it is not harmless and it is not editing, it is rewriting. I
   * would be able to read what she said and then adjust what I "had" said to match,
   * agree with it, or be funnier about it. The whole value of the seal is that both
   * answers were written blind; an editable revealed answer hands that back on a
   * plate, and neither of us would ever be able to trust the coincidences again.
   *
   * So the freeze is not a storage constraint, it is the second half of the same
   * promise the seal makes. It lives on this object — rather than as a check inside
   * the endpoint — because the HUB needs the identical rule to decide whether to
   * render the form at all, and a rule enforced in one place and re-derived in the
   * other is a rule that eventually disagrees with itself.
   *
   * The window applies too: `age <= LATE_ANSWER_DAYS`. A day nobody can answer any
   * more is not a day whose answer can be swapped either.
   */
  editable: boolean;
  /**
   * Whole days from this record's date to today. 0 is today, 1 is yesterday.
   *
   * Exposed because both callers were otherwise going to recompute it, and the
   * arithmetic is the DST-safe UTC-anchored kind (see wholeDaysBetween) that kv.ts
   * and status.ts each had to get right separately. One number beats a third copy.
   */
  age: number;
}

/**
 * A stored day, from one person's side.
 *
 * `who` is the VIEWER. Every field above is relative to them, which is what lets
 * the hub render the same component for either of them and why the store never
 * needs to know who is looking.
 */
export function visibleDay(rec: DayRecord, who: Who, today: string): VisibleDay {
  const them = otherOne(who);
  const mine = rec[who];
  const theirs = rec[them];
  const revealed = mine.length > 0 && theirs.length > 0;
  const age = wholeDaysBetween(rec.date, today);

  return {
    date: rec.date,
    prompt: promptFor(rec.date),
    mine,
    mineAt: rec[`${who}At` as 'herAt' | 'himAt'],
    /* THE SEAL, in one expression. `theirs` is only ever read when `revealed` is
       already true, so there is no version of this object that carries their words
       alongside `revealed: false`. */
    theirs: revealed ? theirs : '',
    theirsAt: revealed ? rec[`${them}At` as 'herAt' | 'himAt'] : 0,
    theyAnswered: theirs.length > 0,
    revealed,
    /* A day is answerable if I have not answered it and it is inside the window.
       `age <= 0` covers today and — defensively — a date in the future, which can
       only come from a hand-edited record and should not be answerable-blocked on
       top of being wrong. */
    canAnswer: mine.length === 0 && age <= LATE_ANSWER_DAYS,
    closed: mine.length === 0 && age > LATE_ANSWER_DAYS,
    // Mine is written, theirs is not, and the day is still in the window. See the
    // field comment — the `!revealed` half of this is the mechanic, not a detail.
    editable: mine.length > 0 && !revealed && age <= LATE_ANSWER_DAYS,
    age,
  };
}

/**
 * Everything normalizeAnswer does EXCEPT the length cap.
 *
 * Split out because the store and the endpoint answer different questions, and
 * collapsing them is a bug marks.ts shipped and had to fix: once the normaliser
 * truncates, `normalizeAnswer(text).length > ANSWER_MAX` is permanently false, the
 * 413 becomes unreachable, and a 600-character answer is silently cut to 400. She
 * sends six hundred characters, sees four hundred, and has no way to know which end
 * went missing. So: tidyAnswer answers "how long is what she actually meant",
 * normalizeAnswer answers "what will be stored".
 *
 * It also folds CRLF to LF BEFORE measuring, which is load-bearing: HTML form
 * submission converts every LF to CRLF on the wire, so measuring the raw body would
 * count each line break she typed as two characters against a textarea `maxlength`
 * that counted it as one — and an answer that fit in the box would be refused by
 * the server.
 *
 * Deliberately NOT sanitised for HTML. Nothing in this repository interpolates an
 * answer into markup — Astro escapes every `{expression}` by default and there is no
 * `set:html` anywhere — so escaping here would mean storing `&amp;` and rendering
 * `&amp;` forever, which is the classic double-escape bug. The right place to escape
 * is the moment of rendering, and that place already does it.
 */
export function tidyAnswer(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return (
    raw
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex -- deliberate: strip invisibles
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      // A wall of blank lines is a paste artifact, never a decision.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** tidyAnswer, then capped. What actually gets stored. */
export function normalizeAnswer(raw: unknown): string {
  const cleaned = tidyAnswer(raw);
  return cleaned.length <= ANSWER_MAX ? cleaned : cutWithoutSplittingAnEmoji(cleaned, ANSWER_MAX);
}

/** An answer as paragraphs, so both halves render identically. */
export function answerParagraphs(text: string): string[] {
  return tidyAnswer(text)
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);
}

/* ============================================================================
   PART FOUR — THE SHARED LIST

   ---------------------------------------------------------------------------
   BOTH ADD, EITHER TICKS OFF, AND ONLY THE AUTHOR RETRACTS

   Three verbs, and the asymmetry between them is the design rather than an
   oversight:

     ADD    Either of them. `by` is stored and always displayed, because "he wants
            to do this" and "she wants to do this" are different pieces of
            information and a list that flattens them into one voice loses the best
            thing about it.

     TICK   Either of them, and reversible. Ticking is a claim about the WORLD — we
            did this — so it does not belong to whoever suggested it. Reversible
            because the realistic mistake is a mis-tap on a phone, and an
            irreversible tick would make the whole list something to be careful
            with.

     REMOVE Only the person who added it. Removing is retracting your own
            suggestion, which is a thing only you can mean. It also means a typo is
            fixable — without it, the only way to get rid of a bad line is to tick
            it off as though you had done it, which quietly corrupts the one part of
            this list that is a record of something real.

   ---------------------------------------------------------------------------
   THE CAPS, AND WHY THESE NUMBERS

     OPEN_CAP = 40. A list of things to do together is an INVITATION. Past about
     forty open lines it stops fitting on a phone screen in any useful way and
     becomes a backlog — and a backlog you are not getting through is a thing you
     feel guilty about, which is the precise feeling this entire wing exists to not
     produce. Forty is also more than they will realistically have: the cap is there
     so the failure is "tick something off first", not "the page got slow".

     TOTAL_CAP = 300. The ceiling on the document. One item is a 140-character line
     plus about 120 bytes of bookkeeping, so 300 is roughly 78KB — comfortably
     inside MAX_DOC_BYTES with the day records beside it.

   NOTHING IS EVER AUTO-DELETED TO STAY UNDER EITHER CAP. Both are enforced at ADD
   time, so hitting one is a refusal with a reason rather than the oldest thing they
   wrote together silently disappearing. marks.ts learned that lesson the expensive
   way (see its `orphans` field) and this file is not going to re-learn it: ticked
   items are the good part, they are proof of a year, and a cap is not a licence to
   delete them.
   ========================================================================= */

/** How long one line may be. See ITEM_MAX's reasoning below. */
export const ITEM_MAX = 140;
export const OPEN_CAP = 40;
export const TOTAL_CAP = 300;

export interface Item {
  /**
   * Server-generated, and the only thing that ever appears in a form field or
   * becomes a store key.
   *
   * A UUID rather than an incrementing number or a slug of the text: it needs no
   * coordination between two writers, it cannot collide, and it carries none of the
   * item's content — so an id in a URL or a log line reveals nothing. Validated by
   * LOOKUP and never by shape alone; see the store's own comment.
   */
  id: string;
  /** One line, escaped at render. Trimmed and capped — see ITEM_MAX. */
  text: string;
  /** Who suggested it. Displayed as a word, never as a colour alone. */
  by: Who;
  /** Epoch millis it was added. */
  at: number;
  done: boolean;
  /** Who ticked it. '' when it is not done. */
  doneBy: Who | '';
  /** Epoch millis it was ticked. 0 when it is not done. */
  doneAt: number;
}

const ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Is this the SHAPE of an id we would have minted?
 *
 * A cheap pre-filter and nothing more. It is what stops a caller filing ten
 * thousand distinct well-formed-looking keys into the document; it is NOT what
 * authorises a write. Every mutation additionally requires the id to SELECT an
 * existing item, which is the discipline marks.ts's isMarkId() and letters.ts's
 * isLetterId() both describe: an id selects a record, it never builds a key.
 */
export function isItemIdShape(value: unknown): value is string {
  return typeof value === 'string' && ITEM_ID_RE.test(value);
}

function newItemId(): string {
  return crypto.randomUUID();
}

/**
 * One line, flattened.
 *
 * Newlines become spaces on purpose: this is a list ITEM, which is a title, and a
 * title with a paragraph break in it breaks the column. Same split as elsewhere —
 * tidyItem measures what she meant, normalizeItem is what gets stored — and for the
 * same reason (see tidyAnswer).
 */
export function tidyItem(raw: unknown): string {
  return oneLine(raw, Number.POSITIVE_INFINITY);
}

export function normalizeItem(raw: unknown): string {
  const cleaned = tidyItem(raw);
  return cleaned.length <= ITEM_MAX ? cleaned : cutWithoutSplittingAnEmoji(cleaned, ITEM_MAX);
}

function parseItem(raw: unknown): Item | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error('[us] a stored list item is not JSON — ignoring it.');
      return null;
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return null;

  const id = typeof obj.id === 'string' ? obj.id : '';
  const text = normalizeItem(obj.text);
  // An item without a usable id or any text is not an item. Everything else
  // degrades, because a hand-edit must not cost her the rest of the list.
  if (!isItemIdShape(id) || !text) return null;

  const done = obj.done === true || obj.done === '1' || obj.done === 1;
  const doneBy = isWho(obj.doneBy) ? obj.doneBy : '';
  return {
    id,
    text,
    // Anything unrecognised is attributed to nobody-in-particular by defaulting to
    // 'her', which is wrong-but-harmless; the alternative is dropping the item, and
    // losing a line because its author field got mangled is the worse trade.
    by: isWho(obj.by) ? obj.by : 'her',
    at: count(obj.at),
    done,
    // Kept consistent on the way out: a done item with no doneBy is fine (the page
    // just says "done"), but a NOT-done item carrying a doneBy would render
    // "ticked off by her" next to an unticked box.
    doneBy: done ? doneBy : '',
    doneAt: done ? count(obj.doneAt) : 0,
  };
}

export interface Board {
  /** Not done. NEWEST FIRST — the thing you just thought of is the thing on your mind. */
  open: Item[];
  /** Done. MOST RECENTLY TICKED FIRST — this half is an archive. */
  done: Item[];
}

/**
 * Split and order the list.
 *
 * The two orderings disagree deliberately, the same way letters.ts's shelf() splits
 * `waiting` from `again`. Open items are a set of intentions and the newest one is
 * the live one, so newest first. Done items are a record, and the one you want to
 * look at is the one you just did, so most-recently-ticked first. One order for both
 * would make one of the halves behave wrongly for no reason.
 */
export function board(items: Record<string, Item>): Board {
  const all = Object.values(items);
  return {
    open: all.filter((i) => !i.done).sort((a, b) => b.at - a.at),
    done: all
      .filter((i) => i.done)
      // `doneAt || at` so a hand-edited item with no doneAt still sorts somewhere
      // sensible instead of sinking to the bottom forever.
      .sort((a, b) => (b.doneAt || b.at) - (a.doneAt || a.at)),
  };
}

/* ============================================================================
   SHARED HELPERS

   Small, pure, and each one is here because two of the four parts above need it.
   ========================================================================= */

/**
 * A non-negative integer, or 0. Rejects Infinity and NaN.
 *
 * Copied from marks.ts, including the reason it is not
 * `Math.max(0, Math.floor(Number(v)) || 0)`: that passes INFINITY straight through
 * (`JSON.parse('{"today":1e999}')` yields Infinity, and `Infinity || 0` is
 * Infinity), it survives `today += 1`, and JSON.stringify writes it as `null` —
 * which reads back as 0. A hand-edited value would silently reset the counter on the
 * next write, in exactly the hand-edit-at-1am scenario the parser exists to harden
 * against.
 */
function count(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * `slice()` counts UTF-16 CODE UNITS and an emoji is two of them, so cutting at
 * exactly `max` can land between a surrogate pair and store a LONE HIGH SURROGATE,
 * which every renderer draws as U+FFFD. Dropping the orphan costs one character from
 * a string that was already being cut. Lifted from marks.ts's normalizeNote.
 */
function cutWithoutSplittingAnEmoji(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Everything on one line: control characters gone, whitespace collapsed, trimmed. */
function oneLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const flat = raw
    // eslint-disable-next-line no-control-regex -- deliberate: strip invisibles
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= max ? flat : cutWithoutSplittingAnEmoji(flat, max);
}

/**
 * Whole days from one wing date to another. Negative when `to` is before `from`.
 *
 * Anchored at UTC midnight on both ends and divided by a flat 86400000, which is
 * exactly how kv.ts's shiftDate() and status.ts's daysUntil() do it, and for the
 * reason they both give: a wing date is a LABEL for a calendar day, not an instant,
 * so doing the arithmetic "in the wing's timezone" is what actually breaks. On the
 * two DST boundaries a local day is 23 or 25 hours long, and an age that quietly
 * gained or lost a day every spring would silently move the LATE_ANSWER_DAYS
 * boundary once a year.
 */
function wholeDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Sortable integer score for the Redis index: `2026-08-21` -> `20260821`. */
function dateScore(date: string): number {
  return Number(date.replace(/-/g, ''));
}

/**
 * Small numbers as words, because "3 times today" is a dashboard and "three times
 * today" is a sentence. Same list and the same reasoning as status.ts's spell();
 * copied rather than imported because status.ts is not mine to add an export to.
 */
const WORDS = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve',
];
function spell(n: number): string {
  return WORDS[n] ?? String(n);
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ============================================================================
   THE INTERFACE

   Six operations. Each one has to be implemented three times, so a seventh has to
   justify itself three times over — the bar kv.ts set and marks.ts and letters.ts
   both kept.

   Note what is NOT here: no composite "give me the hub". `getAll()` is one read
   because the hub needs all of it and three separate reads would be three GETs of
   one R2 object. Everything derived from it (board, visibleDay, thinkingLine) is a
   pure function over what it returned.

   BE PRECISE ABOUT WHAT A MUTATOR'S RETURN VALUE MEANS, because marks.ts's comment
   had to be corrected for over-claiming:

     upstash  a genuine re-read (HGETALL) after the write, because HSET and HINCRBY
              return nothing useful.
     r2       the value from the document whose CONDITIONAL PUT succeeded. Not a
              re-read, and stronger than one: a re-read could observe a later write
              by somebody else and report a value that was never ours, whereas an
              If-Match PUT that returned 200 proves these exact bytes are stored.
     memory   the object itself. There is nothing between it and the caller.
   ========================================================================= */

export interface Snapshot {
  thinking: Record<Who, Thinking>;
  /** date -> record, for the window asked for. Today is ALWAYS present. */
  days: Record<string, DayRecord>;
  /** item id -> item. */
  items: Record<string, Item>;
}

/** Why an add was refused. A reason, so the page can say something true. */
export type AddRefusal = 'open-full' | 'total-full';

export interface Store {
  readonly tier: Tier;
  /**
   * Everything the hub renders, in as few round trips as the data allows.
   *
   * `dayWindow` bounds how many past days come back. It is a page-layout number,
   * not a retention policy: nothing is ever deleted, and asking for 30 does not
   * make day 31 unreachable — it makes it not-rendered.
   */
  getAll(today: string, dayWindow: number): Promise<Snapshot>;
  /** Send one, unless the debounce swallowed it. Returns the state either way. */
  sendThinking(who: Who, nowMs: number, today: string): Promise<{ sent: boolean; record: Thinking }>;
  /** Write one person's answer for one day. Never touches the other's. */
  putAnswer(date: string, who: Who, text: string): Promise<DayRecord>;
  /** Add a line, or refuse with a reason. */
  addItem(text: string, by: Who, nowMs: number): Promise<{ item: Item } | { refused: AddRefusal }>;
  /** Tick or untick. null when the id selects nothing. */
  setItemDone(id: string, on: boolean, by: Who, nowMs: number): Promise<Item | null>;
  /** Retract your own. false when the id selects nothing OR is not theirs. */
  removeItem(id: string, by: Who): Promise<boolean>;
}

function emptySnapshot(today: string): Snapshot {
  return {
    thinking: { her: { ...NO_THINKING }, him: { ...NO_THINKING } },
    days: { [today]: emptyDay(today) },
    items: {},
  };
}

/* ============================================================================
   TIER 1 — UPSTASH REDIS over REST

   ONE HASH PER THING, which looks like the wasteful choice and is the opposite.

   The two `thinking` records are separate hashes, so my tap cannot clobber hers.
   Each DAY is its own hash with her fields and his fields side by side, so two
   people answering the same question in the same minute is one HSET each and NOT a
   read-modify-write — which matters more here than anywhere else in this file,
   because "we both answered at once" is the case the feature is designed to
   produce. And the list is one hash keyed by item id, so ticking one line is a
   single-field write that cannot touch another.

   Reading everything is a handful of HGETALLs in TWO pipelined round trips, which
   is about what one HGETALL costs and buys real atomicity where it counts.
   ========================================================================= */

/** `us:together:` — distinct from `us:song:`, `us:mark:`, `us:letter:`, `us:rl:`. */
const THINK_KEY = (who: Who) => `us:together:thinking:${who}`;
const DAY_KEY = (date: string) => `us:together:day:${date}`;
const DAY_INDEX = 'us:together:day:index';
const LIST_KEY = 'us:together:list';

type Command = (string | number)[];

/** One HTTP round trip for N commands. Verbatim shape from kv.ts and marks.ts. */
async function redis(url: string, token: string, cmds: Command[]): Promise<unknown[]> {
  if (cmds.length === 0) return [];

  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map((c) => c.map(String))),
      // See TIMEOUT_MS: a signal, not a cleared controller, so the deadline survives
      // into the body read.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // An abort is indistinguishable from a network failure to every caller.
    throw new TogetherError('upstash unreachable', { cause: err });
  }

  if (!res.ok) throw new TogetherError(`upstash HTTP ${res.status}`);

  let parsed: Array<{ result?: unknown; error?: string }>;
  try {
    parsed = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  } catch (err) {
    throw new TogetherError('upstash response body did not arrive or was not JSON', { cause: err });
  }
  if (!Array.isArray(parsed) || parsed.length !== cmds.length) {
    throw new TogetherError('upstash returned a malformed pipeline response');
  }

  return parsed.map((entry, i) => {
    // A per-command error is a bug in this file, not a runtime condition, so it is
    // fatal. Only the command NAME is logged — the arguments are their words.
    if (entry?.error) {
      throw new TogetherError(`upstash ${String(cmds[i][0])} failed: ${entry.error}`);
    }
    return entry?.result ?? null;
  });
}

/**
 * Upstash returns a hash as a FLAT array `[field, value, field, value]`, not as an
 * object. Folding it here rather than at each call site is what stops one getter
 * quietly reading `raw.her` off an array and always seeing undefined.
 */
function foldHash(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
  } else if (raw && typeof raw === 'object') {
    // Some Upstash responses are already objects. Accept both rather than depending
    // on which.
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  }
  return out;
}

/** A day hash's four fields, as a DayRecord. */
function dayFromHash(date: string, h: Record<string, string>): DayRecord {
  return {
    date,
    her: normalizeAnswer(h.her ?? ''),
    herAt: count(h.herAt),
    him: normalizeAnswer(h.him ?? ''),
    himAt: count(h.himAt),
  };
}

function upstashStore(url: string, token: string): Store {
  const run = (cmds: Command[]) => redis(url, token, cmds);

  const readItems = async (): Promise<Record<string, Item>> => {
    const [raw] = await run([['HGETALL', LIST_KEY]]);
    return itemsFromHash(foldHash(raw));
  };

  const readOneItem = async (id: string): Promise<Item | null> => {
    const [raw] = await run([['HGET', LIST_KEY, id]]);
    return parseItem(raw);
  };

  return {
    tier: 'upstash',

    async getAll(today, dayWindow) {
      const first = await run([
        ['HGETALL', THINK_KEY('her')],
        ['HGETALL', THINK_KEY('him')],
        ['ZRANGE', DAY_INDEX, 0, Math.max(0, dayWindow - 1), 'REV'],
        ['HGETALL', LIST_KEY],
      ]);

      const indexed = (Array.isArray(first[2]) ? first[2] : []).filter(isWingDate) as string[];
      /* TODAY IS UNIONED IN UNCONDITIONALLY, and that is not belt-and-braces. The
         index only holds days somebody has answered, so on a day nobody has answered
         yet today is simply absent — and today is the one day the hub always has to
         render. Without this, the question card would vanish every morning until one
         of them typed something. */
      const dates = [...new Set([today, ...indexed])].filter(isWingDate);

      const dayResults = await run(dates.map((d) => ['HGETALL', DAY_KEY(d)]));
      const days: Record<string, DayRecord> = {};
      dates.forEach((d, i) => {
        days[d] = dayFromHash(d, foldHash(dayResults[i]));
      });

      return {
        thinking: {
          her: parseThinking(foldHash(first[0])),
          him: parseThinking(foldHash(first[1])),
        },
        days,
        items: itemsFromHash(foldHash(first[3])),
      };
    },

    async sendThinking(who, nowMs, today) {
      const [raw] = await run([['HGETALL', THINK_KEY(who)]]);
      const before = parseThinking(foldHash(raw));
      /* THE DEBOUNCE IS A READ-THEN-DECIDE AND IS NOT A LOCK, exactly like marks.ts's
         countVisit. Two taps in the same instant from two tabs both pass the window
         test and both land, so the count can read one high. That is a cosmetic error
         in a decorative number, and serialising it would mean a lock on the path that
         says "I am thinking about you" — a spectacularly bad trade. */
      if (before.last > 0 && nowMs - before.last < THINKING_DEBOUNCE_MS) {
        return { sent: false, record: before };
      }
      const todayCount = before.day === today ? before.today + 1 : 1;
      // HINCRBY for `total` because it is free and correct; HSET for the rest,
      // because `today` depends on a day comparison no single command can make.
      const [counted] = await run([
        ['HINCRBY', THINK_KEY(who), 'total', 1],
        [
          'HSET',
          THINK_KEY(who),
          'last',
          String(nowMs),
          'day',
          today,
          'today',
          String(todayCount),
        ],
      ]);
      return {
        sent: true,
        record: {
          last: nowMs,
          day: today,
          today: todayCount,
          total: Math.max(1, Number(counted) || before.total + 1),
        },
      };
    },

    async putAnswer(date, who, text) {
      /* Two fields, one command, no read-modify-write. THIS is the atomicity a
         hash-per-day buys and it is the most valuable line in this tier: he cannot
         clobber the answer she is submitting in the same second, which is exactly
         the collision this feature is built to cause. */
      await run([
        ['HSET', DAY_KEY(date), who, text, `${who}At`, String(Date.now())],
        // ZADD on an existing member updates its score rather than duplicating it,
        // so both of them answering the same day never doubles the index entry.
        ['ZADD', DAY_INDEX, dateScore(date), date],
      ]);
      const [raw] = await run([['HGETALL', DAY_KEY(date)]]);
      return dayFromHash(date, foldHash(raw));
    },

    async addItem(text, by, nowMs) {
      /* Read-then-decide for the caps, which is not atomic and does not need to be:
         with two humans the worst case is a 41st open item, and the cap's job is to
         stop the list becoming a backlog rather than to be a hard invariant. */
      const existing = await readItems();
      const refusal = capRefusal(existing);
      if (refusal) return { refused: refusal };

      const item: Item = {
        id: newItemId(),
        text,
        by,
        at: nowMs,
        done: false,
        doneBy: '',
        doneAt: 0,
      };
      await run([['HSET', LIST_KEY, item.id, JSON.stringify(item)]]);
      return { item };
    },

    async setItemDone(id, on, by, nowMs) {
      // SELECTS the record first. A well-formed id that is not in the hash is not an
      // item, so there is nothing to tick and nothing is written.
      const before = await readOneItem(id);
      if (!before) return null;
      const next = tickedItem(before, on, by, nowMs);
      await run([['HSET', LIST_KEY, id, JSON.stringify(next)]]);
      return next;
    },

    async removeItem(id, by) {
      const before = await readOneItem(id);
      // Ownership is checked against the STORED author, never against anything the
      // request said. See the section header for why only the author may retract.
      if (!before || before.by !== by) return false;
      await run([['HDEL', LIST_KEY, id]]);
      return true;
    },
  };
}

/** id -> item, dropping anything unparseable. Shared by the Upstash and R2 tiers. */
function itemsFromHash(h: Record<string, string>): Record<string, Item> {
  const out: Record<string, Item> = {};
  for (const [id, raw] of Object.entries(h)) {
    const item = parseItem(raw);
    // Keyed by the item's OWN id, not by the hash field, so a field renamed by hand
    // cannot produce a record whose key and id disagree.
    if (item) out[item.id] = item;
  }
  return out;
}

/** Which cap, if any, this add would break. null when it is fine. */
function capRefusal(items: Record<string, Item>): AddRefusal | null {
  const all = Object.values(items);
  if (all.length >= TOTAL_CAP) return 'total-full';
  if (all.filter((i) => !i.done).length >= OPEN_CAP) return 'open-full';
  return null;
}

/**
 * The item after a tick. Pure, so all three tiers produce the same thing.
 *
 * Ticking an already-ticked item does NOT re-stamp `doneAt`. That is deliberate: the
 * stamp is when it happened, and a double-tap on a phone must not rewrite history to
 * say they did it today.
 */
function tickedItem(before: Item, on: boolean, by: Who, nowMs: number): Item {
  if (!on) return { ...before, done: false, doneBy: '', doneAt: 0 };
  if (before.done) return { ...before };
  return { ...before, done: true, doneBy: by, doneAt: nowMs };
}

/* ============================================================================
   TIER 2 — CLOUDFLARE R2, one JSON object

   Read the whole document, change one field, write the whole document back.
   Everything about this tier follows from that sentence.

   It is NOT a transaction and must never be described as one. It is also not the
   silent-loss race kv.ts documents for its songs document, and the difference is one
   header: every PUT carries `If-Match: <etag>` from the GET it was built on, so a
   write that lost a race comes back 412 instead of quietly clobbering. mutateDoc
   re-reads and retries once; a second conflict throws and the endpoint answers 502.

   WORTH BUILDING HERE FOR A REASON THE OTHER TWO FILES ONLY HAD IN THEORY: this
   document has TWO HUMAN WRITERS BY DESIGN. marks.ts justified If-Match on one
   gesture firing two writes; letters.ts on one person with two devices. Here, "both
   of them write within the same second" is not the unlucky case, it is the thing the
   daily question is engineered to make happen. Without If-Match, the loser's answer
   would vanish under a page that said it had been saved — the exact outcome this
   file's header calls the worst available.
   ========================================================================= */

/** Must not be `data/songs.json`, `data/marks.json` or `data/letters.json`. */
const R2_DOC_KEY = 'data/together.json';

interface TogetherDoc {
  /** Schema version. Present from day one so a future migration has a hinge. */
  v: 1;
  thinking: Record<Who, Thinking>;
  /** date -> record, for dates that are real wing dates. */
  days: Record<string, DayRecord>;
  /** item id -> item. */
  items: Record<string, Item>;
  /**
   * Day keys that are NOT real wing dates, and items that would not parse, carried
   * through byte-for-byte.
   *
   * marks.ts learned this the expensive way and the bug was the worst kind: silent,
   * permanent, and triggered by a page view rather than by a write. Its first
   * version pruned unknown ids on READ and returned the pruned document as valid,
   * after which every writer persisted the pruned version.
   *
   * The same shape of mistake is available here in two flavours — a day key mangled
   * by a hand-edit, and an item whose JSON got broken in the Cloudflare dashboard.
   * Neither is a licence to delete somebody's answer. They are preserved, they are
   * logged loudly, and they are put back on every write.
   */
  orphans: Record<string, unknown>;
  /**
   * Any other top-level field, carried through and never interpreted.
   *
   * Same class of bug one level up: a document rebuilt from only the fields THIS
   * deploy knows about means an older instance silently erases whatever a newer
   * schema added. Two versions of a serverless function overlap for minutes after
   * every deploy, so this is not hypothetical.
   */
  extra: Record<string, unknown>;
}

const EMPTY_DOC: TogetherDoc = {
  v: 1,
  thinking: { her: { ...NO_THINKING }, him: { ...NO_THINKING } },
  days: {},
  items: {},
  orphans: {},
  extra: {},
};

/**
 * Refuse to read a document larger than this.
 *
 * The ceiling is arithmetic, not a guess. Two parts:
 *
 *   THE LIST is bounded by construction: TOTAL_CAP (300) items at ITEM_MAX (140)
 *   characters plus ~120 bytes of bookkeeping is about 78KB, and nothing can exceed
 *   it because the cap is enforced at add time.
 *
 *   THE DAY RECORDS ARE NOT BOUNDED, because nothing here ever deletes one. Two
 *   answers of ANSWER_MAX (400) plus bookkeeping is ~900 bytes a day, so a year is
 *   ~330KB at the absolute worst and realistically a third of that — nobody types
 *   four hundred characters at breakfast every day for a year.
 *
 * So 2MB holds roughly five years of both of them answering every single day at
 * maximum length, plus a full list. Anything bigger is not a big document, it is the
 * wrong object, and reading it would spend the whole invocation on bytes we would
 * throw away. Checked against Content-Length BEFORE the body is read, because the
 * point is to not download it.
 *
 * TRIMMING WAS CONSIDERED AND REJECTED. Keeping the newest N days and dropping the
 * rest would bound this exactly — and it would mean the room silently deleting
 * things they wrote to each other, on a schedule, forever. That is the one thing
 * marks.ts's `orphans` field exists to say never again. A warning at
 * DOC_WARN_BYTES is the honest version: it makes "the hub got slow" a five-second
 * diagnosis instead of a mystery, and it leaves the decision to a human.
 */
const MAX_DOC_BYTES = 2 * 1024 * 1024;

/** Loud past this, and still read in full. See MAX_DOC_BYTES. */
const DOC_WARN_BYTES = 400 * 1024;

/**
 * A client per process, not per call.
 *
 * `retries: 1` is a deliberate override of aws4fetch's default of 10. Those retries
 * use exponential backoff from 50ms — 50+100+200+...+25600, about 51 seconds — and
 * would happily spend this whole serverless invocation on a bucket that is down. One
 * retry absorbs a blip; ten absorb an outage by hanging.
 *
 * `region: 'auto'` because R2 has no regions but SigV4 requires one in the credential
 * scope, and 'auto' is the value Cloudflare documents for its S3 API. Passed
 * explicitly rather than left to aws4fetch's hostname sniff: relying on a heuristic
 * for the two values that go into the credential scope is a silent 403 waiting for
 * the day the heuristic changes.
 */
let r2Client: AwsClient | null = null;
/**
 * Fingerprint of the credential the cached client was built with.
 *
 * BOTH halves, not just the key id. A secret-only rotation — same R2_ACCESS_KEY_ID,
 * new R2_SECRET_ACCESS_KEY — is an ordinary thing to do, and keying only on the id
 * would leave a warm instance signing every request with the dead secret. The symptom
 * is a 403 surfaced as `502 store` on one instance and nowhere else, which is close
 * to undiagnosable.
 */
let r2ClientFingerprint: string | null = null;

function r2(): { client: AwsClient; base: string } {
  const { accessKeyId, secretAccessKey, bucket } = r2Config();
  const endpoint = r2Endpoint();
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) {
    throw new TogetherError('r2 selected but not fully configured');
  }
  // NUL as the separator so `ab` + `c` and `a` + `bc` cannot collide. Written as an
  // ESCAPE, not a literal: a raw control byte is invisible in a diff and one editor
  // mangling it would silently change the fingerprint.
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
 * Key -> the path to put in the URL, encoded PER SEGMENT so `/` survives as a
 * separator.
 *
 * `data/together.json` contains nothing that needs escaping today, so this looks like
 * ceremony. It is not: photos.ts documents a whole class of SignatureDoesNotMatch that
 * comes from aws4fetch canonicalising with encodeURIComponent while sending the raw
 * character, and the day somebody renames this key to something with an `@` or a space
 * in it, the failure is a 403 that looks exactly like a credentials problem. Encoding
 * up front means that day never comes.
 */
function encodeKeyForUrl(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * Shape-check a document read from the bucket. Returns null when unusable.
 *
 * NOTHING IS DISCARDED. Fields this deploy understands are normalised; unrecognised
 * day keys, unparseable items and unknown top-level keys are carried into `orphans`
 * and `extra` and written back verbatim. See the comments on those two fields.
 */
function parseDoc(text: string): TogetherDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  /* `days` is the structural field: a document without it is not a together
     document. `thinking` and `items` are both ADDITIVE and optional, so their
     absence must never make the document unreadable — that is the same call kv.ts
     makes about `replies`, and it is what lets a document written before one of
     these three features existed still be read by the deploy that added it. */
  const days =
    obj.days && typeof obj.days === 'object' && !Array.isArray(obj.days)
      ? (obj.days as Record<string, unknown>)
      : null;
  if (!days) return null;

  const out: TogetherDoc = {
    v: 1,
    thinking: { her: { ...NO_THINKING }, him: { ...NO_THINKING } },
    days: {},
    items: {},
    orphans: {},
    extra: {},
  };

  const thinking =
    obj.thinking && typeof obj.thinking === 'object' && !Array.isArray(obj.thinking)
      ? (obj.thinking as Record<string, unknown>)
      : {};
  out.thinking.her = parseThinking(thinking.her);
  out.thinking.him = parseThinking(thinking.him);

  for (const [date, value] of Object.entries(days)) {
    if (isWingDate(date)) {
      const d = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      out.days[date] = {
        date,
        her: normalizeAnswer(d.her),
        herAt: count(d.herAt),
        him: normalizeAnswer(d.him),
        himAt: count(d.himAt),
      };
    } else {
      out.orphans[`days:${date}`] = value;
    }
  }

  const items =
    obj.items && typeof obj.items === 'object' && !Array.isArray(obj.items)
      ? (obj.items as Record<string, unknown>)
      : {};
  for (const [id, value] of Object.entries(items)) {
    const item = parseItem(value);
    if (item) out.items[item.id] = item;
    else out.orphans[`items:${id}`] = value;
  }

  for (const key of Object.keys(obj)) {
    if (key !== 'v' && key !== 'thinking' && key !== 'days' && key !== 'items') {
      out.extra[key] = obj[key];
    }
  }

  if (Object.keys(out.orphans).length > 0) {
    // Loud, once per read. The only way an orphan exists is that something was
    // hand-edited, so this is telling Sam that a record is sitting in the bucket
    // being preserved rather than read — and where to look for it.
    console.warn(
      `[us] ${R2_DOC_KEY} holds ${Object.keys(out.orphans).length} record(s) this deploy ` +
        `cannot read: ${Object.keys(out.orphans).join(', ')}. They are being PRESERVED, ` +
        'not deleted. Fix them by hand in the Cloudflare dashboard.',
    );
  }
  return out;
}

/** The document as it goes back on the wire. Orphans and extras restored. */
function serialiseDoc(doc: TogetherDoc): string {
  const days: Record<string, unknown> = { ...doc.days };
  const items: Record<string, unknown> = { ...doc.items };
  /* Orphans go back into the sub-object they came from. The `days:` / `items:`
     prefix is stripped here and nowhere else, so the round trip is exact and an
     orphan that is later fixed by hand simply starts parsing. */
  for (const [key, value] of Object.entries(doc.orphans)) {
    if (key.startsWith('days:')) days[key.slice(5)] = value;
    else if (key.startsWith('items:')) items[key.slice(6)] = value;
  }
  return JSON.stringify({
    ...doc.extra,
    v: 1,
    thinking: doc.thinking,
    days,
    items,
  });
}

/** Read the document, plus the ETag needed to write it back conditionally. */
async function readDoc(): Promise<{ doc: TogetherDoc; corrupt: boolean; etag: string | null }> {
  const { client, base } = r2();
  let res: Response;
  try {
    res = await client.fetch(`${base}/${encodeKeyForUrl(R2_DOC_KEY)}`, {
      method: 'GET',
      // A timeout SIGNAL, not a controller cleared in a `finally`. `fetch` resolves
      // on response HEADERS, so a cleared timer leaves the body download with no
      // deadline and a bucket that answers 200 then stalls hangs the invocation.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new TogetherError('r2 unreachable', { cause: err });
  }

  // 404 is the normal first-run state, not an error: nobody has tapped, answered or
  // added anything. A null etag then means "there must be no object", which writeDoc
  // turns into If-None-Match: * so two cold instances cannot both create it.
  if (res.status === 404) return { doc: structuredClone(EMPTY_DOC), corrupt: false, etag: null };
  if (!res.ok) throw new TogetherError(`r2 GET HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOC_BYTES) {
    // Not read, not parsed, and deliberately NOT treated as corrupt-and-empty: that
    // path degrades a READ to empty, and degrading to empty for an object we never
    // looked at would let a subsequent write replace it with a small one.
    throw new TogetherError(
      `r2 GET returned ${declared} bytes for ${R2_DOC_KEY}; refusing to read it`,
    );
  }
  if (Number.isFinite(declared) && declared > DOC_WARN_BYTES) {
    console.warn(
      `[us] ${R2_DOC_KEY} is ${declared} bytes. Read in full anyway — nothing here is ` +
        `ever auto-deleted — but the hard ceiling is ${MAX_DOC_BYTES}, so this is the ` +
        'reason the hub is slow if it is. See MAX_DOC_BYTES in together.ts.',
    );
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // Reached when the timeout signal fires mid-body, which is the whole point of a
    // signal that outlives the header exchange.
    throw new TogetherError('r2 response body did not arrive', { cause: err });
  }

  /* STRIP THE WEAK-ETAG PREFIX, OR EVERY CONDITIONAL WRITE FAILS FOREVER.
     R2 returns a document of this shape with a WEAK validator — `W/"8f5f..."`.
     RFC 7232 §3.1 says If-Match uses the STRONG comparison function, and a weak
     validator never matches under it, so passing R2's header through verbatim makes
     every PUT a guaranteed 412: mutateDoc burns its one retry, hits a second 412,
     throws, and the endpoint answers 502. In marks.ts that meant `keep`, `note` and
     `seen` were 100% broken against the real bucket while every unit test passed.

     Why tests miss it: a stubbed S3 issues STRONG ETags, weakness is not something
     you would think to stub, and a small fresh object in R2 really does come back
     strong — so a hand probe of If-Match also succeeds. Only a document at this size
     is weak, so nothing short of writing to the live bucket shows it.

     Stripping `W/` is safe HERE SPECIFICALLY because R2's validator is derived from
     the object's content, so the remaining opaque value still changes whenever the
     bytes change — which is the only property optimistic concurrency needs. It is
     not a general-purpose weak-to-strong promotion and must not be copied as one. */
  const rawEtag = res.headers.get('etag');
  const etag = rawEtag ? rawEtag.replace(/^W\//, '') : null;

  const parsed = parseDoc(text);
  if (!parsed) {
    // Reads degrade to empty so the hub still renders. Writes do NOT (below):
    // overwriting an object we could not understand is how a bad deploy turns into a
    // deleted year of answers.
    console.error(`[us] ${R2_DOC_KEY} exists but is not a together document — reading as empty.`);
    return { doc: structuredClone(EMPTY_DOC), corrupt: true, etag };
  }
  return { doc: parsed, corrupt: false, etag };
}

/**
 * Write the document back, but ONLY if it has not changed since we read it.
 *
 * If-None-Match: * on first creation, so two cold instances racing to create the
 * object cannot both "succeed" with one of them silently overwritten.
 */
async function writeDoc(
  doc: TogetherDoc,
  etag: string | null,
): Promise<{ ok: true } | { conflict: true }> {
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
    throw new TogetherError('r2 unreachable', { cause: err });
  }
  // 412 (If-Match lost) and 409 (how some S3 implementations answer a failed
  // If-None-Match) are both "somebody else got there first".
  if (res.status === 412 || res.status === 409) return { conflict: true };
  if (!res.ok) throw new TogetherError(`r2 PUT HTTP ${res.status}`);
  return { ok: true };
}

/**
 * Read, apply, write conditionally, retry ONCE on a conflict.
 *
 * One retry, not a loop: with two humans a conflict is already surprising, and an
 * unbounded retry against a document somebody is writing in a tight loop is how a
 * serverless function times out instead of failing. A second conflict throws, the
 * endpoint answers 502, and they send again — safe, because every operation here is
 * idempotent by construction except the `thinking` counter, whose debounce makes a
 * retry inside thirty minutes a no-op anyway.
 *
 * NOTE ON WHAT THE RETURNED VALUE MEANS: it is from the document whose conditional
 * PUT SUCCEEDED, so it is what is now durably stored — stronger than a read-back,
 * which could observe a third party's later write and report something that was
 * never ours.
 */
async function mutateDoc<T>(apply: (doc: TogetherDoc) => T): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential by nature: attempt 2
    // must read whatever attempt 1 lost to.
    const { doc, corrupt, etag } = await readDoc();
    if (corrupt) {
      throw new TogetherError(
        `refusing to overwrite ${R2_DOC_KEY}: it exists but is not a valid together document`,
      );
    }
    const result = apply(doc);
    // eslint-disable-next-line no-await-in-loop -- same
    const wrote = await writeDoc(doc, etag);
    if ('ok' in wrote) return result;
    console.warn(`[us] ${R2_DOC_KEY} changed under a write; re-reading and trying once more.`);
  }
  throw new TogetherError(
    `${R2_DOC_KEY} is being written concurrently; gave up after two attempts rather than ` +
      "overwriting somebody else's change",
  );
}

function r2Store(): Store {
  return {
    tier: 'r2',

    async getAll(today, dayWindow) {
      const { doc } = await readDoc();
      /* The window is applied HERE, on the way out, and not by forgetting days on the
         way in. The document holds everything; this is a page-layout limit. Newest
         first, then today unioned in so the question card exists on a day nobody has
         answered. */
      const dates = Object.keys(doc.days)
        .filter(isWingDate)
        .sort((a, b) => b.localeCompare(a))
        .slice(0, Math.max(0, dayWindow));
      const days: Record<string, DayRecord> = {};
      for (const d of dates) days[d] = doc.days[d];
      days[today] ??= emptyDay(today);
      return { thinking: doc.thinking, days, items: doc.items };
    },

    async sendThinking(who, nowMs, today) {
      /* Read WITHOUT a write first, so a tap inside the debounce costs one GET and no
         PUT at all. Going through mutateDoc would PUT the whole document back to
         discover it had nothing to change. */
      const { doc, corrupt, etag } = await readDoc();
      if (corrupt) {
        throw new TogetherError(
          `refusing to overwrite ${R2_DOC_KEY}: it exists but is not a valid together document`,
        );
      }
      const before = doc.thinking[who];
      if (before.last > 0 && nowMs - before.last < THINKING_DEBOUNCE_MS) {
        return { sent: false, record: { ...before } };
      }
      const next: Thinking = {
        last: nowMs,
        day: today,
        today: before.day === today ? before.today + 1 : 1,
        total: before.total + 1,
      };
      doc.thinking[who] = next;
      /* A CONFLICT HERE IS A FAILURE, NOT A SHRUG, which is the opposite of what
         marks.ts's countVisit does with its visit tick — and the difference is who
         asked for it. A visit tick is something the page does on her behalf and
         losing one costs a decorative number. This is a BUTTON SOMEBODY PRESSED, and
         a tap that silently did not send is a tap she believes I received. So it
         throws, the endpoint answers 502, and she can press it again. */
      const wrote = await writeDoc(doc, etag);
      if (!('ok' in wrote)) {
        throw new TogetherError(
          `${R2_DOC_KEY} changed under a thinking-of-you write; it did not send`,
        );
      }
      return { sent: true, record: next };
    },

    async putAnswer(date, who, text) {
      return mutateDoc((doc) => {
        const rec = (doc.days[date] ??= emptyDay(date));
        /* Only this person's two fields are touched. On this tier that is a property
           of the code rather than of the protocol — the whole document is rewritten
           either way — so If-Match is what actually protects the other half. The
           narrow assignment is still worth writing: it means a bug here cannot reach
           their answer even in the version of the document we do write. */
        rec[who] = text;
        rec[`${who}At` as 'herAt' | 'himAt'] = Date.now();
        return { ...rec };
      });
    },

    async addItem(text, by, nowMs) {
      return mutateDoc<{ item: Item } | { refused: AddRefusal }>((doc) => {
        const refusal = capRefusal(doc.items);
        if (refusal) return { refused: refusal };
        const item: Item = {
          id: newItemId(),
          text,
          by,
          at: nowMs,
          done: false,
          doneBy: '',
          doneAt: 0,
        };
        doc.items[item.id] = item;
        return { item };
      });
    },

    async setItemDone(id, on, by, nowMs) {
      return mutateDoc((doc) => {
        // SELECTS the record. A well-formed id that is not in the document is not an
        // item, so nothing is created and nothing is written.
        const before = doc.items[id];
        if (!before) return null;
        const next = tickedItem(before, on, by, nowMs);
        doc.items[id] = next;
        return next;
      });
    },

    async removeItem(id, by) {
      return mutateDoc((doc) => {
        const before = doc.items[id];
        // Ownership from the STORED author, never from the request.
        if (!before || before.by !== by) return false;
        delete doc.items[id];
        return true;
      });
    },
  };
}

/* ============================================================================
   TIER 3 — IN-PROCESS MAP

   Non-durable, per instance. Implemented directly against plain objects rather than
   by emulating Redis, because a fake Redis is a second thing that can be subtly
   wrong and this tier's only job is to be obviously correct for one developer on one
   laptop.
   ========================================================================= */

const memory = {
  thinking: { her: { ...NO_THINKING }, him: { ...NO_THINKING } } as Record<Who, Thinking>,
  days: new Map<string, DayRecord>(),
  items: new Map<string, Item>(),
};

function memoryStore(): Store {
  const itemsObject = (): Record<string, Item> => {
    const out: Record<string, Item> = {};
    for (const [id, i] of memory.items) out[id] = { ...i };
    return out;
  };

  return {
    tier: 'memory',

    async getAll(today, dayWindow) {
      const dates = [...memory.days.keys()]
        .filter(isWingDate)
        .sort((a, b) => b.localeCompare(a))
        .slice(0, Math.max(0, dayWindow));
      const days: Record<string, DayRecord> = {};
      for (const d of dates) days[d] = { ...memory.days.get(d)! };
      days[today] ??= emptyDay(today);
      return {
        thinking: { her: { ...memory.thinking.her }, him: { ...memory.thinking.him } },
        days,
        items: itemsObject(),
      };
    },

    async sendThinking(who, nowMs, today) {
      const before = memory.thinking[who];
      if (before.last > 0 && nowMs - before.last < THINKING_DEBOUNCE_MS) {
        return { sent: false, record: { ...before } };
      }
      const next: Thinking = {
        last: nowMs,
        day: today,
        today: before.day === today ? before.today + 1 : 1,
        total: before.total + 1,
      };
      memory.thinking[who] = next;
      return { sent: true, record: { ...next } };
    },

    async putAnswer(date, who, text) {
      const rec = memory.days.get(date) ?? emptyDay(date);
      rec[who] = text;
      rec[`${who}At` as 'herAt' | 'himAt'] = Date.now();
      memory.days.set(date, rec);
      return { ...rec };
    },

    async addItem(text, by, nowMs) {
      const refusal = capRefusal(itemsObject());
      if (refusal) return { refused: refusal };
      const item: Item = { id: newItemId(), text, by, at: nowMs, done: false, doneBy: '', doneAt: 0 };
      memory.items.set(item.id, item);
      return { item };
    },

    async setItemDone(id, on, by, nowMs) {
      const before = memory.items.get(id);
      if (!before) return null;
      const next = tickedItem(before, on, by, nowMs);
      memory.items.set(id, next);
      return { ...next };
    },

    async removeItem(id, by) {
      const before = memory.items.get(id);
      if (!before || before.by !== by) return false;
      memory.items.delete(id);
      return true;
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
 * reasoning: `import.meta.env` is read at request time on Vercel, and a value frozen
 * during the build container's module evaluation would be the build container's
 * answer forever.
 */
export function togetherTier(): Tier {
  if (hasKV()) return 'upstash';
  if (hasR2()) return 'r2';
  return 'memory';
}

/**
 * Announced ONCE per process, the first time the store is touched.
 *
 * Not decoration. The failure it prevents is the quiet one: a production deploy that
 * silently landed on the memory tier because an environment variable was renamed,
 * where every symptom is "the answers sometimes vanish" and no log line ever says
 * why. One line at cold start makes that a five-second diagnosis.
 */
let announced = false;
function announce(tier: Tier): void {
  if (announced) return;
  announced = true;
  if (tier === 'memory') {
    console.warn(
      '[us] together store: IN-PROCESS MEMORY. Non-durable and per-instance — every ' +
        'tap, every answer and every line on the list is lost on the next restart, and ' +
        'an answer written by one instance is invisible to the next request. Set ' +
        'UPSTASH_REDIS_REST_URL/_TOKEN or the R2_* variables before this is real.',
    );
  } else {
    console.log(`[us] together store: ${tier}`);
  }
}

function store(): Store {
  const tier = togetherTier();
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

   Free functions rather than "get the store, then call it", so no caller ever holds
   a backend-specific object and none of them can grow a branch on which tier is
   live.

   Two flavours, and choosing between them is the caller's one real decision:

     THROWING  (sendThinking, putAnswer, addItem, ...) — for the endpoints. A write
               that failed has to be a 502 they can retry.
     SAFE      (getAllSafe)                            — for the hub. All of this is
               a block on a page that must render regardless, so a dead store costs
               her the three blocks and never the front door.
   ========================================================================= */

/**
 * How many past days the hub asks for.
 *
 * Thirty. It is a LAYOUT number and not a retention policy — nothing is deleted, and
 * day 31 is still in the store. Thirty is what fits behind a `<details>` on a phone
 * without becoming a scroll of its own, and a month is the span over which "the ones
 * before" is a thing somebody would actually browse.
 *
 * Exported so the hub does not restate it and the two cannot drift.
 */
export const HUB_DAY_WINDOW = 30;

export function getAll(today: string, dayWindow: number = HUB_DAY_WINDOW): Promise<Snapshot> {
  return store().getAll(today, dayWindow);
}

export function sendThinking(
  who: Who,
  nowMs: number = Date.now(),
  today: string = wingDate(new Date(nowMs)),
): Promise<{ sent: boolean; record: Thinking }> {
  return store().sendThinking(who, nowMs, today);
}

export function putAnswer(date: string, who: Who, text: string): Promise<DayRecord> {
  // Thrown rather than no-opped: the caller is expected to have validated, so
  // reaching here with a bad date is a bug worth surfacing, not a silent write to a
  // key nothing will ever read.
  if (!isWingDate(date)) throw new TogetherError(`putAnswer: ${JSON.stringify(date)} is not a wing date`);
  // Normalised HERE as well as at the endpoint, so the cap is a property of the store
  // and not of one caller's diligence.
  return store().putAnswer(date, who, normalizeAnswer(text));
}

export function addItem(
  text: string,
  by: Who,
  nowMs: number = Date.now(),
): Promise<{ item: Item } | { refused: AddRefusal }> {
  const clean = normalizeItem(text);
  if (!clean) throw new TogetherError('addItem: nothing to add');
  return store().addItem(clean, by, nowMs);
}

export function setItemDone(
  id: string,
  on: boolean,
  by: Who,
  nowMs: number = Date.now(),
): Promise<Item | null> {
  // Shape-checked before it reaches a store, so a malformed id never becomes a
  // command argument. The store still has to SELECT the record; see isItemIdShape.
  if (!isItemIdShape(id)) return Promise.resolve(null);
  return store().setItemDone(id, on, by, nowMs);
}

export function removeItem(id: string, by: Who): Promise<boolean> {
  if (!isItemIdShape(id)) return Promise.resolve(false);
  return store().removeItem(id, by);
}

/* ---- the soft-failing wrapper, for the hub --------------------------------- */

/**
 * Everything, or nothing-shaped-correctly.
 *
 * The hub is the front door and these three blocks are things ON it. A store that is
 * down must cost her the blocks, never the door — so this returns a snapshot whose
 * every field is empty and whose `days` still contains today, because "today's
 * question, nobody has answered" is a state the page renders correctly and a missing
 * key is a crash.
 */
export async function getAllSafe(
  today: string,
  dayWindow: number = HUB_DAY_WINDOW,
): Promise<Snapshot> {
  try {
    return await getAll(today, dayWindow);
  } catch (err) {
    console.error('[us] could not read the together store; rendering the hub without it.', err);
    return emptySnapshot(today);
  }
}

/**
 * Test seam. Not called in production; exported so a suite can start from empty.
 *
 * BE HONEST ABOUT WHAT USES IT: this repo has no committed test runner and no
 * `*.test.ts` anywhere, so treat this as decoration unless one arrives. What the
 * Upstash and R2 tiers here are claimed on is being copied line-for-line from
 * marks.ts and letters.ts — including the weak-ETag fix, which is the one bug in
 * this pattern that no stubbed S3 would ever have surfaced.
 */
export function __resetMemoryTier(): void {
  memory.thinking = { her: { ...NO_THINKING }, him: { ...NO_THINKING } };
  memory.days.clear();
  memory.items.clear();
  promptsCacheKey = null;
  promptsCache = DEFAULT_PROMPTS;
}
