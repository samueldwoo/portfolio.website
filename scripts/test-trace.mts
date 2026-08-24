/**
 * test-trace.mts — proves the logger cannot print their private content.
 *
 *   npm run test:trace
 *
 * The case that matters is `leak.attempt`: it throws her note, a place name, a song
 * title, a store token, her NAME and a push endpoint at trace() and asserts none
 * of them survive. The name one is not hypothetical — an earlier version printed a
 * real first name verbatim, because a short alphanumeric name satisfies the shape
 * filter exactly as well as an outcome code does.
 */
import { trace, timer } from '../src/lib/us/trace.ts';
const lines: string[] = [];
const real = console.log;
console.log = (m: string) => { lines.push(String(m)); };
const P = (i: number) => lines[i] ?? '';

// what a real upload logs
trace('frame.post', { ok: true, who: 'her', ext: 'jpg', bytes: 629730, head: false, coords: true, readMs: 812, storeMs: 340, totalMs: 1190 });
// the things that must NEVER survive
trace('leak.attempt', {
  note: "A sentence standing in for something private, long enough to be refused outright.",
  place: 'A Street Name, Some District',
  lat: 48.839725,
  song: 'Bad Blood — Taylor Swift',
  secret: 'gQAAAAAAAjPVAAIgcDI1M2RiOTliNTFmMjQ0YTdhYTQ4YWQ2NjViZWUzMGRhMA',
  name: 'Aname',
  url: 'https://web.push.apple.com/QLMNOPabcdefgh12345',
});
trace('push.send', { event: 'song', to: 'him', devices: 1, dead: 0, ms: 240 });
console.log = real;

let pass = 0, fail = 0;
const is = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); };

console.log('  --- what a real upload looks like in the log ---');
console.log('    ' + P(0));
console.log('  --- the leak attempt, after filtering ---');
console.log('    ' + P(1));
console.log('  --- a notification ---');
console.log('    ' + P(2));
console.log('');

const leak = P(1);
is('a long sentence is absent',        !leak.includes('standing in') && !leak.includes('private'));
is('a place name is absent',           !leak.includes('Street Name') && !leak.includes('District'));
is('a song title is absent',           !leak.includes('Taylor') && !leak.includes('Bad Blood'));
is('a store token is absent',      !leak.includes('gQAAAAA'));
is('a short NAME is absent',           !leak.includes('Aname'));
is('a push endpoint URL is absent',    !leak.includes('apple.com') && !leak.includes('QLMNOP'));
is('refused strings become lengths',   /note=len:81/.test(leak));
is('a stray latitude is blunted to ~1km, not logged precisely', leak.includes('lat=48.84') && !leak.includes('48.839725'));
is('useful fields survive',            P(0).includes('bytes=629730') && P(0).includes('readMs=812'));
is('booleans render as 1/0',           P(0).includes('ok=1') && P(0).includes('head=0'));
is('safe enums survive',               P(2).includes('event=song') && P(2).includes('to=him'));
is('every line is one line',           lines.every(l => !l.includes('\n')));
is('trace never throws on junk',       (() => { try { trace('x', { a: NaN, b: Infinity, c: undefined, d: null, 'bad key!': 1 } as any); return true; } catch { return false; } })());
const t = timer();
is('timer returns a number',           typeof t.total() === 'number' && t.total() >= 0);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
