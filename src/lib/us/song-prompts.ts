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
   NO TACKED-ON CLAUSE, WHICH IS WHAT MADE THESE READ AS WRITTEN BY A MACHINE

   ~~your favourite country song, AND YES YOU HAVE ONE~~ · ~~the best song of the 2000s,
   AND YOU HAVE TO COMMIT~~ · ~~the best song of the 2010s, ONE PICK ONLY~~ · ~~the best
   Drake verse, NOT THE BEST DRAKE SONG~~ · ~~the best intro on any track, FIRST THIRTY
   SECONDS ONLY~~. Every one of those trailing clauses is the same reflex: anticipating
   an objection nobody made, then answering it inside the question. It reads as nervous,
   it doubles the length of a line that has to be scanned in two seconds, and it is the
   single clearest tell that a person did not write it. The question either stands on its
   own or it is the wrong question.

   Cut with them, as too specific or too pleased with themselves: ~~your favourite
   throwback from before either of us could drive~~ · ~~your favourite song from the year
   you finished school~~ · ~~the best song from a decade you were not born in~~ · ~~the
   first song on a playlist you would make for a stranger~~ · ~~the song you would use to
   convert somebody to your favourite artist~~ · ~~your favourite song to sing badly~~ ·
   ~~the song you would put on right now if nobody else was home~~. A prompt built out of
   a specific imagined scene is doing the answering for them.

   And four near-identical "right now" prompts went down to one apiece: ~~the song you
   cannot stop playing right now~~, ~~the song you have been playing a lot this week~~ and
   ~~your walking-around song this week~~ were all the same question as "your hype song
   right now" wearing different hats. Redundancy inside a rotation is worse than
   elsewhere: it is the same day twice, three weeks apart.

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

   ONLY GENRES BOTH OF THEM ACTUALLY LISTEN TO. Three rounds of cuts:
   ~~amapiano · bossa nova · salsa or bachata · garage or jungle · drum and bass ·
   techno · trip hop · k-pop · metal~~ went first, then
   ~~gospel · reggae · disco · funk~~ — the second four not for being obscure but for
   being hard to answer QUICKLY. Everybody has heard funk and disco; far fewer people
   can name a favourite one on the spot, which is the only thing that matters here.

   Then ~~soul~~, and dancehall and afrobeats collapsed into ONE prompt naming both.
   The reason is the best one available: HE SAID HE CANNOT TELL THEM APART. Those are
   two genuinely distinct traditions — dancehall is Jamaican out of reggae, afrobeats
   is Nigerian and Ghanaian and only named around 2011 — and the distinction is real
   and irrelevant, because a prompt is only as good as the listener can act on it. A
   prompt that requires a genre lesson first is a prompt that gets skipped. Same for
   soul against R&B: the honest line between them is era and production, pre-1980 and
   live versus post-1980 and programmed, which is a fact about music history rather
   than a question anybody wants at 1am. R&B stays because that is the word they
   actually use.

   The phrasing trick propping the first batch up went with them: that pass hedged the
   far-out ones as "the best X you KNOW" rather than "your favourite X", so a shallow
   answer counted. That hedge was the tell. A prompt that has to lower its own bar to
   be answerable is a prompt neither of them wanted.

   THE TEST IS NOT "IS THIS GENRE BIG", IT IS "CAN YOU NAME ONE WITHOUT THINKING", and
   EDM and dubstep coming IN while funk went OUT is what that distinction looks like.
   Funk is the more canonical music by any measure; a dubstep song is the one a person
   can actually produce on demand. Broad and immediate beats broad and respected.

   FOUR SHAPES ARE EARNED, AND ONLY THREE ARTISTS EARN THEM. An artist can be asked
   four different ways — the song, the best verse, the best GUEST verse on somebody
   else record, and the best beat on one of their songs — and those four are genuinely
   four questions rather than padding. The best beat on a Drake song is usually not on
   his best song, which is exactly the argument the prompt is fishing for.

   But the shapes are only worth spending on somebody whose catalogue BOTH of them could
   argue about, and that is a much shorter list than "artists we have posted". Four
   artists carry four prompts — Drake, Future, Travis Scott and Gunna — and the other
   twenty-five carry one each.

   THE TEST IS "COULD THE OTHER ONE ARGUE BACK", not "is this artist good", and I got
   that test wrong once already in a way worth recording. ~~Gunna does not have the kind
   of catalogue where two people each hold a confident favourite VERSE~~ — he is HER
   FAVOURITE ARTIST, which I did not know and could not have read off the store. The
   shelf data said he had been posted once; a favourite artist is a fact about years and
   the shelf holds a fortnight. The measurement was real and the inference from it was
   invented, so the trim went to the one artist on the list who most deserved the space.
   When the evidence is a small sample of recent behaviour, ASK before ranking anybody
   by it.

   THE SHAPES ALSO ONLY FIT RAPPERS at all. A "best verse" prompt about a producer is a
   category error rather than a harder question, so the singers and the dance acts were
   never candidates, and NAMED_ARTISTS records which is which. Travis Scott is the one
   exception in the other direction: his fourth is the best feature ON one of his songs
   rather than his best guest verse elsewhere, because that is the way his features
   actually run.

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
 * out of their OWN song shelves, so none of them is a guess. The one exception is
 * marked below as an exception rather than quietly folded in: it was asked for by name,
 * which is a better provenance than a shelf read and a worse one than nothing, and the
 * distinction is only useful if it stays visible.
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
  /* FOUR SHAPES EACH — song, verse, guest verse, beat. See the header: four prompts is
     earned by a catalogue both of them could argue about, not by having been posted.

     GUNNA IS HERE ON HER SAY-SO AND THAT OUTRANKS THE SHELF COUNT. He was trimmed to
     one prompt on the reasoning that his catalogue would not support two people each
     holding a confident favourite VERSE — a guess, and a wrong one: he is her favourite
     artist. Worth leaving the reversal visible, because the shelf read that drove the
     trim measured 24 records over a fortnight and a favourite artist is a fact about
     years. The data was real and the inference from it was not. */
  'Drake',
  'Travis Scott',
  'Future',
  'Gunna',
  /* Everybody below gets the SONG SHAPE ONLY, whether or not they rap. */
  '21 Savage',
  'Lil Wayne',
  'Kodak Black',
  'Yeat',
  'A$AP Ferg',
  'BigXthaPlug',
  'PARTYNEXTDOOR',
  /* ---- NOT FROM THEIR SHELVES. Everything above was read out of what they have
     actually posted; everything from here down was either asked for by name or
     proposed as adjacent to what they post and then approved. Keeping the two groups
     apart is the whole reason the "no artist is named" rule could be reversed at all —
     the names were evidence, and a name that is instead a suggestion should not be
     able to pass itself off as one later. ---- */
  'Kanye',
  /* Proposed as adjacent to the names above: melodic rap and trap first, then the R&B
     side of what they post. One prompt each, so a wrong guess here costs one day. */
  'Polo G',
  'Bryson Tiller',
  'Lil Baby',
  'Young Thug',
  'Rod Wave',
  'Roddy Ricch',
  'Don Toliver',
  'Playboi Carti',
  'Lil Uzi Vert',
  'Kendrick Lamar',
  'Brent Faiyaz',
  'SZA',
  'The Weeknd',
  /* Not rappers at all, so they were never candidates for the verse and beat shapes
     even before the trim. Grouped in the last cluster below. */
  'Daniel Caesar',
  'Joji',
  'Calvin Harris',
  'The Chainsmokers',
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
  'the best song of the 2000s',
  'the best song of the 2010s',
  'the song that owned last summer',
  'the best song of this year so far',

  /* ---- RIGHT NOW AND LATELY, which is the easiest shape in the list and the most
     comparable. Every other prompt asks somebody to search their memory; these ask
     what is actually playing, so the answer is already in hand and both halves are
     reporting the same kind of thing on the same day. ---- */
  'your hype song right now',
  'the rap song you have been playing a lot lately',
  'the R&B song you have been playing a lot lately',
  'the song you have had on repeat lately',
  'the last song you added to a playlist',
  'the last song you sent somebody',
  'your shower song',
  'the song you woke up with in your head',

  /* ---- NAMED ARTISTS, cluster one. Only from NAMED_ARTISTS above, and FOUR SHAPES
     per artist rather than one — see the header on why the shape carries more of the
     weight than the name does. ---- */
  'your favourite Drake song',
  'the best Drake verse',
  'the best guest verse Drake ever did',
  'the best beat on any Drake song',
  'your favourite Travis Scott song',
  'the best Travis Scott verse',
  'the best beat on any Travis Scott song',
  'the best feature on any Travis Scott song',

  /* ---- A GENRE ANYBODY CAN ANSWER. Kept deliberately broad — see the header on
     why the niche ones went. ---- */
  'your favourite rap song',
  'your favourite R&B song',
  'your favourite pop song',
  'your favourite rock song',
  'your favourite country song',
  'your favourite jazz song',
  'your favourite afrobeats or dancehall song',
  'your favourite house song',
  'your favourite EDM song',
  'your favourite dubstep song',
  'your favourite love song',
  'your favourite sad song',
  'your favourite slow song',
  'your favourite party song',
  'your favourite song to drive to',

  /* ---- named artists, cluster two: the other two who carry four shapes ---- */
  'your favourite Gunna song',
  'the best Gunna verse',
  'the best guest verse Gunna ever did',
  'the best beat on any Gunna song',
  'your favourite Future song',
  'the best Future verse',
  'the best guest verse Future ever did',
  'the best beat on any Future song',

  /* ---- they pick the artist, for the reason in the header ---- */
  'your favourite song by an artist you have never mentioned to me',
  'the best song by the artist you have played most this year',
  'your favourite song by a band',
  'a song where the feature is better than the main artist',
  'your favourite song from a movie',

  /* ---- ONE PART of a song, so both answers are about the same thing ---- */
  'the best beat in any song',
  'the best hook in any song',
  'the best intro on any song',
  'your favourite song with a sample you can name',
  'your favourite cover that beats the original',
  'the best duet',
  'your favourite song under two minutes',
  'your favourite live version of a song',

  /* ---- a moment, but anchored to a superlative so the two picks still compare.
     "a song for walking home at 2am" is a mood; "the BEST song for walking home
     at 2am" is a question with one answer each. ---- */
  'the best song for a long drive',
  'the best song for the start of a night out',
  'the best song for walking home at 2am',
  'the best song for a rainy afternoon',
  'the best song to cook to',
  'the best song to fall asleep to',
  'the song you would be embarrassed to play out loud',
  'the song you would defend in an argument',

  /* ---- named artists, cluster three ---- */
  'your favourite Lil Wayne song',
  'your favourite Yeat song',
  'your favourite 21 Savage song',
  'your favourite Kodak Black song',
  'your favourite A$AP Ferg song',
  'your favourite BigXthaPlug song',
  'your favourite PARTYNEXTDOOR song',
  'your favourite Kanye song',
  'your favourite Young Thug song',
  'your favourite Lil Baby song',
  'your favourite Polo G song',
  'your favourite Rod Wave song',
  'your favourite Roddy Ricch song',
  'your favourite Don Toliver song',
  'your favourite Playboi Carti song',
  'your favourite Lil Uzi Vert song',
  'your favourite Kendrick Lamar song',
  'your favourite Bryson Tiller song',
  'your favourite Brent Faiyaz song',
  'your favourite SZA song',
  'the best song The Weeknd ever made',

  /* ---- named artists, cluster four: the ones who are not rappers. They were never
     candidates for the verse and beat shapes even before the trim, because a "best
     verse" prompt about a producer is a category error rather than a harder
     question. ---- */
  'your favourite Daniel Caesar song',
  'your favourite Joji song',
  'your favourite Calvin Harris song',
  'the best song The Chainsmokers ever made',
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
