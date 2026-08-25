/**
 * kv.ts — the store behind "song of the day".
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS, AND WHY IT IS MORE THAN A CLIENT
 *
 * Five things belong together and are therefore all here:
 *
 *   1. THE INTERFACE — both halves of a day, and the reactions on each. Read and write.
 *   2. THREE BACKENDS behind it, chosen from whatever credentials exist.
 *   3. THE KEY LAYOUT — the exact strings each half of a day lives under.
 *   4. THE CALENDAR — the day-string those keys are built from.
 *   5. THE PAIR — the fold from two flat histories into one day with two slots.
 *   6. THE DERIVATIONS — the shared streak, the totals, and which old day to
 *      resurface. Pure functions over records that are already here, so the pages
 *      cannot each invent their own arithmetic and disagree about how long we
 *      have done this.
 *
 * They are one module because they are one decision. Every song is stored under
 * `<YYYY-MM-DD>`, so the rule that turns "now" into that date string is not a
 * formatting detail — it IS the primary key. If the endpoint that writes and the
 * page that reads ever disagree about what day it is, the write lands in a key
 * nobody looks at and the page shows "nothing today" with no error anywhere.
 * Same failure mode answers.mjs guards against, same fix: exactly one
 * implementation, imported by everyone.
 *
 * For the same reason the REACTIONS rules live here. What counts as a reaction is
 * persisted forever, so it is a schema and not a UI constant — and now that a
 * reaction is an arbitrary emoji rather than one of five keys, the VALIDATOR is the
 * schema. It sits next to the store it guards, with the migration for the five old
 * keys beside it, because a validator that lives somewhere else is a validator one
 * write path forgets to call.
 *
 * ---------------------------------------------------------------------------
 * A DAY IS A PAIR. THE TWO HALVES ARE STORED SEPARATELY ON PURPOSE.
 *
 * Both of us post one song a day, and a day is read as a PAIR: two tracks, two
 * notes, two players, equal weight. Neither half is a response to the other and
 * neither waits for the other — see DayPair below, where an empty slot is the
 * ORDINARY case rather than an error.
 *
 * The STORAGE is deliberately not one record, and the reason is authentication,
 * not modelling taste. His half is written only by the endpoint that demands the
 * ADMIN cookie (`us:song:<date>` / `doc.songs[date]`). Hers only by the endpoint
 * that demands the SESSION cookie (`us:reply:<date>` / `doc.replies[date]`). If
 * both halves shared one record, any bug that let one cookie reach the other's
 * writer would let it forge the other person's half of the day — and her cookie
 * lives for thirty days on a phone that goes to the gym. Two key spaces mean the
 * worst case for such a bug is a wrong half, never a forged one.
 *
 * So: SYMMETRY IS PRESENTATION AND SHAPE. It is emphatically not one endpoint,
 * one cookie or one key. Collapsing them would trade the only structural
 * guarantee in the feature for a shorter file.
 *
 * ---------------------------------------------------------------------------
 * WHY THE KEY IS STILL CALLED `reply` WHEN NOTHING IN THE UI SAYS "REPLY"
 *
 * It used to be a reply: I broadcast, she acknowledged. That framing is gone —
 * the two halves are peers — but the key space is NOT renamed, and the divergence
 * is a decision rather than an oversight.
 *
 * Those keys hold live data, in the real Upstash and in the real R2 document. A
 * rename is a migration, and the failure mode of a half-applied migration here is
 * the worst one available: a deploy that reads `us:pick:*` while everything ever
 * written sits under `us:reply:*` shows her entire history as deleted, silently,
 * with no error anywhere. No noun is worth that.
 *
 * Therefore: `reply` is a STORAGE fact. `hers` / `her half` is the PRODUCT fact.
 * They are allowed to disagree precisely as long as this paragraph exists — which
 * is why putReply/getReply keep their names too, so a reader who greps for the key
 * lands on the same vocabulary the store uses. Do not "fix" the name without a
 * migration, a backfill and a rollback plan.
 *
 * ONE SONG PER SIDE PER DAY, overwritable. Re-posting replaces, so "wrong link"
 * is fixable from a phone. If a day ever needs a thread rather than one song each,
 * that is a third key space, not a list crammed into either of these.
 *
 * Callers NEVER branch on the backend. That is the whole point of the Store
 * interface below: the pages and endpoints are written once, and which tier is
 * live is a deployment fact, not a code path they know about.
 *
 * ---------------------------------------------------------------------------
 * THE THREE TIERS, AND WHAT EACH ONE COSTS
 *
 * 1. UPSTASH REDIS  (hasKV())  — the best of the three, and the only one with
 *    real atomic operations. A reaction is one HSET plus one HDEL; a post is a SET plus a
 *    ZADD. Two people tapping at once cannot lose each other's write.
 *
 * 2. CLOUDFLARE R2  (hasR2())  — the pragmatic default here, because R2 is
 *    already required for the photos and a second account for two people's song
 *    history is not a trade worth making. Everything lives in ONE JSON object at
 *    `data/songs.json`, read and written whole with signed S3 requests.
 *
 *    BE HONEST ABOUT THE COST: R2 has no atomic increment and no
 *    compare-and-set that we use here, so every write is a READ-MODIFY-WRITE and
 *    it CAN RACE. Two writes that overlap — I post a song in the same second she
 *    taps a reaction — mean the second PUT overwrites the first one's change, and
 *    nothing anywhere reports it. This is not a transaction and must not be
 *    described as one. With exactly two humans, one of whom writes roughly once a
 *    morning, the race is theoretical; that is the entire reason it is
 *    acceptable, and it stops being acceptable the moment a third person or an
 *    automated writer appears. Writes are therefore kept small and whole-object,
 *    and never partial.
 *
 * 3. IN-PROCESS MAP (neither) — so the feature is buildable, clickable and
 *    reviewable before any account exists. PER INSTANCE and NON DURABLE: Vercel
 *    runs many functions, a song written by one is invisible to the next request
 *    that lands elsewhere, and a cold start is an empty archive. Development
 *    only. If this tier is ever live in production the feature is not broken
 *    loudly — it is broken in the quiet way where songs "sometimes disappear".
 *    storeTier() exists so pages can say so out loud instead of pretending.
 *
 * ---------------------------------------------------------------------------
 * FAILURE POLICY: READS AND WRITES THROW
 *
 * Unlike ratelimit.ts — which fails OPEN, because locking her out of her own
 * present is worse than a few extra guesses — this file fails LOUD. A song that
 * silently did not save is the worst outcome available: I would think I posted
 * it, she would see yesterday's, and nothing would ever tell either of us. So a
 * transport error is a thrown StoreError and every caller decides what to say.
 * `null` from a read means "that key does not exist", never "the network ate it".
 * ---------------------------------------------------------------------------
 */

import { AwsClient } from 'aws4fetch';
import { hasKV, hasR2, kvConfig, r2Config, r2Endpoint } from './config';
import { countCommands, timer } from './trace';

/** Thrown for transport problems only. A missing record is `null`, not an error. */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
  }
}

export type Tier = 'upstash' | 'r2' | 'memory';

/**
 * 2s on every network call.
 *
 * Chosen against the platform, not against the database: these calls happen
 * inside a serverless function that is itself on a request budget, and a hung
 * fetch with no signal would burn the whole thing before failing. Upstash from a
 * Vercel function is single-digit milliseconds; the R2 blob is kilobytes. 2s is
 * already two orders of magnitude past the expected case — anything slower is
 * not slow, it is broken, and the error is more useful than the wait.
 */
const TIMEOUT_MS = 2000;

/* ============================================================================
   THE WING'S CALENDAR

   One fixed timezone, on purpose. The alternative — UTC — breaks in the most
   embarrassing possible way: I post at 9pm Eastern, UTC has already rolled over,
   the song is filed under tomorrow, and her evening shows an empty page. A
   single declared zone means "today" is the same day for the phone that writes
   and the page that reads, whatever timezone either device is sitting in.
   ========================================================================= */

/** Change this one line to move the wing's midnight. Everything keys off it. */
export const WING_TZ = 'America/New_York';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Today, in the wing's timezone, as `YYYY-MM-DD`.
 *
 * `en-CA` is not a stylistic choice — it is the locale whose numeric date format
 * IS `YYYY-MM-DD`, which lets Intl do the timezone arithmetic (including the DST
 * transitions) and hand back a string that also sorts correctly. Doing this with
 * getUTCDate() and a fixed hour offset would be wrong twice a year.
 */
export function wingDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: WING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Is this a real calendar day in `YYYY-MM-DD` form?
 *
 * The round-trip through Date is what rejects `2026-02-31`: the shape test alone
 * would pass it and it would become a permanent, unreachable key. Anything that
 * becomes part of a primary key gets validated, never trusted.
 */
export function isWingDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const asUtc = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(asUtc.getTime()) && asUtc.toISOString().slice(0, 10) === value;
}

/** Human label for a stored date, e.g. `Fri 21 Aug`. Presentation only. */
export function wingDateLabel(date: string, opts: { withYear?: boolean } = {}): string {
  if (!isWingDate(date)) return date;
  // Parsed as UTC and formatted in UTC: the string is already a wing-local
  // calendar day, so re-interpreting it in WING_TZ would shift it back a day.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(opts.withYear ? { year: 'numeric' } : {}),
  }).format(new Date(`${date}T00:00:00Z`));
}

/** Sortable integer score for the Redis index: `2026-08-21` -> `20260821`. */
function dateScore(date: string): number {
  return Number(date.replace(/-/g, ''));
}

/**
 * A day as a COUNT of days, for anything that rotates.
 *
 * NOT dateScore, and the distinction is the whole point. dateScore reads the date as
 * a decimal number — 2026-08-25 becomes 20260825 — which is a perfectly good
 * monotonic sort key and is exactly what the ZADD indices above need. It is a bad
 * counter, because consecutive days are not consecutive numbers: 20260831 to
 * 20260901 is a jump of SEVENTY.
 *
 * Used as `% pool.length` that jump makes the same choice land twice. Measured over a
 * year of real dates: at a pool of ten, seven pairs of consecutive days picked the
 * SAME item, and the distribution ran from 35 hits to 43 instead of being even. On a
 * "remember this one?" feature, the same memory two mornings running reads as broken
 * rather than nostalgic.
 *
 * Days since the epoch increments by exactly one, every day, forever — no month
 * lengths, no leap years, and no DST, because the parse is fixed at UTC midnight and
 * a UTC day is always 86400 seconds.
 *
 * dateScore is deliberately left alone: it is a stored ZADD score, and changing it
 * would leave old records ordered by one scheme and new ones by another in the same
 * index.
 */
function dayNumber(date: string): number {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : 0;
}

/**
 * The day `days` away from this one, still as `YYYY-MM-DD`.
 *
 * Done in UTC on purpose, and that is not a contradiction of WING_TZ above. A
 * wing date is a LABEL for a calendar day, not an instant; anchoring it at UTC
 * midnight and adding whole 86400000ms steps moves the label by exactly one day
 * every time, because UTC has no DST to skip an hour. Doing the same arithmetic
 * "in the wing's timezone" is what actually breaks: on the two DST boundaries a
 * day is 23 or 25 hours long, +24h lands on the wrong side of midnight, and a
 * streak silently loses or double-counts a day once every spring.
 */
/* Exported because frames.ts needs the same day arithmetic and a second
   implementation of it would be a second place for the DST bug above to come
   back. One definition of "the day before, in the wing's timezone". */
export function shiftDate(date: string, days: number): string {
  const at = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at)) return date;
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, inclusive of both ends. 0 if either is bad. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000) + 1;
}

/* ============================================================================
   REACTIONS — AN OPEN SET OF EMOJI, NOT A CLOSED SET OF KEYS

   WHAT CHANGED, AND WHY THE OLD DESIGN HAD TO GO

   This used to be five `{ key, emoji, label }` records — `heart`, `loop`, `cry`,
   `move`, `pin` — and the WIRE FORMAT was the key, never the emoji. The reasoning
   in /api/us/react's old header was sound as far as it went: an emoji is not one
   character, U+2764 and U+2764 U+FE0F look identical and are different strings, and
   a key is something a human can type into a Redis console.

   It was also a cage. Five prose labels ("on repeat", "okay, ow") printed under
   five buttons, and the only way to say anything else was a deploy. Two people
   sending each other a song a day want to answer it with whatever emoji they
   actually mean, so the vocabulary is now OPEN: three popular emoji are one tap,
   and anything else is typed.

   THE STORED VALUE IS THEREFORE ARBITRARY USER INPUT, and every rule below exists
   because of that sentence:

     * isReaction() is a VALIDATOR, not a lookup. Exactly one grapheme cluster,
       and that cluster has to actually be an emoji. See its comment for the
       grammar.
     * MAX_REACTIONS_PER_DAY bounds how many distinct ones one day can hold, per
       side, so an open vocabulary cannot grow the store without limit.
     * Nothing here is ever rendered with set:html anywhere. A stored "emoji" is a
       string until it has been through isReaction(), and even after that it is
       text.

   THE MIGRATION OF THE FIVE OLD KEYS

   `us:react:<date>` holds live data written under the old scheme: hash FIELDS
   named `heart`, `loop`, `cry`, `move`, `pin`. Those are not emoji, so the new
   validator rejects them, and a validator that rejects them is a validator that
   silently deletes every reaction ever given.

   So LEGACY_REACTIONS below maps each old key to the emoji it always displayed as,
   and normalizeReaction() applies that map on the way OUT of the store. Nothing is
   rewritten in place by a batch job — the read is the migration, which means it
   cannot half-apply. Writes only ever store emoji, and storedNamesFor() makes a
   toggle-off delete the legacy alias as well as the emoji, so an old row is
   upgraded the first time somebody touches it and is correct in the meantime.

   Do not remove LEGACY_REACTIONS. Its cost is five lines; its absence is a
   silently emptied year.

   The emoji are written as escapes so this file stays pure ASCII. Same reasoning
   as answers.mjs: a literal U+1F501 is invisible in a diff and one editor or
   terminal mangling it turns it into a different string.
   ========================================================================= */

export interface Reaction {
  /** Stored verbatim, and also the hash field name. */
  emoji: string;
  /**
   * The ACCESSIBLE NAME, and deliberately not a caption.
   *
   * The old `label` was rendered as visible text under every emoji, which is the
   * thing this revision was asked to remove — nobody needs "on repeat" printed
   * under a repeat glyph. But three buttons whose entire content is aria-hidden
   * decoration announce as "button, button, button", so the words still have to
   * exist; they just live in aria-label now. Invisible to the eye, present to a
   * screen reader. That distinction is the whole point of this field.
   */
  name: string;
}

/**
 * THE HOT BAR. Three, always visible, one tap each.
 *
 * Chosen to cover three DIFFERENT axes rather than three flavours of one, because
 * three buttons that all mean "I liked it" is a hot bar with one button on it:
 *
 *   1. U+2764 U+FE0F  heart   — affection. The unmarked case, and the one reaction
 *      that already had live data behind it under the old `heart` key.
 *   2. U+1F62D        sobbing — feeling. Carries both "this destroyed me" and, in
 *      the way it is actually used, "I am laughing too hard to type". It is the
 *      one glyph in common use that means "this got past my defences", which for a
 *      song is the most useful thing to be able to say in one tap.
 *   3. U+1F525        fire    — energy. "This goes hard." Nothing about warmth or
 *      sadness; it is the axis the other two cannot reach.
 *
 * All three render as recognisably the same picture on iOS, Android and every
 * desktop font — which rules out several better-meaning candidates whose vendor
 * artwork disagrees enough to change the message.
 */
export const HOT_REACTIONS: readonly Reaction[] = [
  { emoji: '\u2764\uFE0F', name: 'love this one' },
  { emoji: '\u{1F62D}', name: 'this got me' },
  { emoji: '\u{1F525}', name: 'this goes hard' },
] as const;

/**
 * THE MIGRATION MAP. Old stored key -> the emoji it always rendered as.
 *
 * Read-side only. See the section header. Never delete an entry; adding one is
 * only correct if something once wrote that key.
 */
const LEGACY_REACTIONS: Readonly<Record<string, string>> = {
  heart: '\u2764\uFE0F',
  loop: '\u{1F501}',
  cry: '\u{1F62D}',
  move: '\u{1F57A}',
  pin: '\u{1F4CC}',
};

/**
 * Accessible names for the emoji we can name. Presentation only — NOT a
 * gate, and absence from this map does not make an emoji invalid.
 *
 * Everything a person types themselves falls through to the emoji itself, which
 * is the right answer rather than a shrug: screen readers speak emoji from the
 * Unicode name ("fire", "red heart"), so an unnamed reaction still announces as
 * something rather than as "button".
 */
const REACTION_NAMES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(HOT_REACTIONS.map((r) => [r.emoji, r.name])),
  // The other four old labels, kept so a reaction given under the old scheme
  // still announces in the words it was given in.
  '\u{1F501}': 'on repeat',
  '\u{1F57A}': 'made me move',
  '\u{1F4CC}': "that's us",
};

/**
 * How many UTF-16 code units a submitted reaction may be.
 *
 * Not a guess at "how long is an emoji" — a ceiling on what gets persisted. The
 * longest RGI sequences in real use are the four-person families and the
 * kiss/couple variants with skin tones (up to ~19 units) and the three
 * subdivision flags (14). 24 clears all of them with nothing to spare, and the
 * grammar in ONE_EMOJI is what actually decides validity; this only stops a
 * megabyte from being handed to a regex.
 */
export const MAX_REACTION_UNITS = 24;

/**
 * How many DISTINCT reactions one day can hold, per side.
 *
 * The old vocabulary was five, so five was the ceiling by construction. An open
 * vocabulary has none, and "no ceiling" on a key an authenticated phone can write
 * in a loop is how a JSON document becomes a bill. Twelve is well past what two
 * people do to one song and small enough that the row still renders on a phone.
 * Enforced on the way IN (see /api/us/react) and again on the way OUT, because the
 * store can also be hand-edited.
 */
export const MAX_REACTIONS_PER_DAY = 12;

/**
 * ONE EMOJI, AS A GRAMMAR.
 *
 * `\p{Extended_Pictographic}` alone is not enough: it matches ONE code point, so
 * it would accept a lone U+200D-less half of a family sequence and reject the
 * whole one. And `/\p{Emoji}/u` is famously wrong in the other direction — digits
 * and `#` carry Emoji=Yes, so it accepts "1".
 *
 * So this spells out the three shapes a single emoji actually takes:
 *
 *   1. REGIONAL INDICATOR PAIR — country flags. Two code points, one glyph.
 *   2. KEYCAP — [0-9#*] then U+FE0F then U+20E3. The only place a digit is allowed,
 *      and only when it is wearing the keycap.
 *   3. A ZWJ SEQUENCE of elements, where an element is a pictographic base with an
 *      optional variation selector and an optional skin-tone modifier. One element
 *      is the ordinary case (U+1F525); several joined by U+200D is the family /
 *      couple / rainbow-flag case.
 *   4. A TAG SEQUENCE — U+1F3F4 plus tag characters. Three of these exist
 *      (Scotland, Wales, England) and they are real emoji, so they are allowed
 *      rather than mysteriously refused.
 *
 * Anchored at both ends, so "fire then a script tag" fails as a whole. Note what
 * this rejects on purpose: a bare U+200D, a bare U+FE0F, a combining accent, two
 * emoji in a row, and every string containing a letter, a space or a `<`.
 *
 * It DOES accept U+00A9, U+00AE and U+203C — the dingbat-era pictographs. They are
 * Extended_Pictographic and they are emoji; refusing them would need a second
 * allowlist for no benefit.
 */
const EMOJI_ELEMENT = '(?:\\p{Extended_Pictographic}\\uFE0F?\\p{Emoji_Modifier}?)';
const ONE_EMOJI = new RegExp(
  '^(?:' +
    // 1. flags
    '\\p{Regional_Indicator}{2}' +
    // 2. keycaps
    '|[0-9#*]\\uFE0F?\\u20E3' +
    // 4. subdivision flags (before 3, which would match the base alone)
    '|\\u{1F3F4}[\\u{E0020}-\\u{E007E}]{1,6}\\u{E007F}' +
    // 3. one element, or several joined
    '|' +
    EMOJI_ELEMENT +
    '(?:\\u200D' +
    EMOJI_ELEMENT +
    ')*' +
    ')$',
  'u',
);

/**
 * How many grapheme clusters, or null when the engine cannot say.
 *
 * Intl.Segmenter is the ONLY correct answer to "is this one character" and it has
 * been in Node since 16, so the null path is not expected to run. It exists
 * because a validator that throws on an old runtime fails OPEN, and this one must
 * fail closed-ish: null makes isReaction() fall back to the grammar above, which
 * already only matches single clusters. Belt and braces, in that order.
 */
function graphemeCount(value: string): number | null {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (typeof Segmenter !== 'function') return null;
  try {
    return [...new Segmenter('en', { granularity: 'grapheme' }).segment(value)].length;
  } catch {
    return null;
  }
}

/**
 * Is this ONE emoji, safe to persist and to print?
 *
 * Three independent checks, cheapest first, and all three have to pass:
 *   a length cap, the grammar, and a grapheme count of exactly 1.
 *
 * Replaces isReactionKey(), which was a Set lookup against five strings. The name
 * changed with the meaning: this validates, it does not recognise. Nothing is
 * coerced, trimmed or repaired here — a caller that wants to trim does it first,
 * because "nearly an emoji" is a thing to refuse and not to guess at.
 */
export function isReaction(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_REACTION_UNITS) return false;
  if (!ONE_EMOJI.test(value)) return false;
  const clusters = graphemeCount(value);
  return clusters === null || clusters === 1;
}

/**
 * U+FE0F stripped. FOR COMPARISON ONLY — never stored, never rendered.
 *
 * The variation selector is presentational: U+2764 and U+2764 U+FE0F are two
 * strings that draw the same heart. Without a fold, tapping the hot heart on a day
 * whose store already holds the bare one gives two chips that look identical and
 * both claim to be off. The fold is what makes them one reaction.
 */
function foldReaction(emoji: string): string {
  return emoji.replace(/\uFE0F/g, '');
}

/** Fold -> the legacy keys that meant it. Reverse of LEGACY_REACTIONS. */
const LEGACY_BY_FOLD = new Map<string, string[]>();
for (const [key, emoji] of Object.entries(LEGACY_REACTIONS)) {
  const fold = foldReaction(emoji);
  LEGACY_BY_FOLD.set(fold, [...(LEGACY_BY_FOLD.get(fold) ?? []), key]);
}

/**
 * One value as it came out of the store, as an emoji — or null to drop it.
 *
 * THE MIGRATION, applied on every read. A legacy key becomes the emoji it always
 * displayed as; a valid emoji passes through; anything else (a typo, a
 * hand-edited field, a retired key nobody mapped) is dropped rather than
 * rendered, which is the same behaviour the old closed set had for unknown keys
 * and is what makes retiring one safe.
 */
export function normalizeReaction(stored: unknown): string | null {
  if (typeof stored !== 'string') return null;
  const legacy = LEGACY_REACTIONS[stored];
  if (legacy) return legacy;
  return isReaction(stored) ? stored : null;
}

/**
 * Every field name in the store that means this emoji.
 *
 * Used by the DELETE path only. Taking a reaction back has to remove the legacy
 * alias and the unselected variant as well as the emoji itself, or a heart given
 * under the old scheme would be un-tappable forever: the button would send
 * U+2764 U+FE0F, the store would still hold `heart`, and the chip would come back
 * pressed with nothing to explain why.
 */
export function storedNamesFor(emoji: string): string[] {
  const fold = foldReaction(emoji);
  const names = new Set<string>([emoji, fold, ...(LEGACY_BY_FOLD.get(fold) ?? [])]);
  return [...names].filter(Boolean);
}

/**
 * What a screen reader should say for one reaction. Presentation only.
 *
 * Falls back to the emoji itself, which assistive tech speaks from its Unicode
 * name. Never returns '' — an empty accessible name is the bug this exists to
 * prevent.
 */
export function reactionName(emoji: string): string {
  return REACTION_NAMES[emoji] ?? REACTION_NAMES[foldReaction(emoji)] ?? emoji;
}

/** One button in a reaction bar. */
export interface ReactionChip {
  emoji: string;
  /** The accessible name. NEVER rendered as visible text — see Reaction.name. */
  name: string;
  /** Already given on this side today, so the button is a toggle-off. */
  on: boolean;
}

/**
 * The buttons one reaction bar shows: the hot three, then anything already given
 * that the hot three do not cover.
 *
 * Lives here rather than in the page because it needs foldReaction() — the pressed
 * state of the hot heart has to account for a stored bare U+2764, and a page that
 * compared strings directly would render the heart as un-pressed next to an
 * identical-looking second chip. That is the kind of bug that is invisible in
 * review and obvious on a phone.
 *
 * The extra chips are always `on: true`: they exist BECAUSE they were given, so a
 * chip for an emoji nobody chose is not a state this can produce. The hot three are
 * always present and always in the same order, so the bar does not move under a
 * thumb between renders.
 */
export function reactionChips(given: readonly string[]): ReactionChip[] {
  const list = normalizeReactions(given);
  const chosen = new Set(list.map(foldReaction));
  const hotFolds = new Set(HOT_REACTIONS.map((r) => foldReaction(r.emoji)));

  const chips: ReactionChip[] = HOT_REACTIONS.map((r) => ({
    emoji: r.emoji,
    name: r.name,
    on: chosen.has(foldReaction(r.emoji)),
  }));
  for (const emoji of list) {
    if (hotFolds.has(foldReaction(emoji))) continue;
    chips.push({ emoji, name: reactionName(emoji), on: true });
  }
  return chips;
}

/**
 * A stored list, normalized, de-duplicated by fold, and capped.
 *
 * Every read path in every tier goes through this, for the reason parseAndOrder()
 * exists: a rule that only some backends apply turns a schema bug into "works on
 * my laptop". The cap is re-applied here as well as at the endpoint because the
 * store can be hand-edited and a page render is not the place to discover that.
 */
function normalizeReactions(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(raw) ? raw : []) {
    const emoji = normalizeReaction(value);
    if (!emoji) continue;
    const fold = foldReaction(emoji);
    if (seen.has(fold)) continue;
    seen.add(fold);
    out.push(emoji);
    if (out.length >= MAX_REACTIONS_PER_DAY) break;
  }
  return out;
}

/**
 * WHICH SONG A REACTION IS ON, per day. Both directions.
 *
 * The field names say ON, not BY, and that is the distinction the old
 * one-directional design let itself blur. A reaction on his song can only have
 * been written by her and vice versa (see /api/us/react), so "by" is derivable and
 * "on" is what the page needs in order to draw it next to the right track.
 *
 * Always both arrays, never undefined, so no caller writes `?? []`.
 */
export interface DayReactions {
  /** Emoji left ON HIS song. Only she can write these. */
  onHis: string[];
  /** Emoji left ON HER song. Only he can write these. */
  onHers: string[];
}

/** A day with no reactions either way. Fresh object per call — callers mutate. */
export function noReactions(): DayReactions {
  return { onHis: [], onHers: [] };
}

/* ============================================================================
   THE RECORD
   ========================================================================= */

/**
 * One track, filed under one day, with the words that came with it.
 *
 * EVERY FIELD EXCEPT `date` AND `id` IS ALLOWED TO BE EMPTY, and that is the
 * central design fact of this record rather than a tolerance. The metadata comes
 * from an endpoint that needs no credentials and can therefore refuse, change or
 * disappear; the enriched fields come from an API whose credentials may never
 * exist. A card that renders from `date` + `id` alone still plays the song, so
 * every optional field is a bonus the page omits rather than a dependency it
 * breaks on.
 */
export interface TrackRecord {
  /** `YYYY-MM-DD` in WING_TZ. Also the primary key. */
  date: string;
  /** Spotify track id, always 22 base62 chars. Validated before it gets here. */
  id: string;
  title: string;
  /** May be empty: Spotify's credential-free oEmbed does not return an artist. */
  artist: string;
  /** Album art URL, or empty when the metadata call failed or was rejected. */
  art: string;
  /** The note. The actual point of the feature. */
  note: string;
  /** Epoch millis, for "posted this morning" copy and for debugging. */
  postedAt: number;

  /**
   * WHERE THE POSTER WAS when they posted it. An IANA name, e.g.
   * `America/Los_Angeles`, captured from their own device.
   *
   * `postedAt` says WHEN in absolute terms; this says whose wall clock to print it
   * against. Those are two different facts and the page needs both, because
   * WING_TZ (America/New_York) is a CALENDAR and not a location — neither of them
   * lives there, so formatting `postedAt` in it produced a time that was nobody's:
   * a song posted at 22:40 in Los Angeles read as 01:40.
   *
   * OPTIONAL, AND THAT IS PERMANENT rather than a migration window. Every record
   * written before this field existed has no `tz`, they are never rewritten, and
   * the no-JavaScript form path cannot fill it either. So '' / undefined is an
   * ordinary value and the render falls back to HER_TZ / HIS_TZ — see
   * postedAtLabel() on the today page. A page that assumed this was here would
   * break on the entire existing archive.
   *
   * VALIDATED, on the way in AND on the way back out — see isTimeZone(). It
   * arrives from a form field and is handed to `Intl`, which throws RangeError on
   * a name it does not know, and a throw inside a page render is a 500.
   */
  tz?: string;

  /* ---- enriched, and only ever present when the Web API credentials exist ----
     See resolveMetadata() in /api/us/song. All three are absent on every record
     written before those credentials were configured, so they are OPTIONAL in the
     type as well as empty-tolerant at render time: a page that assumed they were
     there would break on the entire existing archive. */

  /** Album name. '' or undefined when unknown. */
  album?: string;
  /** Release year as four digits, e.g. `1994`. '' or undefined when unknown. */
  year?: string;
  /** Track length in milliseconds. 0 or undefined when unknown. */
  durationMs?: number;
}

/**
 * His and hers, and they are DELIBERATELY THE SAME SHAPE.
 *
 * Not laziness: the point of the feature is that a day reads as one exchange, so
 * the two halves are rendered by the same card and validated by the same parser.
 * The moment they diverge, one side gets a field the other cannot show and the
 * conversation stops being symmetrical. What separates them is the KEY SPACE and
 * the COOKIE THAT MAY WRITE IT (see the header) — never the fields.
 */
export type SongRecord = TrackRecord;
export type ReplyRecord = TrackRecord;

/** Longest IANA name in the database is 30-odd characters. 64 is slack, not a guess. */
const TZ_MAX = 64;

/**
 * Shape first, so the probe below is never handed something absurd. Two or three
 * `/`-separated segments of the characters IANA actually uses — which deliberately
 * excludes `:`, and therefore excludes OFFSET strings like `+05:00`. Intl accepts
 * those; we must not, because an offset is not a location and would be an hour
 * wrong for half of every year.
 */
const TZ_RE = /^[A-Za-z0-9_+-]{1,32}(?:\/[A-Za-z0-9_+.-]{1,32}){0,2}$/;

/**
 * Is this a timezone name we can safely hand to `Intl`?
 *
 * UNTRUSTED INPUT. It comes from a hidden form field (see the `tz` input on the
 * posting forms), so it is checked before it is stored and again after it is read
 * back — a stored value reaches `Intl.DateTimeFormat`, which throws RangeError on
 * an unknown zone, and a throw inside a page render is a 500 on her vault.
 *
 * WHY A try/catch PROBE AND NOT `Intl.supportedValuesOf('timeZone')`:
 *
 *   1. The probe tests the exact predicate we care about — "will Intl accept this"
 *      — rather than a list that approximates it. `supportedValuesOf` returns only
 *      CANONICAL primary identifiers, so it rejects the perfectly valid IANA link
 *      names a real device can report (`Asia/Calcutta`, `Europe/Kiev`,
 *      `US/Pacific`), which would silently downgrade those posts to the fallback
 *      constant for no reason.
 *   2. It is not guaranteed present. It is ES2022 and this code runs on Node
 *      locally and on a Cloudflare Worker in production; the constructor is
 *      everywhere the rest of this file already relies on it being.
 *   3. It is the pattern together.ts's zone() already uses on HER_TZ / HIS_TZ. One
 *      way of asking this question, not two.
 *
 * DELIBERATELY NOT CACHED, unlike zone() in together.ts. That memoises two
 * compile-time constants; this is fed by a form field, and a Map keyed on
 * caller-supplied strings is an unbounded-growth vector for a constructor call
 * that happens at most twice per render.
 */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const tz = value.trim();
  if (tz.length === 0 || tz.length > TZ_MAX || !TZ_RE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a record read back out of a store.
 *
 * We are the only two writers, so this is not about hostile input — it is about
 * SCHEMA DRIFT. Adding a field, or hand-editing a value in the Upstash console at
 * 1am, must degrade to "that day has no song" rather than throwing inside a page
 * render and 500ing her whole vault.
 *
 * Used for replies as well as songs, because they are one shape. A reply that
 * fails this check is dropped exactly like a song that fails it: the day renders
 * with the half that IS valid rather than erroring on the half that is not.
 */
function parseTrack(raw: unknown): TrackRecord | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error('[us] a stored song is not JSON — ignoring it.');
      return null;
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return null;

  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (!isWingDate(obj.date) || !/^[A-Za-z0-9]{22}$/.test(str(obj.id))) return null;

  return {
    date: obj.date,
    id: str(obj.id),
    title: str(obj.title),
    artist: str(obj.artist),
    art: str(obj.art),
    note: str(obj.note),
    postedAt: Number(obj.postedAt) || 0,
    // Checked AGAIN on the way out, not just on the way in. This value is handed
    // straight to Intl.DateTimeFormat by the render, and a name that got in before
    // the check existed — or by a hand-edit in the Upstash console — would throw a
    // RangeError inside a page render. '' means "we do not know where they were",
    // which is the honest state of every record written before this field and is
    // what the fallback to HER_TZ / HIS_TZ is for.
    tz: isTimeZone(obj.tz) ? obj.tz.trim() : '',
    album: str(obj.album),
    // Four digits or nothing. A stored `year` only ever comes from Spotify's
    // `release_date`, but this read runs against records a human may have edited,
    // and "199x" printed on her card as a release year would be worse than no
    // year at all.
    year: /^\d{4}$/.test(str(obj.year)) ? str(obj.year) : '',
    // Guarded against negatives and NaN so the duration formatter downstream
    // never has to. Anything absurd (over ~3 hours) is treated as absent rather
    // than rendered, because a wrong runtime is a visible lie and a missing one
    // is just a missing one.
    durationMs:
      Number.isFinite(Number(obj.durationMs)) &&
      Number(obj.durationMs) > 0 &&
      Number(obj.durationMs) < 3 * 60 * 60 * 1000
        ? Math.floor(Number(obj.durationMs))
        : 0,
  };
}

/**
 * Validate, drop the unusable, order newest-first, cap.
 *
 * ALL THREE TIERS go through this for their list read, and that is the point:
 * an earlier version had the memory tier return its Map's values directly, which
 * meant a malformed record was filtered out in production and rendered locally.
 * A validation rule that only some backends apply is worse than none, because it
 * turns a schema bug into "works on my laptop".
 *
 * Accepts raw values (JSON strings from Redis, plain objects from R2 or the Map)
 * because parseTrack handles both, so no tier has to pre-normalize.
 */
function parseAndOrder(raws: unknown[], limit: number): TrackRecord[] {
  return raws
    .map(parseTrack)
    .filter((s): s is TrackRecord => s !== null)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

/* ============================================================================
   THE INTERFACE

   Eight operations. Everything the feature needs and nothing it does not, because
   each one has to be implemented three times and a ninth would have to justify
   itself three times over.

   The two shelves mirror each other exactly — same signatures, same ordering
   guarantees, different key space. That symmetry is what lets the pages render ONE
   card template twice, once per side; an asymmetric store API would have leaked
   into an asymmetric UI, which is exactly the shape this feature just grew out of.

   Note what is NOT here: no composite "give me the whole day" read. It would have
   to be written three times, and getExchange() + buildPairs() further down compose
   the primitives instead — one place, one behaviour, and the parallelism is visible
   at the call site rather than buried in three backends.
   ========================================================================= */

export interface Store {
  readonly tier: Tier;
  /** Write (or overwrite) one day's song. */
  putSong(song: SongRecord): Promise<void>;
  /** One day's song, or null when nothing was posted that day. */
  getSong(date: string): Promise<SongRecord | null>;
  /** The `limit` most recent songs, newest first. */
  getSongs(limit: number): Promise<SongRecord[]>;
  /** Write (or overwrite) HER half of one day. Never his. (`reply` = storage name.) */
  putReply(reply: ReplyRecord): Promise<void>;
  /** Her half of one day, or null when she has not posted that day. */
  getReply(date: string): Promise<ReplyRecord | null>;
  /** Her `limit` most recent songs, newest first. */
  getReplies(limit: number): Promise<ReplyRecord[]>;
  /**
   * Set or clear one reaction ON one side's song for one day.
   *
   * `target` is the side the reaction is GIVEN TO, never the side that gave it —
   * see DayReactions. Who is ALLOWED to write which target is an authorization
   * question and lives in /api/us/react; the store only files it correctly.
   */
  putReaction(date: string, target: Side, emoji: string, on: boolean): Promise<void>;
  /** Which reactions exist on each side, per date. Every date asked for gets an entry. */
  getReactions(dates: string[]): Promise<Record<string, DayReactions>>;
}

/** An empty result for every date asked, so callers never check for undefined. */
function emptyReactions(dates: string[]): Record<string, DayReactions> {
  const out: Record<string, DayReactions> = {};
  for (const d of dates) out[d] = noReactions();
  return out;
}

/* ============================================================================
   TIER 1 — UPSTASH REDIS over REST
   ========================================================================= */

/** `us:` prefix matches ratelimit.ts's `us:rl:` so one Redis can hold both. */
const SONG_KEY = (date: string) => `us:song:${date}`;

/* ---------------------------------------------------------------------------
   THE TWO REACTION KEY SPACES, AND WHY ONE OF THEM IS BADLY NAMED

   `us:react:<date>` HOLDS REACTIONS ON HIS SONG. It is not renamed, for exactly
   the reason `us:reply:*` is not renamed (see the file header): it holds live
   data, and the failure mode of a half-applied rename is a deploy that reads an
   empty key space and shows every reaction ever given as deleted.

   THE MIGRATION, STATED PLAINLY. Before this revision there was ONE reaction key
   per day and reactions were one-directional — only she could give them, and only
   to his song. So every array already in `us:react:<date>` is, by definition,
   "reactions on HIS song", and it is read as exactly that. No key is moved, no
   value is rewritten, and nothing is re-attributed. The second direction is a NEW
   key space that starts empty:

     us:react:<date>        reactions ON HIS song   (written only by her)
     us:react-hers:<date>   reactions ON HER song   (written only by him)

   The field NAMES inside the old hash also changed meaning — they used to be the
   five keys `heart`/`loop`/`cry`/`move`/`pin` and are now emoji. That half of the
   migration is handled on read by normalizeReaction(); see the REACTIONS section.

   So the asymmetry in these two names is a STORAGE fact with a date on it, and
   reactKeyFor() below is the only place either name is chosen. Do not "tidy" the
   pair into `us:react-his` / `us:react-hers` without a migration, a backfill and
   a rollback plan.
   ------------------------------------------------------------------------- */
const REACT_KEY = (date: string) => `us:react:${date}`;
const REACT_HERS_KEY = (date: string) => `us:react-hers:${date}`;

/** The one place the legacy name above is mapped to the side it means. */
const reactKeyFor = (date: string, target: Side) =>
  target === 'his' ? REACT_KEY(date) : REACT_HERS_KEY(date);
/**
 * Her side, in its own key space. A separate prefix rather than a field inside
 * the song blob, so that the endpoint holding only her session cookie writes keys
 * that CANNOT collide with mine — see the header. It also means a reply exists on
 * a day with no song, which is exactly the case where she went first.
 */
const REPLY_KEY = (date: string) => `us:reply:${date}`;
/** Sorted set of every date that has a song, scored by dateScore(). */
const INDEX_KEY = 'us:song:index';
/** The same, for replies. Two indexes because they are two histories. */
const REPLY_INDEX_KEY = 'us:reply:index';

/** One Redis command as an argv array, e.g. `['GET', 'us:song:2026-08-21']`. */
type Command = (string | number)[];

/**
 * One HTTP round trip for N commands.
 *
 * `/pipeline` rather than N single-command calls because the cost here is
 * entirely round trips. Note this is a pipeline, NOT a transaction
 * (`/multi-exec`): nothing needs atomicity ACROSS commands, and the worst
 * interleaving is an index entry pointing at a blob written a millisecond later,
 * which getSongs() already tolerates.
 */
async function redis(url: string, token: string, cmds: Command[]): Promise<unknown[]> {
  if (cmds.length === 0) return [];

  const t = timer();
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // Every argument stringified: the REST protocol is textual anyway, and
      // normalizing here means a number vs a numeric string never becomes a
      // difference in behaviour between the tiers.
      body: JSON.stringify(cmds.map((c) => c.map(String))),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout arrives as an AbortError, indistinguishable from a network
    // failure to every caller, so both are normalized into one error type.
    throw new StoreError('upstash unreachable', { cause: err });
  }

  /* THE COMMAND COUNT, and it goes HERE — after the round trip landed, before the
     status is judged. A pipeline is one request and `cmds.length` billed commands, and
     the free tier counts the second number. See countCommands in trace.ts for why this
     is per call rather than a per-request total. */
  countCommands('kv', cmds.length, res.status, t.total());

  if (!res.ok) throw new StoreError(`upstash HTTP ${res.status}`);

  const parsed = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  if (!Array.isArray(parsed) || parsed.length !== cmds.length) {
    throw new StoreError('upstash returned a malformed pipeline response');
  }

  return parsed.map((entry, i) => {
    // A per-command error (wrong type, bad syntax) is a bug in this file rather
    // than a runtime condition, so it is fatal. Only the command NAME is logged:
    // the arguments contain her reactions and my notes.
    if (entry?.error) throw new StoreError(`upstash ${String(cmds[i][0])} failed: ${entry.error}`);
    return entry?.result ?? null;
  });
}

function upstashStore(url: string, token: string): Store {
  const run = (cmds: Command[]) => redis(url, token, cmds);

  /**
   * A "shelf": one blob per date, plus a sorted-set index of the dates on it.
   *
   * Songs and replies are the same three operations over two different key
   * spaces, so they are written ONCE and bound twice. Copy-pasting them would be
   * six implementations of three behaviours, and the failure mode of that is the
   * one this file already warns about elsewhere — a fix applied to the song path
   * and forgotten on the reply path, visible only as "her answers sometimes do
   * not show up in the archive".
   */
  const shelf = (keyFor: (date: string) => string, indexKey: string) => ({
    async put(rec: TrackRecord): Promise<void> {
      // Overwriting is a feature: the realistic mistake is a typo in the note and
      // the fix has to be "post it again from my phone". ZADD on an existing
      // member updates its score instead of duplicating it, so re-posting the
      // same day never doubles up in the archive.
      await run([
        ['SET', keyFor(rec.date), JSON.stringify(rec)],
        ['ZADD', indexKey, dateScore(rec.date), rec.date],
      ]);
    },

    async get(date: string): Promise<TrackRecord | null> {
      const [raw] = await run([['GET', keyFor(date)]]);
      return parseTrack(raw);
    },

    async list(limit: number): Promise<TrackRecord[]> {
      // Two round trips, and deliberately not one: the index is read first so
      // that MGET only fetches the newest `limit` blobs. The alternative — one
      // hash holding every song ever — would drag the entire history across the
      // wire to render a single card, and would grow without bound.
      const [rawDates] = await run([['ZRANGE', indexKey, 0, limit - 1, 'REV']]);
      const dates = (Array.isArray(rawDates) ? rawDates : []).filter(isWingDate);
      if (dates.length === 0) return [];

      const [rawBlobs] = await run([['MGET', ...dates.map(keyFor)]]);
      const blobs = Array.isArray(rawBlobs) ? rawBlobs : [];
      // A date in the index with no blob behind it is dropped silently and on
      // purpose: it means a half-completed write or a manually deleted key, and
      // the right behaviour for an archive is "that row is not there". The
      // re-sort inside parseAndOrder is redundant given ZRANGE ... REV, and kept
      // anyway so this tier cannot drift from the other two.
      return parseAndOrder(blobs, limit);
    },
  });

  const songs = shelf(SONG_KEY, INDEX_KEY);
  const replies = shelf(REPLY_KEY, REPLY_INDEX_KEY);

  return {
    tier: 'upstash',

    putSong: (song) => songs.put(song),
    getSong: (date) => songs.get(date),
    getSongs: (limit) => songs.list(limit),

    putReply: (reply) => replies.put(reply),
    getReply: (date) => replies.get(date),
    getReplies: (limit) => replies.list(limit),

    async putReaction(date, target, emoji, on) {
      const key = reactKeyFor(date, target);
      // The one place a tier difference is visible in the outcome rather than
      // just the code: this is a single atomic field write. No read, no race.
      //
      // Both branches also HDEL the legacy aliases (see storedNamesFor), which is
      // what lazily upgrades a pre-emoji row the first time it is touched: setting
      // U+2764 U+FE0F removes the old `heart` field in the same round trip, so the
      // day never ends up holding two fields that draw the same picture.
      const aliases = storedNamesFor(emoji).filter((n) => n !== emoji);
      await run([
        on ? ['HSET', key, emoji, String(Date.now())] : ['HDEL', key, emoji],
        ...(aliases.length > 0 ? [['HDEL', key, ...aliases] as Command] : []),
      ]);
    },

    async getReactions(dates) {
      const out = emptyReactions(dates);
      if (dates.length === 0) return out;
      // HKEYS, not HGETALL: only the field names are rendered, so asking for the
      // values would drag the timestamps over the wire on every page load.
      //
      // Two commands per date rather than one, which is the honest cost of the
      // second direction. Still ONE round trip: it is a pipeline, so N dates cost
      // 2N commands and one HTTP request.
      const cmds: Command[] = [];
      for (const d of dates) {
        cmds.push(['HKEYS', REACT_KEY(d)]);
        cmds.push(['HKEYS', REACT_HERS_KEY(d)]);
      }
      const results = await run(cmds);
      dates.forEach((d, i) => {
        out[d] = {
          onHis: normalizeReactions(results[i * 2]),
          onHers: normalizeReactions(results[i * 2 + 1]),
        };
      });
      return out;
    },
  };
}

/* ============================================================================
   TIER 2 — CLOUDFLARE R2, one JSON object

   Read the whole document, change one field, write the whole document back.
   Everything about this tier follows from that sentence, including its race
   (see the header). The document is deliberately boring and self-describing so
   that opening it in the Cloudflare dashboard at 2am is a useful thing to do.
   ========================================================================= */

/**
 * The object key. `data/` rather than the bucket root because Phase 3's photos
 * live in the same bucket and mixing bytes with bookkeeping at the top level is
 * how you eventually delete the wrong thing.
 */
const R2_DOC_KEY = 'data/songs.json';

interface SongDoc {
  /**
   * Schema version. Present from day one so a future migration has a hinge.
   *
   * STILL 1 after replies were added, deliberately. `replies` is ADDITIVE and
   * optional: an older document without the key reads as `{}` (see parseDoc), and
   * an older deploy reading a newer document ignores a field it does not know
   * about. Bumping the number would announce a break that does not exist, and the
   * hinge is worth more when it has never been turned for a non-event.
   */
  v: 1;
  /** date -> song. MINE. Written only by the admin-authenticated endpoint. */
  songs: Record<string, SongRecord>;
  /** date -> reply. HERS. Written only by the session-authenticated endpoint. */
  replies: Record<string, ReplyRecord>;
  /**
   * date -> emoji -> epoch millis of the tap. REACTIONS ON HIS SONG.
   *
   * The field name predates the second direction and is kept for the same reason
   * `us:react:<date>` is — see the key-space comment above REACT_KEY. Every entry
   * already in a live document was written when a reaction could only be hers,
   * given to his song, so reading it as "on his" loses and re-attributes nothing.
   */
  reactions: Record<string, Record<string, number>>;
  /**
   * The same, ON HER SONG. Written only by him.
   *
   * ADDITIVE and OPTIONAL, exactly like `replies` was: absent from every document
   * written before reactions went both ways, so parseDoc() reads its absence as
   * `{}` and `v` stays 1. An older deploy reading a newer document simply ignores
   * a field it does not know about.
   */
  reactionsHers: Record<string, Record<string, number>>;
}

const EMPTY_DOC: SongDoc = { v: 1, songs: {}, replies: {}, reactions: {}, reactionsHers: {} };

/**
 * A client per process, not per call.
 *
 * `retries: 1` is a deliberate override of the library's default of 10. Those
 * retries use exponential backoff and would happily spend far more than this
 * function's entire time budget on a bucket that is down. One retry absorbs a
 * blip; ten absorb an outage by hanging.
 *
 * NOTE for integration: photos.ts constructs its own AwsClient for presigning.
 * That duplication is known and intentional for now — these are different
 * operations (signed request vs presigned URL) with different lifetimes, and
 * sharing a client across the two would couple the song store to the photo
 * pipeline for the sake of four lines.
 */
let r2Client: AwsClient | null = null;
function r2(): { client: AwsClient; base: string } {
  const { accessKeyId, secretAccessKey, bucket } = r2Config();
  const endpoint = r2Endpoint();
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) {
    throw new StoreError('r2 selected but not fully configured');
  }
  r2Client ??= new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    // R2 has no regions but SigV4 requires one in the credential scope, and
    // 'auto' is the value Cloudflare documents for the S3 API.
    region: 'auto',
    retries: 1,
  });
  // Path-style addressing: R2's S3 endpoint is per-account, and the bucket is
  // the first path segment. Virtual-host style would need a different hostname.
  return { client: r2Client, base: `${endpoint}/${encodeURIComponent(bucket)}` };
}

/** Shape-check a document read from the bucket. Returns null when unusable. */
function parseDoc(text: string): SongDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<SongDoc>;
  const songs = obj.songs && typeof obj.songs === 'object' ? obj.songs : null;
  const reactions = obj.reactions && typeof obj.reactions === 'object' ? obj.reactions : {};
  /* `reactionsHers` is MISSING from every document written while reactions were
     one-directional, which is the normal case for the whole existing archive.
     Same treatment as `replies` below and for the same reason: additive fields
     never make a document unreadable. */
  const reactionsHers =
    obj.reactionsHers && typeof obj.reactionsHers === 'object' ? obj.reactionsHers : {};
  // `replies` is MISSING from every document written before she could answer, so
  // its absence is the normal case for the whole existing archive and must never
  // make a document unreadable. Only `songs` is structural.
  const replies = obj.replies && typeof obj.replies === 'object' ? obj.replies : {};
  if (!songs) return null;
  return {
    v: 1,
    songs: songs as SongDoc['songs'],
    replies: replies as SongDoc['replies'],
    reactions: reactions as SongDoc['reactions'],
    reactionsHers: reactionsHers as SongDoc['reactionsHers'],
  };
}

async function readDoc(): Promise<{ doc: SongDoc; existed: boolean; corrupt: boolean }> {
  const { client, base } = r2();
  let res: Response;
  try {
    res = await client.fetch(`${base}/${R2_DOC_KEY}`, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new StoreError('r2 unreachable', { cause: err });
  }

  // 404 is the normal first-run state, not an error: nobody has posted yet.
  if (res.status === 404) return { doc: structuredClone(EMPTY_DOC), existed: false, corrupt: false };
  if (!res.ok) throw new StoreError(`r2 GET HTTP ${res.status}`);

  const parsed = parseDoc(await res.text());
  if (!parsed) {
    // Reads degrade to empty so her page still renders. Writes do NOT (below):
    // overwriting an object we could not understand is how a bad deploy turns
    // into a deleted year of songs.
    console.error(`[us] ${R2_DOC_KEY} exists but is not a song document — reading as empty.`);
    return { doc: structuredClone(EMPTY_DOC), existed: true, corrupt: true };
  }
  return { doc: parsed, existed: true, corrupt: false };
}

async function writeDoc(doc: SongDoc): Promise<void> {
  const { client, base } = r2();
  const body = JSON.stringify(doc);
  let res: Response;
  try {
    res = await client.fetch(`${base}/${R2_DOC_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new StoreError('r2 unreachable', { cause: err });
  }
  if (!res.ok) throw new StoreError(`r2 PUT HTTP ${res.status}`);
}

/** Read, apply, write. The race is documented in the file header. */
async function mutateDoc(apply: (doc: SongDoc) => void): Promise<void> {
  const { doc, corrupt } = await readDoc();
  if (corrupt) {
    throw new StoreError(
      `refusing to overwrite ${R2_DOC_KEY}: it exists but is not a valid song document`,
    );
  }
  apply(doc);
  await writeDoc(doc);
}

function r2Store(): Store {
  return {
    tier: 'r2',

    async putSong(song) {
      await mutateDoc((doc) => {
        doc.songs[song.date] = song;
      });
    },

    async getSong(date) {
      const { doc } = await readDoc();
      return parseTrack(doc.songs[date]);
    },

    async getSongs(limit) {
      const { doc } = await readDoc();
      return parseAndOrder(Object.values(doc.songs), limit);
    },

    /* Her side. Same read-modify-write, same documented race, and note that it
       touches ONLY `doc.replies` — a bug here cannot reach `doc.songs`, which is
       the property the two key spaces exist to guarantee. */
    async putReply(reply) {
      await mutateDoc((doc) => {
        doc.replies[reply.date] = reply;
      });
    },

    async getReply(date) {
      const { doc } = await readDoc();
      return parseTrack(doc.replies[date]);
    },

    async getReplies(limit) {
      const { doc } = await readDoc();
      return parseAndOrder(Object.values(doc.replies), limit);
    },

    async putReaction(date, target, emoji, on) {
      await mutateDoc((doc) => {
        // The ONE place this tier picks a bucket. A bug here cannot reach songs or
        // replies, which is the property the separate fields exist to guarantee.
        const bucket = target === 'his' ? doc.reactions : (doc.reactionsHers ??= {});
        const day = (bucket[date] ??= {});
        if (on) day[emoji] = Date.now();
        // Every alias too, so a toggle-off clears a row written under the old
        // five-key scheme rather than leaving it stuck on. See storedNamesFor.
        for (const name of storedNamesFor(emoji)) {
          if (!on || name !== emoji) delete day[name];
        }
        // Prune the empty day so the document does not accumulate `{}` entries
        // for every reaction either of us changed their mind about.
        if (Object.keys(day).length === 0) delete bucket[date];
      });
    },

    async getReactions(dates) {
      const out = emptyReactions(dates);
      if (dates.length === 0) return out;
      const { doc } = await readDoc();
      for (const d of dates) {
        out[d] = {
          onHis: normalizeReactions(Object.keys(doc.reactions[d] ?? {})),
          onHers: normalizeReactions(Object.keys(doc.reactionsHers?.[d] ?? {})),
        };
      }
      return out;
    },
  };
}

/* ============================================================================
   TIER 3 — IN-PROCESS MAP

   Non durable, per instance. See the header. Implemented directly against Maps
   rather than by emulating Redis commands, because a fake Redis is a second
   thing that can be subtly wrong, and this tier's only job is to be obviously
   correct for one developer on one laptop.
   ========================================================================= */

const memory = {
  songs: new Map<string, SongRecord>(),
  /** Her replies. A separate Map, mirroring the separate key space above. */
  replies: new Map<string, ReplyRecord>(),
  /** date -> (emoji -> epoch millis). Reactions ON HIS song. */
  reactions: new Map<string, Map<string, number>>(),
  /** The same, ON HER song. A separate Map, mirroring the separate key space. */
  reactionsHers: new Map<string, Map<string, number>>(),
};

function memoryStore(): Store {
  return {
    tier: 'memory',

    async putSong(song) {
      memory.songs.set(song.date, song);
    },

    async getSong(date) {
      return parseTrack(memory.songs.get(date) ?? null);
    },

    async getSongs(limit) {
      return parseAndOrder([...memory.songs.values()], limit);
    },

    async putReply(reply) {
      memory.replies.set(reply.date, reply);
    },

    async getReply(date) {
      return parseTrack(memory.replies.get(date) ?? null);
    },

    async getReplies(limit) {
      return parseAndOrder([...memory.replies.values()], limit);
    },

    async putReaction(date, target, emoji, on) {
      const bucket = target === 'his' ? memory.reactions : memory.reactionsHers;
      const day = bucket.get(date) ?? new Map<string, number>();
      bucket.set(date, day);
      if (on) day.set(emoji, Date.now());
      for (const name of storedNamesFor(emoji)) {
        if (!on || name !== emoji) day.delete(name);
      }
    },

    async getReactions(dates) {
      const out = emptyReactions(dates);
      for (const d of dates) {
        out[d] = {
          onHis: normalizeReactions([...(memory.reactions.get(d)?.keys() ?? [])]),
          onHers: normalizeReactions([...(memory.reactionsHers.get(d)?.keys() ?? [])]),
        };
      }
      return out;
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
export function storeTier(): Tier {
  if (hasKV()) return 'upstash';
  if (hasR2()) return 'r2';
  return 'memory';
}

/**
 * Announced ONCE per process, the first time the store is touched.
 *
 * Not decoration. The failure this prevents is the quiet one: a production
 * deploy that silently landed on the memory tier because an environment variable
 * was renamed, where every symptom is "songs sometimes vanish" and no log line
 * ever says why. One line at cold start makes that a five-second diagnosis.
 */
let announced = false;
function announce(tier: Tier): void {
  if (announced) return;
  announced = true;
  if (tier === 'memory') {
    console.warn(
      '[us] song store: IN-PROCESS MEMORY. Non-durable and per-instance — ' +
        'nothing posted here survives a restart. Set UPSTASH_REDIS_REST_URL/_TOKEN ' +
        'or the R2_* variables before this is real.',
    );
  } else {
    console.log(`[us] song store: ${tier}`);
  }
}

function store(): Store {
  const tier = storeTier();
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
   ========================================================================= */

export function putSong(song: SongRecord): Promise<void> {
  return store().putSong(song);
}

export function getSong(date: string): Promise<SongRecord | null> {
  // Guarded here rather than in three implementations: an invalid date can never
  // have a record, so this is "not found" and not an error.
  if (!isWingDate(date)) return Promise.resolve(null);
  return store().getSong(date);
}

export function getSongs(limit: number): Promise<SongRecord[]> {
  // Clamped so a caller cannot ask for the entire history by passing Infinity —
  // on the Redis tier that becomes one enormous MGET.
  const capped = Math.max(0, Math.min(365, Math.floor(limit) || 0));
  if (capped === 0) return Promise.resolve([]);
  return store().getSongs(capped);
}

export function putReply(reply: ReplyRecord): Promise<void> {
  return store().putReply(reply);
}

export function getReply(date: string): Promise<ReplyRecord | null> {
  if (!isWingDate(date)) return Promise.resolve(null);
  return store().getReply(date);
}

export function getReplies(limit: number): Promise<ReplyRecord[]> {
  const capped = Math.max(0, Math.min(365, Math.floor(limit) || 0));
  if (capped === 0) return Promise.resolve([]);
  return store().getReplies(capped);
}

/**
 * Set or clear one reaction. THE LAST GATE BEFORE AN EMOJI IS PERSISTED.
 *
 * Silently ignoring a bad value would hide a typo in a caller; the caller is
 * expected to have validated already, so reaching here with garbage is a bug worth
 * a thrown error rather than a no-op write. isReaction() is re-run here anyway —
 * this is the function every tier is behind, and "the endpoint checked" is not a
 * property the store can verify.
 *
 * NOTE WHAT THIS DOES NOT DO: it does not decide WHO may write which `target`.
 * That is authorization and it lives in /api/us/react, where the cookie is.
 */
export function putReaction(
  date: string,
  target: Side,
  emoji: string,
  on: boolean,
): Promise<void> {
  if (!isWingDate(date)) throw new StoreError(`putReaction: ${date} is not a wing date`);
  if (target !== 'his' && target !== 'hers') throw new StoreError('putReaction: unknown side');
  if (!isReaction(emoji)) throw new StoreError('putReaction: not a single emoji');
  return store().putReaction(date, target, emoji, on);
}

export function getReactions(dates: string[]): Promise<Record<string, DayReactions>> {
  const valid = dates.filter(isWingDate);
  if (valid.length === 0) return Promise.resolve(emptyReactions(valid));
  return store().getReactions(valid);
}

/* ============================================================================
   THE PAIR

   The shape every page renders. A day is not "a song, plus maybe an answer" — it
   is TWO SLOTS, either of which may be empty.

   THE EMPTY SLOT IS THE COMMON CASE, NOT AN ERROR. For most of a year exactly one
   of us will have posted by the time the other opens the page, so a half-filled
   day is the normal reading of this feature and must be shaped, typed and worded
   as such. Nothing here reports a missing half; `solo` states it as a fact, and
   nothing in the type ranks one side above the other.

   The fold lives here rather than in the pages for the same reason the calendar
   does: two pages that each folded songs, replies and reactions into days would
   eventually fold them differently, and the first symptom would be an archive
   showing one side's songs while silently dropping the other's. There is one fold.
   ========================================================================= */

/**
 * Which of the two of us. FIXED IDENTITIES, never viewer-relative.
 *
 * 'his' is whoever holds the admin passcode; 'hers' is whoever answered the three
 * questions. Deliberately not 'mine'/'yours': the same DayPair is rendered on her
 * page and on mine, and a side whose meaning flips with the reader is a side that
 * will eventually be labelled backwards on one of them. The pages map these two
 * words to their own second person ("me" / "you", "me" / "her") at render time.
 */
export type Side = 'his' | 'hers';

export interface DayPair {
  /** `YYYY-MM-DD` in WING_TZ. */
  date: string;
  /** His half, or null. Written only by the ADMIN-authenticated endpoint. */
  his: SongRecord | null;
  /** Her half, or null. Written only by the SESSION-authenticated endpoint. */
  hers: ReplyRecord | null;
  /**
   * The emoji on each side's song that day. Both arrays always present.
   *
   * NOW MUTUAL, and this field is where that change is visible. It used to be a
   * flat `string[]` of reactions on HIS song, sitting beside `his` in this type to
   * say out loud that there was no such thing as a reaction from him. That was
   * honest about the old mechanism and wrong about the product: the reported bug
   * was that one person could react to his own song and the other could not be
   * reacted to at all.
   *
   * So it is a per-side record, keyed by the side the reaction is ON. Each list is
   * dropped when the matching side has no song that day — a receipt for a track
   * that is not on the page is worse than no receipt.
   */
  reactions: DayReactions;
  /**
   * Both of us posted. This is the definition the shared streak counts.
   *
   * There is deliberately NO `solo` counterpart. It existed for one revision, was
   * serialized into every archive row of the API response, and was read by
   * nothing: `!both && (his || hers)` is the same test, and a stored field that
   * duplicates a derivable one is a field that can eventually disagree with it.
   * "Exactly one of us posted" is the ORDINARY case and needs no flag to announce
   * itself — the pages simply render the half that is there.
   */
  both: boolean;
}

/**
 * Assemble one day from parts already in hand.
 *
 * Exported because /samdrea/dj fetches a single day BY KEY rather than from the
 * windowed list (so that backfilling a morning older than the window still shows a
 * confirmation), and it must produce a pair identical to the ones buildPairs()
 * emits. Two constructors for one shape is how the preview ends up disagreeing
 * with the page it is previewing.
 */
export function pairFrom(
  date: string,
  his: SongRecord | null,
  hers: ReplyRecord | null,
  reactions: DayReactions = noReactions(),
): DayPair {
  return {
    date,
    his: his ?? null,
    hers: hers ?? null,
    /* Normalized per side, and each side dropped entirely when THAT side has no
       song: a reaction is attached to one track, so keeping an orphan would render
       a receipt for something that is not on the page. normalizeReactions() is what
       applies the legacy-key migration, de-duplicates U+FE0F variants and caps the
       count — anything it cannot make sense of is dropped rather than rendered,
       which is what makes retiring a reaction safe. */
    reactions: {
      onHis: his ? normalizeReactions(reactions.onHis) : [],
      onHers: hers ? normalizeReactions(reactions.onHers) : [],
    },
    both: Boolean(his && hers),
  };
}

/** How many reactions a day carries in total, both directions. */
export function reactionCount(pair: DayPair): number {
  return pair.reactions.onHis.length + pair.reactions.onHers.length;
}

/** A day with nothing on it. For "today" before either of us has posted. */
export function emptyPair(date: string): DayPair {
  return pairFrom(date, null, null, noReactions());
}

/**
 * Fold two flat histories plus the reactions into days, newest first.
 *
 * PURE, and takes exactly what getExchange() returns, so it can be exercised
 * without a store. Every date that appears on either side gets a row; a date with
 * nothing on it cannot appear, because there is nothing to build it from.
 *
 * Both sides go through a Map before anything is counted, so a duplicated record
 * — a caller that concatenated two reads, a tier that returned a date twice —
 * produces one row rather than two. The totals and the shared streak are numbers
 * two people read as facts about themselves; they do not get to be inflated by a
 * retried read.
 */
export function buildPairs(input: {
  songs: readonly SongRecord[];
  replies: readonly ReplyRecord[];
  reactions: Record<string, DayReactions>;
}): DayPair[] {
  const his = new Map<string, SongRecord>();
  for (const s of input.songs) if (isWingDate(s.date)) his.set(s.date, s);

  const hers = new Map<string, ReplyRecord>();
  for (const r of input.replies) if (isWingDate(r.date)) hers.set(r.date, r);

  return [...new Set([...his.keys(), ...hers.keys()])]
    // Newest first. String comparison is correct for ISO dates.
    .sort((a, b) => b.localeCompare(a))
    .map((date) =>
      pairFrom(
        date,
        his.get(date) ?? null,
        hers.get(date) ?? null,
        input.reactions[date] ?? noReactions(),
      ),
    );
}

/**
 * Everything a page needs to render a stretch of days as PAIRS.
 *
 * WHY THIS IS ONE FUNCTION AND NOT THREE CALL SITES: every page that shows a day
 * needs all three parts of it, and every page that assembled them itself would be
 * free to forget one — the archive that shows his songs and silently drops hers is
 * the exact bug this prevents, and it is the bug the old one-sided page shipped.
 *
 * TWO ROUND TRIPS, NOT THREE, AND THAT IS THE MOST IT CAN BE. The two shelves are
 * independent, so they go in parallel. Reactions cannot: they are fetched BY DATE
 * and the dates are not known until the songs come back. So the shape below is
 * `Promise.all` then one dependent read, which is the minimum the data dependency
 * allows.
 *
 * Reactions are requested for the UNION of both sides' dates, which is the change
 * mutual reactions forced here. It used to ask about HIS dates only, because that
 * was the only kind of reaction that existed — and left that way it would have made
 * every reaction he gave to her song invisible on every page, silently, with the
 * write path working perfectly. De-duplicated first, so a day both of us posted on
 * is asked about once.
 *
 * ABOUT `limit`, HONESTLY: it caps each shelf, not the number of days. Two
 * histories of `limit` records that never overlap produce up to `2 * limit` pairs,
 * so a caller that renders a fixed number of rows must slice `pairs` itself rather
 * than trust the length. The counting callers WANT the wider window; the rendering
 * ones slice. Stating it here is cheaper than a surprise at row 61.
 *
 * Failure is NOT swallowed. The reasoning is the file header's: a page that quietly
 * rendered an empty archive because one read failed would look exactly like a page
 * whose archive is genuinely empty, and the caller is the only one who knows how to
 * say "the shelf is not answering" in her language.
 */
export async function getExchange(
  limit: number,
): Promise<{
  songs: SongRecord[];
  replies: ReplyRecord[];
  /** date -> per-side emoji. Keyed for every date on EITHER side, so no caller checks undefined. */
  reactions: Record<string, DayReactions>;
  /** Days, newest first. See the note above about how many there can be. */
  pairs: DayPair[];
  /** date -> day, for O(1) lookup of one specific day inside the window. */
  pairByDate: Record<string, DayPair>;
}> {
  const [songs, replies] = await Promise.all([getSongs(limit), getReplies(limit)]);
  const reactedDates = [...new Set([...songs.map((s) => s.date), ...replies.map((r) => r.date)])];
  const reactions = await getReactions(reactedDates);

  const pairs = buildPairs({ songs, replies, reactions });
  const pairByDate: Record<string, DayPair> = {};
  for (const p of pairs) pairByDate[p.date] = p;

  return { songs, replies, reactions, pairs, pairByDate };
}

/* ============================================================================
   THE DERIVATIONS

   Everything below is a PURE FUNCTION over records that are already in memory.
   No I/O, no clock of its own — `today` is passed in, because a function that
   read the clock itself could not be reasoned about and would make the streak on
   her page disagree with the streak on mine by one day for an hour every night.

   THE RULE FOR ALL OF IT: never print a number the stored data does not support.
   A "streak" that counts days nobody posted, or a total that quietly means "in
   the last 60 records we happened to read", is worse than no number — it is a
   number she would believe. Every field below says exactly what it counted, and
   the window it counted over is the caller's `limit`, stated once at the call
   site rather than implied here.
   ========================================================================= */

export interface Rhythm {
  /** Days with at least one song on them, either side. */
  days: number;
  /** Days he posted. */
  his: number;
  /** Days she posted. */
  hers: number;
  /**
   * Days BOTH of us posted. THE SHARED NUMBER, and the only one either page is
   * allowed to call a streak.
   *
   * This replaced a one-sided count of his mornings, and the replacement is the
   * point rather than a refactor. "How many days in a row did I post" measures one
   * person's discipline, which is a fact about him that she has to watch. "How many
   * days did we both show up" measures the thing the feature exists for, cannot be
   * moved by one person alone, and is the number worth putting on a page two people
   * read. It is also a SMALLER number, which is the honest cost of measuring the
   * right thing.
   */
  both: number;
  /**
   * Days with at least one reaction on them, EITHER DIRECTION.
   *
   * THE MEANING CHANGED WITH THE MECHANISM, and saying so is the point of this
   * paragraph. It used to be "days she reacted to his song", which was the only
   * kind of reaction that existed. Now both of them can react, so a count of one
   * direction would be a number that quietly stopped meaning what its name says
   * the day the second direction shipped.
   *
   * Still kept separate from `his`/`hers`, which count POSTS. A reaction is not a
   * post and lumping the two would inflate a number two people read as a fact.
   */
  reacted: number;
  /** Days she reacted to his song. The old `reacted`, under an honest name. */
  reactedOnHis: number;
  /** Days he reacted to her song. */
  reactedOnHers: number;
  /**
   * Consecutive days we BOTH posted, counting back from today.
   *
   * If today is not yet a both-day — which it usually is not, because one of us
   * has not opened the page — this counts back from yesterday instead and
   * `streakLive` is false. At 7am on a Tuesday the Monday-ending run is the true
   * answer, and zeroing the number every midnight would be both wrong and cruel.
   */
  streak: number;
  /** Whether `streak` includes today. Drives the tense of the sentence. */
  streakLive: boolean;
  /** Longest run of consecutive both-days anywhere in the window. */
  best: number;
  /** Earliest date seen, either side. '' when there is nothing at all. */
  first: string;
  /** Calendar days from `first` to `today` inclusive. 0 when empty. */
  span: number;
}

const EMPTY_RHYTHM: Rhythm = {
  days: 0,
  his: 0,
  hers: 0,
  both: 0,
  reacted: 0,
  reactedOnHis: 0,
  reactedOnHers: 0,
  streak: 0,
  streakLive: false,
  best: 0,
  first: '',
  span: 0,
};

/**
 * Count what actually happened, over the days the caller read.
 *
 * Takes PAIRS rather than two record arrays, so "both of us posted" is decided in
 * exactly one place — buildPairs / pairFrom — and cannot be re-derived here with a
 * slightly different rule.
 *
 * EVERY TOTAL IS THE SIZE OF A SET OF DATES, never the length of the input array.
 * An earlier version of this counted `pairs.length` and incremented per element,
 * which was correct for the only two callers (both hand it buildPairs output, which
 * is already de-duplicated) and quietly wrong for anyone else — an adversarial
 * review fed it the same pair twice and got `days: 2, his: 2`. This function is
 * exported and takes a plain readonly array, so it cannot assume its input went
 * through the fold. These numbers are read as facts about two people; they do not
 * get to be inflated by a caller that concatenated two reads.
 */
export function summarize(input: {
  /** Today in WING_TZ. Passed, never read from the clock. See the section header. */
  today: string;
  pairs: readonly DayPair[];
}): Rhythm {
  const { today } = input;
  if (!isWingDate(today)) return EMPTY_RHYTHM;

  // A pair with nothing on it (emptyPair for a day neither of us has reached yet)
  // is not a day that happened, so it is not counted as one.
  const pairs = input.pairs.filter((p) => isWingDate(p.date) && (p.his || p.hers));
  if (pairs.length === 0) return EMPTY_RHYTHM;

  const allDates = new Set<string>();
  const hisDates = new Set<string>();
  const herDates = new Set<string>();
  const reactedDates = new Set<string>();
  const reactedOnHisDates = new Set<string>();
  const reactedOnHersDates = new Set<string>();
  const bothDates = new Set<string>();
  for (const p of pairs) {
    allDates.add(p.date);
    if (p.his) hisDates.add(p.date);
    if (p.hers) herDates.add(p.date);
    if (p.both) bothDates.add(p.date);
    if (p.reactions.onHis.length > 0) reactedOnHisDates.add(p.date);
    if (p.reactions.onHers.length > 0) reactedOnHersDates.add(p.date);
    if (reactionCount(p) > 0) reactedDates.add(p.date);
  }

  // Walk back one day at a time. Bounded by the window the caller read rather
  // than by a `while (true)`: the loop can only ever run as many times as there
  // are both-days, because the first gap ends it.
  const streakLive = bothDates.has(today);
  let cursor = streakLive ? today : shiftDate(today, -1);
  let streak = 0;
  while (bothDates.has(cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }

  // Longest run ever. Ascending order so a run is "this date's predecessor was
  // also a both-day", which is one pass and no lookahead.
  const ascending = [...bothDates].sort();
  let best = 0;
  let run = 0;
  let previous = '';
  for (const date of ascending) {
    run = previous && shiftDate(previous, 1) === date ? run + 1 : 1;
    if (run > best) best = run;
    previous = date;
  }

  // Sorted rather than "the last row", so this does not depend on buildPairs
  // having ordered its output — a total she reads as a fact should not rest on
  // another function's sort order.
  const first = [...allDates].sort()[0] ?? '';

  return {
    days: allDates.size,
    his: hisDates.size,
    hers: herDates.size,
    both: bothDates.size,
    reacted: reactedDates.size,
    reactedOnHis: reactedOnHisDates.size,
    reactedOnHers: reactedOnHersDates.size,
    streak,
    streakLive,
    best,
    first,
    span: first ? Math.max(1, daysBetween(first, today)) : 0,
  };
}

/**
 * How long ago a stored day was, in words. Presentation only.
 *
 * Rounded DOWN and hedged with "about" past a fortnight, because the alternative
 * is a card that claims "3 weeks ago" about something 18 days old. The unit gets
 * coarser as it recedes, which is how people actually talk about time.
 */
export function agoLabel(date: string, today: string): string {
  if (!isWingDate(date) || !isWingDate(today)) return '';
  const days = daysBetween(date, today) - 1;
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `about ${Math.floor(days / 7)} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `about ${months} months ago`;
  return `about ${Math.floor(days / 365)} years ago`;
}

/** `3:42` from milliseconds. '' when the duration is unknown — see TrackRecord. */
export function durationLabel(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * How old a morning has to be before it is worth playing again.
 *
 * Two weeks. Short enough that this has something to show inside the first month,
 * long enough that "remember this one?" is not pointing at last Thursday — which
 * is still in the visible archive and would make the whole block look broken.
 */
export const RESURFACE_MIN_AGE_DAYS = 14;

/**
 * Pick one old DAY to bring back, or null when there is not one worth it.
 *
 * Returns the whole pair, not one track, and that is the change that matters here.
 * The old version resurfaced one of his songs and left her half of that day
 * behind — so the feature that exists to say "remember this one?" was structurally
 * incapable of remembering hers. A day is the unit.
 *
 * DETERMINISTIC PER DAY, and that is the requirement that shapes the rest. A
 * random pick would change on every reload, so the one she wanted to come back to
 * after making coffee would be gone and unfindable — a memory feature whose
 * memories move is actively worse than no feature. Keying the choice off `today`
 * means it is stable for the whole day and different tomorrow.
 *
 * THE PREFERENCE LADDER, strongest evidence first:
 *
 *   1. days we BOTH posted   — two people chose to be there. Nothing in the store
 *                              is better evidence that a day was worth having.
 *   2. days SOMEBODY reacted — the next best, and the only other signal we record.
 *                              Either direction counts: a day he answered her song
 *                              with an emoji is exactly as much evidence as the
 *                              mirror image, and only counting hers would have made
 *                              the memory feature prefer his mornings.
 *   3. any old day           — because on day 20 neither of the above may exist
 *                              yet, and an empty block explaining its own absence
 *                              is worse than an unremarkable Tuesday.
 */
export function resurface(input: {
  today: string;
  pairs: readonly DayPair[];
}): DayPair | null {
  const { today } = input;
  if (!isWingDate(today)) return null;

  const cutoff = shiftDate(today, -RESURFACE_MIN_AGE_DAYS);
  // String comparison is correct for ISO dates, and `<=` excludes the cutoff day
  // itself so the boundary is "at least this old".
  const old = input.pairs.filter(
    (p) => isWingDate(p.date) && p.date <= cutoff && (p.his || p.hers),
  );
  if (old.length === 0) return null;

  const together = old.filter((p) => p.both);
  const answered = old.filter((p) => reactionCount(p) > 0);
  const pool = together.length > 0 ? together : answered.length > 0 ? answered : old;

  // Sorted by date so the pool's ORDER does not depend on how the store happened
  // to hand the records back — otherwise the "deterministic" pick would quietly
  // differ between the R2 tier (object key order) and Redis (index order).
  const ordered = [...pool].sort((a, b) => a.date.localeCompare(b.date));
  /* dayNumber, NOT dateScore — see the comment on dayNumber. Using the decimal date
     here made the same memory resurface on two consecutive mornings at every month
     boundary, because 0831 to 0901 is a jump of seventy rather than one. */
  return ordered[dayNumber(today) % ordered.length] ?? null;
}
