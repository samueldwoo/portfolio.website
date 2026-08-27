/**
 * test-day-seal.mts — neither answer escapes until both are written, and the four
 * states the hub's archive renders are the four the seal can actually produce.
 *
 *   npm run test:day-seal
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * The seal is the most consequential rule in the wing and it had NO TEST. The R2
 * key had one, the rate limiter had one, the tracer's inability to print their
 * words had one, the day page's slot picks had one. The rule that neither of them
 * reads the other's answer until both have written was covered by reading it —
 * because it lived in the middle of together.ts, which imports the Upstash config
 * and the question list, so bare `node` could not load it.
 *
 * EVERY CASE RUNS FROM BOTH SIDES. A seal that leaks in one direction only is a
 * real bug and a one-viewer test cannot see it: with `who` hard-coded, swapping
 * `mine` and `theirs` in the implementation passes every assertion.
 *
 * NOTHING HERE TOUCHES R2 OR UPSTASH. day-seal.ts has no runtime imports at all.
 *
 * THE ANSWERS BELOW ARE INVENTED and obviously so. This repo is public and both of
 * them write real things into this feature; a fixture that reads like a real answer
 * is a real answer committed, which has nearly happened twice by reaching for
 * realism as a proxy for rigour. 'HER-ANSWER' is nobody's sentence.
 */
import { LATE_ANSWER_DAYS, emptyDay, sealDay, type DayRecord } from '../src/lib/us/day-seal.ts';

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const HER = 'HER-ANSWER';
const HIM = 'HIS-ANSWER';
const HER_AT = 1111111111111;
const HIM_AT = 2222222222222;

/** A record with whichever halves the case wants. Times are distinct so a swapped
 *  field is visible rather than coincidentally equal. */
const rec = (her: string, him: string): DayRecord => ({
  date: '2026-08-20',
  her,
  herAt: her ? HER_AT : 0,
  him,
  himAt: him ? HIM_AT : 0,
});

const seal = (r: DayRecord, who: 'her' | 'him', age: number) => sealDay(r, who, age, 'PROMPT');

console.log('\n  --- 1. THE SEAL: one side answered, the other has not ---');
{
  /* The case the whole feature rests on. Their words must not be in the object at
     all — not blanked on the way to the page, absent from it. */
  for (const [label, r, viewer] of [
    ['she wrote, he is reading', rec(HER, ''), 'him'],
    ['he wrote, she is reading', rec('', HIM), 'her'],
  ] as const) {
    const v = seal(r, viewer, 1);
    eq(`${label}: theirs is absent`, v.theirs, '');
    eq(`${label}: theirsAt is zeroed too`, v.theirsAt, 0);
    eq(`${label}: not revealed`, v.revealed, false);
    eq(`${label}: theyAnswered IS allowed out`, v.theyAnswered, true);
    eq(`${label}: my own half is empty`, v.mine, '');
    eq(`${label}: so I may still answer`, v.canAnswer, true);
  }
}

console.log('\n  --- 1b. and the timestamp cannot leak either ---');
{
  /* theirsAt alone would say WHEN they answered, which the sealed state is not
     entitled to say. It is a separate field and a separate chance to get wrong. */
  const v = seal(rec(HER, ''), 'him', 1);
  eq('her real timestamp is nowhere in the object', JSON.stringify(v).includes(String(HER_AT)), false);
  eq('nor is her answer', JSON.stringify(v).includes(HER), false);
}

console.log('\n  --- 2. BOTH ANSWERED: everything is released, both ways round ---');
{
  const asHer = seal(rec(HER, HIM), 'her', 1);
  eq('her view: mine is hers', asHer.mine, HER);
  eq('her view: theirs is his', asHer.theirs, HIM);
  eq('her view: mineAt is hers', asHer.mineAt, HER_AT);
  eq('her view: theirsAt is his', asHer.theirsAt, HIM_AT);
  eq('her view: revealed', asHer.revealed, true);

  const asHim = seal(rec(HER, HIM), 'him', 1);
  eq('his view: mine is his', asHim.mine, HIM);
  eq('his view: theirs is hers', asHim.theirs, HER);
  eq('his view: mineAt is his', asHim.mineAt, HIM_AT);
  eq('his view: theirsAt is hers', asHim.theirsAt, HER_AT);

  /* THE SIDES ARE NOT THE SAME OBJECT. If sealDay ignored `who`, every assertion
     above about a name would still pass while both of them read one view. */
  eq('the two views differ on mine', asHer.mine === asHim.mine, false);
  eq('the two views differ on theirs', asHer.theirs === asHim.theirs, false);
}

console.log('\n  --- 3. THE REVEAL FREEZES IT. Editing after is rewriting ---');
{
  eq('one side in, inside the window: editable', seal(rec(HER, ''), 'her', 1).editable, true);
  eq('revealed: NOT editable', seal(rec(HER, HIM), 'her', 1).editable, false);
  eq('revealed and old: still not editable', seal(rec(HER, HIM), 'her', 99).editable, false);
  eq('nothing written: not editable', seal(rec('', ''), 'her', 1).editable, false);
}

console.log('\n  --- 4. THE WINDOW, exactly at the boundary ---');
{
  /* Off-by-one here is a day silently un-answerable, so the boundary is asserted on
     both sides of itself rather than "somewhere past a week". */
  eq(`age ${LATE_ANSWER_DAYS} is still open`, seal(rec('', ''), 'her', LATE_ANSWER_DAYS).canAnswer, true);
  eq(`age ${LATE_ANSWER_DAYS} is not expired`, seal(rec('', ''), 'her', LATE_ANSWER_DAYS).expired, false);
  eq(`age ${LATE_ANSWER_DAYS + 1} is shut`, seal(rec('', ''), 'her', LATE_ANSWER_DAYS + 1).canAnswer, false);
  eq(`age ${LATE_ANSWER_DAYS + 1} is expired`, seal(rec('', ''), 'her', LATE_ANSWER_DAYS + 1).expired, true);
  eq('today is open', seal(rec('', ''), 'her', 0).canAnswer, true);
  /* A future date can only come from a hand-edited record. It should not be
     answer-blocked on top of being wrong. */
  eq('a future date is not expired', seal(rec('', ''), 'her', -3).expired, false);
  eq('a future date is answerable', seal(rec('', ''), 'her', -3).canAnswer, true);
}

console.log('\n  --- 4b. `closed` means *I* never answered, and nothing else ---');
{
  /* The distinction the hub got wrong: `closed` is false when MY answer is in, so
     it cannot carry "this day is over" on its own. That is `expired`. */
  eq('expired, mine absent: closed', seal(rec(HER, ''), 'him', 99).closed, true);
  eq('expired, mine present: NOT closed', seal(rec(HER, ''), 'her', 99).closed, false);
  eq('expired, mine present: IS expired', seal(rec(HER, ''), 'her', 99).expired, true);
  eq('the two flags are not the same fact',
    seal(rec(HER, ''), 'her', 99).closed === seal(rec(HER, ''), 'her', 99).expired, false);
}

console.log('\n  --- 5. THE FOUR STATES THE HUB ARCHIVE BRANCHES ON ---');
{
  /* index.astro picks its branch in this order: revealed → canAnswer → mine →
     else. These assert each state is reachable and that exactly one branch claims
     it, which is what the "it has closed" bug violated: a live one-sided day fell
     into the branch whose copy said the window had shut. */
  const branch = (v: ReturnType<typeof seal>) =>
    v.revealed ? 'pair' : v.canAnswer ? 'late-form' : v.mine ? 'mine-only' : 'gravestone';

  eq('both in            → the pair', branch(seal(rec(HER, HIM), 'her', 2)), 'pair');
  eq('neither, in window → the late form', branch(seal(rec('', ''), 'her', 2)), 'late-form');
  eq('theirs only, window→ the late form', branch(seal(rec('', HIM), 'her', 2)), 'late-form');
  eq('mine only, in window → mine-only', branch(seal(rec(HER, ''), 'her', 2)), 'mine-only');
  eq('mine only, expired   → mine-only', branch(seal(rec(HER, ''), 'her', 99)), 'mine-only');
  eq('theirs only, expired → gravestone', branch(seal(rec('', HIM), 'her', 99)), 'gravestone');

  /* AND THE FIX. Both land in mine-only, and `expired` is the only thing that tells
     "still time" from "it has closed". Before this flag existed the branch said the
     day had closed in both rows below. */
  eq('mine-only in window is NOT expired', seal(rec(HER, ''), 'her', 2).expired, false);
  eq('mine-only in window IS still editable', seal(rec(HER, ''), 'her', 2).editable, true);
  eq('mine-only expired IS expired', seal(rec(HER, ''), 'her', 99).expired, true);
  eq('mine-only expired is not editable', seal(rec(HER, ''), 'her', 99).editable, false);
}

console.log('\n  --- 6. the hub filters out days with nothing to show ---');
{
  /* index.astro keeps a past day when `revealed || canAnswer || mine || theyAnswered`.
     An expired day nobody answered must be dropped, or the archive grows a headstone
     for every day either of them was simply busy. */
  const shown = (v: ReturnType<typeof seal>) => v.revealed || v.canAnswer || v.mine.length > 0 || v.theyAnswered;
  eq('expired and untouched: hidden', shown(seal(rec('', ''), 'her', 99)), false);
  eq('expired, theirs only: shown', shown(seal(rec('', HIM), 'her', 99)), true);
  eq('expired, mine only: shown', shown(seal(rec(HER, ''), 'her', 99)), true);
  eq('in window, untouched: shown', shown(seal(rec('', ''), 'her', 2)), true);
}

console.log('\n  --- 7. the prompt and age are the caller’s, passed through unchanged ---');
{
  /* day-seal.ts cannot derive either without the imports that would cost it this
     test, so the contract is that it does not try. */
  const v = sealDay(emptyDay('2026-01-02'), 'her', 4, 'A GIVEN PROMPT');
  eq('prompt is passed through', v.prompt, 'A GIVEN PROMPT');
  eq('age is passed through', v.age, 4);
  eq('date comes off the record', v.date, '2026-01-02');
  eq('emptyDay really is empty', v.mine + v.theirs, '');
}

console.log(`\n  ${fail ? 'FAILED' : 'all good'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
