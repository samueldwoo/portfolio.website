/**
 * test-ratelimit.mts — the in-process bucket that caps /api/us/photo/[id].
 *
 *   npm run test:ratelimit
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * hitMemory() has been in the tree since the gate shipped and has never had a test,
 * because the interesting backend was always the Upstash one. hitLocal() makes it
 * load-bearing on its own: it is now the ONLY thing capping the photo endpoint, so
 * "the counter works" stopped being a detail of a fallback path.
 *
 * NOTHING HERE TOUCHES A NETWORK. hitLocal() reads no environment and calls no
 * fetch, so this runs identically with or without credentials configured — which is
 * the property that lets it be a test at all rather than something to try by hand.
 *
 * WHAT IS DELIBERATELY NOT COVERED: the opportunistic sweep above 5000 entries.
 * `buckets` is module-private with no size accessor, so asserting it would mean
 * exporting internals to prove a housekeeping detail. Left untested on purpose
 * rather than untested by accident.
 */
import { hitLocal } from '../src/lib/us/ratelimit.ts';

let pass = 0, fail = 0;
const is = (n: string, c: boolean, got?: unknown) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c ? '' : '  got ' + JSON.stringify(got)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Every case needs a bucket nothing else has touched, and the Map is process-wide
   and private. A counter in the key is simpler and more honest than exporting a
   reset: it guarantees isolation without giving production code a way to clear a
   limiter. */
let n = 0;
const freshKey = () => `test:${(n += 1)}`;

console.log('\n  --- it allows up to the limit and then stops ---');
{
  const k = freshKey();
  const first = hitLocal(k, 3, 60);
  is('the first attempt is allowed', first.ok === true, first);
  is('and reports the memory backend', first.backend === 'memory', first);
  is('retryAfter is 0 while allowed', first.retryAfter === 0, first);

  is('the second is allowed', hitLocal(k, 3, 60).ok === true);
  is('the third is allowed (the limit itself)', hitLocal(k, 3, 60).ok === true);

  const over = hitLocal(k, 3, 60);
  is('the fourth is refused', over.ok === false, over);
  is('and carries a positive retryAfter', over.retryAfter > 0, over);
  is('which is within the window', over.retryAfter <= 60, over);
  is('still the memory backend when refusing', over.backend === 'memory', over);
}

console.log('\n  --- a refusal keeps refusing, it does not reset itself ---');
{
  const k = freshKey();
  hitLocal(k, 1, 60);
  is('over the limit', hitLocal(k, 1, 60).ok === false);
  is('and again', hitLocal(k, 1, 60).ok === false);
  is('and again', hitLocal(k, 1, 60).ok === false);
}

console.log('\n  --- separate callers get separate buckets ---');
{
  const a = freshKey(), b = freshKey();
  hitLocal(a, 1, 60);
  is('exhausting one caller', hitLocal(a, 1, 60).ok === false);
  is('leaves the other untouched', hitLocal(b, 1, 60).ok === true);
  /* The real keys are `photo:<ip>` and `mark:<ip>`, so the same person hitting two
     endpoints must not share a counter. Prefixing is what buys that, and this is
     the assertion that says so. */
  const ip = `${freshKey()}-1.2.3.4`;
  hitLocal(`photo:${ip}`, 1, 60);
  is('and two endpoints for one IP are separate', hitLocal(`mark:${ip}`, 1, 60).ok === true);
}

console.log('\n  --- the window is FIXED, and it does expire ---');
{
  const k = freshKey();
  hitLocal(k, 2, 1);
  hitLocal(k, 2, 1);
  is('exhausted inside a one-second window', hitLocal(k, 2, 1).ok === false);

  /* Real elapsed time rather than a fake clock: hitMemory reads Date.now() directly
     and takes no injectable now, and threading one through production code to make a
     test tidier is a worse trade than waiting a second. */
  await sleep(1100);
  const after = hitLocal(k, 2, 1);
  is('allowed again once the window has passed', after.ok === true, after);

  /* THE FIXED-WINDOW PROPERTY, which the EXPIRE ... NX in the Upstash path exists to
     match. If hammering extended the window, a client that kept trying would never
     be let back in, including her on a shared address. */
  const j = freshKey();
  hitLocal(j, 1, 1);
  await sleep(600);
  is('a mid-window attempt is still refused', hitLocal(j, 1, 1).ok === false);
  await sleep(600);
  is('and the window still expires on its original schedule', hitLocal(j, 1, 1).ok === true);
}

console.log('\n  --- it is synchronous, which is a safety property ---');
{
  /* hit() returns a Promise, so a forgotten `await` yields an object whose `.ok` is
     undefined and `if (!limit.ok)` refuses EVERYTHING. hitLocal cannot be misused
     that way, and this asserts it rather than trusting the signature. */
  const r = hitLocal(freshKey(), 1, 60) as unknown as { then?: unknown };
  is('not a Promise', typeof r.then === 'undefined', r);
  is('and usable without await', hitLocal(freshKey(), 1, 60).ok === true);
}

console.log('\n  --- the ceiling the photo endpoint actually uses ---');
{
  /* 200 per 600s. A heavy board session is around thirty-two requests, so this must
     comfortably clear a real visit and still stop a loop. */
  const k = freshKey();
  let allowed = 0;
  for (let i = 0; i < 250; i += 1) if (hitLocal(k, 200, 600).ok) allowed += 1;
  is('exactly 200 of 250 attempts are allowed', allowed === 200, allowed);
  is('a heavy 32-request session is nowhere near it', 32 < 200);
}

console.log(`\n  ${fail ? 'FAILED' : 'all good'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
