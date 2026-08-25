/**
 * test-frames-key.mts — the R2 key can no longer be overwritten, and the
 * photographs written before that was true still resolve to their own bytes.
 *
 *   npm run test:frames-key
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 *
 * On 2026-08-24 a local upload test destroyed the only copy of a real photograph,
 * because `frames/<date>/<who>.<ext>` is a pure function of the day and the person:
 * a second PUT for a day IS the first object, and R2 is unversioned. The fix puts
 * the upload's millisecond in the key. This file is the proof, and it is a unit
 * test on purpose — proving it by uploading is the thing that caused the incident.
 *
 * NOTHING HERE TOUCHES R2 OR UPSTASH. Every function under test is pure. There is
 * no client, no credential and no network, so running this cannot write a byte.
 * putFrame() is deliberately NOT exercised: it throws without R2 configured, and
 * configuring R2 to test it is precisely the mistake being guarded against.
 */
/* frame-keys.ts, NOT frames.ts — and that is the point of the split. frames.ts
   pulls in the R2 client and the Upstash config, so importing it here would mean a
   key test that loads a credential path. This module's only import is a type. */
import { frameKey, frameKeyAt, keyFromHash } from '../src/lib/us/frame-keys.ts';

let pass = 0, fail = 0;
const is = (n: string, c: boolean, got?: unknown) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c ? '' : '  got ' + JSON.stringify(got)}`);
};
const throws = (n: string, fn: () => unknown) => {
  try { const r = fn(); is(n, false, r); } catch { is(n, true); }
};

/* The real day. Her photograph from 2026-08-25 was written by the OLD code, so its
   hash carries an extension and a timestamp but no `herKey` — which is exactly the
   record shape case 1 is about. */
const DAY = '2026-08-25';
const LEGACY_HER = 'frames/2026-08-25/her.jpg';

/* Every FIELD a real pre-change record carries, with none of its values. What is
   being tested is that a fully populated hash still resolves to the legacy key and
   cannot accidentally satisfy the stored-key branch — and the field names alone do
   that. The values are deliberately invented.
   THIS FILE IS IN A PUBLIC REPOSITORY. A "realistic" fixture here would mean real
   coordinates and a real place label committed to it, which has nearly happened
   before in exactly this way: a genuine caption pasted as test data into the module
   whose job is keeping it out. None of these numbers point anywhere. */
const legacyHash = {
  herExt: 'jpg',
  herAt: '1756108080000',
  herNote: 'x'.repeat(24),
  herLat: '11.111',
  herLon: '22.222',
  herPlace: 'somewhere',
};

console.log('\n  --- 1. a record written before <who>Key still finds its own bytes ---');
{
  const k = keyFromHash(legacyHash, 'her', DAY, 'jpg');
  is('resolves to the legacy layout', k === LEGACY_HER, k);
  /* No millisecond suffix — checked on the FILENAME, because the date itself is
     full of hyphens and a naive `includes('-')` fails on `2026-08-25`. */
  is('no millisecond is invented from the other fields', !/\/her-\d+\.\w+$/.test(k), k);
  /* The load-bearing assertion in the whole file: byte-identical to what the code
     that uploaded it computed. If this drifts, three real photographs stop
     rendering and the page shows a signed URL for a 404 instead — withUrls() does
     not check existence, so nothing would raise. */
  is('byte-identical to what the old code built', k === frameKey(DAY, 'her', 'jpg'), k);
  is('his side too', keyFromHash({ himExt: 'png' }, 'him', DAY, 'png') === 'frames/2026-08-25/him.png');
}

console.log('\n  --- 2. a new upload cannot land on that photograph ---');
{
  const fresh = frameKeyAt(DAY, 'her', 'jpg', 1756200000000);
  is('the new key is not the legacy key', fresh !== LEGACY_HER, fresh);
  is('and it is not any legacy key', fresh !== frameKey(DAY, 'her', 'jpg'), fresh);
  is('it carries the millisecond', fresh === 'frames/2026-08-25/her-1756200000000.jpg', fresh);
  /* Two uploads on the same day by the same person — the swap. Before the fix these
     were one string; that identity is what "overwrote" meant. */
  const a = frameKeyAt(DAY, 'her', 'jpg', 1756200000000);
  const b = frameKeyAt(DAY, 'her', 'jpg', 1756200000001);
  is('two uploads a millisecond apart are two objects', a !== b, [a, b]);
  is('a re-post keeps its own key even with the same extension',
    frameKeyAt(DAY, 'her', 'webp', 1) !== frameKeyAt(DAY, 'her', 'webp', 2));
  is('the two people never share a key',
    frameKeyAt(DAY, 'her', 'jpg', 5) !== frameKeyAt(DAY, 'him', 'jpg', 5));
}

console.log('\n  --- 3. after a swap, the old photograph is still addressable ---');
{
  /* The pointer moves; the bytes do not. This is what makes the previous
     photograph recoverable rather than merely un-deleted — frames-export lists it
     as an orphan and downloads it. */
  const swapped = { herExt: 'jpg', herKey: 'frames/2026-08-25/her-1756200000000.jpg' };
  is('the record now points at the new object',
    keyFromHash(swapped, 'her', DAY, 'jpg') === 'frames/2026-08-25/her-1756200000000.jpg');
  is('and the superseded object still has a key that names it',
    frameKey(DAY, 'her', 'jpg') === LEGACY_HER);
}

console.log('\n  --- 4. a stored key is honoured only when it is well formed ---');
{
  const good = 'frames/2026-08-25/her-1756200000000.jpg';
  is('a well-formed stored key is used', keyFromHash({ herKey: good }, 'her', DAY, 'jpg') === good);
  is('a stored legacy-shaped key is also fine',
    keyFromHash({ herKey: LEGACY_HER }, 'her', DAY, 'jpg') === LEGACY_HER);
}

console.log('\n  --- 5. an untrusted stored key never escapes, it falls back ---');
{
  /* keyFromHash()'s result is handed to presignedUrl() and signed with the bucket
     credential, so a stored key used verbatim would be an arbitrary-object-read
     against a private bucket. Every one of these must resolve to the legacy key
     for the record actually being read, never to what the hash asked for. */
  const hostile = [
    ['traversal', 'frames/2026-08-25/../../.env'],
    ['dot-dot inside the name', 'frames/2026-08-25/her-1/../../../secret.jpg'],
    ['another day', 'frames/2026-08-01/her-1756200000000.jpg'],
    ['the other person', 'frames/2026-08-25/him-1756200000000.jpg'],
    ['another prefix entirely', 'secrets/database-dump.jpg'],
    ['an absolute URL', 'https://example.invalid/x.jpg'],
    ['a leading slash', '/frames/2026-08-25/her.jpg'],
    ['an extension we never write', 'frames/2026-08-25/her-1.svg'],
    ['a suffix too long to be a timestamp', 'frames/2026-08-25/her-999999999999999999.jpg'],
    ['a non-numeric suffix', 'frames/2026-08-25/her-abc.jpg'],
    ['a trailing newline', 'frames/2026-08-25/her.jpg\n'],
    ['empty-ish', '   '],
  ] as const;
  for (const [label, key] of hostile) {
    const got = keyFromHash({ herKey: key, herExt: 'jpg' }, 'her', DAY, 'jpg');
    is(`refuses ${label}`, got === LEGACY_HER, got);
  }
}

console.log('\n  --- 6. the builders refuse to make a key they cannot vouch for ---');
{
  throws('atMs 0 (which would be deterministic again)', () => frameKeyAt(DAY, 'her', 'jpg', 0));
  throws('a negative atMs', () => frameKeyAt(DAY, 'her', 'jpg', -1));
  throws('a fractional atMs', () => frameKeyAt(DAY, 'her', 'jpg', 1756200000000.5));
  throws('NaN', () => frameKeyAt(DAY, 'her', 'jpg', Number.NaN));
  throws('Infinity', () => frameKeyAt(DAY, 'her', 'jpg', Number.POSITIVE_INFINITY));
  throws('an atMs past the 13-digit bound', () => frameKeyAt(DAY, 'her', 'jpg', 10_000_000_000_000));
  throws('a non-date', () => frameKeyAt('yesterday', 'her', 'jpg', 1));
  throws('a traversal in the date', () => frameKeyAt('../../etc', 'her', 'jpg', 1));
  throws('a third person', () => frameKeyAt(DAY, 'them' as never, 'jpg', 1));
  throws('an extension we do not sniff', () => frameKeyAt(DAY, 'her', 'svg', 1));
  throws('the legacy builder still guards its date', () => frameKey('nope', 'her', 'jpg'));
}

console.log(`\n  ${fail ? 'FAILED' : 'all good'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
