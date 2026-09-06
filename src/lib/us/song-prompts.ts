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
   DETERMINISTIC FOR TODAY, AND WRITTEN DOWN FOR HISTORY

   The prompt is a pure function of the date, identical for both of them and stable
   all day — exactly like promptFor(). Everything on THIS page comes from that.

   ~~THE ARCHIVE CAN RECOMPUTE ANY PAST DAY'S PROMPT, so no prompt is written to the
   store.~~ It can, and it must not. That was true of the code and wrong about the
   world: recomputing is only honest while the list never changes, and the list is a
   list of questions somebody wrote. The first rewrite arrived ONE DAY after this
   shipped, because the prompts were too open-ended to compare — and every entry that
   moved would have silently re-labelled every past day, so the archive would state a
   question with total confidence that the song was never answering.

   So `prompt` is now copied onto the song record at post time (TrackRecord in kv.ts,
   written by song.ts and reply.ts) and the archive READS it. The rotation below is
   still the only thing that decides what today asks.

   WHAT THAT BUYS: the list is now editable. Reordering, replacing and deleting are
   all safe, because nothing in history depends on this array any more. The cost is
   eleven words per song, and a day posted before the field existed shows no prompt
   line at all rather than an invented one — which is also the right answer for every
   day before the feature existed.

   ~~ORDER IS LOAD-BEARING. Append.~~ Not any more, and this is the whole point of
   storing it. One thing does still follow from the rotation: a prompt APPENDED to the
   end is asked once the walk reaches it, which at 51 entries can be two months away,
   while one that REPLACES an existing entry is in circulation immediately. That is a
   scheduling fact, not a safety rule.

   ---------------------------------------------------------------------------
   A PROMPT NAMES A CATEGORY, NOT A FEELING

   The rule the rewrite came out of, and the one to hold any new entry against.

   "the song that got you through the day" gets two answers with nothing in common:
   each of them needed something different that day, both answers are private and
   correct, and there is nothing to say back. "the best disco song ever made" gets two
   answers you can put side by side and argue about. The feature exists so a day reads
   as one exchange, and that only happens when both people are answering the same
   question in the same terms.

   So every entry is anchored to an era, a genre, a named part of a song, or a role.
   Where a mood survived, it carries a SUPERLATIVE — "the best song for walking home
   at 2am" has one answer each, where "a song for walking home at 2am" has twenty.

   AN ERA, NEVER A SINGLE YEAR. ~~your favourite song from 2005~~ was the first pass
   and it is too tight: almost nobody can name a favourite from one specific year
   without stopping to look it up, so a prompt that should take ten seconds becomes
   homework and the day gets skipped. "the early 2000s" is still narrow enough that
   two picks sit in the same world, and it is answerable from memory. The two personal
   year anchors that remain — the year you finished school, last summer — stay because
   those are years a person already has in mind rather than years they have to work
   out.

   ONLY GENRES BOTH OF THEM ACTUALLY LISTEN TO. Two rounds of cuts:
   ~~amapiano · bossa nova · salsa or bachata · garage or jungle · drum and bass ·
   techno · trip hop · k-pop · metal~~ went first, then
   ~~gospel · reggae · disco · funk~~ — the second four not for being obscure but for
   being hard to answer QUICKLY. Everybody has heard funk and disco; far fewer people
   can name a favourite one on the spot, which is the only thing that matters here.

   The phrasing trick propping the first batch up went with them: that pass hedged the
   far-out ones as "the best X you KNOW" rather than "your favourite X", so a shallow
   answer counted. That hedge was the tell. A prompt that has to lower its own bar to
   be answerable is a prompt neither of them wanted.

   THE TEST IS NOT "IS THIS GENRE BIG", IT IS "CAN YOU NAME ONE WITHOUT THINKING", and
   EDM and dubstep coming IN while funk went OUT is what that distinction looks like.
   Funk is the more canonical music by any measure; a dubstep song is the one a person
   can actually produce on demand. Broad and immediate beats broad and respected.

   RIGHT NOW BEATS ALL TIME, and that shape was missing entirely. Every other prompt
   asks somebody to search their memory and rank things, which is work. "your hype
   song right now" and "the rap song you have been playing a lot lately" ask what is
   ALREADY playing — no searching, no ranking, and both halves report the same kind of
   fact on the same day. It is also the only shape whose answer changes over time, so
   the same prompt is worth asking again next year.

   The genre prompts are the closest this list gets to naming an artist, which is the
   thing the screening rules below forbid. Naming the genre does the same work — it
   narrows the field enough that two picks are comparable — without betting on either
   of their libraries.

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

/**
 * Sunday's prompt. One a week, and it looks back at the week rather than at an era.
 *
 * ~~the song that got you through this week~~ — replaced, and it is the line that
 * started the rewrite below. "Got you through" asks for a private answer: whatever
 * each of them needed that week, which the other cannot agree or disagree with and
 * cannot really answer back. Most-played is the same backward look at the week and it
 * is a FACT both of them can produce, so the two halves sit next to each other and
 * mean something together. "Honestly" is doing real work — it licenses the
 * embarrassing true answer over the flattering one.
 */
export const SONG_WEEK_PROMPT = 'the song you played most this week, honestly';

/**
 * THE ONLY ARTISTS THIS LIST MAY NAME, and the single source for that permission.
 *
 * ~~NO ARTIST IS NAMED~~ was the original rule and its reasoning was sound on both
 * counts: a named artist is dead on a day neither of them feels like that artist, and
 * a list written by somebody who has never seen their library is guessing. The second
 * objection is the one that mattered, and it was answerable — these names were read
 * out of their OWN song shelves, so none of them is a guess.
 *
 * THE FILTER IS "DEEP ENOUGH TO HAVE A FAVOURITE", and it is doing two jobs. The
 * shelves hold 26 distinct artists and most were posted exactly once, including
 * several with barely an album out: "your favourite <one-hit artist> song" has one
 * possible answer and asking it is a formality, not a question. So only artists with a
 * real catalogue are here.
 *
 * That same filter IS THE SYMMETRY RULE, which is the neater half of this. A prompt
 * has to be answerable by EITHER of them, and these names come from two shelves
 * combined — some were posted by one of them and never the other. Restricting to
 * artists this famous makes "who posted them" stop mattering: both of them can name a
 * favourite from any of these whether or not it was ever their own pick.
 *
 * ADDING ONE IS AN EDIT HERE, DELIBERATELY. scripts/test-song-prompts.mts requires
 * every capitalised word in every prompt to appear in this array, so a name that
 * arrives in a prompt without arriving here fails the suite. That is the point: the
 * old test banned proper nouns outright, and replacing a ban with an allowlist is only
 * safe if the allowlist is enforced.
 */
export const NAMED_ARTISTS: readonly string[] = [
  'Drake',
  'Travis Scott',
  'Future',
  '21 Savage',
  'Lil Wayne',
  'Gunna',
  'Kodak Black',
  'PARTYNEXTDOOR',
  'Daniel Caesar',
  'Joji',
  'Calvin Harris',
  'The Chainsmokers',
  'Yeat',
];

/**
 * The rotation.
 *
 * Grouped loosely so that a run of days does not feel like one long quiz about
 * decades. Order within the list is the order they will be asked, which is also why
 * the named-artist prompts sit in three separate clusters rather than one block —
 * thirteen consecutive days of "your favourite X song" is a quiz.
 */
export const SONG_PROMPTS: readonly string[] = [
  /* ---- AN ERA, NEVER A SINGLE YEAR. See the header: "your favourite song from
     2005" is a trivia question, and the honest answer to it is usually "hold on".
     A stretch of years is still narrow enough that two picks compare. ---- */
  'your favourite song from the early 2000s',
  'your favourite song from the late 2000s',
  'your favourite song from the early 2010s',
  'your favourite song from the late 2010s',
  'your favourite song from the 2020s so far',
  'your favourite song from the 90s',
  'your favourite song from the 80s',
  'the best song of the 2000s, and you have to commit',
  'the best song of the 2010s, one pick only',
  'your favourite throwback from before either of us could drive',
  'the best song from a decade you were not born in',
  'the song that owned last summer',
  'your favourite song from the year you finished school',
  'the best song of this year so far',

  /* ---- RIGHT NOW AND LATELY, which is the easiest shape in the list and the most
     comparable. Every other prompt asks somebody to search their memory; these ask
     what is actually playing, so the answer is already in hand and both halves are
     reporting the same kind of thing on the same day. ---- */
  'your hype song right now',
  'the song you have been playing a lot this week',
  'the rap song you have been playing a lot lately',
  'the R&B song you have been playing a lot lately',
  'the song you have had on repeat this month',
  'the last song you added to a playlist',
  'the last song you sent somebody',
  'the song you cannot stop playing right now',
  'your shower song at the moment',
  'the song you would put on right now if nobody else was home',
  'the song you woke up with in your head',
  'your walking-around song this week',

  /* ---- NAMED ARTISTS, cluster one. Only from NAMED_ARTISTS above. ---- */
  'your favourite Drake song',
  'your favourite Travis Scott song',
  'the best Future song, one pick only',
  'your favourite Lil Wayne song',
  'your favourite PARTYNEXTDOOR song',

  /* ---- A GENRE ANYBODY CAN ANSWER. Kept deliberately broad — see the header on
     why the niche ones went. ---- */
  'your favourite rap song',
  'your favourite R&B song',
  'your favourite pop song',
  'your favourite rock song',
  'your favourite soul song',
  'your favourite country song, and yes you have one',
  'your favourite jazz song',
  'your favourite dancehall song',
  'your favourite afrobeats song',
  'your favourite house song',
  'your favourite EDM song',
  'your favourite dubstep song',
  'your favourite love song',
  'your favourite sad song',
  'your favourite slow song',
  'your favourite party song',
  'your favourite song to sing badly',
  'your favourite song to drive to',

  /* ---- named artists, cluster two ---- */
  'your favourite 21 Savage song',
  'your favourite Gunna song',
  'your favourite Kodak Black song',
  'your favourite Daniel Caesar song',
  'your favourite Joji song',

  /* ---- they pick the artist, for the reason in the header ---- */
  'your favourite song by an artist you have never mentioned to me',
  'the artist you have played most this year, and their best song',
  'your favourite song by a band rather than one person',
  'a song where the feature is better than the main artist',
  'your favourite song you found through a soundtrack',
  'the song you would use to convert somebody to your favourite artist',

  /* ---- ONE PART of a song, so both answers are about the same thing ---- */
  'the best beat you know',
  'the best hook you know',
  'the best intro you know, first thirty seconds only',
  'your favourite song with a sample you can name',
  'your favourite cover that beats the original',
  'the best duet you know',
  'your favourite song under two minutes',
  'your favourite live version of a song you know by heart',

  /* ---- a moment, but anchored to a superlative so the two picks still compare.
     "a song for walking home at 2am" is a mood; "the BEST song for walking home
     at 2am" is a question with one answer each. ---- */
  'the best song for a long drive with nowhere to be',
  'the best song for the start of a night out',
  'the best song for walking home at 2am',
  'the best song for a rainy afternoon and no plans',
  'the best song to cook to',
  'the best song to fall asleep to',
  'the first song on a playlist you would make for a stranger',
  'the best song you would be a bit embarrassed to play out loud',
  'the song you would defend in an argument',

  /* ---- named artists, cluster three ---- */
  'your favourite Calvin Harris song',
  'your favourite Yeat song',
  'the best song The Chainsmokers ever made',
  'the best Drake verse, not the best Drake song',
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
   are unaskable, permanently, and nothing anywhere would say so. The list was 50 long
   at the time and 50 is coprime with 7, so it never bit — a latent trap that would
   have sprung on whoever tidied the list to 49 entries. It is 83 now, and the length
   is free precisely because this was fixed rather than documented: 84 would have been
   a live bug under the old index and is fine under this one.

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
