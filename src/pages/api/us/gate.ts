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
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { isAccepted } from '../../../lib/us/answers.mjs';
import {
  ANSWER_PEPPER,
  SESSION_SECRET,
  isConfigured,
  loadAnswers,
  loadQuestions,
  missingConfig,
  gateNeedsReview,
} from '../../../lib/us/config';
import { TTL, clearCookie, readCookie, sign, verify, writeCookie } from '../../../lib/us/session';
import { clientKey, hit } from '../../../lib/us/ratelimit';

export const prerender = false;

/** Attempts per window, per IP. Generous for her, useless for a wordlist. */
const RATE_LIMIT = 12;
const RATE_WINDOW_SEC = 600;

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

export const POST: APIRoute = async ({ request, cookies, url, clientAddress }) => {
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
  const limit = await hit(`gate:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!limit.ok) {
    return json({ ok: false, error: 'rate', retryAfter: limit.retryAfter }, 429, {
      'Retry-After': String(limit.retryAfter),
    });
  }

  // ---- 3. Parse, defensively --------------------------------------------
  let step: number;
  let answer: string;
  try {
    const body = (await request.json()) as { step?: unknown; answer?: unknown };
    step = Number(body?.step);
    answer = typeof body?.answer === 'string' ? body.answer : '';
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  const questions = loadQuestions();
  const answers = loadAnswers();

  // Cap the answer length before hashing it. Unbounded input into an HMAC is a
  // free CPU-burn vector, and no real answer is 4KB.
  if (answer.length > 200) answer = answer.slice(0, 200);

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
    return json({ ok: true, done: false, next, solved });
  }

  const session = sign(secret, 'session', TTL.session);
  writeCookie(cookies, url, 'session', session, TTL.session);
  clearCookie(cookies, 'progress');

  return json({ ok: true, done: true, redirect: '/stronger/vault' });
};

/** Anything other than POST. Kept explicit so a stray GET is a 405, not a crash. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
