/**
 * test-who-words.mts — the reader is always 'you', and the other one always has
 * a name.
 *
 *   npm run test:who-words
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * Four pages had each grown their own answer to "what do we call the two of
 * them", and they disagreed: day.astro and today.astro used her name, the hub's
 * questions block used 'she', and presenceLine() used 'he'. Nothing crashed —
 * the words were just cold on the one block where the two of them talk to each
 * other, and nobody could see the disagreement without reading three files.
 *
 * So the rule lives in one module, and this asserts the property that matters:
 * FOR EVERY READER AND EVERY SUBJECT, run the same table twice from opposite
 * sides. The bug class is a label that reads correctly from one side and names
 * the wrong person from the other, and a test that only checks one viewer is
 * structurally unable to catch it.
 *
 * NOTHING HERE TOUCHES R2 OR UPSTASH. who-words.ts is pure and its only import
 * is a type, which is why bare node can load it at all.
 *
 * THE NAME BELOW IS INVENTED. This repo is public and her real name lives in
 * US_HER_NAME for that reason. A fixture that mirrors production is a copy of
 * production, committed — which has nearly happened here twice, both times by
 * reaching for realism as a proxy for rigour. 'Wren' is nobody.
 */
import { whoWords, sentenceCase } from '../src/lib/us/who-words.ts';

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const NAME = 'Wren';

console.log('\n  --- 1. she is reading, and the name is set ---');
{
  const w = whoWords('her', NAME);
  eq('her own half is "you"', w.of('her'), 'you');
  eq('his half is his name', w.of('him'), 'Sam');
  eq('them resolves to him', w.them, 'Sam');
  eq('her own possessive', w.possessiveOf('her'), 'yours');
  eq('his possessive', w.possessiveOf('him'), 'Sam’s');
  eq('her own attributive', w.attributiveOf('her'), 'your');
  eq('his attributive', w.attributiveOf('him'), 'Sam’s');
  eq('themPossessive', w.themPossessive, 'Sam’s');
  eq('themAttributive', w.themAttributive, 'Sam’s');
}

console.log('\n  --- 2. he is reading, and the name is set ---');
{
  const w = whoWords('him', NAME);
  eq('his own half is "you"', w.of('him'), 'you');
  eq('her half is her name', w.of('her'), NAME);
  eq('them resolves to her', w.them, NAME);
  eq('his own possessive', w.possessiveOf('him'), 'yours');
  eq('her possessive is the name', w.possessiveOf('her'), 'Wren’s');
  eq('his own attributive', w.attributiveOf('him'), 'your');
  eq('her attributive is the name', w.attributiveOf('her'), 'Wren’s');
  eq('themPossessive', w.themPossessive, 'Wren’s');
  eq('themAttributive', w.themAttributive, 'Wren’s');
}

console.log('\n  --- 2b. the apostrophe is the curly one, everywhere ---');
{
  /* A straight quote here would be invisible in review and wrong on the page next
     to every other possessive in the wing. Asserted rather than eyeballed because
     the two characters are one pixel apart in most editors. */
  const w = whoWords('him', NAME);
  eq('possessive has no straight quote', w.possessiveOf('her').includes("'"), false);
  eq('attributive has no straight quote', w.attributiveOf('her').includes("'"), false);
  eq("Sam's possessive too", whoWords('her', NAME).possessiveOf('him').includes("'"), false);
}

console.log('\n  --- 3. THE UNSET VARIABLE, which is the whole reason for the raw read ---');
{
  /* US_HER_NAME missing is a real state, not a hypothetical: Vite bakes env vars
     into the build, so one that misses a deploy is absent until the next one. The
     old code read HER_NAME(), whose fallback is 'you' — so this case labelled HER
     half of the page "you" on HIS screen. */
  const w = whoWords('him', undefined);
  eq('her subject form falls back to a pronoun', w.of('her'), 'she');
  eq('and NEVER to "you"', w.of('her') === 'you', false);
  eq('his own half is still "you"', w.of('him'), 'you');
  eq('her independent possessive', w.possessiveOf('her'), 'hers');
  eq('her ATTRIBUTIVE possessive differs', w.attributiveOf('her'), 'her');
  eq('the two possessives are not the same word', w.possessiveOf('her') === w.attributiveOf('her'), false);
}

console.log('\n  --- 3b. an empty variable is treated as unset ---');
{
  /* Vercel's UI will happily save a blank value. config.ts's env() already maps ''
     to undefined, and this asserts the module does not depend on that having
     happened — a blank name would otherwise render as nothing at all. */
  const w = whoWords('him', '');
  eq('empty name behaves like undefined', w.of('her'), 'she');
  eq('empty name possessive', w.possessiveOf('her'), 'hers');
  eq('empty name attributive', w.attributiveOf('her'), 'her');
}

console.log('\n  --- 4. THE PROPERTY: no reader is ever told they are the other one ---');
{
  /* The bug class this module exists for. Run every combination and assert the
     only invariant that has to hold: 'you' appears for the reader and for nobody
     else. One viewer alone cannot catch a flipped label. */
  for (const name of [NAME, undefined] as const) {
    for (const viewer of ['her', 'him'] as const) {
      const w = whoWords(viewer, name);
      for (const subject of ['her', 'him'] as const) {
        const mine = subject === viewer;
        eq(
          `viewer=${viewer} name=${name ? 'set' : 'unset'} subject=${subject} → ${mine ? 'you' : 'not you'}`,
          w.of(subject) === 'you',
          mine,
        );
      }
    }
  }
}

console.log('\n  --- 5. the two sides never see the same word for one person ---');
{
  /* "she said" on his screen and "you said" on hers are the SAME record. If a
     future edit made of() ignore the viewer, every assertion above about a name
     would still pass while both of them read the same label. */
  for (const name of [NAME, undefined] as const) {
    const hers = whoWords('her', name);
    const his = whoWords('him', name);
    eq(`name=${name ? 'set' : 'unset'}: her record reads differently on the two screens`,
      hers.of('her') === his.of('her'), false);
    eq(`name=${name ? 'set' : 'unset'}: his record reads differently on the two screens`,
      hers.of('him') === his.of('him'), false);
  }
}

console.log('\n  --- 6. sentenceCase, for the sites with no CSS uppercase over them ---');
{
  eq('a lowercase fallback is lifted', sentenceCase('she'), 'She');
  eq('a name is already capital and survives', sentenceCase(NAME), NAME);
  eq('"you" is lifted too', sentenceCase('you'), 'You');
  eq('empty string does not throw', sentenceCase(''), '');
  eq('the rest of the word is untouched', sentenceCase('mcgregor'), 'Mcgregor');
}

console.log(`\n  ${fail ? 'FAILED' : 'all good'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
