#!/usr/bin/env node
/**
 * env-push.mjs — copy the private wing's variables from .env into Vercel.
 *
 * Usage:
 *   node scripts/env-push.mjs           # DRY RUN: prints what it would do
 *   node scripts/env-push.mjs --apply   # actually writes to Vercel
 *
 * ---------------------------------------------------------------------------
 * WHY A DRY RUN BY DEFAULT
 *
 * This mutates a deployed project's configuration, and to overwrite a variable
 * it must first REMOVE the existing one. A script that silently deletes
 * production environment variables the moment you run it is a bad script, so
 * nothing happens without --apply.
 *
 * WHY REMOVE-THEN-ADD
 *
 * `vercel env add` refuses to overwrite an existing key. Rather than depend on
 * a --force flag whose behaviour varies by CLI version, this removes the key
 * (ignoring "not found") and adds it back. The window where the variable is
 * absent only affects builds started in that instant, and the gate FAILS CLOSED
 * on a missing secret — it will not accidentally open.
 *
 * WHY VALUES GO OVER STDIN
 *
 * `vercel env add NAME env` reads the value from stdin. Passing secrets as
 * command-line arguments would leak them into the process table and your shell
 * history; stdin does not.
 * ---------------------------------------------------------------------------
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const ENV_PATH = new URL('../.env', import.meta.url).pathname;
const APPLY = process.argv.includes('--apply');

/** The only keys this script is allowed to touch. */
const KEYS = [
  'US_ANSWER_PEPPER',
  'US_SESSION_SECRET',
  'US_ANSWERS',
  'US_QUESTIONS',
  'US_ADMIN_PASSCODE_DIGEST',
  'US_HER_NAME',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];

const TARGETS = ['production', 'preview', 'development'];

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

if (!existsSync(ENV_PATH)) {
  console.error(c.red('No .env found. Run `npm run gate:hash` first.'));
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);

const present = KEYS.filter((k) => env[k]);
const missing = KEYS.filter((k) => !env[k]);

// Not linked = every `vercel env` call would fail one by one with the same
// error. Check once, up front, and say the fix.
if (!existsSync(new URL('../.vercel/project.json', import.meta.url).pathname)) {
  console.error(c.red('\nThis directory is not linked to a Vercel project.'));
  console.error('Run ' + c.bold('vercel link') + ' first, then re-run this script.\n');
  process.exit(1);
}

console.log(`
${c.bold('Vercel env push')}  ${APPLY ? c.red('APPLY — this will write') : c.dim('dry run')}
${c.dim('-'.repeat(64))}`);

for (const k of present) {
  // Never print a secret. Length is enough to confirm the right thing is there.
  console.log(`  ${c.green('push')}  ${k.padEnd(26)} ${c.dim(`(${env[k].length} chars)`)}`);
}
for (const k of missing) {
  console.log(`  ${c.dim('skip')}  ${c.dim(k.padEnd(26))} ${c.dim('(not set locally)')}`);
}

if (!APPLY) {
  console.log(`
${c.yellow('Dry run — nothing was written.')}
Re-run with ${c.bold('--apply')} to push ${present.length} variable(s) to: ${TARGETS.join(', ')}.

${c.yellow('Before you apply:')} make sure US_ANSWERS holds your REAL answers.
If it still has the setup placeholders, run ${c.bold('npm run gate:hash')} first —
otherwise your production gate ships with guessable answers.
`);
  process.exit(0);
}

let failed = 0;

for (const key of present) {
  for (const target of TARGETS) {
    // Remove first; a missing key is not an error we care about.
    spawnSync('vercel', ['env', 'rm', key, target, '--yes'], { stdio: 'ignore' });

    const res = spawnSync('vercel', ['env', 'add', key, target], {
      input: env[key],
      stdio: ['pipe', 'ignore', 'pipe'],
      encoding: 'utf8',
    });

    if (res.status === 0) {
      console.log(`  ${c.green('ok')}    ${key} → ${target}`);
    } else {
      failed += 1;
      console.log(`  ${c.red('FAIL')}  ${key} → ${target}`);
      const err = (res.stderr || '').trim().split('\n').slice(-2).join(' ');
      if (err) console.log(`        ${c.dim(err)}`);
    }
  }
}

console.log(`
${failed === 0 ? c.green('Done.') : c.red(`Done with ${failed} failure(s).`)}
${c.dim('Environment variables only take effect on the NEXT deployment —')}
${c.dim('redeploy, or push a commit, before testing the live gate.')}
`);
process.exit(failed === 0 ? 0 : 1);
