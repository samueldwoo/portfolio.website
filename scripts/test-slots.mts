/**
 * test-slots.mts — the day page's headline-frame rule.
 *
 *   npm run test:slots
 *
 * Runs on bare node via --experimental-strip-types, which is why slots.ts has no
 * runtime imports. The case that matters is the first one: he posts at 20:00 his
 * time, the wing day rolls at 21:00 his time, and she looks the next morning.
 * Before pickSlots existed she saw "Nothing from Sam yet today" and his photograph
 * was already a thumbnail in the strip.
 */
import { pickSlots, CARRY_DAYS } from '../src/lib/us/slots.ts';
const F = (n: string) => ({ ext: 'jpg', atMs: 1, note: n }) as any;
const D = (date: string, her: any, him: any) => ({ date, her, him }) as any;
let pass = 0, fail = 0;
const is = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
};

console.log(`  CARRY_DAYS = ${CARRY_DAYS}`);
console.log('\n  --- THE REPORTED BUG: he posts 8pm his time, she looks next morning ---');
{
  // wing rolled overnight; today has nothing, yesterday has his
  const week = [D('2026-08-22', null, null), D('2026-08-21', null, F('his 8pm')), D('2026-08-20', null, null)];
  const s = pickSlots(week, '2026-08-22', 'her');
  is('she sees his photo in the SLOT', s.theirs?.note, 'his 8pm');
  is('and it is labelled as carried forward', s.theirsFrom, '2026-08-21');
  is('her own slot is empty', s.mine, null);
  is('no day label on an empty slot', s.mineFrom, null);
  is('and it is NOT duplicated in the strip', s.earlier.length, 0);
}

console.log('\n  --- posting today replaces the carried-forward one ---');
{
  const week = [D('2026-08-22', null, F('his today')), D('2026-08-21', null, F('his 8pm'))];
  const s = pickSlots(week, '2026-08-22', 'her');
  is('slot shows today’s', s.theirs?.note, 'his today');
  is('no carry label once current', s.theirsFrom, null);
  is('the older one drops back to the strip', s.earlier.map((d: any) => d.him?.note), ['his 8pm']);
}

console.log('\n  --- the 2-day cap: 3 days stale must NOT headline ---');
{
  const week = [D('2026-08-22', null, null), D('2026-08-21', null, null), D('2026-08-20', null, F('old'))];
  const s = pickSlots(week, '2026-08-22', 'her');
  is('slot is honestly empty', s.theirs, null);
  is('but the photo is still in the strip, not deleted', s.earlier.map((d: any) => d.him?.note), ['old']);
}

console.log('\n  --- the row-dropping trap: he promoted from a day she also posted ---');
{
  const week = [D('2026-08-22', null, null), D('2026-08-21', F('hers y'), F('his y'))];
  const s = pickSlots(week, '2026-08-22', 'her');
  is('his is promoted', s.theirs?.note, 'his y');
  is('hers is promoted too (same row, both carried)', s.mine?.note, 'hers y');
  is('so the row is fully consumed and the strip is empty', s.earlier.length, 0);
}
console.log('\n  --- and the asymmetric version: only his is promoted ---');
{
  // she posted TODAY, so her yesterday frame is NOT promoted and must survive in the strip
  const week = [D('2026-08-22', F('hers today'), null), D('2026-08-21', F('hers y'), F('his y'))];
  const s = pickSlots(week, '2026-08-22', 'her');
  is('her slot is today’s', s.mine?.note, 'hers today');
  is('his slot is yesterday’s', s.theirs?.note, 'his y');
  is('her yesterday frame SURVIVES in the strip', s.earlier.map((d: any) => d.her?.note), ['hers y']);
  is('his was promoted so it is blanked there', s.earlier.map((d: any) => d.him), [null]);
}

console.log('\n  --- symmetry: the same window read by him ---');
{
  const week = [D('2026-08-22', null, null), D('2026-08-21', null, F('his 8pm'))];
  const h = pickSlots(week, '2026-08-22', 'him');
  is('his own photo is in HIS mine slot', h.mine?.note, 'his 8pm');
  is('labelled carried forward for him too', h.mineFrom, '2026-08-21');
  is('and her slot is empty', h.theirs, null);
}

console.log('\n  --- degenerate inputs ---');
is('empty window', pickSlots([], '2026-08-22', 'her').mine, null);
is('empty window strip', pickSlots([], '2026-08-22', 'her').earlier, []);
is('single empty day', pickSlots([D('2026-08-22', null, null)], '2026-08-22', 'her').theirs, null);
{
  const s = pickSlots([D('2026-08-22', F('h'), F('m'))], '2026-08-22', 'her');
  is('single full day, nothing to strip', s.earlier, []);
  is('both slots current', [s.mineFrom, s.theirsFrom], [null, null]);
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
