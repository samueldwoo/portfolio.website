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
import { trace, timer, countCommands } from '../src/lib/us/trace.ts';
const lines: string[] = [];
const real = console.log;
console.log = (m: string) => { lines.push(String(m)); };
const P = (i: number) => lines[i] ?? '';

// what a real upload logs
trace('frame.post', { ok: true, who: 'her', ext: 'jpg', bytes: 629730, head: false, coords: true, limitMs: 41, readMs: 812, prepMs: 3, storeMs: 340, pushMs: 210, totalMs: 1406 });
// the things that must NEVER survive
trace('leak.attempt', {
  note: "A sentence standing in for something private, long enough to be refused outright.",
  place: 'A Street Name, Some District',
  lat: 48.839725,
  song: 'Bad Blood — Taylor Swift',
  secret: 'gQAAAAAAAjPVAAIgcDI1M2RiOTliNTFmMjQ0YTdhYTQ4YWQ2NjViZWUzMGRhMA',
  name: 'Aname',
  url: 'https://web.push.apple.com/QLMNOPabcdefgh12345',
  /* THE GATE'S TWO, and they are here because they are the case the shape filter is
     WEAKEST against: a real answer is a day of the week or a drink, so it is short and
     alphanumeric and passes SAFE outright, exactly as a first name does. Only the key
     allowlist stops them. Both values below are invented for this test — no answer and
     no passcode is written anywhere in this repository. */
  answer: 'notarealanswer',
  passcode: 'notarealpasscode',
});
trace('push.send', { event: 'song', to: 'him', devices: 1, dead: 0, ms: 240 });
// the four song.resolve outcomes, which were printing as lengths until `via` was allowed
trace('song.resolve', { ok: false, via: 'none', status: '404', ms: 120 });
trace('song.resolve', { ok: true, via: 'body', ms: 300 });
// a gate refusal, and a step index of -1 for "that was not a real question"
trace('gate.answer', { ok: false, step: -1, misses: 0, solved: 1, ms: 351 });
// the Upstash command count
countCommands('together', 35, 200, 44);
console.log = real;

let pass = 0, fail = 0;
const is = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); };

console.log('  --- what a real upload looks like in the log ---');
console.log('    ' + P(0));
console.log('  --- the leak attempt, after filtering ---');
console.log('    ' + P(1));
console.log('  --- a notification ---');
console.log('    ' + P(2));
console.log('  --- a shortlink that resolved from the interstitial body ---');
console.log('    ' + P(4));
console.log('  --- a rejected answer, and a hub render is thirty-five commands ---');
console.log('    ' + P(5));
console.log('    ' + P(6));
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
/* THE GATE'S TWO, asserted separately from the sentence cases because they are the ones
   the shape filter alone would have let through. A short lowercase word is
   indistinguishable from an outcome code by shape; the key is the only difference. */
is('a short ANSWER is absent',         !leak.includes('notarealanswer') && /answer=len:14/.test(leak));
is('a PASSCODE is absent',             !leak.includes('notarealpasscode') && /passcode=len:16/.test(leak));
/* `via` was missing from the allowlist, so all four song.resolve outcomes printed as
   lengths — and 'body' and 'none' are both four characters, so the field meant to say
   whether a paste worked printed the same thing either way. */
is('via survives verbatim',            P(3).includes('via=none') && P(4).includes('via=body'));
is('via no longer collides',           !P(3).includes('via=len:4') && !P(4).includes('via=len:4'));
is('a negative step renders',          P(5).includes('step=-1'));
// Field names, not a substring search — `op=gate.answer` contains the word "answer".
is('the gate line carries no answer',  !/(^| )(answer|hint|passcode|len:)/.test(P(5)));
is('a command count is countable',     P(6).includes('op=redis') && P(6).includes('kind=together') && P(6).includes('cmds=35'));
is('countCommands cannot throw',       (() => { try { countCommands('x', NaN, NaN, NaN); return true; } catch { return false; } })());
is('every line is one line',           lines.every(l => !l.includes('\n')));
is('trace never throws on junk',       (() => { try { trace('x', { a: NaN, b: Infinity, c: undefined, d: null, 'bad key!': 1 } as any); return true; } catch { return false; } })());
const t = timer();
is('timer returns a number',           typeof t.total() === 'number' && t.total() >= 0);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
