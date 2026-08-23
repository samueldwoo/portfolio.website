/**
 * status.ts — the two things the hub says out loud before she picks a room.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN HERE
 *
 *   1. NEXT_TIME  — the one config value Sam edits: the date they are next in the
 *      same place. Read the block; it is the whole feature.
 *   2. countdown() — that date turned into "17 days" / "tomorrow" / "today".
 *   3. newSince()  — what has changed since her PREVIOUS visit, as counts plus the
 *      copy that describes them.
 *
 * They share a file because they share a job: both exist so that landing on
 * /samdrea/vault tells her something she did not already know. Nothing else in
 * the wing does that — every other page waits to be opened before it says
 * anything, which meant the only way to find out I had posted was to go and look.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING HERE IS A PURE FUNCTION, AND NEITHER OF THEM READS THE CLOCK
 *
 * Same discipline as kv.ts's derivations, for the same reason. `today` is an
 * argument, records are arguments, and the only thing these functions do is
 * arithmetic and string assembly. That is what makes it possible to reason about
 * "what does she see at 11:58pm" without standing up a store, and it is what stops
 * two pages from disagreeing about how many days are left.
 *
 * There is one deliberate exception: NEXT_TIME is module state, because it is
 * SOURCE. Sam edits a line and deploys; it is not data and it is not input.
 *
 * ---------------------------------------------------------------------------
 * THE CALENDAR IS kv.ts'S, NOT A SECOND ONE
 *
 * wingDate / wingDateLabel / isWingDate are imported, never re-derived. kv.ts's
 * header explains what re-deriving them costs: the day-string IS the primary key
 * for a song, so a second implementation of "what day is it" eventually disagrees
 * by an hour and the page silently reads a key nobody wrote. The countdown does not
 * write keys, but it sits on the same page as "today's song", and a page where the
 * countdown has already rolled over to tomorrow while the song has not is the same
 * class of bug wearing a nicer hat.
 * ---------------------------------------------------------------------------
 */

import { isWingDate, wingDate, wingDateLabel, type SongRecord } from './kv';
import type { Mark, Visits } from './marks';

/* ============================================================================
   ===  THE ONE THING SAM EDITS  ==============================================

   Set `date` to the day they are next in the same place. That is it. Everything
   below reads from here and nothing else needs touching.

     date   `YYYY-MM-DD`. In the WING'S timezone (America/New_York — see kv.ts's
            WING_TZ), NOT in whichever timezone you happen to be standing in when
            you type it. In practice: the calendar day printed on the ticket.

            EMPTY STRING SWITCHES THE WHOLE THING OFF and the hub renders nothing
            at all — no placeholder, no "TBD", no empty box. An unset countdown is
            invisible, because a countdown to nothing is worse than silence.

            A TYPO IS NOT SILENT. `2026-13-01` or `next tuesday` is rejected and
            logged once per process, because a mistyped date and an unset one would
            otherwise look identical from the outside — she would see nothing, Sam
            would think he had set it, and there would be no way to tell.

     label  What actually happens that day, in his voice, lower case, no full stop:
            'you land in SFO', 'I land in Paris', 'we are in the same room'.
            Optional — leave it '' and the date carries the line on its own.

     graceDays
            How long the line keeps saying "you're here" after the date passes,
            before it disappears. See countdown() for why this exists at all; the
            short version is that the wing's midnight is in New York and hers is
            not, so a hard cutoff at day 0 can hide the line hours before she has
            even landed.

   ========================================================================= */

interface NextTime {
  date: string;
  label: string;
  graceDays: number;
}

/**
 * Typed through `NextTime` rather than left to `as const` on purpose: a literal
 * type of `''` would make every comparison against `date` look statically decided
 * to TypeScript, and the invalid-date warning below would be flagged as dead code
 * the moment somebody trusted the inference.
 */
export const NEXT_TIME: NextTime = {
  date: '2026-10-16',
  label: 'I see you',
  graceDays: 2,
};

/* ============================================================================
   THE COUNTDOWN
   ========================================================================= */

export interface Countdown {
  /**
   * Whole calendar days from today to the date, in the wing's timezone.
   *
   * Positive before, 0 on the day, negative after — and the ONLY negative values
   * that ever reach a caller are inside the grace window, because countdown()
   * returns null past it. A caller therefore never has to defend against printing
   * "-4 days"; that state does not exist as a Countdown.
   */
  days: number;
  /** The loud part. `17 days` | `tomorrow` | `today` | `you're here`. */
  count: string;
  /** Sits between the count and the date. `until` | `since` | ''. */
  connector: string;
  /** `YYYY-MM-DD`, for `<time datetime>`. Always a valid wing date. */
  iso: string;
  /** The date for humans, e.g. `Sun 14 Sep`. */
  when: string;
  /**
   * NEXT_TIME.label, or '' — including when Sam DID set one but it no longer reads
   * true. 'you land in SFO' is a forecast; once she has landed it is a tense error,
   * so the grace-window state drops it and lets the date speak.
   */
  label: string;
}

/** Warn about a malformed NEXT_TIME.date once per process, not once per render. */
let warnedAboutDate = false;

/**
 * Whole days from one wing date to another. Negative when `to` is in the past.
 *
 * Both ends are anchored at UTC midnight and the difference divided by a flat
 * 86400000, which is exactly how kv.ts does its own date arithmetic and for exactly
 * the reason its shiftDate() gives: a wing date is a LABEL for a calendar day, not
 * an instant, so doing the arithmetic "in the wing's timezone" is what actually
 * breaks. On the two DST boundaries a local day is 23 or 25 hours long, and a
 * countdown that quietly gained or lost a day every spring would be a lie that only
 * shows up once a year.
 */
function daysUntil(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The countdown, or null when there is nothing honest to say.
 *
 * ---------------------------------------------------------------------------
 * WHY `today` IS AN ARGUMENT AND WHY IT MUST BE A WING DATE
 *
 * He is on the US west coast, she is in Europe, and the requirement is that they
 * see the SAME number. `new Date()` differenced against a date cannot do that: for
 * nine hours out of every twenty-four it is a different calendar day in the two
 * places, so a browser-side countdown would show her 16 and him 17 and both would
 * be locally correct. That is worse than a wrong number, because each of them would
 * trust theirs.
 *
 * Two things fix it, and both are needed:
 *
 *   1. THIS RENDERS ON THE SERVER. /samdrea/vault is `prerender = false`, so the
 *      number is computed once per request in one process and no device clock is
 *      consulted. Neither of their laptops can be wrong about it, and neither can
 *      be "off by a timezone" — there is nothing client-side to be off.
 *
 *   2. "TODAY" IS ONE DECLARED ZONE. The server's own clock is UTC, which would
 *      roll the number over at 5pm Pacific — so the server alone is not enough. The
 *      caller passes wingDate(), i.e. today in America/New_York, and the target date
 *      is read as a day in the same calendar. One zone, one answer, for both of them.
 *
 * WHY NEW YORK, given that neither of them lives there: because kv.ts already
 * declared it as the wing's midnight and the song of the day is keyed by it. The
 * countdown and "today's song" appear within a few hundred pixels of each other, so
 * they must agree on when a day ends; two zones on one page means an hours-long
 * window every night where the countdown has ticked and the song has not. The
 * practical effect is fine for both of them anyway — the number changes at 6am for
 * her and 9pm for him, which is to say she wakes up to a new one.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR STATES, AND WHY THERE ARE NOT FIVE
 *
 *   >= 2 days   "17 days · until Sun 14 Sep". Days is the unit for almost the
 *               entire life of the feature.
 *
 *   1 day       "tomorrow". NOT "24 hours", and this is a real decision rather
 *               than laziness: NEXT_TIME.date is a DATE, so the store holds no
 *               arrival time at all. Printing "in 19 hours" would be inventing
 *               precision we do not have and dressing it as a fact — and it would
 *               be wrong by up to a day in either direction. Inside 48 hours the
 *               honest move is to stop counting and start naming the day.
 *
 *   0 days      "today".
 *
 *   past        "you're here", for `graceDays`, then nothing.
 *
 *               The grace window is not sentiment, it is the New York anchor
 *               leaking. Her flight lands in the evening, Pacific; the wing's
 *               midnight is three hours ahead of that, so a hard cutoff at day 0
 *               would blank the line while she is still in the air. And "she is
 *               visiting" is a state that lasts days, during which "you're here" is
 *               simply true, so present tense for a couple of days is more accurate
 *               than a countdown to a date that has passed.
 *
 *               After the grace window it returns null — the same nothing as unset,
 *               which is a state the page already renders correctly. A stale date is
 *               therefore self-clearing: Sam does not have to remember to blank it,
 *               and there is no path on which a negative number can reach the page,
 *               because that number never leaves this function.
 */
export function countdown(today: string): Countdown | null {
  const raw = NEXT_TIME.date.trim();

  // Unset. Silent by design — see the config block.
  if (raw === '') return null;

  if (!isWingDate(raw)) {
    if (!warnedAboutDate) {
      warnedAboutDate = true;
      console.warn(
        `[us] NEXT_TIME.date in src/lib/us/status.ts is ${JSON.stringify(raw)}, which is not a ` +
          'real YYYY-MM-DD calendar day. The countdown is switched off. Fix the date or set it ' +
          "to '' to turn it off on purpose.",
      );
    }
    return null;
  }

  // Defensive: a caller that passed something other than wingDate() would make
  // every branch below meaningless, and rendering nothing beats rendering a number
  // derived from a date nobody validated.
  if (!isWingDate(today)) return null;

  const days = daysUntil(today, raw);
  // Floored at 0 so a hand-edited negative cannot invert the comparison and make
  // the line permanent.
  const grace = Math.max(0, Math.floor(NEXT_TIME.graceDays) || 0);
  if (days < -grace) return null;

  const label = NEXT_TIME.label.trim();
  const when = wingDateLabel(raw);

  if (days >= 2) return { days, count: `${days} days`, connector: 'until', iso: raw, when, label };
  if (days === 1) return { days, count: 'tomorrow', connector: '', iso: raw, when, label };
  if (days === 0) return { days, count: 'today', connector: '', iso: raw, when, label };
  // Inside the grace window. The label is dropped rather than shown in the wrong
  // tense; see Countdown.label.
  return { days, count: "you're here", connector: 'since', iso: raw, when, label: '' };
}

/* ============================================================================
   WHAT IS NEW

   ---------------------------------------------------------------------------
   TWO KINDS OF SIGNAL, DELIBERATELY NOT MIXED

   SINCE-HER-LAST-VISIT is time-based and comes from `postedAt` on a song record
   compared against Visits.prev. It is the real "you have not seen this yet".

   NEVER-OPENED is standing and comes from `Mark.seen === 0`. It is not new — the
   thirteen memories are a fixed manifest with no timestamps, so "a new memory
   appeared" is not a thing the data can express. What it can express is "you have
   never held this one down long enough to read what I wrote on it", which is worth
   saying and stays true until she does.

   They are counted separately and worded separately so the summary line never
   claims a standing fact arrived recently. "three photographs you've never opened"
   is true whenever it is shown; "three photographs arrived since Tuesday" would
   not be.

   ---------------------------------------------------------------------------
   WHAT IS NOT COUNTED, AND WHY

   HER OWN SONGS. A reply is HERS — kv.ts's key spaces are split precisely so that
   her session cookie writes `us:reply:<date>` and my admin cookie writes
   `us:song:<date>`, and this page is hers alone (my admin token cannot open the
   vault; see today.astro). So there is no such record as "a reply from Sam" to
   count, and the songs bucket already covers every case where I answered a day she
   went first. Counting her own replies back at her would be the page telling her
   about herself.

   HER REACTIONS AND HER NOTES, for the same reason.

   ---------------------------------------------------------------------------
   NOTHING IN HERE MAY INVENT A NUMBER

   Every count below is the length of a filtered list of stored records. There is no
   estimate, no "or so", and no bucket that exists because the layout wanted a third
   badge. If the data cannot support a number, the number is not shown — which is
   also why `postedAt: 0` (a hand-edited or pre-timestamp record) counts as nothing
   rather than as new: absence of a timestamp is not evidence of recency.
   ========================================================================= */

export interface Fresh {
  /** Mornings whose song was written since her previous visit. */
  songs: number;
  /** Older mornings I went back and rewrote since her previous visit. */
  changed: number;
  /** Memories she has never opened. Standing, not time-based. */
  unopened: number;
  /** Quiet marker for the song room, or '' for no marker. */
  song: string;
  /** Quiet marker for the studio, or '' for no marker. */
  studio: string;
  /**
   * The one summary line.
   *
   * '' means render NOTHING — not an empty state, not a dash. That is the
   * first-visit and no-baseline case, where there is genuinely no previous visit to
   * compare against and "nothing new since last time" would be a claim about a
   * moment that never happened.
   *
   * A non-empty line with `any === false` is the calm empty state, which is the one
   * she will see most often and the one that has to feel deliberate.
   */
  line: string;
  /** True when a marker is showing anywhere. Drives emphasis, never content. */
  any: boolean;
}

/**
 * Returned as a COPY, never by reference.
 *
 * Same rule marks.ts applies to NO_VISITS, and for the same reason: this is a
 * module-level object handed to a page that is free to do whatever it likes with it,
 * and one caller assigning to a field would silently change what every later render
 * in that process sees. It costs a spread.
 */
const NOTHING: Fresh = { songs: 0, changed: 0, unopened: 0, song: '', studio: '', line: '', any: false };

/**
 * Small numbers as words.
 *
 * Because "3 unread" is the voice this feature was explicitly built to avoid.
 * Thirteen is not an arbitrary ceiling — it is the size of the memory manifest and
 * one more than the largest count any bucket here can reach in practice — and the
 * digit fallback means a future fourteenth memory degrades to "14" rather than to
 * `undefined`.
 */
const WORDS = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
];
function spell(n: number): string {
  return WORDS[n] ?? String(n);
}

/**
 * `a, b, and c` — with the comma before `and` even when there are only two.
 *
 * Normally two items take no comma ("salt and pepper"), and that rule is wrong here
 * because these are not items, they are clauses: "a morning in here you haven't
 * heard and one photograph you've never opened" runs the two together and reads as
 * one thought on the first pass. The comma is the pause that separates them.
 */
function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What changed since she was last here.
 *
 * `visits` MUST be the value returned by countVisit (not getVisits) for this
 * render, because the baseline is Visits.prev and that field only means "her
 * previous visit" once the current visit has been stamped. See Visits.prev in
 * marks.ts for the failure this arrangement exists to prevent.
 */
export function newSince(input: {
  /** Today in WING_TZ. Passed, never read from the clock. */
  today: string;
  /** From countVisitSafe(), this render. */
  visits: Visits;
  /** Newest-first, as getSongs() returns them. Order is not relied on. */
  songs: readonly SongRecord[];
  /** From getMarksSafe(). Every manifest id is present. */
  marks: Record<string, Mark>;
}): Fresh {
  const { visits } = input;

  /* HER FIRST VISIT SAYS NOTHING, ON PURPOSE.
     count is 1 on the render that counted her arrival, so `> 1` is "she has been
     here before". On a genuine first visit the entire wing is new and pointing at
     three parts of it is noise — "first time in here." (marks.ts's visitLine) is
     the right sentence for that render, and this is not it.

     It is also the backstop for a dead store: countVisitSafe returns count 0 when
     the store is unreachable, and getMarksSafe returns thirteen empty marks from
     the same failure — so without this line an outage would render "thirteen
     photographs you've never opened" as if it were a fact about her. Both reads hit
     the same backend, so one failing almost always means both did. */
  if (visits.count <= 1) return { ...NOTHING };

  /* 0 IS "NO BASELINE", NOT THE EPOCH. See Visits.prev. Reading it as a timestamp
     would make every record ever written newer than it. */
  const since = visits.prev;
  const hasBaseline = since > 0;

  /* The calendar day her previous visit fell on, which is what separates "a morning
     that happened while she was away" from "a morning she has already seen, that I
     went back and rewrote". Both look identical in the store — a song record has
     exactly ONE timestamp, and putSong overwrites it, so a re-post and a first post
     are indistinguishable by design. What IS distinguishable is whether the DAY the
     song belongs to had already passed the last time she was here. */
  const sinceDay = hasBaseline ? wingDate(new Date(since)) : '';

  let songs = 0;
  let changed = 0;
  if (hasBaseline) {
    for (const song of input.songs) {
      // 0 is "no timestamp recorded", which is not evidence of recency.
      if (!(song.postedAt > since)) continue;
      if (!isWingDate(song.date)) continue;
      /* Plain string comparison, which is a real date comparison here: both sides
         are zero-padded YYYY-MM-DD validated by isWingDate, so lexical order IS
         chronological order. Same property kv.ts relies on for its sort.

         THE BOUNDARY CASE IS `date === sinceDay`, AND `>=` PUTS IT IN `songs`
         DELIBERATELY. A song filed under the same day she last visited, written
         after she left, is either (a) a morning I posted late and she never saw —
         very common, she checks before I post — or (b) an edit to a card she already
         read. The store cannot tell them apart, so the tie has to go somewhere, and
         it goes to the louder bucket: mistaking an edit for a new song points her at
         something that genuinely did change, whereas mistaking a new song for an
         edit ("a note I went back and changed") invites her to ignore a whole
         morning. `changed` is left as the unambiguous case only — a day that had
         already passed when she was last here. */
      if (song.date >= sinceDay) songs += 1;
      else changed += 1;
    }
  }

  let unopened = 0;
  for (const mark of Object.values(input.marks)) if (mark.seen <= 0) unopened += 1;

  /* ---- the copy ----------------------------------------------------------
     Assembled from fragments rather than written as N canned sentences, because
     the states multiply: three buckets, each of which can be absent, one, or
     several. Canned sentences would mean twelve of them and eleven would be
     unreachable in practice and therefore never proofread. */
  const frags: string[] = [];
  if (songs === 1) frags.push("a morning in here you haven't heard");
  else if (songs > 1) frags.push(`${spell(songs)} mornings you haven't heard`);
  if (changed === 1) frags.push('a note I went back and changed');
  else if (changed > 1) frags.push(`${spell(changed)} notes I went back and changed`);
  if (unopened === 1) frags.push("one photograph you've never opened");
  else if (unopened > 1) frags.push(`${spell(unopened)} photographs you've never opened`);

  /* THE EMPTY STATE IS THE COMMON CASE, so it is written as a sentence somebody
     meant, not as the absence of one. Most visits will land here: she comes back on
     a Thursday, I posted on Wednesday and she already heard it, and the honest thing
     for the room to say is that it is unchanged. "0 new" or a blank space would both
     read as a fault.

     Two versions, because the claim has to be one we can actually support. With a
     baseline we know what "since you were last here" means and can say it. Without
     one (her second visit on a record written before `prev` existed) we do not, so
     the line drops the comparison and keeps only the part that is still true. */
  const line = frags.length
    ? `${sentence(joinAnd(frags))}.`
    : hasBaseline
      ? 'Nothing new since you were last here — everything is exactly where you left it.'
      : 'Everything is exactly where you left it.';

  return {
    songs,
    changed,
    unopened,
    /* Per-room markers. Wording, not counts: the card already carries a number's
       worth of information by being a link to the room, and "3" on a card is the
       notification badge this feature was told not to be. The song room says
       "something new in here" whether it is one morning or four — she is going to
       open it either way, and the summary line above the grid is where the count
       belongs. */
    song: songs > 0 ? 'something new in here' : changed > 0 ? 'I changed something in here' : '',
    studio:
      unopened === 0
        ? ''
        : unopened === 1
          ? "one you haven't opened"
          : `${spell(unopened)} you haven't opened`,
    line,
    any: frags.length > 0,
  };
}
