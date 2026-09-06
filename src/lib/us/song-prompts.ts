/* ===========================================================================
   song-prompts.ts — a prompt a day for the song, so the two picks rhyme.
   ===========================================================================

   ---------------------------------------------------------------------------
   WHY, AND WHAT THE SONG PAGE WAS MISSING

   The daily question has had a prompt since it shipped (`promptFor` in
   together.ts). The song never did: it was "post a song", every day, forever. That
   works and it is also the reason the two halves of a day rarely have anything to
   do with each other — she posts what she is listening to, he posts what he is
   listening to, and there is nothing to talk about except that they are different.

   A shared prompt makes the pair a PAIR. "favourite song from 2004" gets two
   answers that are about the same question, which is the whole thing the song page
   was for and the one part of it that was missing.

   ---------------------------------------------------------------------------
   DETERMINISTIC, SO NOTHING HAS TO BE STORED

   The prompt is a pure function of the date, identical for both of them and stable
   all day — exactly like promptFor(). That has a consequence worth stating because
   it removes a whole feature: THE ARCHIVE CAN RECOMPUTE ANY PAST DAY'S PROMPT, so
   no prompt is written to the store, there is no field to migrate, and no record
   written before today is missing anything.

   The cost is the same one promptFor() carries: ORDER IS LOAD-BEARING. Appending to
   the end of the list is free. INSERTING IN THE MIDDLE re-labels every past day from
   that point on, so an archive day would quietly start claiming it was asked
   something it was not. Append.

   ---------------------------------------------------------------------------
   A SEQUENTIAL ROTATION, NOT A HASH

   Copied deliberately from promptFor(), including the reason: `hash(date) % n`
   serves the same prompt twice in a fortnight and skips others for months, which
   reads as broken. Walking the list one day at a time guarantees every prompt is
   asked before any is asked twice.

   ---------------------------------------------------------------------------
   NO RUNTIME IMPORTS, WHICH IS WHY THIS IS ITS OWN FILE

   `promptFor` lives in together.ts, which pulls in the Upstash config, so bare
   `node` cannot load it and its rotation has never been tested. This module imports
   nothing — same reason `frame-keys.ts`, `day-seal.ts` and `who-words.ts` are
   separate files, and see scripts/test-song-prompts.mts.

   The list is passed IN rather than read from the environment here. An env override
   would mean an `env()` import and the file would stop being bare-node loadable for
   the sake of a feature nobody has asked for: unlike the daily question, a song
   prompt has no private variant to hide. `US_PROMPTS` exists for the question
   because "what did your mother say" is not publishable; "favourite song from 2004"
   is. If that ever changes, the override belongs in the caller.

   ---------------------------------------------------------------------------
   WHAT THE LIST IS SCREENED FOR, since this repository is PUBLIC

     - Nothing that names either of them, a place, a date or an event from their
       life. Every prompt below would make sense to a stranger.
     - Answerable with ONE song, by either of them, on a bad day. A prompt that
       needs a paragraph is a prompt that gets skipped.
     - Symmetric. Nothing that only lands for one of them — a prompt one side cannot
       answer breaks the pairing that is the entire point.
     - NO ARTIST IS NAMED. That is a deliberate choice and not caution: "favourite
       Drake song" is dead on a day neither of them feels like Drake, and a list
       written by somebody who has never seen their library would be guessing. The
       artist prompts below let THEM choose the artist, which is both safer and a
       better question.
   =========================================================================== */

/** Days since the epoch for a `YYYY-MM-DD`. Pure, and UTC so it cannot drift. */
function dayNumber(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / 86_400_000);
}

/**
 * Sunday looks back at the week, the same way the daily question's Sunday does.
 *
 * 1970-01-01 was a Thursday, so `(dayNumber + 4) % 7 === 0` is Sunday. Double-modulo
 * because a pre-epoch date would otherwise index negatively — impossible here, and
 * free to guard.
 */
export function isSongWeekPrompt(date: string): boolean {
  const n = dayNumber(date);
  return (((n + 4) % 7) + 7) % 7 === 0;
}

/** Sunday's prompt. One a week, and it is about the week rather than about a era. */
export const SONG_WEEK_PROMPT = 'the song that got you through this week';

/**
 * The rotation. Append only — see the header.
 *
 * Grouped loosely so that a run of days does not feel like one long quiz about
 * decades. Order within the list is the order they will be asked.
 */
export const SONG_PROMPTS: readonly string[] = [
  /* ---- eras, which is what he asked for first ---- */
  'your favourite song from 2005',
  'a song from the 2000s you still know every word to',
  'your favourite song from 2012',
  'a 2010s song you think aged really well',
  'the song that was everywhere the summer you turned sixteen',
  'a song from before either of us was allowed to listen to it',
  'your favourite song from the year you finished school',
  'a 2000s R&B song that deserves more credit',
  'the best rap song of 2009, and you have to commit',
  'a song from the 2010s you were late to and now love',

  /* ---- genre and sound ---- */
  'your favourite slow jam',
  'the best beat you have ever heard, whatever is on top of it',
  'a neo-soul song for a slow morning',
  'your favourite song with a sample you can name',
  'the hardest verse you know by heart',
  'a song that is all bass and no apology',
  'your favourite song that is barely two minutes long',
  'a song with a beat switch that still gets you',
  'the best hook, not the best song',
  'a song you would use to explain rap to somebody who has never listened to it',
  'your favourite R&B song sung by a man',
  'your favourite R&B song sung by a woman',
  'a song where the feature outshines the main artist',
  'the best intro on any track, first thirty seconds only',
  'a song that is better on headphones than out loud',

  /* ---- let them pick the artist, which is better than us picking ---- */
  'your favourite song by an artist you have never mentioned to me',
  'the song you would pick to convert somebody to your favourite artist',
  'your favourite song by an artist who only made one you like',
  'the best song by the artist you have played most this year',
  'a song by somebody you discovered through a soundtrack',
  'your favourite song by an artist neither of us can pronounce properly',

  /* ---- occasions, and none of them a workout ---- */
  'the song for a long drive with nowhere to be',
  'a song for cooking on a weeknight',
  'the song you would put first on a playlist for a stranger',
  'a song for the exact moment a night starts',
  'the song for walking home at 2am',
  'a song for a rainy Sunday and no plans',
  'the song you would want playing when you arrive somewhere new',
  'a song for doing nothing at all',

  /* ---- feeling, kept light ---- */
  'a song that makes you feel like you are getting away with something',
  'the song you play when you need to snap out of a mood',
  'a song you love that you would be a little embarrassed to put on aloud',
  'the song you would defend in an argument',
  'a song that sounds like the city you live in',
  'a song that sounds like the city you want to live in',
  'the song you have listened to most times in your life, honestly',
  'a song that reminds you of somebody you have not seen in years',
  'a song you cannot listen to just once',
  'the last song that genuinely surprised you',
  'a song you would want to hear live more than any other',
  'the song you would pick if you only got one more',
];

/**
 * Today's prompt. Identical for both of them, stable all day, recomputable for any
 * past date — see the header on why nothing is stored.
 *
 * `list` is injectable so the rotation can be asserted against a known short list
 * rather than against whatever happens to be committed. Production never passes it.
 */
export function songPromptFor(date: string, list: readonly string[] = SONG_PROMPTS): string {
  if (isSongWeekPrompt(date)) return SONG_WEEK_PROMPT;
  if (list.length === 0) return '';
  const i = ((rotationIndex(dayNumber(date)) % list.length) + list.length) % list.length;
  return list[i] ?? '';
}

/* ===========================================================================
   COUNT THE DAYS THAT ACTUALLY ASK A ROTATION PROMPT

   ---------------------------------------------------------------------------
   THE BUG THIS EXISTS TO FIX, WHICH A TEST FOUND AND NOT A REVIEW

   The first version indexed on the raw day number: `dayNumber(date) % list.length`.
   That is what promptFor() in together.ts does, and it is wrong for both of us for
   the same reason — SUNDAY STILL ADVANCES THE INDEX even though Sunday serves the
   week prompt instead. So one index per week is consumed by a day that never shows
   it, the walk is not contiguous, and "every prompt before any repeat" is false.

   Measured on a five-item list: `a b c d e` came out as `e a b d e` — a repeat
   inside the first cycle, which is exactly the failure the sequential walk was
   chosen over a hash to avoid.

   THERE IS A WORSE VERSION OF IT hiding behind that. The skipped index is
   `dayNumber % 7`-dependent, and Sunday is always the same residue, so if the list
   length is a MULTIPLE OF SEVEN the same indices are skipped forever: those prompts
   are unaskable, permanently, and nothing anywhere would say so. This list is 50
   long and 50 is coprime with 7, so it never bit — a latent trap that would have
   sprung on whoever tidied the list to 49 entries.

   Counting non-Sunday days instead makes the walk genuinely contiguous and removes
   the trap rather than documenting it, so appending is safe at any length.

   THE SAME DEFECT IS STILL LIVE IN promptFor() for the daily question. Not fixed
   here on purpose: changing its index would re-label every past day AND change
   today's question under them mid-day, which is not a decision this file gets to
   make on another feature's behalf.
   =========================================================================== */

/**
 * How many rotation days have happened up to and including `n`, zero-based.
 *
 * Sundays are the days where `n % 7 === 3` — 1970-01-04 was day 3 and was a Sunday —
 * so the count of them in `[0, n]` is a division, no loop.
 */
function rotationIndex(n: number): number {
  if (n < 0) return 0;
  const sundays = n >= 3 ? Math.floor((n - 3) / 7) + 1 : 0;
  // Non-Sundays in [0, n], minus one because the caller's own day is one of them.
  return n + 1 - sundays - 1;
}
