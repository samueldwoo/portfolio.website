/**
 * test-fresh.mts — when a photograph stops being shown.
 *
 *   npm run test:fresh
 *
 * The rule is 07:00 in the POSTER's own timezone, so each side expires on its own
 * author's morning. The DST cases are the reason this file exists: converting a local
 * wall time to an instant needs the offset that applies at that instant, which is the
 * value being solved for, and getting it wrong shifts an expiry by an hour twice a
 * year in each zone — on different dates, since the EU and US do not shift together.
 */
import { clearsAt, stillFresh, CLEAR_HOUR } from '../src/lib/us/fresh.ts';

const HER = 'Europe/Paris';
const HIM = 'America/Los_Angeles';
const fmt = (t: number, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
const hourIn = (t: number, tz: string) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(t))) % 24;

let pass = 0, fail = 0;
const is = (n: string, c: boolean, got?: unknown) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c ? '' : '  got ' + JSON.stringify(got)}`);
};

console.log(`  CLEAR_HOUR = ${CLEAR_HOUR}`);
console.log('\n  --- it always lands on 07:00 local, in every season ---');
for (const [label, iso] of [['midwinter', '2026-01-15T12:00:00Z'], ['midsummer', '2026-07-15T12:00:00Z'],
                            ['EU shift week', '2026-03-30T12:00:00Z'], ['US shift week', '2026-11-02T12:00:00Z']]) {
  for (const [who, tz] of [['her', HER], ['him', HIM]] as const) {
    const t = Date.parse(iso as string);
    const c = clearsAt(t, tz);
    is(`${label} / ${who}: clears at 07:00 local`, hourIn(c, tz) === 7, fmt(c, tz));
  }
}

console.log('\n  --- DST transition days, both zones, both directions ---');
// EU springs forward 29 Mar 2026, back 25 Oct 2026. US: 8 Mar 2026, 1 Nov 2026.
for (const [label, iso, tz] of [
  ['EU spring-forward eve', '2026-03-28T23:00:00Z', HER],
  ['EU fall-back eve',      '2026-10-24T23:00:00Z', HER],
  ['US spring-forward eve', '2026-03-07T23:00:00Z', HIM],
  ['US fall-back eve',      '2026-10-31T23:00:00Z', HIM],
] as const) {
  const t = Date.parse(iso);
  const c = clearsAt(t, tz);
  is(`${label}: still 07:00 local`, hourIn(c, tz) === 7, fmt(c, tz));
  is(`${label}: strictly in the future`, c > t, { posted: fmt(t, tz), clears: fmt(c, tz) });
  is(`${label}: within 25h`, c - t <= 25 * 3600e3, ((c - t) / 3600e3).toFixed(1) + 'h');
}

console.log('\n  --- posted before vs after 07:00 ---');
{
  // 02:00 Paris -> clears the SAME morning; 09:00 Paris -> clears the NEXT morning.
  const early = Date.parse('2026-06-10T00:00:00Z'); // 02:00 Paris
  const late  = Date.parse('2026-06-10T07:00:00Z'); // 09:00 Paris
  is('02:00 clears same morning (<6h)',  (clearsAt(early, HER) - early) / 3600e3 < 6, ((clearsAt(early,HER)-early)/3600e3).toFixed(1));
  is('09:00 clears next morning (>20h)', (clearsAt(late,  HER) - late)  / 3600e3 > 20, ((clearsAt(late,HER)-late)/3600e3).toFixed(1));
}

console.log('\n  --- the two real photographs ---');
{
  const her = 1787608945295, him = 1787629078562;
  const hc = clearsAt(her, HER), mc = clearsAt(him, HIM);
  is('hers clears 07:00 her time',  hourIn(hc, HER) === 7, fmt(hc, HER));
  is('and that is 22:00 his time',  hourIn(hc, HIM) === 22, fmt(hc, HIM));
  is('his clears 07:00 his time',   hourIn(mc, HIM) === 7,  fmt(mc, HIM));
  is('and that is 16:00 her time',  hourIn(mc, HER) === 16, fmt(mc, HER));
  is('she keeps his through her morning', mc - her > 0 && hourIn(mc, HER) > 12, fmt(mc, HER));
}

console.log('\n  --- stillFresh ---');
{
  const t = Date.parse('2026-06-10T00:00:00Z'); // 02:00 Paris
  const c = clearsAt(t, HER);
  is('fresh one minute before',  stillFresh(t, HER, c - 60_000) === true);
  is('gone at the boundary',     stillFresh(t, HER, c) === false);
  is('gone one minute after',    stillFresh(t, HER, c + 60_000) === false);
  is('atMs 0 is shown, not hidden', stillFresh(0, HER, Date.now()) === true);
  is('a future stamp is shown',  stillFresh(t + 3600e3, HER, t) === true);
}

console.log('\n  --- AN UNUSABLE TIMEZONE MUST NOT THROW ---');
{
  /* This was a live 500. kv.ts stores `tz: ''` for a record whose poster never told us
     a zone, which is exactly what the no-JavaScript form produces — it has no way to
     fill the hidden field. Intl.DateTimeFormat throws RangeError on '', clearsAt() called
     it unguarded, and today.astro's frontmatter took the whole song page down for BOTH
     of them. The call sites also guarded with `?? HER_TZ`, which does not catch ''.

     `true` is asserted deliberately, not just "does not throw": we cannot work out when
     an unknown zone clears, and that is no reason to make something somebody posted
     vanish. Same direction as the atMs-0 rule above. */
  const t = Date.parse('2026-06-10T00:00:00Z');
  const later = t + 40 * 3600e3; // well past any 07:00 boundary
  for (const bad of ['', '   ', 'Not/AZone', 'Europe/Paris ', 'UTC+2', 'null']) {
    let threw = false;
    let out: boolean | null = null;
    try {
      out = stillFresh(t, bad, later);
    } catch {
      threw = true;
    }
    is(`tz ${JSON.stringify(bad)} does not throw`, threw === false);
    is(`tz ${JSON.stringify(bad)} shows rather than hides`, out === true);
  }
  // And a real zone still expires, so the guard has not swallowed the whole feature.
  is('a VALID zone still clears', stillFresh(t, HER, later) === false);
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
