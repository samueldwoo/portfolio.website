/**
 * test-recent.mts — the carry-forward rule shared by the photograph and song pages.
 *
 *   npm run test:recent
 *
 * The first case is the one that was reported twice: something posted in his evening,
 * after wing midnight has already rolled at 21:00 his time, looked at by her the next
 * morning. The `date` assertions matter more than they look — on the song page a
 * reaction is addressed to that date, and /api/us/react accepts whatever it is given.
 */
import { mostRecent, CARRY_DAYS } from '../src/lib/us/slots.ts';
const D = (date: string, his: unknown, hers: unknown) => ({ date, his, hers }) as any;
let pass = 0, fail = 0;
const is = (n: string, c: boolean, got?: unknown) => { c ? pass++ : fail++; console.log(`  ${c?'ok  ':'FAIL'} ${n}${c?'':'  got '+JSON.stringify(got)}`); };
console.log(`  CARRY_DAYS=${CARRY_DAYS}`);
console.log('\n  --- his evening post, she looks next morning (the reported case) ---');
{
  const days = [D('2026-08-25', null, null), D('2026-08-24', 'hisSong', null)];
  const h = mostRecent<string>(days, 'his');
  is('his song is found', h.value === 'hisSong', h);
  is('and it is marked carried', h.carried === true, h);
  is('with YESTERDAY’s date, not today', h.date === '2026-08-24', h);
  const s = mostRecent<string>(days, 'hers');
  is('her side is empty', s.value === null && s.date === null, s);
  is('an empty side is never "carried"', s.carried === false, s);
}
console.log('\n  --- posting today replaces the carried one ---');
{
  const days = [D('2026-08-25', 'today', null), D('2026-08-24', 'old', null)];
  const h = mostRecent<string>(days, 'his');
  is('today wins', h.value === 'today', h);
  is('not flagged carried', h.carried === false, h);
  is('date is today', h.date === '2026-08-25', h);
}
console.log('\n  --- the 2-day cap ---');
{
  const days = [D('2026-08-25', null, null), D('2026-08-24', null, null), D('2026-08-23', 'stale', null)];
  const h = mostRecent<string>(days, 'his');
  is('3 days back is NOT promoted', h.value === null, h);
  is('and has no date to address a reaction to', h.date === null, h);
}
console.log('\n  --- the sides are independent ---');
{
  const days = [D('2026-08-25', null, 'hersToday'), D('2026-08-24', 'hisYesterday', 'hersOld')];
  const h = mostRecent<string>(days, 'his');
  const s = mostRecent<string>(days, 'hers');
  is('his carried from yesterday', h.value === 'hisYesterday' && h.date === '2026-08-24', h);
  is('hers is today', s.value === 'hersToday' && s.date === '2026-08-25', s);
  is('only his is flagged carried', h.carried && !s.carried, [h.carried, s.carried]);
}
console.log('\n  --- degenerate ---');
is('empty window', mostRecent<string>([], 'his').value === null);
is('single empty day', mostRecent<string>([D('2026-08-25', null, null)], 'his').date === null);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
