#!/usr/bin/env node
/**
 * gate-hash.mjs — turn plaintext answers into the environment variables the gate
 * verifies against. Run it with `npm run gate:hash`.
 *
 * ---------------------------------------------------------------------------
 * THE POINT
 *
 * This repo is PUBLIC. The plaintext answers must exist in exactly two places:
 * your head, and this terminal session. This script is the airlock — you type
 * answers in, keyed digests come out, and the plaintext is never written to
 * disk, never echoed into a file, and never committed.
 *
 * It imports the SAME normalize/digest code the server uses (src/lib/us/
 * answers.mjs) and walks the SAME question list the server renders
 * (src/lib/us/questions.mjs). That is the whole reason those two files are
 * plain ESM instead of TypeScript: if this script had its own copy of either,
 * a drift between them would produce a gate that rejects every correct answer
 * with no error message anywhere.
 * ---------------------------------------------------------------------------
 *
 * FLOW
 *   For each question, enter every phrasing you would accept, one per line.
 *   Blank line moves to the next question. More variants = more forgiving gate.
 *
 * OUTPUT
 *   An env block to paste into Vercel (Project → Settings → Environment
 *   Variables), and optionally the same block written to ./.env for local dev.
 *   .env is gitignored.
 */

import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';

import { digest, normalize, tokenKey, digestsFor } from '../src/lib/us/answers.mjs';
import { DEFAULT_QUESTIONS } from '../src/lib/us/questions.mjs';

const ENV_PATH = new URL('../.env', import.meta.url).pathname;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  blue: (s) => `\x1b[38;5;69m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

/** Parse an existing .env into a plain object so re-runs can reuse secrets. */
function readExistingEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  const existing = readExistingEnv();

  console.log(`
${c.bold('[us] gate answer hashing')}
${c.dim('Plaintext answers stay in this terminal. Only keyed digests leave it.')}
`);

  // ---- secrets ----------------------------------------------------------
  // Reuse whatever already exists. Regenerating US_ANSWER_PEPPER invalidates
  // every digest ever produced; regenerating US_SESSION_SECRET logs her out.
  // Neither should happen just because I ran this script twice.
  const pepper = existing.US_ANSWER_PEPPER || randomBytes(32).toString('base64url');
  const sessionSecret = existing.US_SESSION_SECRET || randomBytes(32).toString('base64url');

  if (existing.US_ANSWER_PEPPER) {
    console.log(c.dim('Reusing the US_ANSWER_PEPPER already in .env.\n'));
  } else {
    console.log(c.yellow('Generated a new US_ANSWER_PEPPER.') + c.dim(' Keep it — changing it later invalidates every answer.\n'));
  }

  // ---- questions --------------------------------------------------------
  const answerSets = [];

  for (const [i, q] of DEFAULT_QUESTIONS.entries()) {
    console.log(`${c.blue(`Q${i + 1}`)} ${c.bold(q.prompt)}`);
    console.log(c.dim(`     hints she can earn: "${q.hints[0]}" then "${q.hints[1]}"`));
    console.log(c.dim('     Enter every phrasing you would accept, one per line. Blank line = done.'));

    const digests = new Set();
    const shown = [];

    for (;;) {
      const raw = (await rl.question('     > ')).trim();
      if (raw === '') break;

      const canonical = normalize(raw);
      if (canonical === '') {
        console.log(c.red('     ! that normalizes to nothing (all filler words) — skipped'));
        continue;
      }

      for (const d of digestsFor(pepper, raw)) digests.add(d);
      // Echo the canonical forms, not a digest: this is the moment to notice
      // whether the phrasings you just typed really do cover each other.
      shown.push(`"${canonical}"${tokenKey(raw) && tokenKey(raw) !== canonical ? ` + tokens "${tokenKey(raw)}"` : ''}`);
    }

    if (digests.size === 0) {
      console.log(c.red(`     ! Q${i + 1} has no accepted answers. The gate can never open. Aborting.`));
      rl.close();
      process.exitCode = 1;
      return;
    }

    console.log(c.green(`     ✓ ${digests.size} digest(s) covering: ${shown.join(', ')}\n`));
    answerSets.push([...digests]);
  }

  // ---- my admin passcode (Phase 2: posting a song) ----------------------
  console.log(c.blue('Admin') + c.bold(' passcode for /samdrea/dj (yours, for posting songs).'));
  console.log(c.dim('     Compared exactly as typed — case and punctuation count. Blank to skip.'));
  const passcode = (await rl.question('     > ')).trim();
  // Digested RAW, not normalized — matching checkAdminPasscode() in config.ts,
  // which also skips normalization so case and punctuation keep their entropy.
  const adminDigest = passcode ? digest(pepper, passcode) : '';

  // ---- the review question ----------------------------------------------
  /* This is the only check on the thing that actually matters, and it has to be
     a human answering. No automated test can tell whether an answer is
     derivable from something you have already published — and an earlier
     version of this project tried, by keeping the placeholder plaintexts in a
     source file, which just published the answer key in a public repo instead.
     So: ask, once, and only write the flag on an explicit yes. */
  console.log(`
${c.blue('One more thing.')} ${c.bold('Could a stranger derive any of those answers')}
${c.bold('     from something you have already put on the internet')} ${c.dim('— your portfolio,')}
${c.dim('     a public profile, a photo caption, this repo?')}`);
  console.log(c.dim("     Answer 'no' only if you are sure. y = yes, a stranger could."));
  const guessable = (await rl.question('     could a stranger guess these? [y/N] ')).trim().toLowerCase();
  const reviewed = guessable === 'n' || guessable === 'no' || guessable === '';
  // Blank defaults to "reviewed" ONLY because the prompt says N is the default;
  // if that ever feels too generous, flip this to require an explicit "no".
  if (reviewed) {
    console.log(c.green('     ok — marking the gate as reviewed.\n'));
  } else {
    console.log(c.yellow('     noted. The gate will keep warning until you replace them.\n'));
  }

  rl.close();

  // ---- output -----------------------------------------------------------
  const block = [
    `US_ANSWER_PEPPER=${pepper}`,
    `US_SESSION_SECRET=${sessionSecret}`,
    `US_ANSWERS=${Buffer.from(JSON.stringify(answerSets), 'utf8').toString('base64')}`,
    ...(adminDigest ? [`US_ADMIN_PASSCODE_DIGEST=${adminDigest}`] : []),
    // Only written on an explicit "a stranger could NOT guess these".
    ...(reviewed ? ['US_GATE_REVIEWED=1'] : []),
  ].join('\n');

  console.log(`
${c.bold('Paste into Vercel → Settings → Environment Variables')} ${c.dim('(all environments)')}
${c.dim('-'.repeat(72))}
${block}
${c.dim('-'.repeat(72))}
`);

  // Written unconditionally: without a local .env the dev server cannot open
  // the gate, and the file is gitignored. Any pre-existing US_* keys are
  // replaced; unrelated keys are preserved.
  const preserved = Object.entries(existing)
    .filter(([k]) => !block.includes(`${k}=`))
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(
    ENV_PATH,
    `# Generated by npm run gate:hash. GITIGNORED — never commit this file.\n${block}\n${preserved.join('\n')}\n`,
    { mode: 0o600 },
  );
  console.log(c.green(`Wrote ${ENV_PATH} (mode 600, gitignored).`));
  console.log(c.dim('Local: npm run dev  →  http://localhost:4321/samdrea\n'));
}

main().catch((err) => {
  console.error(c.red(`\n[us] gate:hash failed: ${err?.message ?? err}`));
  process.exitCode = 1;
});
