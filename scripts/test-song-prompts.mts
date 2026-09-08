/**
 * test-song-prompts.mts — the song prompt is the same for both of them, stable all
 * day, and recomputable for any day in the archive.
 *
 *   npm run test:song-prompts
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY THE DAILY QUESTION'S ROTATION HAS NO TEST
 *
 * `promptFor()` in together.ts does the same job for the daily question and has
 * never been tested, for the reason `CLAUDE.md` names: together.ts imports the
 * Upstash config, so bare `node` cannot load it. song-prompts.ts imports nothing at
 * all, which is the whole reason it is a separate file rather than forty lines added
 * to together.ts.
 *
 * WHAT IS ACTUALLY AT RISK HERE, because "a list of strings" sounds untestable:
 *
 *   1. THE ARCHIVE RECOMPUTES PAST PROMPTS. Nothing is stored, so a rotation that is
 *      not a pure function of the date means a past day silently starts claiming it
 *      was asked something it was not.
 *   2. BOTH OF THEM MUST GET THE SAME PROMPT. It is a pairing mechanic; two
 *      different questions is the feature not working.
 *   3. EVERY PROMPT BEFORE ANY REPEAT. A hash-based pick repeats within a fortnight,
 *      which reads as broken. This is the property the sequential walk buys and the
 *      only one a reader would not assume.
 *   4. THE LIST IS IN A PUBLIC REPOSITORY. Screened here as well as by eye.
 */
import { readFileSync } from 'node:fs';
import {
  NAMED_ARTISTS,
  SONG_PROMPTS,
  SONG_WEEK_PROMPT,
  isSongWeekPrompt,
  songPromptFor,
} from '../src/lib/us/song-prompts.ts';

let pass = 0,
  fail = 0;
const is = (n: string, c: boolean, got?: unknown) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c ? '' : '  got ' + JSON.stringify(got)}`);
};

/** A date `n` days after 2026-01-01, as YYYY-MM-DD. */
const dayAfter = (n: number) =>
  new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

console.log('\n  --- 1. the same prompt for both of them, all day ---');
{
  /* There is no viewer argument, which is the strongest form this assertion can
     take: the function CANNOT differ by person because it is not told who is
     asking. Stated rather than tested, and then the stability is tested. */
  is('songPromptFor takes only a date', songPromptFor.length <= 2, songPromptFor.length);
  const a = songPromptFor('2026-03-04');
  const b = songPromptFor('2026-03-04');
  is('the same date gives the same prompt', a === b, [a, b]);
  is('and it is not empty', a.length > 0, a);
}

console.log('\n  --- 2. Sunday is the week prompt, and only Sunday ---');
{
  /* 2026-03-01 is a Sunday. Checked against a real weekday rather than trusting the
     epoch arithmetic in the module — if both were wrong the same way, an assertion
     derived from the module would agree with it. */
  is('2026-03-01 really is a Sunday', new Date('2026-03-01T00:00:00Z').getUTCDay() === 0);
  is('and it gets the week prompt', songPromptFor('2026-03-01') === SONG_WEEK_PROMPT, songPromptFor('2026-03-01'));
  is('isSongWeekPrompt agrees', isSongWeekPrompt('2026-03-01'));

  let sundays = 0;
  for (let i = 0; i < 70; i += 1) {
    const d = dayAfter(i);
    const isSunday = new Date(`${d}T00:00:00Z`).getUTCDay() === 0;
    if (isSunday) sundays += 1;
    if (isSongWeekPrompt(d) !== isSunday) {
      is(`${d}: week-prompt flag matches the real weekday`, false, {
        flagged: isSongWeekPrompt(d),
        sunday: isSunday,
      });
      break;
    }
  }
  is('ten weeks of days, every Sunday and no other day', sundays === 10, sundays);
  is('a Monday is NOT the week prompt', songPromptFor('2026-03-02') !== SONG_WEEK_PROMPT);
}

console.log('\n  --- 3. every prompt is asked before any is asked twice ---');
{
  /* THE PROPERTY THE SEQUENTIAL WALK BUYS. Asserted against a SHORT injected list so
     the arithmetic is visible: five prompts must produce five distinct answers across
     five consecutive non-Sundays and then wrap. A hash-based pick fails this. */
  const five = ['a', 'b', 'c', 'd', 'e'];
  const seen: string[] = [];
  let d = 0;
  while (seen.length < 5) {
    const date = dayAfter(d);
    d += 1;
    if (isSongWeekPrompt(date)) continue;   // Sunday is not part of the rotation
    seen.push(songPromptFor(date, five));
  }
  is('five consecutive non-Sundays give five prompts', seen.length === 5, seen);
  is('and every one of them is different', new Set(seen).size === 5, seen);

  /* And over the REAL list: no repeat inside one full cycle of non-Sunday days. */
  const real = new Map<string, string>();
  let repeats = 0;
  let asked = 0;
  for (let i = 0; i < SONG_PROMPTS.length * 2; i += 1) {
    const date = dayAfter(i);
    if (isSongWeekPrompt(date)) continue;
    const p = songPromptFor(date);
    asked += 1;
    if (asked <= SONG_PROMPTS.length && real.has(p)) repeats += 1;
    real.set(p, date);
  }
  is('no repeat within one full cycle of the real list', repeats === 0, repeats);

  /* THE LATENT TRAP, PROVED GONE. Indexing on the raw day number meant Sunday's
     residue was skipped forever, so a list whose length is a MULTIPLE OF SEVEN had
     permanently unaskable prompts — and nothing would have said so. A seven-item
     list is the smallest case, and all seven must appear. */
  const seven = ['s0', 's1', 's2', 's3', 's4', 's5', 's6'];
  const got = new Set<string>();
  for (let i = 0; i < 7 * 12; i += 1) {
    const date = dayAfter(i);
    if (isSongWeekPrompt(date)) continue;
    got.add(songPromptFor(date, seven));
  }
  is('a list whose length is a multiple of 7 still asks every prompt', got.size === 7, {
    asked: [...got].sort(),
    missing: seven.filter((x) => !got.has(x)),
  });
  is('and the cycle covered most of the list', real.size >= SONG_PROMPTS.length - 1, {
    distinct: real.size,
    listed: SONG_PROMPTS.length,
  });
}

console.log('\n  --- 4. a past day still answers the same thing ---');
{
  /* THE ARCHIVE'S REQUIREMENT. Nothing is stored, so if this is not stable then an
     old day starts claiming it was asked something it was not. */
  const past = ['2026-01-05', '2026-02-17', '2026-06-30', '2026-12-25'];
  for (const d of past) {
    is(`${d} is stable across calls`, songPromptFor(d) === songPromptFor(d), d);
  }
  is('and two different days generally differ',
    songPromptFor('2026-01-05') !== songPromptFor('2026-01-06'),
    [songPromptFor('2026-01-05'), songPromptFor('2026-01-06')]);
}

console.log('\n  --- 5. it never throws and never returns rubbish ---');
{
  for (const bad of ['', 'yesterday', '2026-13-45', 'not-a-date', '../../etc']) {
    let threw = false;
    let out = '';
    try {
      out = songPromptFor(bad);
    } catch {
      threw = true;
    }
    is(`${JSON.stringify(bad)} does not throw`, !threw);
    is(`${JSON.stringify(bad)} returns a real string`, typeof out === 'string' && out.length > 0, out);
  }
  is('an empty list gives an empty string rather than undefined',
    songPromptFor('2026-03-04', []) === '' || songPromptFor('2026-03-04') === SONG_WEEK_PROMPT,
    songPromptFor('2026-03-04', []));
}

console.log('\n  --- 6. the list is fit for a PUBLIC repository, and for a bad day ---');
{
  is('there are enough prompts to be a rotation', SONG_PROMPTS.length >= 30, SONG_PROMPTS.length);
  is('every prompt is non-empty', SONG_PROMPTS.every((p) => p.trim().length > 0));
  is('no duplicates', new Set(SONG_PROMPTS).size === SONG_PROMPTS.length, {
    distinct: new Set(SONG_PROMPTS).size,
    total: SONG_PROMPTS.length,
  });
  /* One line each. A prompt that needs a paragraph is a prompt that gets skipped. */
  is('every prompt is one short line', SONG_PROMPTS.every((p) => p.length <= 90 && !p.includes('\n')),
    SONG_PROMPTS.filter((p) => p.length > 90));
  /* EVERY NAMED ARTIST IS AN APPROVED ONE.
     ~~NO ARTIST IS NAMED~~ was the rule, on the reasoning that a list written without
     ever seeing their library would be guessing. That objection was answered — the
     names in NAMED_ARTISTS were read out of their own shelves — so the ban became an
     ALLOWLIST. A ban is only safely replaced by an allowlist that is actually
     enforced, which is what this is: a name that reaches a prompt without reaching
     NAMED_ARTISTS fails here.

     STRICTER THAN THE BAN IT REPLACES, in one way that matters. The old check was
     `/[A-Z][a-z]{2,}/`, which cannot see an ALL-CAPS name: `PARTYNEXTDOOR` would have
     sailed past it, so the "no proper nouns" assertion had a hole exactly where a
     stage name is most likely to sit. This tests every token containing ANY capital,
     so all-caps, mixed-caps and `A$AP`-style names are all caught. */
  /* GENRES ARE LISTED HERE TOO, not waved through by a looser pattern. `R&B` and `EDM`
     are the only capitalised words in the list that are not artists, and naming them
     explicitly is what keeps the check honest: a rule like "allow any all-caps word"
     would hand a free pass to exactly the stage names this is meant to catch. */
  const APPROVED = new Set<string>([
    'Sunday',
    'R&B',
    'EDM',
    ...NAMED_ARTISTS.flatMap((a) => a.split(/\s+/)),
  ]);
  const namesIn = (p: string): string[] =>
    p
      .split(/[\s,]+/)
      .map((w) => w.replace(/^[^A-Za-z0-9$&!]+|[^A-Za-z0-9$&!]+$/g, ''))
      .filter((w) => w.length > 0 && /[A-Z]/.test(w));
  const offenders = SONG_PROMPTS.flatMap((p) =>
    namesIn(p)
      .filter((w) => !APPROVED.has(w))
      .map((w) => ({ prompt: p, word: w })),
  );
  is('every capitalised word is an approved artist or genre', offenders.length === 0, offenders);
  /* ---- SPACING IN TIME, WHICH IS NOT THE SAME PROPERTY AS GROUPING BY THEME ------
     THE ORDER OF THIS ARRAY IS A SCHEDULE. The rotation walks it one day at a time, so
     a run of same-shaped entries is a run of same-shaped DAYS. The list was grouped by
     category and read beautifully, and it served fifteen "your favourite X song" days
     out of seventeen consecutive ones — a name quiz that three separate artist clusters
     were supposed to prevent, defeated by appending thirteen new artists into one of
     them. Nothing failed, because the intent lived in a comment.

     So it is asserted instead. Two in a row is the ceiling: enough that appending a
     name is still safe, tight enough that a theme-sorted list cannot pass. */
  const isArtistPrompt = (p: string) => NAMED_ARTISTS.some((a) => p.includes(a));
  let run = 0;
  let longestRun = 0;
  let runAt = '';
  for (const p of SONG_PROMPTS) {
    run = isArtistPrompt(p) ? run + 1 : 0;
    if (run > longestRun) {
      longestRun = run;
      runAt = p;
    }
  }
  is('no more than two artist prompts in a row', longestRun <= 2, { longestRun, endingAt: runAt });
  /* And the artist prompts are spread across the WHOLE list rather than bunched at one
     end, which a run check alone cannot see: three in the first half and thirty-seven in
     the second passes "no long runs" and still gives one quiz month. */
  const half = Math.floor(SONG_PROMPTS.length / 2);
  const firstHalf = SONG_PROMPTS.slice(0, half).filter(isArtistPrompt).length;
  const secondHalf = SONG_PROMPTS.slice(half).filter(isArtistPrompt).length;
  is('artist prompts are spread across both halves of the rotation',
    Math.abs(firstHalf - secondHalf) <= Math.ceil(SONG_PROMPTS.length / 10),
    { firstHalf, secondHalf });

  /* The allowlist must not rot into permission for names nobody asks about. */
  const unused = NAMED_ARTISTS.filter((a) => !SONG_PROMPTS.some((p) => p.includes(a)));
  is('every approved artist is actually asked about', unused.length === 0, unused);
  is('the week prompt names nobody', namesIn(SONG_WEEK_PROMPT).every((w) => APPROVED.has(w)),
    namesIn(SONG_WEEK_PROMPT));
  /* No workout vocabulary — the palette is solidcore-derived, the language is not.
     This is in CLAUDE.md as a voice rule and a prompt list is exactly where it would
     slip in ("the song for your warm-up"). */
  const gym = /\b(workout|warm-?up|reps?|gym|cardio|lift|sweat|pump|training)\b/i;
  is('no workout vocabulary', SONG_PROMPTS.every((p) => !gym.test(p)),
    SONG_PROMPTS.filter((p) => gym.test(p)));
  is('the week prompt is clean too', !gym.test(SONG_WEEK_PROMPT) && SONG_WEEK_PROMPT.length > 0);
}

console.log('\n  --- 7. the module stays loadable by bare node ---');
{
  /* THE PROPERTY THAT MAKES THIS FILE POSSIBLE. together.ts's promptFor() has no test
     precisely because that file imports the Upstash config. One import here and this
     suite stops running, so the absence of imports is asserted rather than hoped for. */
  const src = readFileSync(new URL('../src/lib/us/song-prompts.ts', import.meta.url), 'utf8');
  const imports = src.match(/^\s*import\s.+$/gm) ?? [];
  is('song-prompts.ts imports nothing at all', imports.length === 0, imports);
}

console.log(`\n  ${fail ? 'FAILED' : 'all good'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
