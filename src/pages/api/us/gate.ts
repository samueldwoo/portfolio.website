/**
 * POST /api/us/gate — the only place an answer is ever checked.
 *
 * ---------------------------------------------------------------------------
 * THE FLOW, AND WHY IT IS STATELESS
 *
 * She answers one question at a time, which is nicer than one big form but
 * raises an obvious hole: what stops a client from POSTing only the LAST
 * question and being let in? A signed `progress` token.
 *
 * Every correct answer returns a fresh progress token listing which question
 * indices have been solved. The session is minted only when that token — whose
 * signature we just verified — proves EVERY question is solved. The client
 * carries the state; the server trusts none of it without checking the HMAC.
 *
 * WHAT THIS ENDPOINT NEVER DOES
 *
 *   - Return an answer, or any transformation of one.
 *   - Say which question was wrong when several were submitted.
 *   - Behave differently for "no such question" vs "wrong answer" (both are a
 *     plain miss, so probing the question count tells you nothing).
 *   - Open when misconfigured. Missing secrets is a 503, never a pass.
 *   - Take a NAME. It accepts an optional passcode and DERIVES the name from it;
 *     `who` is never read from a request body anywhere in this wing.
 *
 * ---------------------------------------------------------------------------
 * THE OPTIONAL IDENTITY PROOF
 *
 * Passing the questions makes you HER, which is correct — the wing is for her.
 * Sam passes the same gate, so he arrived as her and had to correct it afterwards.
 * An optional `passcode` alongside the final answer lets him arrive as himself in
 * one pass: correct, and the endpoint mints identity and admin next to the session;
 * absent, and nothing below changes; present and wrong, and it mints NOTHING and
 * says so, because opening as her would be the exact silent mis-identification the
 * field exists to prevent. See step 6.
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { crossSite } from '../../../lib/us/together';
import { isAccepted } from '../../../lib/us/answers.mjs';
import {
  ADMIN_PASSCODE_DIGEST,
  ANSWER_PEPPER,
  SESSION_SECRET,
  checkAdminPasscode,
  isConfigured,
  loadAnswers,
  loadQuestions,
  missingConfig,
  gateNeedsReview,
} from '../../../lib/us/config';
import { TTL, clearCookie, readCookie, sign, verify, writeCookie } from '../../../lib/us/session';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import { timer, trace } from '../../../lib/us/trace';

export const prerender = false;

/** Attempts per window, per IP. Generous for her, useless for a wordlist. */
const RATE_LIMIT = 12;
const RATE_WINDOW_SEC = 600;

/**
 * The passcode's budget, and it is DELIBERATELY THE SAME BUCKET /api/us/admin USES.
 *
 * The gate now accepts an optional admin passcode (see step 6), which means there
 * are two doors a guess at that one secret can be posted through. Giving this one
 * its own counter would have handed an attacker 12 tries here PLUS 8 at
 * /api/us/admin — twenty guesses per ten minutes at a credential whose whole
 * defence is that it is only guessable, never derivable.
 *
 * One key (`admin:<ip>`, identical to admin.ts's) means the budget belongs to the
 * SECRET rather than to the endpoint, so opening a second door does not widen the
 * hole. The gate's own 12/600s still applies on top and is charged first, so a
 * wrong passcode costs an attempt on both counters and there is no free probe.
 *
 * She never touches this: the passcode is optional, absent from her request, and
 * this only runs when one was actually supplied.
 */
const PASSCODE_LIMIT = 8;
const PASSCODE_WINDOW_SEC = 600;

/**
 * Fixed pause on every REJECTED answer. Two jobs: it caps the practical guess
 * rate even if the rate limiter is degraded to its in-memory backend, and it
 * flattens any residual timing difference between rejection paths. Applied only
 * on failure, so a correct answer still feels instant.
 */
const REJECT_DELAY_MS = 350;

interface Progress {
  solved: number[];
  tries: number[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------------
   WHAT THIS ENDPOINT IS ALLOWED TO WRITE DOWN

   Failed attempts at the only door in the wing are security-relevant, and until now
   nothing recorded them: a wordlist that burned through the 12/600s limit produced
   exactly zero log lines, because a rate-limit trip returns a 429 and says nothing.
   "Has anybody tried?" was unanswerable, which for the wing's one authentication
   boundary is the wrong answer to be unable to give.

   SO THERE IS A LINE PER ATTEMPT, AND ITS FIELDS ARE PICKED BY SUBTRACTION. Not what
   would be useful — what cannot possibly be a credential:

     step      WHICH question, an index. The questions themselves are in
               questions.mjs, in this repository, and are not the secret.
     misses    HOW MANY times that question has been missed. A count, not a guess.
     ok        whether it was accepted.
     ms        how long the attempt took.

   AND EXPLICITLY NOT, none of these being oversights:

     the answer            obviously.
     its LENGTH            a wrong guess's length leaks nothing, but the same field on
                           an ACCEPTED attempt is the length of the real answer, which
                           is most of the way to a wordlist filter. One field cannot be
                           safe on one branch and not the other, so there is no field.
     any similarity score  a near-miss is the single most dangerous thing that could be
                           written here: "you were one character away" in a log file is
                           a guessing oracle for whoever can read logs.
     the passcode          not its value, not its length, not whether it was close.
                           `provedHim` is a boolean and that is the entire disclosure.

   `step` IS ALWAYS PRESENT AND IS -1 WHEN THE STEP WAS NOT A REAL QUESTION, so the
   line has a fixed shape. The header promises that "no such question" and "wrong
   answer" are indistinguishable from outside; a field that appears on one branch and
   not the other would make the two paths differ in the work they do, which is the
   thing REJECT_DELAY_MS exists to flatten. Cheaper to keep the shape constant than to
   reason about whether a shorter log line is measurable.
   --------------------------------------------------------------------------- */

export const POST: APIRoute = async ({ request, cookies, url, clientAddress }) => {
  const t = timer();
  // ---- 1. Fail closed on misconfiguration -------------------------------
  if (!isConfigured()) {
    const missing = missingConfig();
    console.error(`[us] gate called but not configured. Missing: ${missing.join(', ')}`);
    return json(
      {
        ok: false,
        error: 'unconfigured',
        // The names of missing variables are only useful to me and only leak
        // in development. In production this is a blank wall.
        ...(import.meta.env.DEV ? { missing } : {}),
      },
      503,
    );
  }

  // Emits a loud console.error the first time it is true. Vercel logs are the
  // only channel that reaches me once this is deployed. Memoized, so this is
  // free after the first call.
  gateNeedsReview();

  // ---- 2. Rate limit before doing any crypto ----------------------------
  /* CROSS-SITE, checked here because Astro's own checkOrigin is now OFF — see the
     long comment in astro.config.mjs. The short version: Astro compares the Origin
     header to the full origin and treats a MISSING Origin as cross-site, and iOS
     Safari does not send Origin on a same-origin form submission. That 403'd every
     plain form in the wing on her phone. crossSite() reads Sec-Fetch-Site first,
     compares HOST rather than full origin so a proxy hop cannot break it, and
     refuses only on a positive mismatch. */
  if (crossSite(request, url)) {
    trace('gate.answer', { ok: false, code: 'cross-site', ms: t.total() });
    return json({ ok: false, error: 'cross-site' }, 403);
  }

  const limit = await hit(`gate:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!limit.ok) {
    /* THE LINE THAT WAS MOST MISSING. Somebody exhausting twelve attempts in ten
       minutes is the only signal this wing gets that it is being guessed at, and it was
       going nowhere at all.

       `backend` is the reason this is not merely a counter. It says which limiter
       answered, and `failed-open` means Upstash was unreachable and the request was
       ALLOWED — the state in which the quiz is defended by nothing but the answers and
       a 350ms pause. That is worth being able to grep for after the fact, and it is
       invisible in every other record. */
    trace('gate.answer', {
      ok: false,
      code: 'rate',
      backend: limit.backend,
      retryAfter: limit.retryAfter,
      ms: t.total(),
    });
    return json({ ok: false, error: 'rate', retryAfter: limit.retryAfter }, 429, {
      'Retry-After': String(limit.retryAfter),
    });
  }

  // ---- 3. Parse, defensively --------------------------------------------
  let step: number;
  let answer: string;
  /* THE OPTIONAL IDENTITY PROOF. Empty for her, on every request she will ever
     make — the field that carries it is not even rendered unless the gate is asked
     for it (see /samdrea's `?me`). It is read here and evaluated in step 6, because
     it only means anything once the questions are actually done. */
  let passcode: string;
  try {
    const body = (await request.json()) as {
      step?: unknown;
      answer?: unknown;
      passcode?: unknown;
    };
    step = Number(body?.step);
    answer = typeof body?.answer === 'string' ? body.answer : '';
    passcode = typeof body?.passcode === 'string' ? body.passcode : '';
  } catch {
    /* A body that is not JSON. Her browser cannot produce this, so it is either a probe
       or a client bug, and both are worth one line. */
    trace('gate.answer', { ok: false, code: 'bad-request', ms: t.total() });
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  const questions = loadQuestions();
  const answers = loadAnswers();

  // Cap the answer length before hashing it. Unbounded input into an HMAC is a
  // free CPU-burn vector, and no real answer is 4KB.
  if (answer.length > 200) answer = answer.slice(0, 200);
  /* Same cap, same reason. NOT trimmed, unlike an answer: checkAdminPasscode
     compares raw so that case and punctuation still count, and silently eating a
     leading space would make a correct passcode fail with no clue why. */
  if (passcode.length > 200) passcode = passcode.slice(0, 200);

  const stepValid = Number.isInteger(step) && step >= 0 && step < questions.length;

  // ---- 4. Recover verified progress -------------------------------------
  const secret = SESSION_SECRET()!;
  const priorToken = readCookie(cookies, 'progress', url);
  const prior = verify(secret, 'progress', priorToken);
  const progress: Progress = {
    solved: Array.isArray(prior?.solved) ? prior!.solved.filter((n) => Number.isInteger(n)) : [],
    tries: [],
  };
  // `tries` rides along in the same signed token so the hint level cannot be
  // dialed up by a client that simply claims it has failed twice.
  progress.tries = Array.isArray(prior?.tries) ? prior!.tries.map((n) => Number(n) || 0) : [];

  // ---- 5. Check the answer ----------------------------------------------
  const accepted =
    stepValid && isAccepted(answer, answers[step] ?? [], ANSWER_PEPPER()!);

  if (!accepted) {
    await sleep(REJECT_DELAY_MS);

    // Count the miss against this step and hand back the next hint. An invalid
    // step number lands here too, and looks identical from outside.
    const tries = [...progress.tries];
    if (stepValid) tries[step] = (tries[step] ?? 0) + 1;

    // `solved` is the only field session-minting reads; `tries` is carried in
    // the same signed blob purely so it cannot be tampered with.
    const nextProgress = sign(secret, 'progress', TTL.progress, { solved: progress.solved, tries });
    writeCookie(cookies, url, 'progress', nextProgress, TTL.progress);

    const missCount = stepValid ? tries[step] : 0;
    const hints = stepValid ? questions[step].hints : ['', ''];
    const hint = missCount >= 2 ? hints[1] : missCount === 1 ? hints[0] : undefined;

    /* AFTER the sleep, so this cannot become the thing that distinguishes two rejection
       paths from each other by timing. The hint is NOT logged: it is question copy and
       therefore not secret, but it is also the one field here that varies with how close
       somebody is getting, and a log is the wrong place to start that habit. */
    trace('gate.answer', {
      ok: false,
      step: stepValid ? step : -1,
      misses: missCount,
      solved: progress.solved.length,
      ms: t.total(),
    });

    return json({ ok: false, misses: missCount, hint, giveUp: missCount >= 3 });
  }

  // ---- 6. Correct: record it, and mint a session if that was the last ----
  const solved = [...new Set([...progress.solved, step])].sort((a, b) => a - b);
  const complete = questions.every((_, i) => solved.includes(i));

  if (!complete) {
    const nextProgress = sign(secret, 'progress', TTL.progress, {
      solved,
      tries: progress.tries,
    });
    writeCookie(cookies, url, 'progress', nextProgress, TTL.progress);

    // The next unsolved question, so the client never has to guess the order.
    const next = questions.findIndex((_, i) => !solved.includes(i));
    trace('gate.answer', {
      ok: true,
      step,
      misses: progress.tries[step] ?? 0,
      solved: solved.length,
      done: false,
      ms: t.total(),
    });
    return json({ ok: true, done: false, next, solved });
  }

  /* ---------------------------------------------------------------------------
     THE OPTIONAL IDENTITY PROOF, CHECKED HERE AND NOWHERE ELSE.

     WHAT IT IS FOR. Everyone who answers the three questions is treated as HER,
     which is right — she is who the wing is for, and being her is the absence of a
     cookie rather than a claim. But Sam passes the same gate, so he landed as her
     and had to tap "not Andrea?" afterwards. That is one tap too many AND it is the
     window the stale-presence bug lived in: he browsed as her first, and the
     footprint he left in her slot was read back to him as her.

     So: an optional field. Supply the admin passcode and the gate mints identity in
     the same pass. Supply nothing and this whole block is skipped and the endpoint
     behaves exactly as it did before, byte for byte.

     WHY THIS IS NOT A SECOND CREDENTIAL. It is the SAME one — the passcode
     /api/us/admin has always taken, against the same US_ADMIN_PASSCODE_DIGEST, via
     the same constant-time digest comparison in config.ts. Nothing new was invented
     and there is nothing extra to rotate.

     AND `who` IS STILL NEVER READ FROM A BODY. This does not accept a name; it
     accepts a SECRET and derives the name from whether that secret verifies. The
     body cannot say "I am Sam" — it can only prove it. Every reader of identity
     still goes through identify(), which reads cookies and nothing else.
     --------------------------------------------------------------------------- */
  const provedHim = passcode.length > 0;

  if (provedHim) {
    // The name of the variable rather than "wrong passcode": being told you typed
    // it wrong for an hour when the real problem is an unset environment variable
    // is a genuinely bad afternoon. Same call admin.ts makes.
    if (!ADMIN_PASSCODE_DIGEST()) {
      console.error('[us] gate got a passcode but US_ADMIN_PASSCODE_DIGEST is missing.');
      trace('gate.answer', { ok: false, code: 'unconfigured', ms: t.total() });
      return json({ ok: false, error: 'passcode-unconfigured' }, 503);
    }

    /* SHARED BUDGET WITH /api/us/admin — see PASSCODE_LIMIT. Charged BEFORE the
       comparison, so a correct passcode costs an attempt too and the counter
       cannot be read as a hit/miss oracle. */
    const pass = await hit(
      `admin:${clientKey(request, clientAddress)}`,
      PASSCODE_LIMIT,
      PASSCODE_WINDOW_SEC,
    );
    if (!pass.ok) {
      /* A DIFFERENT COUNTER FROM THE ONE ABOVE, and the line says so. This is the shared
         `admin:<ip>` budget, so a trip here means the passcode specifically has been
         guessed at eight times in ten minutes through either door — a much sharper
         signal than the gate's own limit, which she could plausibly trip herself by
         mistyping a restaurant name. */
      trace('gate.passcode', {
        ok: false,
        code: 'rate',
        backend: pass.backend,
        retryAfter: pass.retryAfter,
        ms: t.total(),
      });
      return json({ ok: false, error: 'rate', retryAfter: pass.retryAfter }, 429, {
        'Retry-After': String(pass.retryAfter),
      });
    }

    if (!checkAdminPasscode(passcode)) {
      await sleep(REJECT_DELAY_MS);
      // Never the attempt itself. A near-miss in a log file is most of a credential
      // in a log file.
      console.warn('[us] gate passcode rejected — refusing to open as her instead.');
      /* The existing warning already says this happened; the line adds the timing and
         puts it in the same greppable stream as everything else, so counting rejections
         over a window does not mean parsing prose. Nothing about the attempt itself is
         on it — see the header block: not the value, not its length, not how close it
         was. `ok=0 code=bad-passcode` is the entire disclosure. */
      trace('gate.passcode', { ok: false, code: 'bad-passcode', ms: t.total() });

      /* NO SESSION IS MINTED, and that is the point of the feature rather than a
         side effect of it. Falling through to "well, you answered the questions, so
         you are Andrea" is EXACTLY the silent mis-identification this exists to
         end: he would land on the hub as her, browse, stamp her presence, and find
         out only by reading the footer.

         The solved answers are kept in the progress token so retrying costs one
         field and not three questions. `progress` is signed and lives 20 minutes,
         and minting still requires a correct answer on THIS request as well as a
         complete `solved` — so persisting it here grants nothing a correct final
         answer did not already grant. */
      const keep = sign(secret, 'progress', TTL.progress, { solved, tries: progress.tries });
      writeCookie(cookies, url, 'progress', keep, TTL.progress);

      return json({ ok: false, error: 'bad-passcode', done: false }, 401);
    }
  }

  const session = sign(secret, 'session', TTL.session);
  writeCookie(cookies, url, 'session', session, TTL.session);

  if (provedHim) {
    /* THE SAME THREE COOKIES /api/us/admin MINTS, WITH THE SAME THREE LIFETIMES,
       and the split is load-bearing rather than tidy — see Purpose in session.ts.
       12 hours to post, 30 days of access, 180 days of identity. They were one
       cookie once, and because the posting half expired first he silently became
       Andrea overnight and his photographs were filed as hers. */
    writeCookie(cookies, url, 'whoami', sign(secret, 'whoami', TTL.whoami), TTL.whoami);
    writeCookie(cookies, url, 'admin', sign(secret, 'admin', TTL.admin), TTL.admin);
  }

  clearCookie(cookies, 'progress');

  /* THE SESSION WAS MINTED, which is the single most important event in the wing and had
     no record of any kind. `who` is the honest answer to "who just got in": the passcode
     proves him, and its absence means her by construction rather than by claim — which
     is also exactly the ambiguity the optional field exists to remove, so the line is
     worth having for that reason alone. */
  trace('gate.answer', {
    ok: true,
    done: true,
    who: provedHim ? 'him' : 'her',
    solved: solved.length,
    ms: t.total(),
  });

  return json({ ok: true, done: true, redirect: '/samdrea/vault' });
};

/** Anything other than POST. Kept explicit so a stray GET is a 405, not a crash. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
