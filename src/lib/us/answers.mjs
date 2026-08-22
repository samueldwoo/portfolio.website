/**
 * answers.mjs — answer normalization and digesting.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS .mjs AND NOT .ts
 *
 * Two callers must agree on every byte of this logic:
 *
 *   1. `npm run gate:hash` (scripts/gate-hash.mjs) — run on my laptop, turns
 *      plaintext answers into digests I paste into Vercel.
 *   2. src/pages/api/gate.ts — runs on the server, turns HER typed answer into
 *      a digest and compares.
 *
 * If those two normalize differently by even one character, every correct
 * answer is rejected and the failure is completely silent — there is no error,
 * the gate just never opens. So there is exactly ONE implementation, in plain
 * ESM that both a bare `node` script and Astro/Vite can import. Do not
 * reimplement any of this anywhere else, and do not change a rule here without
 * re-running `gate:hash` and re-pasting US_ANSWERS.
 * ---------------------------------------------------------------------------
 *
 * THE MATCHING MODEL
 *
 * The repo is public, so no plaintext answer may exist in it. That rules out
 * fuzzy matching: you cannot compute an edit distance against a hash. So
 * "generous" is achieved a different way — every answer is reduced to TWO
 * canonical forms, and I hash every phrasing I would accept:
 *
 *   normalize()  "It was Tuesdays!"        -> "it was tuesdays"
 *   tokenKey()   "the blue door, on 5th"   -> "5th blue door"
 *
 * tokenKey drops filler words and sorts what is left, so word order and
 * connective tissue stop mattering — "blue door 5th" and "the blue door on 5th"
 * collapse to one digest. Between them, these two forms absorb the
 * realistic ways someone retypes the same answer: capitals, trailing
 * punctuation, accents, doubled spaces, "the"/"a", reordering.
 *
 * What they deliberately do NOT absorb is a typo ("bleu" for "blue") or a genuinely
 * different answer. Typos are handled at the UX layer instead — escalating
 * hints and unlimited retries — because that is a product problem, not a
 * crypto one.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Filler dropped by tokenKey(). Kept deliberately small: every word removed
 * here is a word that can no longer distinguish two answers, so this is a
 * security/usability trade, not a "more is better" list. Nothing here can be
 * the whole of a plausible answer.
 */
export const STOPWORDS = new Set([
  'a', 'an', 'the',
  'and', 'or', 'but', 'so',
  'of', 'in', 'on', 'at', 'to', 'for', 'from', 'with', 'by', 'into', 'over',
  'is', 'was', 'were', 'be', 'been', 'am', 'are',
  'it', 'its', 'this', 'that', 'these', 'those', 'there',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your',
  'he', 'she', 'they', 'them', 'his', 'her', 'their',
  'do', 'did', 'does', 'had', 'has', 'have',
]);

/**
 * Case-, accent- and punctuation-insensitive canonical form.
 *
 * NFKD then stripping U+0300–U+036F is what makes "café" and "cafe" the same
 * answer: NFKD splits an accented character into base + combining mark, and
 * that range is the combining marks. Doing it the other way round (stripping
 * first) would not work, because a precomposed "é" contains no combining mark
 * to strip.
 *
 * Punctuation becomes a SPACE rather than being deleted, so "one-thirty" and
 * "one thirty" agree instead of producing "onethirty" vs "one thirty".
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalize(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    // \p{M} (all Unicode combining marks) rather than a literal
    // [U+0300-U+036F] class: the escape keeps this file pure ASCII, so no
    // editor, terminal or copy-paste can mangle it, and it covers marks
    // outside the Latin block too. A silent change here breaks every answer.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Order- and filler-insensitive canonical form: significant tokens, sorted.
 *
 * Returns '' when the answer is nothing but stopwords, and callers MUST skip
 * empty forms — otherwise every all-filler input ("the a of") would hash to
 * the same value and match each other.
 *
 * @param {string} raw
 * @returns {string}
 */
export function tokenKey(raw) {
  const tokens = normalize(raw)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));

  // Deduplicate before sorting so "new york new york" === "new york".
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * Every canonical form a single piece of text should be credited with.
 * Empty forms are dropped here so no caller has to remember to.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function candidateForms(raw) {
  const forms = new Set([normalize(raw), tokenKey(raw)]);
  forms.delete('');
  return [...forms];
}

/**
 * Keyed digest of one canonical form.
 *
 * HMAC rather than a bare SHA-256 because the answer space is small and highly
 * guessable — first names, cities, months, days. A bare hash of any of them is
 * instantly reversible with a wordlist, and US_ANSWERS is one leaked
 * environment variable away from being public. The pepper means a leaked digest
 * list is inert on its own.
 *
 * @param {string} pepper  US_ANSWER_PEPPER
 * @param {string} form    output of normalize() or tokenKey()
 * @returns {string} lowercase hex
 */
export function digest(pepper, form) {
  return createHmac('sha256', pepper).update(form, 'utf8').digest('hex');
}

/**
 * Constant-time hex comparison.
 *
 * timingSafeEqual throws on length mismatch instead of returning false, which
 * would turn "wrong length" into an exception and a 500 — so the length check
 * is explicit. Both inputs are our own hex digests and always 64 chars, but
 * US_ANSWERS is hand-pasted and a truncated paste must fail closed, not crash.
 *
 * @param {string} a
 * @param {string} b
 */
export function digestsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Does `raw` match any accepted digest for this question?
 *
 * @param {string} raw               what she typed
 * @param {string[]} acceptedDigests digests for THIS question, from US_ANSWERS
 * @param {string} pepper            US_ANSWER_PEPPER
 * @returns {boolean}
 */
export function isAccepted(raw, acceptedDigests, pepper) {
  if (!Array.isArray(acceptedDigests) || acceptedDigests.length === 0) return false;

  // Every form is compared against every digest with no early `return true`,
  // so the work done is independent of WHERE the match is (or whether there is
  // one). Cheap here — a handful of HMACs — and it keeps the endpoint from
  // leaking "you were close on question 2" through response time.
  let hit = false;
  for (const form of candidateForms(raw)) {
    const d = digest(pepper, form);
    for (const accepted of acceptedDigests) {
      if (digestsEqual(d, accepted)) hit = true;
    }
  }
  return hit;
}

/**
 * All digests to store for one accepted phrasing. Used only by the CLI.
 *
 * @param {string} pepper
 * @param {string} plaintext
 * @returns {string[]}
 */
export function digestsFor(pepper, plaintext) {
  return candidateForms(plaintext).map((form) => digest(pepper, form));
}
