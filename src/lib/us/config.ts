/**
 * config.ts — every secret and every piece of gate content, in one place.
 *
 * ---------------------------------------------------------------------------
 * FAIL CLOSED
 *
 * The single most dangerous bug this wing could have is a gate that opens when
 * it is misconfigured. So `isConfigured()` is checked before any answer is
 * evaluated, and a missing secret makes the endpoint return 503 — never "pass".
 * There is deliberately no development bypass, no `if (DEV) return true`, and no
 * default secret. A default secret in a public repo is not a default, it is a
 * published password.
 * ---------------------------------------------------------------------------
 */

import { digest, digestsEqual } from './answers.mjs';
import { DEFAULT_QUESTIONS } from './questions.mjs';

/**
 * Read one environment variable.
 *
 * Bracket access on a VARIABLE, not `import.meta.env.US_FOO`, is deliberate:
 * Vite statically replaces the dotted form at build time, which would bake
 * whatever value existed during `astro build` into the bundle — on Vercel that
 * is the build container, where these secrets may not be present, so the
 * inlined value would be `undefined` forever. Bracket access forces a real
 * lookup at request time.
 */
function env(name: string): string | undefined {
  const fromMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromNode = typeof process !== 'undefined' ? process.env : undefined;
  const value = fromMeta?.[name] ?? fromNode?.[name];
  // Treat empty string as absent. Vercel's UI happily saves a blank value, and
  // an empty HMAC key must never be mistaken for a configured one.
  return value && value.length > 0 ? value : undefined;
}

export const ANSWER_PEPPER = () => env('US_ANSWER_PEPPER');
export const SESSION_SECRET = () => env('US_SESSION_SECRET');
export const ADMIN_PASSCODE_DIGEST = () => env('US_ADMIN_PASSCODE_DIGEST');

/**
 * Her name, for copy. Kept in an environment variable rather than the source
 * because the repo is public and her name is hers, not the internet's. The
 * fallback reads as intentional second person rather than a broken template,
 * so an unset variable degrades to prose instead of to "{{HER_NAME}}".
 */
export const HER_NAME = () => env('US_HER_NAME') ?? 'you';

/* ---------------------------------------------------------------------------
   PHASE 2 / 3 BACKING SERVICES

   Both are OPTIONAL by design. Every feature that depends on them must degrade
   to something demoable rather than crash, because the wing has to be
   developable and reviewable before either account exists. Check the has*()
   helper before use; never assume the credentials are there.
   --------------------------------------------------------------------------- */

/** Upstash Redis (REST). Storage for songs, reactions and the rate limiter. */
export function kvConfig() {
  return {
    url: env('UPSTASH_REDIS_REST_URL'),
    token: env('UPSTASH_REDIS_REST_TOKEN'),
  };
}
export function hasKV(): boolean {
  const { url, token } = kvConfig();
  return Boolean(url && token);
}

/**
 * Cloudflare R2, via the S3-compatible API.
 *
 * The bucket must stay PRIVATE — no public dev URL, no custom domain. The only
 * way a photo is ever reachable is a short-lived presigned URL minted by
 * /api/us/photo/[id] AFTER the session cookie has been verified. Attaching a
 * public domain to this bucket would silently undo the entire lock.
 */
export function r2Config() {
  return {
    accountId: env('R2_ACCOUNT_ID'),
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
    bucket: env('R2_BUCKET'),
  };
}
export function hasR2(): boolean {
  const c = r2Config();
  return Boolean(c.accountId && c.accessKeyId && c.secretAccessKey && c.bucket);
}

/** S3 endpoint for the account's R2. Null when unconfigured. */
export function r2Endpoint(): string | null {
  const { accountId } = r2Config();
  return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null;
}

/** True only when the gate can actually verify an answer. */
export function isConfigured(): boolean {
  return Boolean(ANSWER_PEPPER() && SESSION_SECRET() && loadAnswers().length > 0);
}

/* ---------------------------------------------------------------------------
   GATE REVIEW FLAG

   The failure mode this guards against is silent and entirely plausible: the
   setup answers get pushed to Vercel to "test the deploy", the real ones never
   replace them, and the wing sits in production looking locked while being
   trivially openable. Nothing about the running system would complain.

   THE FIRST VERSION OF THIS WAS ITSELF A VULNERABILITY. It detected the
   condition by holding the placeholder plaintexts in an array and re-deriving
   their digests with the live pepper. That works — but this file is committed to
   a PUBLIC repository, so it amounted to publishing the answer key next to the
   lock. An adversarial review caught it. Any check that recognises specific
   known answers must encode those answers, so there is no version of that idea
   that is safe here; the whole approach had to go.

   What replaced it needs no secret at all: an explicit acknowledgement. The
   author asserts, once, that the answers are not guessable. Absent that
   assertion the gate assumes they are and says so.

   This is strictly better than the digest check in one more way: no automated
   test could ever have detected the ACTUAL risk. An answer is not weak because it
   is a placeholder — it is weak because the portfolio a few directories over may
   already publish it. Only a human can judge "could a stranger derive this from
   something I have already put on the internet", so the check asks a human
   instead of pretending to know.

   Deliberately a WARNING, never a refusal. Failing closed here would brick the
   gate at exactly the moment it is misconfigured, which is the worst possible
   time to lock the author out of his own site.
   --------------------------------------------------------------------------- */

/**
 * Has the author confirmed the answers are not derivable from public sources?
 *
 * Set `US_GATE_REVIEWED=1` to assert it. `npm run gate:hash` asks the question
 * and writes the flag only on an explicit yes, so the default is "not reviewed"
 * and the reminder keeps appearing until someone actually decides.
 */
export function gateReviewed(): boolean {
  return env('US_GATE_REVIEWED') === '1';
}

let warnedOnce = false;

/**
 * True when the gate is live but nobody has confirmed the answers are private.
 * Logs once per process; the caller decides whether to surface it in the UI.
 */
export function gateNeedsReview(): boolean {
  // Nothing to warn about if the gate cannot open at all.
  if (!isConfigured()) return false;
  const needs = !gateReviewed();

  if (needs && !warnedOnce) {
    warnedOnce = true;
    console.error(
      '[us] ############################################################\n' +
        '[us] THE GATE ANSWERS HAVE NOT BEEN CONFIRMED AS PRIVATE.\n' +
        '[us] If they are still the setup answers, or anything a stranger\n' +
        '[us] could derive from the public portfolio, the wing only LOOKS\n' +
        '[us] locked. Run `npm run gate:hash` to replace them, then\n' +
        '[us] `npm run env:push -- --apply` and redeploy.\n' +
        '[us] Once they are genuinely private, set US_GATE_REVIEWED=1.\n' +
        '[us] ############################################################',
    );
  }
  return needs;
}

/** Names of whatever is missing — for a dev-only diagnostic, never shown in production. */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!ANSWER_PEPPER()) missing.push('US_ANSWER_PEPPER');
  if (!SESSION_SECRET()) missing.push('US_SESSION_SECRET');
  if (loadAnswers().length === 0) missing.push('US_ANSWERS');
  return missing;
}

function decodeBase64Json<T>(raw: string | undefined, label: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as T;
  } catch {
    // Loud, because a mangled paste is the likeliest real-world failure here and
    // it is otherwise indistinguishable from "not set yet".
    console.error(`[us] ${label} is set but is not valid base64-encoded JSON — ignoring it.`);
    return null;
  }
}

/**
 * Accepted answer digests, indexed by question.
 * Shape: `string[][]` — outer index is the question, inner list is every
 * accepted phrasing's digest. Produced by `npm run gate:hash`.
 */
export function loadAnswers(): string[][] {
  const parsed = decodeBase64Json<unknown>(env('US_ANSWERS'), 'US_ANSWERS');
  if (!Array.isArray(parsed)) return [];
  // Validate the shape rather than trusting it: this comes from a hand-paste,
  // and a half-pasted value must degrade to "not configured" (which fails
  // closed) instead of throwing deep inside the request handler.
  const ok = parsed.every((q) => Array.isArray(q) && q.every((d) => typeof d === 'string'));
  if (!ok) {
    console.error('[us] US_ANSWERS parsed but is not string[][] — ignoring it.');
    return [];
  }
  return parsed as string[][];
}

export interface Question {
  /** The question she reads. */
  prompt: string;
  /** Shown after wrong attempt 1, then 2. She can never be truly stuck. */
  hints: [string, string];
  /** Placeholder text; also a soft format cue ("a month", "a city"). */
  placeholder?: string;
}

/**
 * Questions come from ./questions.mjs so that `scripts/gate-hash.mjs` — which
 * runs under a bare `node` and cannot import TypeScript — walks the exact same
 * list in the exact same order when it asks me for the accepted answers.
 * US_QUESTIONS overrides the whole list when set.
 */
export function loadQuestions(): Question[] {
  const override = decodeBase64Json<Question[]>(env('US_QUESTIONS'), 'US_QUESTIONS');
  const questions = Array.isArray(override) && override.length > 0 ? override : DEFAULT_QUESTIONS;

  // The gate can only ever ask as many questions as it has answer digests for.
  // If they disagree, trust the digests: asking a question we cannot verify
  // would mean either a crash or — far worse — a question that always passes.
  const answers = loadAnswers();
  if (answers.length > 0 && answers.length !== questions.length) {
    console.error(
      `[us] ${questions.length} questions but ${answers.length} answer sets. ` +
        `Truncating to ${Math.min(questions.length, answers.length)}. Re-run gate:hash.`,
    );
    return questions.slice(0, answers.length);
  }
  return questions;
}

/** Verify my admin passcode. Same pepper, so a passcode is digested like an answer. */
export function checkAdminPasscode(raw: string): boolean {
  const pepper = ANSWER_PEPPER();
  const expected = ADMIN_PASSCODE_DIGEST();
  if (!pepper || !expected) return false;
  // Passcode is compared RAW (not normalized): it is mine, I will type it
  // exactly, and normalizing would throw away case and punctuation entropy
  // that is doing real work in a single-secret credential.
  //
  // digestsEqual, not `===`: this is the one credential a remote caller can
  // grind against, so the comparison is constant-time like every other one here.
  return digestsEqual(digest(pepper, raw), expected);
}

/** Public-facing question shape — hints are withheld until earned. */
export function publicQuestions(): Array<{ prompt: string; placeholder?: string }> {
  return loadQuestions().map(({ prompt, placeholder }) => ({ prompt, placeholder }));
}
