/**
 * letters.ts — the long-form room. Content that Sam AUTHORS, state that SHE writes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * Everything else in the wing is short by design and the shortness is load-bearing:
 * a song takes a 200-character note because it is written one-handed at 7am, a
 * photo caption is one line because it sits on a panel in a 3D room. Those limits
 * are correct for what they are. What they add up to is a wing with nowhere to say
 * anything at length — and a year of long distance is not made of one-liners.
 *
 * So: letters. Actual prose, hundreds of words, read as a page rather than as a
 * card. The whole feature is the reading experience, which is why the typography
 * lives in its own stylesheet and why this file's only jobs are (a) get the text to
 * the page correctly and (b) remember what she has read and what she wrote back.
 *
 * ---------------------------------------------------------------------------
 * THE RELEASE MODEL, AND WHY IT IS THIS ONE
 *
 * Four options were on the table and three of them are worse:
 *
 *   ALL AT ONCE      A wall of text. Twelve letters on one screen is an archive,
 *                    and an archive is something you mean to get to. The first one
 *                    is the only one that gets read properly.
 *   ONE PER VISIT    A slot machine. It makes the ROOM the author — she has to keep
 *                    coming back to see whether the machine feels like giving her
 *                    something, and the letter she is reading is chosen by a
 *                    scheduler rather than by me. That is the opposite of a letter.
 *   STRICTLY DATED   A promise I might not keep. "One on the first of every month"
 *                    is a subscription, and the month I miss is a month the room
 *                    tells her I missed it.
 *   SEALED-OR-OPEN   What this file does, and what won.
 *
 * Every letter carries an OPTIONAL `openOn` date.
 *
 *   - No `openOn` → it is simply there, from the moment I write it. This is the
 *     default and it should stay the common case: the honest shape of "I wrote you
 *     something" is that it is available.
 *   - `openOn` in the future → it is SEALED. The shelf shows that it exists and the
 *     date it opens, and NOTHING ELSE. On that date it opens by itself and stays
 *     open forever after.
 *
 * That gives me one deliberate instrument — "not until your birthday", "not until
 * the flight home" — without turning the whole room into a schedule. Nothing
 * expires, nothing is rationed, nothing disappears once read. She can re-read any
 * open letter as many times as she likes, which is the actual behaviour of somebody
 * who liked a letter.
 *
 * THE SEAL IS ENFORCED ON THE SERVER, NOT IN CSS. A sealed letter's body is never
 * put in the response at all — not hidden, not collapsed, not behind a class. See
 * `visibleLetter()`. `display: none` on a letter I promised not to show her until
 * October is a promise broken by View Source, and she is a smart person with a
 * phone.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE TEXT LIVES, AND WHY IT IS NOT IN THE STORE
 *
 * THIS REPO IS PUBLIC. So the committed manifest below is PLACEHOLDERS ONLY, in the
 * same obviously-fake `[bracketed lowercase]` style photos.ts uses, and the real
 * letters arrive in `US_LETTERS` — base64(JSON), exactly the mechanism `US_QUESTIONS`
 * already uses in config.ts to keep a question out of the repository. When it is set
 * it replaces the manifest wholesale; when it is not, the room renders placeholders
 * that could not possibly be mistaken for something I wrote to her.
 *
 * The alternative was an admin UI writing letters into the store. It was rejected,
 * and the reason is worth stating because it is also a security property:
 *
 *   NOTHING IN THIS CODEBASE CAN WRITE A LETTER BODY TO ANY STORE.
 *
 * There is no such field, no such command and no such endpoint. /api/us/reply
 * documents the split — her cookie writes replies, my cookie writes songs — and
 * relies on two endpoints each naming one cookie. Here the split is stronger than
 * that: it is not enforced by a check that could be got wrong, it is enforced by the
 * absence of a code path. A bug in the letters endpoint cannot forge a letter from
 * me, because forging one would require a feature that does not exist.
 *
 * The cost is real and I am not hiding it: publishing a letter means editing JSON,
 * base64-ing it, and setting an environment variable. That is friction on MY side,
 * once per letter, in exchange for her side being unforgeable. Fine trade.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE STORE ACTUALLY HOLDS
 *
 * Per letter: when she first opened it, when she last opened it, how many times,
 * and her reply. That is the entire schema. It is the mutable half — the half that
 * is HERS — and it is the only half anything here can write.
 *
 * OWN KEY SPACE, OWN DOCUMENT: `us:letter:*` on Upstash, `data/letters.json` on R2.
 * kv.ts owns `us:song:*` / `data/songs.json`; marks.ts owns `us:mark:*` /
 * `data/marks.json`. Two whole-document writers on one R2 key is not a race, it is
 * data loss on a schedule.
 *
 * Every hard-won operational detail is COPIED from kv.ts and marks.ts rather than
 * re-derived, because re-deriving them means re-learning them the expensive way:
 * `region: 'auto'`, `retries: 1` (aws4fetch defaults to TEN with exponential
 * backoff, which will spend a whole serverless invocation on a bucket that is
 * down), a hard `AbortSignal.timeout` that stays armed through the body read,
 * per-segment key encoding, a Content-Length pre-check, orphan and unknown-field
 * preservation, and — the one that cost real debugging time — stripping the `W/`
 * prefix off R2's ETag so `If-Match` can actually match. See `readDoc()`.
 *
 * ---------------------------------------------------------------------------
 * FAILURE POLICY: SPLIT, THE SAME WAY marks.ts SPLITS IT
 *
 * HER REPLY FAILS LOUD. A letter she answered at length that silently did not save
 * is the worst outcome this feature has available — she would believe she sent it,
 * I would never see it, and nothing would say so. A transport error is a thrown
 * LetterError and the endpoint turns it into a 502 she can retry with the text
 * still in the textarea.
 *
 * READ RECEIPTS FAIL SOFT. "New" versus "read again" is a nicety on a page that
 * must render regardless. If the store is unreachable she gets the letters with no
 * new/read distinction, which is fine; an error page instead of the letter is not.
 * ---------------------------------------------------------------------------
 */

import { AwsClient } from 'aws4fetch';
import { hasKV, hasR2, kvConfig, r2Config, r2Endpoint } from './config';
/* The wing's calendar, imported rather than re-implemented. kv.ts's comment on
   WING_TZ explains why one fixed zone exists at all; the point here is that a
   letter's "opens on the 3rd" and a song's "today" MUST agree about when the 3rd
   starts. Two implementations of that would disagree twice a year at the DST
   boundaries, and the symptom would be a sealed letter opening a day early. */
import { isWingDate, wingDate } from './kv';
import { countCommands, timer } from './trace';

/** Thrown for transport problems only. A letter she has never opened is a DEFAULT. */
export class LetterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LetterError';
  }
}

export type Tier = 'upstash' | 'r2' | 'memory';

/**
 * 2500ms on every network call, matching marks.ts rather than kv.ts's 2000.
 *
 * Same reasoning: her reply write happens while she is looking at a button waiting
 * for it to confirm, and a spurious "that didn't save" on a train connection is
 * worse here than half a second of waiting — she would retype a paragraph. Still a
 * HARD deadline, because this runs inside a serverless function on its own budget.
 *
 * ALWAYS `AbortSignal.timeout()`, never an AbortController cleared in a `finally`.
 * `fetch` resolves as soon as the response HEADERS arrive, so clearing the timer
 * before reading the body leaves the download unbounded and a server that answers
 * 200 then stalls hangs the whole invocation — precisely what this constant exists
 * to prevent. marks.ts documents the same mistake; it is not repeated here.
 */
const TIMEOUT_MS = 2500;

/* ============================================================================
   PART ONE — THE CONTENT

   Authored by Sam. Read-only at runtime. Nothing below this heading is ever
   written by anything.
   ========================================================================= */

export interface Letter {
  /**
   * Stable public id, and the ONLY thing that ever appears in a URL or becomes a
   * store key. Constrained to `[a-z0-9-]` so that even a bug cannot turn it into a
   * path segment, an R2 object key, or a Redis pattern.
   *
   * TREAT THESE AS PERMANENT. The read receipt and her reply are filed under this
   * id, so renaming one after she has read it orphans her words. They are
   * preserved rather than deleted (see LettersDoc.orphans) but they stop being
   * attached to the letter, and only a hand-edit puts them back.
   */
  id: string;
  /** What the shelf calls it. Falls back to plain "a letter" when empty. */
  title: string;
  /**
   * `YYYY-MM-DD` — when it was WRITTEN, in the wing's timezone. Displayed, and the
   * sort key for the sequence she reads.
   *
   * An unparseable value is kept as '' rather than dropping the letter: nothing an
   * author typo'd should cost her the letter itself. It sorts last and renders
   * with no dateline, and the console says so loudly.
   */
  written: string;
  /**
   * `YYYY-MM-DD`, OPTIONAL — sealed until this day in the wing's timezone, then
   * open forever. Absent means available now, which is the intended default.
   *
   * AN UNPARSEABLE VALUE KEEPS IT SEALED. That direction is deliberate: the two
   * failure modes are "a typo hides a letter until he fixes it" and "a typo shows
   * her a letter I promised not to show her yet", and only one of those breaks a
   * promise. Fail toward the seal, log loudly.
   */
  openOn?: string;
  /**
   * OPTIONAL — the label on the outside of an envelope she chooses when to open.
   * The words AFTER "open when": `you can't sleep`, `you're annoyed with me`,
   * `you miss me`, `it's a bad day`.
   *
   * ---------------------------------------------------------------------------
   * THE OTHER KIND OF SEAL, AND WHY IT IS A DIFFERENT KIND
   *
   * `openOn` is a seal against the CALENDAR: it opens on its own, whether or not
   * she wants it, and nothing she does moves it. That is right for a birthday and
   * wrong for everything else, because the moment a letter is actually needed is
   * not a date anybody can put on it in advance.
   *
   * This is a seal against her CHOICE. The letter sits there indefinitely showing
   * only its label, and it opens when she decides the label describes today. So
   * the timing is handed to the only person who can know it.
   *
   * IT IS SINGLE USE, AND THAT IS THE POINT. Once opened it stays open forever —
   * it is not a trick and it never re-seals — but it cannot go back to being
   * unopened, so there is a real decision in picking one. A set of these that
   * could all be opened and re-sealed at will is just a list of letters with
   * moods written on them; the finality is what makes choosing feel like
   * anything. `LetterState.firstReadAt` already records it, so this needs no new
   * storage at all.
   *
   * BOTH SEALS CAN APPLY. With `openOn` as well, the date must pass FIRST and
   * then it becomes hers to open — "you can have this one, but not before
   * October". The date gate is checked first in isSealed() for that reason.
   *
   * Safe to send to the browser while sealed, like `teaser` and for the same
   * reason: she cannot choose an envelope she is not allowed to read the outside
   * of. It is capped at TEASER_MAX so it cannot quietly become a second body.
   */
  openWhen?: string;
  /**
   * The letter. Paragraphs separated by BLANK LINES — see `paragraphs()`, which is
   * the only thing that interprets this string.
   *
   * No markdown, no HTML, no formatting vocabulary of any kind, and that is a
   * decision rather than an omission: the moment this accepts markup it becomes a
   * string that gets interpolated into a page, and every XSS in the history of
   * this pattern starts with "it is only my own content". It is prose. The page
   * renders it as escaped text inside real <p> elements.
   */
  body: string;
  /** Optional closing line, set apart from the prose. "— S", "yours", whatever. */
  signoff?: string;
  /**
   * Optional, and the ONE thing a sealed letter is allowed to show.
   *
   * A sealed card with nothing but a date is honest but inert. This lets me put a
   * few words on the outside of the envelope. It is sent to the browser while the
   * letter is sealed, so it must be safe to read early — that is the whole contract
   * of the field, and it is capped short (see TEASER_MAX) so it cannot quietly
   * become a second body.
   */
  teaser?: string;
}

/** Ids are matched against this, never sanitised into it. */
const LETTER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A teaser is a line on an envelope, not a preview. Truncated, loudly, past this. */
const TEASER_MAX = 90;

/**
 * Past this many characters a body gets a loud console warning and is rendered
 * ANYWAY, in full.
 *
 * Not a cap, on purpose. Truncating something Sam wrote to her — mid-sentence, with
 * no marker, because there is no honest marker — is a worse outcome than a heavy
 * page, and there is exactly one author so this is not an untrusted input. The
 * number exists so that "her letters page got slow" is a five-second diagnosis
 * instead of a mystery. ~24k characters is about four thousand words.
 */
const BODY_WARN = 24_000;

/**
 * THE PLACEHOLDER MANIFEST. Every word of it is fake and must obviously be fake.
 *
 * The `[bracketed lowercase]` style is copied verbatim from photos.ts's MEMORIES and
 * it is doing real work: this repo is public, so the failure to design against is a
 * placeholder that reads as a real letter and gets shipped, or worse, a real letter
 * that gets committed because the file already looked like it holds real letters.
 * Brackets make both impossible to miss in a diff.
 *
 * REPLACE THIS BY SETTING `US_LETTERS`, NOT BY EDITING THIS ARRAY. See loadLetters().
 */
export const PLACEHOLDER_LETTERS: readonly Letter[] = [
  {
    id: 'l01',
    title: '[the first one]',
    written: '2026-01-01',
    body: [
      /* The environment variable's NAME used to be in this sentence, and this
         string is reader-visible and NOT dev-gated — the banner above the shelf
         is, but the letter body is not, and the body is also the only one of the
         two that a reader sees on the reading view. So the one place a config
         key could reach production HTML was inside a placeholder. The
         instruction to replace it belongs in the doc comment above this array,
         where it already is. */
      '[replace this. this is the placeholder letter and it exists to prove the',
      'room renders, nothing else.]',
      '',
      '[two things about the body format, both of which matter more than they',
      'look. paragraphs are separated by a BLANK LINE and nothing else — no',
      'markdown, no html, no asterisks, because the page renders this as escaped',
      'text and any markup you type will show up as the characters you typed.]',
      '',
      '[and write it long. the entire reason this room exists is that everywhere',
      'else in the wing caps you at a sentence. this page is set for reading:',
      'a serif, a sixty-character measure, and leading you can actually follow',
      'down a phone screen at midnight. use it.]',
    ].join('\n'),
    signoff: '[— sign it]',
  },
  {
    id: 'l02',
    title: '[an undated one]',
    written: '2026-02-14',
    body: [
      '[replace this too. this second placeholder exists to show what the shelf',
      'looks like with more than one letter on it, and to demonstrate that a',
      'letter with no openOn date is simply available — which is the default and',
      'should stay the common case.]',
    ].join('\n'),
  },
  {
    id: 'l03',
    title: '[a sealed one]',
    /* Deliberately sealed with a date far enough out that it stays sealed while
       the placeholders are still in place. This is the card to look at to check
       that the seal works: the body below must NEVER appear in the HTML of the
       shelf, and hitting ?read=l03 must be refused by the server. */
    written: '2026-03-01',
    openOn: '2099-12-25',
    teaser: '[a line on the outside of the envelope]',
    body: [
      '[if you can see this text in the page source, the seal is broken and that',
      'is a bug worth stopping for. a sealed body is never sent to the browser —',
      'see visibleLetter() in src/lib/us/letters.ts.]',
    ].join('\n'),
  },
  {
    id: 'l04',
    title: '[an open-when one]',
    /* THE OTHER SEAL. No date at all — this one sits on the `whenever` shelf
       showing nothing but its label until she decides the label describes today,
       and then it is open forever. Check the same thing here as on l03: the body
       must not appear in the HTML of the shelf, and `?read=l04` WITHOUT `&open=1`
       must render the choose card rather than the letter. */
    written: '2026-04-02',
    openWhen: "you can't sleep",
    teaser: '[a line she reads before deciding]',
    body: [
      '[replace this. these are the ones worth writing carefully, because she will',
      'open this one at 3am on the night it applies and nothing else on the site',
      'will be doing any work at that moment. write it for that night.',
      '',
      'good labels are specific states, not moods in general: "you cannot sleep",',
      '"you are annoyed with me", "you got bad news", "you are about to do the',
      'thing you are nervous about". a label she never reaches is a letter she',
      'never reads.]',
    ].join('\n'),
  },
] as const;

/**
 * Read one environment variable.
 *
 * A third copy of config.ts's `env()` — after ratelimit.ts's — and the duplication
 * is deliberate for the reason ratelimit.ts's comment gives: the lookup ORDER has
 * to match, or two files disagree about whether something is configured. Bracket
 * access on a VARIABLE, never `import.meta.env.US_LETTERS`, because Vite statically
 * replaces the dotted form at build time and on Vercel that bakes in the build
 * container's answer — which is `undefined` — forever.
 *
 * It is not imported from config.ts because config.ts is not mine to extend, and a
 * copy with this comment on it is cheaper than a shared helper that needs a new
 * export in a file three other features depend on.
 */
function env(name: string): string | undefined {
  const fromMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromNode = typeof process !== 'undefined' ? process.env : undefined;
  const value = fromMeta?.[name] ?? fromNode?.[name];
  // Empty string is absent. Vercel's UI happily saves a blank value.
  return value && value.length > 0 ? value : undefined;
}

/** Normalise whatever a keyboard produced into one canonical string. */
function tidyProse(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return (
    raw
      // CRLF and CR both fold to LF, so a body is the same string whether it was
      // typed on a phone, pasted from Notes, or arrived through a form POST (which
      // converts every LF to CRLF on the wire).
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex -- deliberate: strip invisibles
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      // Three or more blank lines collapse to one paragraph break. A wall of them
      // is a paste artifact, never a decision.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** One line: newlines become spaces. For titles, teasers and signoffs. */
function tidyLine(raw: unknown, max: number, label: string): string {
  const flat = tidyProse(raw).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  console.warn(`[us] ${label} is longer than ${max} characters; it is being cut.`);
  return cutWithoutSplittingAnEmoji(flat, max);
}

/**
 * `slice()` counts UTF-16 CODE UNITS and an emoji is two of them, so cutting at
 * exactly `max` can land between a surrogate pair and store a LONE HIGH SURROGATE,
 * which every renderer draws as U+FFFD. Dropping the orphan costs one character
 * from a string that was already being cut. Lifted from marks.ts's normalizeNote.
 */
function cutWithoutSplittingAnEmoji(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * One entry from the manifest or from US_LETTERS, validated into a Letter.
 *
 * Returns null ONLY for the two things a letter cannot survive without: a usable
 * id (there is no URL and no store key without one) and a non-empty body (there is
 * nothing to read). Everything else degrades and logs — an author typo must not
 * cost her a letter.
 */
function parseLetter(raw: unknown, where: string): Letter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.error(`[us] letters: ${where} is not an object — skipping it.`);
    return null;
  }
  const obj = raw as Record<string, unknown>;

  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (!LETTER_ID_RE.test(id)) {
    console.error(
      `[us] letters: ${where} has id ${JSON.stringify(obj.id)}, which is not ` +
        '[a-z0-9-] (1-40 chars). Skipping it — an id is a URL and a store key, so ' +
        'there is nothing safe to do with a bad one.',
    );
    return null;
  }

  const body = tidyProse(obj.body);
  if (!body) {
    console.error(`[us] letters: ${id} has no body — skipping it. A letter is its text.`);
    return null;
  }
  if (body.length > BODY_WARN) {
    console.warn(
      `[us] letters: ${id} is ${body.length} characters. Rendered in full anyway ` +
        '(truncating something you wrote to her is worse than a heavy page), but ' +
        'that is the reason this page is slow if it is.',
    );
  }

  let written = '';
  if (isWingDate(obj.written)) {
    written = obj.written;
  } else if (obj.written !== undefined) {
    console.error(
      `[us] letters: ${id} has written=${JSON.stringify(obj.written)}, which is not ` +
        'YYYY-MM-DD. Keeping the letter with no date; it will sort last.',
    );
  }

  /* SEALED IS THE FAIL-CLOSED DIRECTION. An openOn we cannot parse is treated as a
     seal with no opening date rather than as "no seal" — see the field comment.
     `'9999-12-31'` is a sentinel and not a magic number by accident: every
     comparison in this file is a string compare on ISO dates, so the latest
     representable day is the one that means "not until somebody fixes this". */
  let openOn: string | undefined;
  if (obj.openOn !== undefined && obj.openOn !== null && obj.openOn !== '') {
    if (isWingDate(obj.openOn)) {
      openOn = obj.openOn;
    } else {
      console.error(
        `[us] letters: ${id} has openOn=${JSON.stringify(obj.openOn)}, which is not ` +
          'YYYY-MM-DD. It stays SEALED until that is fixed — failing toward the seal, ' +
          'because the other direction shows her a letter early.',
      );
      openOn = '9999-12-31';
    }
  }

  return {
    id,
    title: tidyLine(obj.title, 120, `letters: ${id} title`),
    written,
    ...(openOn ? { openOn } : {}),
    body,
    signoff: tidyLine(obj.signoff, 80, `letters: ${id} signoff`) || undefined,
    teaser: tidyLine(obj.teaser, TEASER_MAX, `letters: ${id} teaser`) || undefined,
    /* Same cap as a teaser: both are words on the OUTSIDE of an envelope, both
       are sent while sealed, and neither may quietly become a second body. */
    openWhen: tidyLine(obj.openWhen, TEASER_MAX, `letters: ${id} openWhen`) || undefined,
  };
}

/* The decode is cached against the RAW env string, not against a boolean.
   Two reasons. It runs on every render and on every id validation, and
   base64 + JSON.parse + validation of a few thousand characters is not free.
   And keying on the raw value means a changed variable is picked up by a warm
   instance on its next request rather than sticking until it is recycled — which
   is the bug you get from caching this at module scope. */
let lettersCacheKey: string | null = null;
let lettersCache: readonly Letter[] = [];
/**
 * Did the last load actually end up on the committed placeholders?
 *
 * A separate flag rather than `!env('US_LETTERS')`, and the difference is a bug the
 * standalone exercise caught: with the variable SET BUT MALFORMED, loadLetters()
 * falls back to placeholders while `!env(...)` is false, so the dev banner that
 * exists to say "nothing she can see is real" stays hidden in precisely the
 * situation it was written for. The flag records what happened rather than what was
 * configured.
 */
let lettersAreFake = true;

/**
 * The letters, oldest first, validated.
 *
 * `US_LETTERS` — base64(JSON) of `Letter[]` — replaces the placeholder manifest
 * WHOLESALE when it is set. Exactly the mechanism config.ts's loadQuestions() uses
 * for `US_QUESTIONS`, for exactly the same reason: this repo is public and the
 * content is not.
 *
 * A malformed variable degrades to the PLACEHOLDERS and says so loudly. It
 * deliberately does not degrade to an empty room: an empty letters page is
 * indistinguishable from "he has not written any", which is a lie the room should
 * never tell on her behalf, whereas obviously-fake bracketed text is a page that
 * announces its own breakage.
 *
 * Oldest first because a letter is part of a sequence. Reading number five before
 * number three loses the thread, and unlike a song archive there is no reason a
 * year-old letter is less worth reading than this month's. The page regroups them
 * for the shelf; this is the canonical order.
 */
export function loadLetters(): readonly Letter[] {
  const rawEnv = env('US_LETTERS');
  const key = rawEnv ?? '';
  if (lettersCacheKey === key) return lettersCache;

  let source: readonly unknown[] = PLACEHOLDER_LETTERS;
  let label = 'the placeholder manifest';

  if (rawEnv) {
    let decoded: unknown = null;
    try {
      decoded = JSON.parse(Buffer.from(rawEnv, 'base64').toString('utf8'));
    } catch {
      // A mangled paste is the likeliest real failure here and it is otherwise
      // indistinguishable from "not set yet".
      console.error(
        '[us] US_LETTERS is set but is not valid base64-encoded JSON — falling back ' +
          'to the placeholder letters. Nothing she can see is real right now.',
      );
    }
    if (Array.isArray(decoded)) {
      source = decoded;
      label = 'US_LETTERS';
    } else if (decoded !== null) {
      console.error('[us] US_LETTERS decoded but is not an array — falling back to placeholders.');
    }
  }

  const seen = new Set<string>();
  const out: Letter[] = [];
  source.forEach((entry, i) => {
    const letter = parseLetter(entry, `${label}[${i}]`);
    if (!letter) return;
    if (seen.has(letter.id)) {
      /* Fatal for the DUPLICATE, not for the original. Two letters under one id
         share one read receipt and one reply, so the second would silently show
         her answer to the first attached to the wrong letter. */
      console.error(`[us] letters: duplicate id ${letter.id} in ${label} — keeping the first only.`);
      return;
    }
    seen.add(letter.id);
    out.push(letter);
  });

  /* Undated letters (written === '') sort LAST rather than first: '' sorts before
     every real date under a plain string compare, which would put the one letter
     whose date is broken at the head of the sequence she reads. */
  out.sort((a, b) => {
    if (!a.written && !b.written) return 0;
    if (!a.written) return 1;
    if (!b.written) return -1;
    return a.written < b.written ? -1 : a.written > b.written ? 1 : 0;
  });

  if (out.length === 0) {
    console.error(
      '[us] letters: nothing in ' + label + ' survived validation. The room will say ' +
        'it is empty, which is almost certainly not what you meant.',
    );
  }

  lettersCacheKey = key;
  lettersCache = out;
  /* Based on the OUTCOME, not on which source we tried to read.
     `label` is set to 'US_LETTERS' as soon as the variable decodes to an array,
     BEFORE any entry is validated. So a valid-but-entirely-rejected array — a
     schema typo repeated down the file, say — left `label === 'US_LETTERS'`,
     `out` empty, and this flag FALSE: the room said it was showing real letters
     while showing none at all, and the dev banner stayed hidden at exactly the
     moment it was the only thing that would have explained the empty room.
     Requiring out.length means "real" has to be earned by a letter that actually
     survived, and every failure mode falls back to warning. */
  lettersAreFake = !(label === 'US_LETTERS' && out.length > 0);
  return lettersCache;
}

/**
 * True when the letters she can see are the fake committed ones.
 *
 * Calls loadLetters() rather than reading the environment, because "am I showing
 * placeholders" is a question about the OUTCOME of the load and not about whether a
 * variable is set — see lettersAreFake. loadLetters() is cached, so this is free
 * after the first call in a request.
 */
export function usingPlaceholders(): boolean {
  loadLetters();
  return lettersAreFake;
}

/**
 * Is this the id of a letter that actually exists?
 *
 * Checked against the loaded list rather than against LETTER_ID_RE alone, and the
 * distinction is the same one marks.ts's isMarkId() makes: the regex prevents
 * nonsense, but only the manifest check prevents UNBOUNDED KEYS. Without it a
 * caller could POST ten thousand distinct well-formed ids and grow
 * `data/letters.json` until the read hits MAX_DOC_BYTES and her page stops showing
 * read receipts at all. The manifest is however many letters Sam has written, so
 * the store has a ceiling by construction.
 */
export function isLetterId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return loadLetters().some((l) => l.id === value);
}

/** The letter with this id, or null. Selects a record; never builds a key. */
export function findLetter(id: unknown): Letter | null {
  if (typeof id !== 'string') return null;
  return loadLetters().find((l) => l.id === id) ?? null;
}

/**
 * Is this letter still sealed on `today`?
 *
 * String comparison, which is correct and not a shortcut: both sides are ISO
 * `YYYY-MM-DD` in the wing's timezone, and ISO dates sort as text. `openOn` is
 * inclusive — a letter marked `2026-10-03` opens AT the start of the 3rd, because
 * "opens on the third" and "opens on the fourth" are different sentences and only
 * one of them is the one written on the card.
 */
export function isSealed(
  letter: Letter,
  today: string = wingDate(),
  opened: boolean = false,
): boolean {
  // THE DATE GATE FIRST. A letter with both seals is not hers to open until its
  // day has come, so "open when you miss me, but not before October" behaves as
  // written rather than opening the moment she taps it in September.
  if (letter.openOn && letter.openOn > today) return true;

  // Then the one she holds. `opened` defaults to false, so EVERY caller that has
  // not been taught about this seal keeps an open-when letter sealed — the
  // failure direction is a letter she has to tap twice, not a letter that opened
  // itself. See the comment on Letter.openWhen.
  if (letter.openWhen) return !opened;

  return false;
}

/**
 * The letter as it is allowed to reach the browser.
 *
 * THIS FUNCTION IS THE SEAL. A sealed letter comes back with its body, signoff and
 * title REMOVED — not blanked at render time, not hidden by CSS, absent from the
 * object the page is holding. The page cannot leak what it was never given, which
 * is the only version of this that survives somebody opening View Source, and the
 * only version I would be willing to promise her.
 *
 * The title goes too, and that is deliberate rather than thorough: a title is a
 * summary, and "the one about your dad" on a card dated three months out is the
 * spoiler the seal existed to prevent. `teaser` is the one thing that survives,
 * because its entire contract is being safe to read early.
 */
export interface VisibleLetter {
  id: string;
  sealed: boolean;
  written: string;
  /** Present only when open. Sealed letters have no title, on purpose. */
  title: string;
  /** Present only when open. */
  paragraphs: string[];
  /** Present only when open. */
  signoff: string;
  /** Safe while sealed — that is what the field is for. */
  teaser: string;
  /** The day it opens, when it is sealed. '' when it is not. */
  opensOn: string;
  /**
   * The label on an envelope she chooses when to open, WITHOUT the words "open
   * when" — the page supplies those. Present whether sealed or open: after she
   * has opened it, "you couldn't sleep" is part of what the letter is.
   */
  openWhen: string;
}

export function visibleLetter(
  letter: Letter,
  today: string = wingDate(),
  opened: boolean = false,
): VisibleLetter {
  const sealed = isSealed(letter, today, opened);
  if (sealed) {
    return {
      id: letter.id,
      sealed: true,
      written: letter.written,
      title: '',
      paragraphs: [],
      signoff: '',
      teaser: letter.teaser ?? '',
      /* The sentinel from parseLetter() is not shown to her as a date. "Opens
         31 Dec 9999" is a bug report printed on her page; "sealed" with no date
         is the truthful version of the same state. */
      opensOn: letter.openOn === '9999-12-31' ? '' : (letter.openOn ?? ''),
      openWhen: letter.openWhen ?? '',
    };
  }
  return {
    id: letter.id,
    sealed: false,
    written: letter.written,
    title: letter.title,
    paragraphs: paragraphs(letter.body),
    signoff: letter.signoff ?? '',
    teaser: letter.teaser ?? '',
    opensOn: '',
    openWhen: letter.openWhen ?? '',
  };
}

/**
 * A body split into paragraphs on blank lines.
 *
 * Lives here rather than in the page for one reason: it is the only interpreter of
 * the body format, so there is exactly one answer to "what counts as a paragraph"
 * and the page has no text-processing logic in it at all. Single newlines inside a
 * paragraph are folded to spaces — a soft-wrapped paste from Notes is one
 * paragraph, not eleven one-line ones.
 */
export function paragraphs(body: string): string[] {
  return tidyProse(body)
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);
}

/* ============================================================================
   PART TWO — THE STATE

   Written by her, and only by her. See the header: there is no field here for a
   letter body, which is what makes forging one from me impossible rather than
   merely forbidden.
   ========================================================================= */

export interface LetterState {
  id: string;
  /** Epoch millis she FIRST opened it. 0 means never — this is the new/read line. */
  firstReadAt: number;
  /** Epoch millis she last opened it. */
  lastReadAt: number;
  /** How many separate times she has opened it. See READ_DEBOUNCE_MS. */
  reads: number;
  /** Her reply, or ''. Normalised and capped — see REPLY_MAX. */
  reply: string;
  /** Epoch millis the reply was written. 0 when there is none. */
  repliedAt: number;
}

export function emptyState(id: string): LetterState {
  return { id, firstReadAt: 0, lastReadAt: 0, reads: 0, reply: '', repliedAt: 0 };
}

/**
 * How long her reply may be.
 *
 * Twenty times marks.ts's MARK_NOTE_MAX, and the asymmetry is the entire point of
 * this room: a mark is a line under a photo, a reply to a letter is a letter. 4000
 * characters is around 700 words, which is a long answer written properly and not a
 * limit anybody hits by accident.
 *
 * It is also the only unbounded write in this feature, so it is the only thing
 * standing between the store and an arbitrary-size document. The arithmetic that
 * makes MAX_DOC_BYTES safe is stated over there and depends on this number.
 *
 * ENFORCED IN THREE PLACES, ALL OF WHICH IMPORT THIS CONSTANT — normalizeReply()
 * here (the real enforcement), the endpoint's 413 check, and the textarea's
 * `maxlength` on the page. marks.ts documents a fourth place that could NOT import
 * its constant because it was a client island; nothing here is, so there is no
 * restated literal to drift.
 */
export const REPLY_MAX = 4000;

/**
 * Everything normalizeReply does EXCEPT the length cap.
 *
 * Split out because the store and the endpoint are answering different questions,
 * and collapsing them is a bug marks.ts shipped and had to fix: once the normaliser
 * truncates, `normalizeReply(text).length > REPLY_MAX` is permanently false, the
 * 413 becomes unreachable, and a 5000-character reply is silently cut to 4000. She
 * sends five thousand characters, sees four thousand, and has no way to know which
 * end went missing. So: tidyReply answers "how long is what she actually meant",
 * normalizeReply answers "what will be stored".
 *
 * Deliberately NOT sanitised for HTML. Nothing in this repo ever interpolates a
 * reply into markup — Astro escapes every `{expression}` by default — so escaping
 * here would mean storing `&amp;` and rendering `&amp;` forever, which is the
 * classic double-escape bug. The right place to escape is the moment of rendering,
 * and that place already does it.
 */
export function tidyReply(raw: unknown): string {
  return tidyProse(raw);
}

/** tidyReply, then capped. What actually gets stored. */
export function normalizeReply(raw: unknown): string {
  const cleaned = tidyReply(raw);
  if (cleaned.length <= REPLY_MAX) return cleaned;
  return cutWithoutSplittingAnEmoji(cleaned, REPLY_MAX);
}

/**
 * A non-negative integer, or 0. Rejects Infinity and NaN.
 *
 * Copied from marks.ts, including the reason it is not
 * `Math.max(0, Math.floor(Number(v)) || 0)`: that passes INFINITY straight through
 * (`JSON.parse('{"reads":1e999}')` yields Infinity, `Infinity || 0` is Infinity),
 * it survives `reads += 1`, and JSON.stringify writes it as `null` — which reads
 * back as 0. A hand-edited value would silently reset the counter on the next
 * write, in exactly the hand-edit-at-1am scenario the parser exists to harden
 * against.
 */
function count(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Coerce anything read back out of a store into a valid LetterState. Never throws. */
function parseState(id: string, raw: unknown): LetterState {
  const base = emptyState(id);
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // A hand-edit in the Upstash console must degrade to "she has not read it",
      // not throw inside a page render. Same reasoning as kv.ts's parseTrack.
      console.error(`[us] a stored letter state for ${id} is not JSON — ignoring it.`);
      return base;
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return base;

  return {
    id,
    firstReadAt: count(obj.firstReadAt),
    lastReadAt: count(obj.lastReadAt),
    reads: count(obj.reads),
    reply: normalizeReply(obj.reply),
    repliedAt: count(obj.repliedAt),
  };
}

/**
 * A refresh is not a second reading.
 *
 * Twenty minutes, matching marks.ts's VISIT_DEBOUNCE_MS and for the same reason:
 * without it, "you have read this four times" really means "this page rendered four
 * times", which is a different and much less interesting sentence. Long enough that
 * scrolling back up and reloading is one reading, short enough that opening it
 * again after dinner is a second one.
 *
 * It buys a second thing that matters more operationally: inside the window
 * markRead() performs NO WRITE AT ALL. This runs on every render of every letter,
 * so on the R2 tier the difference is one GET versus a GET plus a whole-document
 * PUT on every single page view.
 */
export const READ_DEBOUNCE_MS = 20 * 60 * 1000;

/* ============================================================================
   THE INTERFACE

   Three operations, each implemented three times, so a fourth has to justify
   itself three times over — the bar kv.ts set and marks.ts kept.

   Both mutators return the RESULTING state rather than void, so the caller can
   render real stored state instead of trusting an optimistic guess. Be precise
   about what "real" means per tier, because marks.ts's comment had to be corrected
   for over-claiming here:

     upstash  a genuine re-read (HGETALL) after the write, because HSET and HINCRBY
              return nothing useful.
     r2       the value from the document whose CONDITIONAL PUT succeeded. Not a
              re-read, and stronger than one: a re-read could observe a later write
              by somebody else and report a value that was never ours, whereas an
              If-Match PUT that returned 200 proves these exact bytes are stored.
     memory   the object itself. There is nothing between it and the caller.
   ========================================================================= */

export interface Store {
  readonly tier: Tier;
  getStates(): Promise<Record<string, LetterState>>;
  /** Count a reading if the debounce allows it. Returns the state either way. */
  markRead(id: string, nowMs: number): Promise<LetterState>;
  setReply(id: string, reply: string): Promise<LetterState>;
}

/** Every loaded letter id present, so a caller never checks for undefined. */
function fullMap(partial: Record<string, LetterState>): Record<string, LetterState> {
  const out: Record<string, LetterState> = {};
  for (const l of loadLetters()) out[l.id] = partial[l.id] ?? emptyState(l.id);
  return out;
}

/* ============================================================================
   TIER 1 — UPSTASH REDIS over REST

   One hash PER LETTER rather than one hash for all of them. It looks like the
   wasteful choice and is not: with a field-per-letter hash, recording a reading
   would mean reading that letter's JSON, editing it and writing it back — a
   read-modify-write, in the one tier that does not need one. A hash per letter
   makes every mutation a single atomic command, so counting a reading cannot
   clobber a reply she is in the middle of sending. Reading them all is N HGETALLs
   in ONE pipelined round trip, which costs about what one HGETALL costs.
   ========================================================================= */

/** `us:` prefix matches ratelimit.ts's `us:rl:`, kv.ts's `us:song:`, marks.ts's `us:mark:`. */
const STATE_KEY = (id: string) => `us:letter:${id}`;

type Command = (string | number)[];

/** One HTTP round trip for N commands. Verbatim shape from kv.ts and marks.ts. */
async function redis(url: string, token: string, cmds: Command[]): Promise<unknown[]> {
  if (cmds.length === 0) return [];

  const t = timer();
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map((c) => c.map(String))),
      // See TIMEOUT_MS: a signal, not a cleared controller, so the deadline
      // survives into the body read.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // An abort is indistinguishable from a network failure to every caller.
    throw new LetterError('upstash unreachable', { cause: err });
  }

  /* THE COMMAND COUNT. getStates() is one HGETALL per letter, so this grows with the
     manifest exactly as marks.ts does. See countCommands in trace.ts. */
  countCommands('letters', cmds.length, res.status, t.total());

  if (!res.ok) throw new LetterError(`upstash HTTP ${res.status}`);

  let parsed: Array<{ result?: unknown; error?: string }>;
  try {
    parsed = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  } catch (err) {
    throw new LetterError('upstash response body did not arrive or was not JSON', { cause: err });
  }
  if (!Array.isArray(parsed) || parsed.length !== cmds.length) {
    throw new LetterError('upstash returned a malformed pipeline response');
  }

  return parsed.map((entry, i) => {
    // A per-command error is a bug in this file, not a runtime condition, so it is
    // fatal. Only the command NAME is logged — the arguments are her words.
    if (entry?.error) throw new LetterError(`upstash ${String(cmds[i][0])} failed: ${entry.error}`);
    return entry?.result ?? null;
  });
}

/**
 * Upstash returns a hash as a FLAT array `[field, value, field, value]`, not as an
 * object. Folding it here rather than at each call site is what stops one getter
 * quietly reading `raw.reply` off an array and always seeing undefined.
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

  async function readOne(id: string): Promise<LetterState> {
    const [raw] = await run([['HGETALL', STATE_KEY(id)]]);
    return parseState(id, foldHash(raw));
  }

  return {
    tier: 'upstash',

    async getStates() {
      const ids = loadLetters().map((l) => l.id);
      const results = await run(ids.map((id) => ['HGETALL', STATE_KEY(id)]));
      const out: Record<string, LetterState> = {};
      ids.forEach((id, i) => {
        out[id] = parseState(id, foldHash(results[i]));
      });
      return fullMap(out);
    },

    async markRead(id, nowMs) {
      const before = await readOne(id);
      // Inside the debounce: no write at all. See READ_DEBOUNCE_MS.
      if (before.reads > 0 && nowMs - before.lastReadAt < READ_DEBOUNCE_MS) return before;

      const first = before.firstReadAt > 0 ? before.firstReadAt : nowMs;
      /* HINCRBY so two tabs cannot land on the same NUMBER. Be honest about what
         that does and does not buy — marks.ts had to correct exactly this claim:
         the DEBOUNCE above is a read-then-decide and is not a lock, so two tabs
         opened in the same instant both pass the window test and both increment.
         The consequence is that the shelf says "read 3 times" when it was twice,
         which is a cosmetic error in a decorative number and nowhere near worth a
         lock on the path that renders her letter. */
      const [counted] = await run([
        ['HINCRBY', STATE_KEY(id), 'reads', 1],
        ['HSET', STATE_KEY(id), 'lastReadAt', String(nowMs), 'firstReadAt', String(first)],
      ]);
      return {
        ...before,
        reads: Math.max(1, Number(counted) || before.reads + 1),
        firstReadAt: first,
        lastReadAt: nowMs,
      };
    },

    async setReply(id, reply) {
      // Two fields, one command, no read-modify-write. This is the atomicity a
      // hash-per-letter buys: recording a reading cannot clobber this.
      await run([['HSET', STATE_KEY(id), 'reply', reply, 'repliedAt', String(Date.now())]]);
      return readOne(id);
    },
  };
}

/* ============================================================================
   TIER 2 — CLOUDFLARE R2, one JSON object

   Read the whole document, change one field, write the whole document back.
   Everything about this tier follows from that sentence.

   It is NOT a transaction and must never be described as one. It is also not the
   silent-loss race kv.ts documents for its songs document, and the difference is
   one header: every PUT carries `If-Match: <etag>` from the GET it was built on, so
   a write that lost a race comes back 412 instead of quietly clobbering. mutateDoc
   re-reads and retries once; a second conflict throws and the endpoint answers 502.

   WORTH BUILDING HERE for the same reason marks.ts built it: two writers of this
   document overlap in ordinary use, not in an unlucky one. She opens a letter (a
   read receipt write) and sends a reply from the same page minutes later; she has
   the shelf open on a laptop and the letter open on a phone. The thing that would
   be lost is her reply, which is the one thing in this feature that must never
   silently vanish under a page that said "sent".
   ========================================================================= */

/** Must not be `data/songs.json` or `data/marks.json`. See the header. */
const R2_DOC_KEY = 'data/letters.json';

interface LettersDoc {
  /** Schema version. Present from day one so a future migration has a hinge. */
  v: 1;
  /** letter id -> state, for ids that are in the CURRENTLY LOADED list. */
  states: Record<string, LetterState>;
  /**
   * States whose id is NOT in the loaded list, carried through byte-for-byte.
   *
   * marks.ts learned this the expensive way and the bug was the worst kind:
   * silent, permanent, and triggered by a page view rather than by a write. Its
   * first version pruned unknown ids on READ and returned the pruned document as
   * valid, after which every writer persisted the pruned version.
   *
   * IT IS EVEN MORE NECESSARY HERE, because this list is not a committed constant.
   * It comes from an environment variable, so "an id is temporarily missing from
   * the manifest" is not a rename-and-deploy event — it is what happens for the
   * seconds between a bad US_LETTERS paste and the fix, or on any instance still
   * holding the old value. Pruning would mean a typo in an env var permanently
   * deletes her replies.
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

const EMPTY_DOC: LettersDoc = { v: 1, states: {}, orphans: {}, extra: {} };

/**
 * Refuse to read a document larger than this.
 *
 * The ceiling is arithmetic, not a guess: one state is her reply (REPLY_MAX = 4000
 * characters) plus about 200 bytes of bookkeeping, so sixty letters she has all
 * answered at full length is roughly 250KB. 512KB is comfortably past that, and
 * anything bigger is not a big document — it is the wrong object, and reading it
 * would spend the whole invocation on bytes we would throw away. Checked against
 * Content-Length BEFORE the body is read, because the point is to not download it.
 *
 * IF THE MANIFEST EVER PASSES ~100 LETTERS, raise this and recompute the sentence
 * above rather than discovering it as "her read receipts stopped working".
 *
 * Note what the EXPECTED size is: a handful of letters and a few replies is single-
 * digit kilobytes. This is a wrong-object guard, not a target.
 */
const MAX_DOC_BYTES = 512 * 1024;

/**
 * A client per process, not per call.
 *
 * `retries: 1` is a deliberate override of aws4fetch's default of 10. Those retries
 * use exponential backoff from 50ms — 50+100+200+...+25600, about 51 seconds — and
 * would happily spend this whole serverless invocation on a bucket that is down.
 * One retry absorbs a blip; ten absorb an outage by hanging.
 *
 * `region: 'auto'` because R2 has no regions but SigV4 requires one in the
 * credential scope, and 'auto' is the value Cloudflare documents for its S3 API.
 * Passed explicitly rather than left to aws4fetch's hostname sniff: relying on a
 * heuristic for the two values that go into the credential scope is a silent 403
 * waiting for the day the heuristic changes.
 */
let r2Client: AwsClient | null = null;
/**
 * Fingerprint of the credential the cached client was built with.
 *
 * BOTH halves, not just the key id. A secret-only rotation — same R2_ACCESS_KEY_ID,
 * new R2_SECRET_ACCESS_KEY — is an ordinary thing to do, and keying only on the id
 * would leave a warm instance signing every request with the dead secret. The
 * symptom is a 403 surfaced as `502 store` on one instance and nowhere else, which
 * is close to undiagnosable.
 */
let r2ClientFingerprint: string | null = null;

function r2(): { client: AwsClient; base: string } {
  const { accessKeyId, secretAccessKey, bucket } = r2Config();
  const endpoint = r2Endpoint();
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) {
    throw new LetterError('r2 selected but not fully configured');
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
 * `data/letters.json` contains nothing that needs escaping today, so this looks
 * like ceremony. It is not: photos.ts documents a whole class of
 * SignatureDoesNotMatch that comes from aws4fetch canonicalising with
 * encodeURIComponent while sending the raw character, and the day somebody renames
 * this key to something with an `@` or a space in it the failure is a 403 that
 * looks exactly like a credentials problem. Encoding up front means that day never
 * comes.
 */
function encodeKeyForUrl(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * Shape-check a document read from the bucket. Returns null when unusable.
 *
 * NOTHING IS DISCARDED. Fields this deploy understands are normalised; unknown
 * letter ids and unknown top-level keys are carried into `orphans` and `extra` and
 * written back verbatim. See the comments on those two fields.
 */
function parseDoc(text: string): LettersDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const states =
    obj.states && typeof obj.states === 'object' && !Array.isArray(obj.states)
      ? (obj.states as Record<string, unknown>)
      : null;
  if (!states) return null;

  const out: LettersDoc = { v: 1, states: {}, orphans: {}, extra: {} };
  for (const [id, value] of Object.entries(states)) {
    if (isLetterId(id)) out.states[id] = parseState(id, value);
    else out.orphans[id] = value;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key !== 'v' && key !== 'states') out.extra[key] = value;
  }
  if (Object.keys(out.orphans).length > 0) {
    // Loud, once per read, because the only way an orphan exists is that an id left
    // the manifest — so this is telling Sam that her reply to a letter he renamed
    // (or that vanished with a bad US_LETTERS paste) is sitting under its old name,
    // preserved, waiting to be re-pointed.
    console.warn(
      `[us] ${R2_DOC_KEY} holds state for ${Object.keys(out.orphans).length} letter id(s) ` +
        `that are not in the current list: ${Object.keys(out.orphans).join(', ')}. They are ` +
        'being PRESERVED, not deleted. Re-point the id in US_LETTERS or move them by hand.',
    );
  }
  return out;
}

/** The document as it goes back on the wire. Orphans and extras restored. */
function serialiseDoc(doc: LettersDoc): string {
  return JSON.stringify({
    ...doc.extra,
    v: 1,
    states: { ...doc.orphans, ...doc.states },
  });
}

/** Read the document, plus the ETag needed to write it back conditionally. */
async function readDoc(): Promise<{ doc: LettersDoc; corrupt: boolean; etag: string | null }> {
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
    throw new LetterError('r2 unreachable', { cause: err });
  }

  // 404 is the normal first-run state, not an error: she has not opened anything.
  // A null etag then means "there must be no object", which writeDoc turns into
  // If-None-Match: * so two cold instances cannot both create it.
  if (res.status === 404) return { doc: structuredClone(EMPTY_DOC), corrupt: false, etag: null };
  if (!res.ok) throw new LetterError(`r2 GET HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOC_BYTES) {
    // Not read, not parsed, and deliberately NOT treated as corrupt-and-empty: that
    // path degrades a READ to empty, and degrading to empty for an object we never
    // looked at would let a subsequent write replace it with a small one.
    throw new LetterError(
      `r2 GET returned ${declared} bytes for ${R2_DOC_KEY}; refusing to read it`,
    );
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // Reached when the timeout signal fires mid-body, which is the whole point of a
    // signal that outlives the header exchange.
    throw new LetterError('r2 response body did not arrive', { cause: err });
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
     strong — so a hand probe of If-Match also succeeds. Only a document at this
     size is weak, so nothing short of writing to the live bucket shows it.

     Stripping `W/` is safe HERE SPECIFICALLY because R2's validator is derived from
     the object's content, so the remaining opaque value still changes whenever the
     bytes change — which is the only property optimistic concurrency needs. It is
     not a general-purpose weak-to-strong promotion and must not be copied as one. */
  const rawEtag = res.headers.get('etag');
  const etag = rawEtag ? rawEtag.replace(/^W\//, '') : null;

  const parsed = parseDoc(text);
  if (!parsed) {
    // Reads degrade to empty so her letters still render. Writes do NOT (below):
    // overwriting an object we could not understand is how a bad deploy turns into
    // a deleted year of her replies.
    console.error(`[us] ${R2_DOC_KEY} exists but is not a letters document — reading as empty.`);
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
  doc: LettersDoc,
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
    throw new LetterError('r2 unreachable', { cause: err });
  }
  // 412 (If-Match lost) and 409 (how some S3 implementations answer a failed
  // If-None-Match) are both "somebody else got there first".
  if (res.status === 412 || res.status === 409) return { conflict: true };
  if (!res.ok) throw new LetterError(`r2 PUT HTTP ${res.status}`);
  return { ok: true };
}

/**
 * Read, apply, write conditionally, retry ONCE on a conflict.
 *
 * One retry, not a loop: with two humans a conflict is already surprising, and an
 * unbounded retry against a document somebody is writing in a tight loop is how a
 * serverless function times out instead of failing. A second conflict throws, the
 * endpoint answers 502, and she sends again — safe, because every operation here is
 * idempotent by construction.
 */
async function mutateDoc<T>(apply: (doc: LettersDoc) => T): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential by nature: attempt 2
    // must read whatever attempt 1 lost to.
    const { doc, corrupt, etag } = await readDoc();
    if (corrupt) {
      throw new LetterError(
        `refusing to overwrite ${R2_DOC_KEY}: it exists but is not a valid letters document`,
      );
    }
    const result = apply(doc);
    // eslint-disable-next-line no-await-in-loop -- same
    const wrote = await writeDoc(doc, etag);
    if ('ok' in wrote) return result;
    console.warn(`[us] ${R2_DOC_KEY} changed under a write; re-reading and trying once more.`);
  }
  throw new LetterError(
    `${R2_DOC_KEY} is being written concurrently; gave up after two attempts rather than ` +
      "overwriting somebody else's change",
  );
}

function r2Store(): Store {
  /** The entry to mutate, created on demand. */
  const entry = (doc: LettersDoc, id: string): LetterState => (doc.states[id] ??= emptyState(id));

  return {
    tier: 'r2',

    async getStates() {
      const { doc } = await readDoc();
      return fullMap(doc.states);
    },

    async markRead(id, nowMs) {
      /* Read WITHOUT a write first, so the common case — a refresh inside the
         debounce — costs one GET and no PUT. Going through mutateDoc would PUT the
         whole document back on every render of every letter, and this runs on every
         render of every letter.

         The debounce is BEST-EFFORT and is not a lock: two tabs opened in the same
         instant both read the old `lastReadAt`, both pass the window test, and both
         count. The cost is that the shelf occasionally says "read 3 times" when it
         was twice. Serialising this properly would mean a lock on the path that
         renders her letter, which is a much worse trade. */
      const { doc, corrupt, etag } = await readDoc();
      if (corrupt) return emptyState(id);
      const before = doc.states[id] ?? emptyState(id);
      if (before.reads > 0 && nowMs - before.lastReadAt < READ_DEBOUNCE_MS) return { ...before };

      /* Snapshotted BEFORE the mutation. marks.ts's countVisit had to fix exactly
         this: returning the mutated object on the conflict path reports the very
         value whose write just failed. */
      const unchanged = { ...before };
      const next: LetterState = {
        ...unchanged,
        reads: unchanged.reads + 1,
        firstReadAt: unchanged.firstReadAt > 0 ? unchanged.firstReadAt : nowMs,
        lastReadAt: nowMs,
      };

      /* ONE read, and the PUT carries THAT read's etag. An earlier version of this
         function read twice — once to test the debounce, once to get a "fresh" etag
         — and that was not a wasted round trip, it was a data-loss bug: `next` is
         built from the FIRST snapshot, so if her reply landed between the two reads,
         writing `next` into the second document would have restored the older reply
         over the newer one while If-Match happily succeeded. Optimistic concurrency
         only works when the value you write and the etag you write it against come
         from the same read.

         A conflict here is IGNORED rather than retried or thrown, which is a
         deliberate asymmetry with setReply below. The other writer was either
         another tab counting the same reading — in which case the count is already
         right and ours would double it — or her REPLY, whose data matters
         infinitely more than this counter. Losing a read tick is the cheapest
         outcome available and it must never be able to fail a page render.

         mutateDoc is not used for the same reason: its retry would re-read the
         document her reply just wrote and count the reading on top of it, turning a
         harmless dropped tick into a second whole-document write racing her words. */
      doc.states[id] = next;
      const wrote = await writeDoc(doc, etag);
      return 'ok' in wrote ? next : unchanged;
    },

    async setReply(id, reply) {
      // mutateDoc, with its If-Match and its one retry, because THIS is the write
      // that must not be silently lost. See the tier header.
      return mutateDoc((doc) => {
        const s = entry(doc, id);
        s.reply = reply;
        s.repliedAt = Date.now();
        return { ...s };
      });
    },
  };
}

/* ============================================================================
   TIER 3 — IN-PROCESS MAP

   Non-durable, per instance. Implemented directly against a Map rather than by
   emulating Redis, because a fake Redis is a second thing that can be subtly wrong
   and this tier's only job is to be obviously correct for one developer on one
   laptop.
   ========================================================================= */

const memory = new Map<string, LetterState>();

function memoryStore(): Store {
  const entry = (id: string): LetterState => {
    const existing = memory.get(id);
    if (existing) return existing;
    const fresh = emptyState(id);
    memory.set(id, fresh);
    return fresh;
  };

  return {
    tier: 'memory',

    async getStates() {
      const out: Record<string, LetterState> = {};
      for (const [id, s] of memory) out[id] = { ...s };
      return fullMap(out);
    },

    async markRead(id, nowMs) {
      const s = entry(id);
      if (s.reads > 0 && nowMs - s.lastReadAt < READ_DEBOUNCE_MS) return { ...s };
      s.reads += 1;
      if (s.firstReadAt === 0) s.firstReadAt = nowMs;
      s.lastReadAt = nowMs;
      return { ...s };
    },

    async setReply(id, reply) {
      const s = entry(id);
      s.reply = reply;
      s.repliedAt = Date.now();
      return { ...s };
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
export function lettersTier(): Tier {
  if (hasKV()) return 'upstash';
  if (hasR2()) return 'r2';
  return 'memory';
}

/**
 * Announced ONCE per process, the first time the store is touched.
 *
 * Not decoration. The failure it prevents is the quiet one: a production deploy
 * that silently landed on the memory tier because an environment variable was
 * renamed, where every symptom is "her replies to my letters sometimes vanish" and
 * no log line ever says why.
 */
let announced = false;
function announce(tier: Tier): void {
  if (announced) return;
  announced = true;
  if (tier === 'memory') {
    console.warn(
      '[us] letters store: IN-PROCESS MEMORY. Non-durable and per-instance — every ' +
        'read receipt and every reply she writes is lost on the next restart. Set ' +
        'UPSTASH_REDIS_REST_URL/_TOKEN or the R2_* variables before this is real.',
    );
  } else {
    console.log(`[us] letters store: ${tier}`);
  }
}

function store(): Store {
  const tier = lettersTier();
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

   Free functions rather than "get the store, then call it", so no caller ever
   holds a backend-specific object and none of them can grow a branch on which tier
   is live.

   Two flavours, and choosing between them is the caller's one real decision:

     THROWING  (setReply)      — for the endpoint. A reply that failed has to be a
                                 502 she can retry with her text still on screen.
     SAFE      (*Safe)         — for a page render. New-versus-read is decoration on
                                 a page that must show her the letter regardless.
   ========================================================================= */

export function getStates(): Promise<Record<string, LetterState>> {
  return store().getStates();
}

export function markRead(id: string, nowMs: number = Date.now()): Promise<LetterState> {
  // Thrown rather than no-opped: the caller is expected to have validated, so
  // reaching here with an unknown id is a bug worth surfacing, not a silent write
  // to a key nothing will ever read.
  if (!isLetterId(id)) throw new LetterError(`markRead: ${JSON.stringify(id)} is not a letter id`);
  return store().markRead(id, nowMs);
}

export function setReply(id: string, reply: string): Promise<LetterState> {
  if (!isLetterId(id)) throw new LetterError(`setReply: ${JSON.stringify(id)} is not a letter id`);
  // Normalised HERE as well as at the endpoint, so the cap is a property of the
  // store and not of one caller's diligence.
  return store().setReply(id, normalizeReply(reply));
}

/* ---- the soft-failing wrappers, for page renders --------------------------- */

/** State for every letter, or all-empty when the store is unreachable. */
export async function getStatesSafe(): Promise<Record<string, LetterState>> {
  try {
    return await getStates();
  } catch (err) {
    console.error('[us] could not read letter states; rendering without new/read.', err);
    return fullMap({});
  }
}

/**
 * Count this reading, or shrug.
 *
 * A read receipt is the least important thing on the page and it sits on the
 * critical path of rendering the most important thing on it, so it must never be
 * able to 500 her letter. Returns an empty state on failure, which reads as "not
 * read yet" — the honest answer, since we genuinely do not know.
 */
export async function markReadSafe(
  id: string,
  nowMs: number = Date.now(),
): Promise<LetterState> {
  try {
    return await markRead(id, nowMs);
  } catch (err) {
    console.error('[us] could not record that she opened a letter; the letter matters more.', err);
    return emptyState(id);
  }
}

/* ============================================================================
   THE SHELF, AND A SUMMARY FOR ANYBODY ELSE

   Derived here rather than in the page for the reason kv.ts gives about its
   streak: the hub will eventually want to say "one waiting", and two
   implementations of "how many are unread" would disagree by one with no way to
   tell which page was lying.
   ========================================================================= */

export interface Shelf {
  /** Open, unread, OLDEST FIRST — the order they were written, which is the order to read them. */
  waiting: VisibleLetter[];
  /** Open and already read, NEWEST FIRST — this is an archive, not a sequence. */
  again: VisibleLetter[];
  /** Still sealed, SOONEST OPENING FIRST. Bodies and titles absent by construction. */
  sealed: VisibleLetter[];
  /**
   * Hers to open whenever she decides the label fits, AUTHORED ORDER.
   *
   * A fourth bucket rather than a flag on `sealed`, because the two are opposite
   * instructions. A sealed letter says WAIT and there is nothing to do about it.
   * These say CHOOSE, and putting them in the same list as the calendar-sealed
   * ones would bury the only letters on the page she can act on among the only
   * ones she cannot.
   *
   * Not sorted by anything meaningful on purpose: they are a set of options, not a
   * sequence, and ordering a set by date implies a reading order that does not
   * exist. Authored order is his order, which is the only intentional one there is.
   */
  whenever: VisibleLetter[];
}

/**
 * Group the letters the way the shelf shows them.
 *
 * The two orderings disagree on purpose, and it is the one layout decision in this
 * feature worth arguing for. Unread letters are a SEQUENCE — she should meet them
 * in the order they were written, or letter five arrives before the thing letter
 * three explains. Read letters are an ARCHIVE — the one she is most likely to want
 * again is the one she just finished, so newest first. Picking one order for both
 * would make one of the two groups behave wrongly, and there is no reason to.
 */
export function shelf(
  states: Record<string, LetterState>,
  today: string = wingDate(),
): Shelf {
  const waiting: VisibleLetter[] = [];
  const again: VisibleLetter[] = [];
  const sealed: VisibleLetter[] = [];
  const whenever: VisibleLetter[] = [];

  // loadLetters() is already oldest-first, so `waiting` needs no sort at all.
  for (const letter of loadLetters()) {
    /* THE READ RECEIPT IS ALSO THE OPENED RECEIPT. An open-when letter she has
       read once is open forever, and `firstReadAt` already records exactly that,
       which is why this seal needed no new storage. Computed BEFORE
       visibleLetter() so the seal is evaluated with the fact, not after it. */
    const opened = (states[letter.id]?.firstReadAt ?? 0) > 0;
    const view = visibleLetter(letter, today, opened);

    if (view.sealed) {
      /* Sealed AND labelled AND past any date gate means the seal is hers to
         break — that is the `whenever` shelf. Sealed and labelled but NOT past
         its date is still just sealed, because there is nothing she can do about
         it yet; isSealed() checks the date first for this reason. */
      const dateStillHolding = Boolean(letter.openOn && letter.openOn > today);
      if (letter.openWhen && !dateStillHolding) whenever.push(view);
      else sealed.push(view);
    } else if (opened) {
      again.push(view);
    } else {
      waiting.push(view);
    }
  }

  again.reverse();
  /* Soonest first. The sentinel from a broken openOn ('9999-12-31') therefore sorts
     to the end, which is exactly where a letter nobody can date belongs. */
  sealed.sort((a, b) => (a.opensOn || '9999-12-31').localeCompare(b.opensOn || '9999-12-31'));

  return { waiting, again, sealed, whenever };
}

export interface LettersSummary {
  /** Letters she can read at all — open ones only. Sealed ones are not hers yet. */
  open: number;
  /** Open and never opened. The number the hub would badge. */
  unread: number;
  /** How many are still sealed by a DATE — nothing she can do about these. */
  sealed: number;
  /**
   * How many are hers to open whenever she likes.
   *
   * Counted apart from `sealed` because the hub's badge is a call to action and
   * these are the only sealed-looking letters that answer to one. Folding them in
   * would make the hub say "three sealed" about a shelf where one of them is
   * waiting for her to simply decide.
   */
  whenever: number;
  /** `YYYY-MM-DD` of the next seal to open, or '' when there is none. */
  nextOpens: string;
  /** How many she has answered. */
  replied: number;
}

/**
 * One object with every number the room or the hub might want to say.
 *
 * Exported so a hub card can badge "one waiting" without reimplementing the seal
 * rule. Takes the states it needs rather than reading the store, so a caller that
 * already has them pays for one read and not two.
 */
export function summarize(
  states: Record<string, LetterState>,
  today: string = wingDate(),
): LettersSummary {
  const { waiting, again, sealed, whenever } = shelf(states, today);
  const replied = Object.values(states).filter((s) => s.reply.length > 0).length;
  return {
    open: waiting.length + again.length,
    unread: waiting.length,
    sealed: sealed.length,
    whenever: whenever.length,
    nextOpens: sealed.find((s) => s.opensOn)?.opensOn ?? '',
    replied,
  };
}

/**
 * Test seam. Not called in production; exported so a suite can start from empty.
 *
 * BE HONEST ABOUT WHAT USES IT: this repo has no committed test runner and no
 * `*.test.ts` anywhere, so treat this as decoration unless one arrives. Everything
 * claimed in this file about the Upstash and R2 tiers is claimed on the strength of
 * being copied line-for-line from marks.ts, which was itself verified against a
 * stubbed S3 and the live bucket — not on the strength of a test of this file.
 */
export function __resetMemoryTier(): void {
  memory.clear();
  lettersCacheKey = null;
  lettersCache = [];
}
