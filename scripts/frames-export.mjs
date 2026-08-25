#!/usr/bin/env node
/**
 * frames-export.mjs — pull every `line 04` frame out of R2 and Upstash, onto a
 * disk you can hand to a print shop.
 *
 * Usage:
 *   node scripts/frames-export.mjs                    # DRY RUN: what it would fetch
 *   node scripts/frames-export.mjs --apply            # actually download
 *   node scripts/frames-export.mjs --apply --out=DIR  # somewhere other than ~/us-export
 *   node scripts/frames-export.mjs --apply --strip-location   # remove GPS on the way out
 *
 * ---------------------------------------------------------------------------
 * THIS SCRIPT IS READ-ONLY AGAINST BOTH STORES, AND THAT IS ENFORCED RATHER
 * THAN PROMISED.
 *
 * Every Redis command goes through redisRead(), which refuses any verb outside
 * an allowlist of HGETALL and SCAN — so a future edit cannot smuggle an HSET,
 * DEL or EXPIRE through it without deleting the guard first, which is a visible
 * act. Every R2 request goes through r2Head(), r2Get() or r2List(), each of
 * which hardcodes its method; there is no code path here that can emit a PUT or
 * a DELETE.
 *
 * The reason for the paranoia is not symmetry with the rest of the wing. It is
 * that this script exists to be run repeatedly, months apart, by somebody who
 * will not re-read it each time — and the data it touches is the only copy of
 * photographs of two people. A read-only tool that is read-only by CONSTRUCTION
 * can be re-run without re-auditing. One that is read-only by good intentions
 * cannot.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DEFAULT OUTPUT IS OUTSIDE THE REPOSITORY, AND WHY THERE IS NO FLAG
 * TO PUT IT BACK INSIDE
 *
 * THIS REPOSITORY IS PUBLIC. The bytes this script writes are private
 * photographs of two people, one of whom did not choose to have a GitHub
 * account involved, and the notes are things they wrote to each other. A single
 * `git add -A` in a directory containing this output is an unrecoverable
 * disclosure — you cannot un-publish a photograph.
 *
 * `.gitignore` is the usual answer and it is not good enough on its own. It is
 * one line that a future edit can drop, it does not cover a path somebody
 * passes with `--out=`, and `git add -f` overrides it. So the primary defence
 * here is not a rule about naming, it is REFUSAL: assertOutsideRepo() resolves
 * the output directory through symlinks and exits non-zero if it lands anywhere
 * inside the git worktree. There is deliberately no `--force`, no
 * `--i-know-what-im-doing`, and no environment variable to switch it off. The
 * feature "write private photographs into a public repository" does not exist.
 *
 * A `us-export/` line was still added to `.gitignore` in the same change, as a
 * second and independent layer: it catches the case where somebody copies the
 * finished folder into the repo by hand, or where a future version of this
 * script grows the flag this one refuses to have. Two layers, because the cost
 * of being wrong once is permanent.
 *
 * ---------------------------------------------------------------------------
 * WHY IT ENUMERATES WITH SCAN AND NOT BY WALKING BACK FROM TODAY
 *
 * getDays() in frames.ts builds its date list arithmetically — today, then
 * today-1, for seven days — because it is rendering a fixed window and knows
 * exactly which days it wants. Reusing that shape here would mean choosing a
 * number of days to walk back, and any number is a guess that silently drops
 * everything older than itself. An export that quietly omits March is worse
 * than one that fails.
 *
 * So the day list comes from the keyspace: `SCAN MATCH us:frame:*`. That is
 * O(keyspace) rather than O(window), which for this wing is a few hundred keys
 * and irrelevant. SCAN is also allowed to return the same key twice across
 * cursor iterations, so the results go into a Set — a duplicate would otherwise
 * become a duplicated manifest row.
 *
 * KEYS would work identically at this size. SCAN is used anyway because it is
 * the habit that survives the keyspace growing, and because it is cursored, so
 * it can never block the store the wing itself is reading from.
 *
 * ---------------------------------------------------------------------------
 * ORPHANS: R2 IS ALSO ENUMERATED, BECAUSE THE HASH IS NOT THE INDEX
 *
 * putFrame() in frames.ts writes bytes FIRST and metadata second, and its
 * header says why: a metadata write that fails after the bytes land leaves "an
 * orphaned object in R2 that nothing points at — invisible, harmless". That is
 * true for the page. It is false for an export, where an object nothing points
 * at is a photograph that would be silently left behind.
 *
 * So this also does a paginated ListObjectsV2 under `frames/` and reports any
 * object the hashes do not account for. Orphans ARE exported — the picture is
 * the point, and a missing caption is a smaller loss than a missing picture —
 * with `orphan: true` in the manifest. They do not fail the run; they are a
 * surprise to look at, not a broken invariant.
 *
 * SINCE KEYS BECAME UNIQUE, MOST ORPHANS ARE NOT SURPRISES AT ALL. R2 keys carry
 * the upload's millisecond (`frames/<date>/<who>-<atMs>.<ext>`), so posting a second
 * photograph on a day writes a new object and moves the pointer rather than
 * overwriting — which means the first one is still in the bucket and nothing
 * references it. Every swap makes an orphan by design, and those orphans are the
 * reason the 2026-08-24 data loss cannot repeat. This pass is what turns them from
 * "still present" into "actually recoverable", so it is now load-bearing rather
 * than a safety net.
 *
 * A superseded orphan DOES have a timestamp — it is in the key — and it exports as
 * `<date>/<who>-<atMs>.<ext>` so it cannot overwrite the current photograph's file.
 * Only pre-uniqueness objects still lack a timestamp.
 *
 * ---------------------------------------------------------------------------
 * THE TIMEZONE TRAP, WRITTEN OUT BECAUSE IT IS THE EASIEST THING HERE TO GET
 * SILENTLY WRONG
 *
 * THREE zones are in play and they are all different:
 *
 *   WING_TZ (America/New_York)  decides the DAY KEY. It is the folder name.
 *                               Neither of them lives there; see the section
 *                               header in together.ts. It is a calendar, not a
 *                               place.
 *   HER_TZ  (Europe/Paris)      the wall clock she actually posted at.
 *   HIS_TZ  (America/Los_Angeles)  the wall clock he actually posted at.
 *
 * The consequence that matters when sorting prints: THE WING DAY AND THE
 * POSTER'S OWN CALENDAR DATE CAN DISAGREE. She posts at 01:30 in Paris; that is
 * 19:30 the PREVIOUS day in New York, so the frame is filed under yesterday's
 * folder while her own phone said today. He posts at 22:00 in Los Angeles;
 * New York has already rolled over, so it files under tomorrow.
 *
 * A manifest that printed only one of those two dates would put photographs in
 * the wrong pile. So every row carries BOTH: `date` (the wing day, which is the
 * directory name) and `localDate` + `localTime` + `tz` (what the poster's own
 * clock read). When they differ, manifest.md says so on the line rather than
 * leaving it to be noticed.
 *
 * Times are assembled from Intl.formatToParts and not from a formatted string,
 * for the reason together.ts gives: separator, order and padding of a formatted
 * date are all locale decisions, and any of them changing would quietly produce
 * a wrong hour.
 *
 * ---------------------------------------------------------------------------
 * WHY THE THREE ZONE NAMES ARE PARSED OUT OF THE TYPESCRIPT INSTEAD OF COPIED
 *
 * together.ts says of HER_TZ: "when she moves back to the west coast ... That
 * is the only change needed: this one line." A copy of `'Europe/Paris'` in this
 * file would break that promise — the wing would move and the export would keep
 * labelling her photographs with a city she left, which is a wrong fact printed
 * on the back of a photograph rather than a crash.
 *
 * This script runs under bare `node`, so it cannot import the modules: frames.ts
 * imports './config' extensionless, which Node's ESM resolver rejects even with
 * --experimental-strip-types (that is why test-slots.mts can only test slots.ts,
 * the one file with no runtime imports). So the constants are read out of the
 * source with a regex.
 *
 * THAT IS A WEAK COUPLING AND IT IS TREATED AS ONE: if the regex does not match,
 * the script EXITS with the file and the constant it wanted. It never falls back
 * to a hardcoded guess, because a stale guess is the exact failure the parsing
 * exists to prevent. Refactor HER_TZ into a computed value and this script stops
 * working loudly, on the first run, with a message naming the file to fix.
 *
 * assertLayout() applies the same idea to the two shapes this file has to
 * duplicate outright — the R2 key template and the day-key prefix. It greps
 * frames.ts for the literal source text of both. If somebody re-lays-out the
 * bucket, this refuses to run rather than exporting nothing and reporting
 * success, which is the worst available outcome for a backup tool.
 *
 * ---------------------------------------------------------------------------
 * WHY A SKIP IS SAFE, AND WHAT STILL GETS RE-READ
 *
 * Resumability is the whole point: two frames a day means this will be run
 * against a growing store repeatedly between now and October, and re-downloading
 * every previous month each time is both slow and pointless.
 *
 * A file is skipped when it exists and its size matches R2's Content-Length.
 * Length alone is a weak equality — a file corrupted in place, or truncated and
 * re-padded, has the right length and the wrong bytes. So a skip is NOT a
 * no-op: the local file is re-read and hashed anyway, and its MD5 is compared
 * against R2's ETag, which for the single-part PUTs putFrame() makes IS the MD5
 * of the object. A silently rotted file therefore fails the run instead of
 * sitting in a manifest that claims it is fine.
 *
 * The re-read is local disk and the ETag comes from a HEAD that was happening
 * anyway, so the check costs nothing over the network. Where the ETag carries a
 * `-N` multipart suffix the comparison is impossible and is reported as
 * unchecked rather than assumed good.
 *
 * ---------------------------------------------------------------------------
 * WHY NOTE TEXT NEVER REACHES STDOUT
 *
 * env-push.mjs prints the LENGTH of each secret and never its value, because a
 * terminal is a place output gets copied out of — into a transcript, a bug
 * report, a screenshot pasted into a chat. The notes here are the same kind of
 * thing: they are two people's words to each other, and there is no reason a
 * progress log needs them. So the console shows a character count and the text
 * goes only into manifest.json / manifest.md, which live outside the repo.
 *
 * ---------------------------------------------------------------------------
 * --strip-location, AND WHY IT IS HERE RATHER THAN IN THE UPLOAD PATH
 *
 * Some frames reach R2 carrying GPS coordinates. The fix could have gone in the
 * upload endpoint; it deliberately did not.
 *
 * IT IS NOT A SECURITY PROBLEM. The bucket is private, every URL is presigned,
 * and the two people who can read the wing are a couple who already know where
 * each other live. Nobody learns anything from those coordinates that they did
 * not already know.
 *
 * IT IS A DATA-MINIMISATION PROBLEM, AND THE EXPOSURE IS ENTIRELY DOWNSTREAM.
 * This export folder is the one artefact in the whole system that is DESIGNED to
 * leave the owner's control — it goes to a print shop, or into a directory that
 * syncs to somebody's cloud. That is the moment the coordinates start to matter,
 * and it is therefore the right moment to drop them.
 *
 * Stripping at UPLOAD would destroy the data permanently, for every future use,
 * to solve a problem that only exists at the exit. Stripping at EXPORT is
 * reversible (the original is still in R2, one re-run away), opt-in, and applies
 * exactly where the risk is. That is why this flag exists and the upload path was
 * left alone.
 *
 * Worth knowing: the data is inconsistent anyway. An iPhone original goes through
 * the client resizer in day.astro, whose canvas re-encode discards EXIF wholesale
 * — so the only frames that still carry GPS are the ones small enough to hit the
 * `scale === 1 && f.size < maxBytes * 0.5` early return and skip re-encoding. A
 * strip pass will therefore report "3 of 12" rather than "12 of 12", and that is
 * correct rather than a bug.
 *
 * WHY THE NAME IS --strip-location AND NOT --strip-metadata
 *
 * Because it removes location and nothing else, and the flag should not be able
 * to be read as promising more. It keeps Make, Model, lens, exposure, colour
 * space — and specifically keeps the two tags that would cause visible damage or
 * lose the point of the project:
 *
 *   Orientation       iPhones store pixels ROTATED and rely on this tag to say
 *                     which way is up. photos-prep.mjs has a whole header about
 *                     the same trap. Strip it and every portrait print comes out
 *                     sideways — a privacy nicety traded for a visible bug.
 *   DateTimeOriginal  the real capture time. The whole export exists to sort
 *                     photographs by when they happened.
 *
 * DEFAULT OFF, and that is not timidity. Without the flag the output is
 * byte-for-byte identical to the R2 object, which is the print-fidelity
 * guarantee this script's entire integrity story rests on. The flag is the
 * exception, taken knowingly.
 *
 * ---------------------------------------------------------------------------
 * THE STRIP IS METADATA SURGERY. IT NEVER TOUCHES A PIXEL.
 *
 * No decode, no re-encode, no library. The compressed image data is copied
 * through untouched, byte for byte, and only metadata bytes change. A re-encode
 * would be a second lossy generation on a file that is about to be printed,
 * which is the one thing this script must not do.
 *
 * For JPEG and WebP the surgery is LENGTH-PRESERVING, which is worth
 * understanding because it is what makes it safe:
 *
 *   - GPS lives in its own TIFF IFD, reached from a pointer tag (0x8825) in
 *     IFD0. The GPS IFD's bytes and any external value data it points at are
 *     ZEROED IN PLACE, so no other offset in the file moves.
 *   - The pointer entry is then removed from IFD0 by shifting the following
 *     entries back twelve bytes, decrementing the entry count, and re-writing
 *     the next-IFD pointer at its new position. The twelve trailing bytes become
 *     slack that nothing references. Every ABSOLUTE value offset elsewhere in
 *     the TIFF — including MakerNote, which is notoriously offset-dependent and
 *     breaks if it is moved — is left exactly where it was.
 *   - XMP is text, and the XMP spec allows arbitrary whitespace padding, so
 *     location properties are overwritten WITH SPACES of the same byte length.
 *     Still valid XML, still a valid XMP packet, same size, no segment length to
 *     recompute and no offsets disturbed.
 *
 * The alternative — parse the TIFF, drop the GPS IFD, re-serialise with
 * recomputed offsets — is the textbook approach and was rejected. It moves
 * bytes, and moving bytes is what breaks MakerNote on real camera files. Zeroing
 * in place cannot.
 *
 * PNG is the exception: dropping a whole tEXt chunk changes the file length.
 * That is fine (PNG has no global length field and chunks are position
 * independent) but it does mean a stripped PNG may be shorter than the R2
 * object, which the resume logic below has to know about.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE STRIP CANNOT REACH, STATED PLAINLY
 *
 * MakerNote. Some cameras write GPS into their own proprietary MakerNote blob,
 * whose layout is per-manufacturer, undocumented, and version-dependent. This
 * code does not parse it, so location hidden in there SURVIVES. Removing
 * MakerNote wholesale would take real data with it and is not obviously the
 * right trade; it is called out here rather than quietly assumed away.
 *
 * ---------------------------------------------------------------------------
 * HOW STRIPPING INTERACTS WITH RESUME, WHICH IS THE SUBTLE PART
 *
 * The integrity check below compares a local file's MD5 against R2's ETag. A
 * stripped file CANNOT match that by construction, so a naive implementation
 * would either re-download everything on every run or scream corruption at
 * perfectly good files — and the byte-flip test proves that check is live, so it
 * would really happen.
 *
 * So the two concerns are separated:
 *
 *   INTEGRITY is verified on the bytes AS DOWNLOADED, before anything is
 *   removed. That is the only place the ETag comparison is meaningful, and it
 *   still catches a truncated or corrupted transfer.
 *
 *   RESUME is verified against the MANIFEST. Each row records the original R2
 *   digest AND the post-strip digest of what is actually on disk, plus
 *   `strippedLocation` saying which mode wrote it. A later run compares the file
 *   to the recorded post-strip digest, so "stripped, intact" and "corrupted" stay
 *   distinguishable.
 *
 * The consequence, stated because it is a real cost: in strip mode the manifest
 * is load-bearing. Delete manifest.json and the next stripped run has no record
 * to verify against and re-downloads. Without the flag, nothing changes — the
 * ETag alone is sufficient, exactly as before.
 *
 * A MODE CHANGE IS DETECTED AND REPORTED, NEVER MIXED. Exporting a directory
 * plain and then re-running with --strip-location (or the reverse) rewrites the
 * affected files and says how many, so a folder can never end up half stripped
 * and half not with nothing to indicate which is which. Files that turned out to
 * carry no location at all are identical in both modes and are left alone rather
 * than pointlessly re-downloaded.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 *
 * - It does not touch pixels, ever, in either mode. No re-encode, no resize. The
 *   uploads were already downscaled to a 1600px long edge by the page before
 *   they ever reached R2, and a print is the one consumer that would show a
 *   second lossy generation. Without --strip-location bytes land exactly as
 *   stored; with it, only metadata bytes differ and the compressed image data is
 *   copied through untouched.
 * - It is sequential. One HEAD then one GET per frame, in order. A year of two
 *   frames a day is ~730 objects, so a cold full run is a couple of minutes;
 *   every run after that is HEADs only. Parallelism would buy seconds on a
 *   script run twice a year and cost the property that a reader can see, top to
 *   bottom, that nothing here writes.
 * - It does not delete or reconcile. A frame that was overwritten in R2 (a
 *   second upload on the same day replaces the first, deliberately) has no
 *   earlier version to recover; there is only ever one object per day per person.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/* ===========================================================================
   WHERE THINGS ARE
   =========================================================================== */

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ENV_PATH = join(ROOT, '.env');

/** The files whose constants this script mirrors. Named so errors can point at them. */
const SRC = {
  frames: join(ROOT, 'src/lib/us/frames.ts'),
  frameKeys: join(ROOT, 'src/lib/us/frame-keys.ts'),
  kv: join(ROOT, 'src/lib/us/kv.ts'),
  together: join(ROOT, 'src/lib/us/together.ts'),
};

const APPLY = process.argv.includes('--apply');
/** OFF by default. See the header: without it the output is byte-identical to R2. */
const STRIP = process.argv.includes('--strip-location');
const OUT_ARG = (process.argv.find((a) => a.startsWith('--out=')) || '').slice('--out='.length);
const DEFAULT_OUT = join(homedir(), 'us-export');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function die(...lines) {
  console.error('');
  for (const l of lines) console.error(c.red(l));
  console.error('');
  process.exit(1);
}

/* ===========================================================================
   THE OUTPUT DIRECTORY MUST NOT BE IN THE REPOSITORY

   Resolved through symlinks before comparing, because /tmp and /var on macOS
   are symlinks and a string compare on the unresolved path would both
   false-negative (a symlink INTO the repo would pass) and false-positive.
   The nearest EXISTING ancestor is what gets resolved: the output directory
   itself usually does not exist yet on the first run, and realpath of a
   missing path throws.
   =========================================================================== */

function realOf(path) {
  let p = resolve(path);
  for (;;) {
    if (existsSync(p)) return realpathSync(p);
    const up = dirname(p);
    // Filesystem root that does not exist is not a case worth handling.
    if (up === p) return p;
    p = up;
  }
}

function assertOutsideRepo(out) {
  const repo = realOf(ROOT);
  const target = realOf(out);
  // The trailing separator matters: without it `/repo-export` would look like it
  // is inside `/repo`.
  if (target === repo || target.startsWith(repo + sep)) {
    die(
      'REFUSING to write inside the repository.',
      '',
      `  repository: ${repo}`,
      `  requested:  ${resolve(out)}`,
      '',
      'This repo is PUBLIC and these are private photographs. There is no flag to',
      'override this. Pick a path outside the worktree, e.g.:',
      '',
      `  node scripts/frames-export.mjs --apply --out=${DEFAULT_OUT}`,
    );
  }

  /* SOME OTHER git worktree is a WARNING and not a refusal.
     The check above knows this repo is public, so it can refuse outright. It
     cannot know that about anybody else's repo — and "outside this repo" is not
     the same safety property as "not in version control at all". A home
     directory that is a dotfiles repo, or a notes repo that syncs to a private
     remote that later becomes public, is the realistic way this still goes
     wrong.
     Refusing would be wrong: plenty of people keep their whole home directory in
     git and their remote is genuinely private, and a tool that will not write
     anywhere useful gets worked around rather than heeded. So this says the true
     thing once, loudly, and lets the person who knows whether that remote is
     public make the call. */
  /* Probed against `target`, the nearest EXISTING ancestor, and not against
     `out` itself. `git -C` on a directory that does not exist yet just fails,
     which would have silently disabled this warning on exactly the run that
     matters — the first one, before the export directory has been created. */
  const probe = spawnSync('git', ['-C', target, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (probe.status === 0) {
    const other = probe.stdout.trim();
    console.log(`
  ${c.yellow(c.bold('WARNING: that path is inside a git repository.'))}
  ${c.yellow(`  ${other}`)}
  ${c.dim('These are private photographs and private notes. If that repository has a')}
  ${c.dim('remote — or ever gets one — committing this output publishes them permanently.')}
  ${c.dim('Add the directory to that repo\'s .gitignore, or export somewhere untracked:')}
  ${c.dim(`  --out=${DEFAULT_OUT}`)}`);
  }
}

/* ===========================================================================
   CONSTANTS MIRRORED FROM THE TYPESCRIPT — see the header on why this is
   parsed and not copied, and why a miss is fatal.
   =========================================================================== */

function sourceOf(file) {
  if (!existsSync(file)) die(`Cannot read ${file}. Run this from inside the repository.`);
  return readFileSync(file, 'utf8');
}

/** `export const NAME = 'value';` — the only shape any of the three uses. */
function constFromSource(file, name) {
  const src = sourceOf(file);
  const m = new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`).exec(src);
  if (!m) {
    die(
      `Could not find ${name} in ${file}.`,
      '',
      'This script reads the three timezone names out of the TypeScript rather than',
      'copying them, so that moving the wing is still a one-line change. It cannot',
      'guess a fallback: a stale timezone would print a wrong fact on the back of a',
      'photograph instead of failing. Fix the constant or fix this regex.',
    );
  }
  return m[1];
}

function assertZone(tz, label) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    die(`${label} is ${JSON.stringify(tz)}, which Intl does not recognise as a timezone.`);
  }
  return tz;
}

const WING_TZ = assertZone(constFromSource(SRC.kv, 'WING_TZ'), 'WING_TZ');
const HER_TZ = assertZone(constFromSource(SRC.together, 'HER_TZ'), 'HER_TZ');
const HIS_TZ = assertZone(constFromSource(SRC.together, 'HIS_TZ'), 'HIS_TZ');
const TZ_OF = { her: HER_TZ, him: HIS_TZ };

/**
 * The two shapes this file has to duplicate rather than parse: the R2 key
 * template and the Redis day-key prefix. Grepped for as literal source text.
 *
 * A regex over source is a crude coupling, and it is the right crudeness here:
 * the failure it prevents is an exporter that runs clean, finds nothing, and
 * reports success after the bucket layout moved. That failure is invisible until
 * somebody needs the photographs.
 */
function assertLayout() {
  /* TWO FILES NOW. The key builders moved to frame-keys.ts so they could be tested
     without loading a credential path, which means the templates this exporter
     mirrors are no longer all in one place. Checking the wrong file would pass
     vacuously — the worst possible outcome for a guard whose entire job is to fail. */
  const expected = [
    [SRC.frameKeys, 'legacy R2 key template', 'return `frames/${date}/${who}.${ext}`;'],
    [SRC.frameKeys, 'unique R2 key template', 'return `frames/${date}/${who}-${atMs}.${ext}`;'],
    [SRC.frameKeys, 'stored-key field name', "const stored = h[`${who}Key`] ?? '';"],
    [SRC.frames, 'stored-key write', '`${who}Key`, frame.key,'],
    [SRC.frames, 'day-key prefix', 'const DAY_KEY = (date: string) => `us:frame:${date}`;'],
  ];
  const cache = new Map();
  const read = (f) => (cache.has(f) ? cache.get(f) : (cache.set(f, sourceOf(f)), cache.get(f)));
  const drifted = expected.filter(([file, , literal]) => !read(file).includes(literal));
  if (drifted.length) {
    die(
      'frames.ts / frame-keys.ts no longer match what this exporter assumes.',
      '',
      ...drifted.map(([file, what, literal]) => `  missing ${what} in ${basename(file)}:  ${literal}`),
      '',
      'Refusing to run. An exporter that guesses the wrong key finds nothing and',
      'reports success, which for a backup is the worst available outcome. Re-read',
      'those files, then update frameKey(), keyFromHash() and DAY_KEY_PREFIX here — and the',
      'literals above, which are what make the next drift loud too.',
    );
  }
}

/** Mirror of frameKey() in frames.ts — the LEGACY layout, still the fallback. */
function frameKey(date, who, ext) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`refusing a non-date: ${JSON.stringify(date)}`);
  if (who !== 'her' && who !== 'him') throw new Error(`refusing who: ${JSON.stringify(who)}`);
  if (!/^(jpg|png|webp)$/.test(ext)) throw new Error(`refusing ext: ${JSON.stringify(ext)}`);
  return `frames/${date}/${who}.${ext}`;
}

/**
 * Mirror of keyFromHash() in frames.ts.
 *
 * A BACKUP TOOL MUST RESOLVE KEYS THE SAME WAY THE APP DOES, and this is the exact
 * place that assumption can rot: if this kept deriving `<who>.<ext>` while the app
 * wrote `<who>-<atMs>.<ext>`, every export would download the OLD photograph for a
 * day that had been swapped, or nothing at all, and report success either way. That
 * is the failure mode assertLayout() exists to make loud — the new template literal
 * is on its list for exactly this reason.
 *
 * Same strictness as the app: a stored key is only honoured if it matches the day
 * and person of the record it came in on.
 */
function keyFromHash(h, who, date, ext) {
  const stored = h[`${who}Key`] ?? '';
  if (stored) {
    if (new RegExp(`^frames/${date}/${who}(-\\d{1,13})?\\.(jpg|png|webp)$`).test(stored)) return stored;
    console.error(
      c.red(`  ignoring an out-of-shape stored key for ${who} on ${date}; using the legacy layout`),
    );
  }
  return frameKey(date, who, ext);
}

const DAY_KEY_PREFIX = 'us:frame:';
const FRAMES_PREFIX = 'frames/';

/* ===========================================================================
   ENV
   =========================================================================== */

function readEnv() {
  if (!existsSync(ENV_PATH)) die('No .env found. The R2 and Upstash credentials live there.');
  return Object.fromEntries(
    readFileSync(ENV_PATH, 'utf8')
      .split('\n')
      .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
  );
}

const env = readEnv();

const NEEDED = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];
{
  const missing = NEEDED.filter((k) => !env[k]);
  if (missing.length) {
    die(
      `Missing from .env: ${missing.join(', ')}`,
      '',
      'Both stores are required and neither has a degraded mode here. frames.ts can',
      'render a page without Upstash because the bytes are still in R2; an EXPORT',
      'without Upstash would write photographs with no dates and no notes and call',
      'itself done, which is not a thing worth producing.',
    );
  }
}

/* ===========================================================================
   UPSTASH — READ VERBS ONLY, ENFORCED

   Same /pipeline transport as frames.ts, with the allowlist bolted on. The
   timeout is longer than frames.ts's 4s: that one is inside a page render where
   a slow store must not hold up a response, this one is a batch job where
   waiting is free and giving up costs a re-run.
   =========================================================================== */

const REDIS_READ_VERBS = new Set(['HGETALL', 'SCAN']);
const REDIS_TIMEOUT_MS = 15_000;
const REDIS_URL = env.UPSTASH_REDIS_REST_URL.replace(/\/+$/, '');

async function redisRead(cmds) {
  for (const cmd of cmds) {
    const verb = String(cmd[0]).toUpperCase();
    if (!REDIS_READ_VERBS.has(verb)) {
      // Not a die(): this is a programming error in this file, and a thrown
      // error carries the stack that says which call site did it.
      throw new Error(
        `frames-export is READ-ONLY and refuses to send ${verb}. ` +
          `Allowed: ${[...REDIS_READ_VERBS].join(', ')}.`,
      );
    }
  }

  let res;
  try {
    res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cmds.map((cmd) => cmd.map(String))),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
  } catch (err) {
    die('Upstash is unreachable.', `  ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) die(`Upstash returned HTTP ${res.status}.`, '  Check UPSTASH_REDIS_REST_TOKEN in .env.');

  let parsed;
  try {
    parsed = await res.json();
  } catch {
    die('Upstash response was not JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length !== cmds.length) {
    die('Upstash returned a malformed pipeline response.');
  }
  return parsed.map((e, i) => {
    if (e?.error) die(`Upstash ${String(cmds[i][0])} failed: ${e.error}`);
    return e?.result ?? null;
  });
}

/** Upstash returns a hash as a flat array. Folded exactly as frames.ts folds it. */
function foldHash(raw) {
  const out = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) out[k] = String(v);
  }
  return out;
}

/**
 * Mirror of frameFrom() in frames.ts.
 *
 * The `ext` test is what decides a side EXISTS — same as the page. A hash
 * holding a note and a timestamp but no extension is not a frame, because
 * there is no key to fetch; putFrame() writes all three together, so this only
 * happens if somebody hand-edited the hash.
 *
 * atMs 0 is kept rather than dropped, and rendered as "time unknown" downstream.
 * Printing 1970 on the back of a photograph would be worse than admitting the
 * timestamp is missing.
 */
function frameFrom(h, who, date) {
  const ext = h[`${who}Ext`] ?? '';
  if (!/^(jpg|png|webp)$/.test(ext)) return null;
  const atMs = Number(h[`${who}At`] ?? 0);
  return {
    ext,
    key: keyFromHash(h, who, date, ext),
    atMs: Number.isFinite(atMs) && atMs > 0 ? atMs : 0,
    note: h[`${who}Note`] ?? '',
  };
}

/* ===========================================================================
   R2 — GET, HEAD AND LIST, AND NOTHING ELSE
   =========================================================================== */

const { AwsClient } = await import('aws4fetch');

/**
 * Retries ON, unlike photos.ts.
 *
 * photos.ts deliberately signs-then-fetches to AVOID AwsClient.fetch's retry
 * loop, because there it runs thirteen times inside a page render and 51
 * seconds of backoff on one throttled HEAD would cost the whole response. Here
 * the opposite is true: this is an offline batch, nobody is waiting on a
 * response, and a transient 500 that kills the run costs a full re-run. Two
 * retries with a 300ms base is ~1s of worst-case backoff per object.
 */
const aws = new AwsClient({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  // Passed explicitly for the reason photos.ts gives: these two go into the
  // credential scope, and relying on aws4fetch's hostname sniff for them is a
  // silent 403 waiting for the day that heuristic changes.
  service: 's3',
  region: 'auto',
  retries: 2,
  initRetryMs: 300,
});

const R2_BASE = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}`;

/** Per segment, so `/` survives as a separator. Same reason as photos.ts. */
function encodeKeyForUrl(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** `{ status, length, etag }`. status 404 means the object is genuinely absent. */
async function r2Head(key) {
  const res = await aws.fetch(`${R2_BASE}/${encodeKeyForUrl(key)}`, { method: 'HEAD' });
  return {
    status: res.status,
    length: Number(res.headers.get('content-length') ?? -1),
    // R2 quotes the ETag. A `-N` suffix means multipart, which putFrame() never
    // produces, but it is checked for rather than assumed.
    etag: (res.headers.get('etag') ?? '').replace(/^"|"$/g, ''),
  };
}

/** Raw bytes, or a thrown error naming the status. */
async function r2Get(key) {
  const res = await aws.fetch(`${R2_BASE}/${encodeKeyForUrl(key)}`, { method: 'GET' });
  if (!res.ok) throw new Error(`GET ${key} -> HTTP ${res.status}`);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    etag: (res.headers.get('etag') ?? '').replace(/^"|"$/g, ''),
  };
}

/**
 * Every object under `frames/`, paginated.
 *
 * The pagination is not theoretical. ListObjectsV2 caps at 1000 keys per call
 * and two frames a day passes 1000 inside eighteen months, so a single
 * unpaginated call would start silently under-reporting orphans partway through
 * next year — the kind of bug that only shows up when the data has grown past
 * the day it was tested on.
 */
async function r2List(prefix) {
  const keys = [];
  let token = null;
  for (;;) {
    const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
    if (token) q.set('continuation-token', token);
    const res = await aws.fetch(`${R2_BASE}?${q}`, { method: 'GET' });
    const body = await res.text();
    if (!res.ok) throw new Error(`LIST ${prefix} -> HTTP ${res.status}`);
    for (const m of body.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1]);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(body)) break;
    const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(body);
    if (!next) break;
    token = next[1];
  }
  return keys;
}

/* ===========================================================================
   TIME — see the header. Three zones, all of them load-bearing.
   =========================================================================== */

/**
 * One instant as a wall clock in one zone, assembled from named parts.
 *
 * Returns `{ date, time, weekday, abbr }`. `abbr` is Intl's short zone name,
 * which for North American zones is `PDT`/`EDT` and for European ones is
 * `GMT+2` — English has no registered abbreviation for CEST. The offset form is
 * arguably the more useful of the two on a printed page anyway, so it is left as
 * Intl gives it rather than being mapped to a table this file would have to
 * maintain.
 */
function zoned(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
    timeZoneName: 'short',
  }).formatToParts(new Date(ms));
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    // % 24 for the reason together.ts gives: some engines produce hour 24 for
    // midnight even under h23, which would render "24:05".
    time: `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`,
    weekday: p.weekday,
    abbr: p.timeZoneName ?? '',
  };
}

/* ===========================================================================
   LOCATION SURGERY — only reached with --strip-location. See the header for the
   whole argument; this section is the mechanics.

   EVERY FUNCTION HERE IS FAIL-SAFE IN ONE DIRECTION: when anything looks
   unfamiliar it gives up and reports that it gave up, leaving the bytes alone.
   The failure mode of a bug in this code would be a corrupted photograph, which
   is strictly worse than a photograph that still knows where it was taken. So
   there is no "best effort" repair anywhere below — either the structure parses
   exactly as expected or the file is passed through and the run says so.
   =========================================================================== */

/** TIFF value sizes by type code. Index is the type; 0 means "unknown type". */
const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** The GPSInfo IFD pointer in IFD0. This one tag is the whole EXIF location story. */
const TAG_GPS_IFD = 0x8825;
/** The ExifIFD pointer, followed only so a stray GPS pointer inside it is caught too. */
const TAG_EXIF_IFD = 0x8769;

/** Endianness-aware accessors, chosen once from the TIFF header. */
function tiffIO(le) {
  return {
    u16: (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)),
    u32: (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o)),
    w16: (b, o, v) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o)),
    w32: (b, o, v) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o)),
  };
}

/**
 * Zero one IFD and everything it points at, in place.
 *
 * External value data is zeroed FIRST, because the offsets that say where it
 * lives are inside the entries this then overwrites. Get that order wrong and
 * the coordinates stay in the file with nothing left pointing at them — removed
 * from a parser's view but still sitting in the bytes, which is exactly the kind
 * of half-fix this flag must not be.
 */
function zeroIfd(buf, off, io) {
  if (off + 2 > buf.length) return false;
  const count = io.u16(buf, off);
  const end = off + 2 + count * 12 + 4;
  if (count === 0 || count > 512 || end > buf.length) return false;

  for (let i = 0; i < count; i += 1) {
    const e = off + 2 + i * 12;
    const type = io.u16(buf, e + 2);
    const n = io.u32(buf, e + 4);
    const size = (TIFF_TYPE_SIZE[type] ?? 0) * n;
    if (size > 4) {
      const vOff = io.u32(buf, e + 8);
      if (vOff + size > buf.length) return false;
      buf.fill(0, vOff, vOff + size);
    }
  }
  buf.fill(0, off, end);
  return true;
}

/**
 * Remove entry `idx` from the IFD at `off`, without moving any other byte.
 *
 * The trick, and the reason this is safe on files with MakerNote: an IFD is
 * [count][entry * count][nextIFD], and every VALUE lives at an absolute offset
 * somewhere else. Shrinking the entry array therefore moves only the next-IFD
 * pointer; it invalidates nothing. The twelve bytes freed at the end become
 * slack that no offset and no count reaches.
 */
function removeIfdEntry(buf, off, idx, count, io) {
  const first = off + 2 + idx * 12;
  const after = first + 12;
  const tail = count - 1 - idx;
  const oldNext = off + 2 + count * 12;
  const nextVal = io.u32(buf, oldNext);

  if (tail > 0) buf.copy(buf, first, after, after + tail * 12);
  io.w16(buf, off, count - 1);
  const newNext = off + 2 + (count - 1) * 12;
  io.w32(buf, newNext, nextVal);
  buf.fill(0, newNext + 4, oldNext + 4);
}

/**
 * Strip GPS from a raw TIFF block (the payload of an Exif APP1, a PNG eXIf
 * chunk, or a WebP EXIF chunk). Mutates `buf`. Length never changes.
 *
 * Walks the IFD0 chain and also descends into ExifIFD. By the specification a
 * GPS pointer only appears in IFD0, but a pointer costs four bytes to check and
 * "the spec says it cannot be there" is not a reason to leave location data in a
 * file whose whole purpose is to be handed to a stranger.
 */
function stripTiffLocation(buf) {
  if (buf.length < 8) return { changed: false, why: 'tiff shorter than its header' };
  const bom = buf.readUInt16BE(0);
  if (bom !== 0x4949 && bom !== 0x4d4d) return { changed: false, why: 'not a TIFF byte-order mark' };
  const io = tiffIO(bom === 0x4949);
  if (io.u16(buf, 2) !== 42) return { changed: false, why: 'TIFF magic is not 42' };

  let changed = false;
  const queue = [io.u32(buf, 4)];
  const seen = new Set();

  while (queue.length) {
    const off = queue.shift();
    if (!off || off + 2 > buf.length || seen.has(off)) continue;
    seen.add(off);
    const count = io.u16(buf, off);
    if (count === 0 || count > 512 || off + 2 + count * 12 + 4 > buf.length) continue;

    /* Scanned back to front. Removing an entry shifts the ones after it, so
       walking forwards would renumber the indices still to be visited. */
    for (let i = count - 1; i >= 0; i -= 1) {
      const e = off + 2 + i * 12;
      const tag = io.u16(buf, e);
      if (tag === TAG_EXIF_IFD) {
        queue.push(io.u32(buf, e + 8));
      } else if (tag === TAG_GPS_IFD) {
        const gpsOff = io.u32(buf, e + 8);
        // Zero the pointed-at IFD first; if that fails the pointer is left in
        // place, because a dangling pointer to live coordinates is worse than
        // an intact one that at least a normal tool will show you.
        if (!zeroIfd(buf, gpsOff, io)) return { changed, why: 'GPS IFD did not parse; left alone' };
        removeIfdEntry(buf, off, i, io.u16(buf, off), io);
        changed = true;
      }
    }
    // Chain to the next IFD (thumbnail directory), read AFTER any removal above
    // so the pointer is taken from its new position.
    const cnt = io.u16(buf, off);
    queue.push(io.u32(buf, off + 2 + cnt * 12));
  }
  return { changed, why: null };
}

/* ---------------------------------------------------------------------------
   XMP

   Location shows up in XMP completely independently of EXIF — `exif:GPSLatitude`
   as an attribute, `Iptc4xmpExt:LocationCreated` as a nested structure,
   `photoshop:City` as either. A strip that cleaned EXIF and left XMP would be a
   fix that does not fix it, so both are handled and by the same function, since
   the XMP packet is textually identical inside JPEG, PNG and WebP.
   --------------------------------------------------------------------------- */

/** Property local-names that carry location. Matched under ANY namespace prefix. */
const XMP_LOCATION_NAMES =
  'GPS[A-Za-z0-9]*|LocationCreated|LocationShown|Location|City|Sublocation|' +
  'ProvinceState|State|CountryName|CountryCode|Country|WorldRegion|' +
  'GPano:PoseHeadingDegrees';

/**
 * Blank every location property in an XMP packet, preserving byte length.
 *
 * OPERATES ON LATIN-1, WHICH IS THE ONLY DETAIL THAT MATTERS HERE. The packet is
 * UTF-8 and may contain multi-byte characters; decoding as UTF-8 would make one
 * character out of several bytes, so replacing a match with that many SPACES
 * would shrink the packet and desynchronise the segment length. Latin-1 makes
 * one character exactly one byte, so a space-for-character substitution is also
 * a byte-for-byte substitution.
 *
 * Whitespace is a legal XMP padding and legal XML between elements, so the
 * result still parses. Elements are blanked whole, including their tags, so a
 * nested structure like LocationCreated goes in one piece.
 */
function blankXmpLocation(buf) {
  let text = buf.toString('latin1');
  const hits = [];
  const blank = (m) => {
    hits.push(m.slice(0, 40));
    return ' '.repeat(m.length);
  };

  const N = XMP_LOCATION_NAMES;
  // Order matters: whole elements first, so attributes nested inside a location
  // element are consumed with it rather than left behind as orphans.
  text = text.replace(new RegExp(`<([A-Za-z][\\w.-]*):(${N})\\b[^>]*?/>`, 'g'), blank);
  text = text.replace(
    new RegExp(`<([A-Za-z][\\w.-]*):(${N})\\b[^>]*>[\\s\\S]*?</\\1:\\2>`, 'g'),
    blank,
  );
  text = text.replace(new RegExp(`\\s[A-Za-z][\\w.-]*:(${N})\\s*=\\s*"[^"]*"`, 'g'), blank);
  text = text.replace(new RegExp(`\\s[A-Za-z][\\w.-]*:(${N})\\s*=\\s*'[^']*'`, 'g'), blank);

  const out = Buffer.from(text, 'latin1');
  if (out.length !== buf.length) {
    // Cannot happen with latin1, and asserted anyway: a length change here would
    // silently corrupt whatever container the packet sits in.
    return { changed: false, why: 'XMP blanking changed length; refused' };
  }
  return { changed: hits.length > 0, buf: out, hits, why: null };
}

/* ---------------------------------------------------------------------------
   IPTC-IIM, inside a JPEG APP13 / Photoshop image resource block

   A third, older place location hides: IIM datasets 2:90 City, 2:92 Sublocation,
   2:95 State, 2:100/101 Country. Not in the original brief, but leaving it would
   be the same shape of half-fix as leaving XMP, so it is handled.

   Values are overwritten with SPACES rather than the dataset being removed,
   because a dataset's length is part of its header and rewriting it would move
   every following byte in the resource block. A City of three spaces carries no
   location; that is the goal, and it is length-preserving.
   --------------------------------------------------------------------------- */
const IPTC_LOCATION_DATASETS = new Set([5, 26, 27, 90, 92, 95, 100, 101]);

function blankIptcLocation(buf) {
  const hits = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    if (buf[i] !== 0x1c) {
      i += 1;
      continue;
    }
    const record = buf[i + 1];
    const dataset = buf[i + 2];
    const len = buf.readUInt16BE(i + 3);
    // The extended form (high bit set) is vanishingly rare and would need
    // different arithmetic, so it is skipped rather than guessed at.
    if (len & 0x8000) break;
    const vStart = i + 5;
    if (vStart + len > buf.length) break;
    if (record === 2 && IPTC_LOCATION_DATASETS.has(dataset)) {
      hits.push(`iptc 2:${dataset}`);
      buf.fill(0x20, vStart, vStart + len);
    }
    i = vStart + len;
  }
  return { changed: hits.length > 0, hits };
}

/* ---------------------------------------------------------------------------
   CONTAINERS
   --------------------------------------------------------------------------- */

const EXIF_PREFIX = Buffer.from('Exif\0\0', 'latin1');
const XMP_PREFIX = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');

/** A TIFF block that may or may not carry the `Exif\0\0` prefix. */
function stripExifBlock(block, removed, warnings, label) {
  const hasPrefix = block.length > 6 && block.subarray(0, 6).equals(EXIF_PREFIX);
  const tiff = hasPrefix ? block.subarray(6) : block;
  const r = stripTiffLocation(tiff);
  if (r.changed) removed.push(`${label}:exif-gps`);
  else if (r.why) warnings.push(`${label}: ${r.why}`);
  return r.changed;
}

/**
 * JPEG. Walks the marker segments and stops at SOS — everything past it is
 * entropy-coded image data with no metadata in it, and is copied untouched.
 */
function stripJpeg(input) {
  const buf = Buffer.from(input);
  const removed = [];
  const warnings = [];
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { bytes: buf, removed, warnings: ['not a JPEG SOI; left alone'] };
  }

  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) {
      warnings.push(`lost marker alignment at ${i}; stopped scanning`);
      break;
    }
    const marker = buf[i + 1];
    // Standalone markers carry no length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) {
      warnings.push(`segment ff${marker.toString(16)} has an impossible length; stopped scanning`);
      break;
    }
    const payload = buf.subarray(i + 4, i + 2 + len);

    if (marker === 0xe1) {
      if (payload.length > 6 && payload.subarray(0, 6).equals(EXIF_PREFIX)) {
        stripExifBlock(payload, removed, warnings, 'jpeg');
      } else if (payload.length > XMP_PREFIX.length && payload.subarray(0, XMP_PREFIX.length).equals(XMP_PREFIX)) {
        const body = payload.subarray(XMP_PREFIX.length);
        const r = blankXmpLocation(body);
        if (r.changed) {
          r.buf.copy(body);
          removed.push(`jpeg:xmp-location(${r.hits.length})`);
        } else if (r.why) warnings.push(`jpeg xmp: ${r.why}`);
      }
    } else if (marker === 0xed) {
      const r = blankIptcLocation(payload);
      if (r.changed) removed.push(`jpeg:iptc-location(${r.hits.length})`);
    }
    i += 2 + len;
  }
  return { bytes: buf, removed, warnings };
}

/** PNG chunk CRC is over the type AND the data. */
function pngCrc(type, data) {
  return crc32(Buffer.concat([type, data]));
}

/** Table-driven CRC-32, so a chunk can be re-sealed after its payload changes. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** PNG keywords whose whole chunk is location and can go entirely. */
const PNG_LOCATION_KEYWORD = /^(GPS|Location|Geo|Coordinates)/i;

/**
 * PNG. Rebuilt chunk by chunk, which is safe because PNG chunks are
 * position-independent — unlike the TIFF above, nothing here points at a byte
 * offset. This is therefore the one format where a chunk can simply be dropped,
 * and the only one whose output may be shorter than the R2 object.
 */
function stripPng(input) {
  const buf = Buffer.from(input);
  const removed = [];
  const warnings = [];
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    return { bytes: buf, removed, warnings: ['not a PNG signature; left alone'] };
  }

  const out = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8);
    if (i + 12 + len > buf.length) {
      warnings.push('truncated PNG chunk; stopped scanning');
      out.push(buf.subarray(i));
      i = buf.length;
      break;
    }
    const name = type.toString('latin1');
    const data = Buffer.from(buf.subarray(i + 8, i + 8 + len));
    let keep = true;
    let touched = false;

    if (name === 'eXIf') {
      touched = stripExifBlock(data, removed, warnings, 'png');
    } else if (name === 'tEXt' || name === 'zTXt' || name === 'iTXt') {
      const z = data.indexOf(0);
      const keyword = z > 0 ? data.subarray(0, z).toString('latin1') : '';
      if (keyword === 'XML:com.adobe.xmp' && name === 'iTXt') {
        /* iTXt layout after the keyword NUL: compressionFlag, compressionMethod,
           languageTag NUL, translatedKeyword NUL, then the text. A compressed
           packet cannot be edited length-preservingly, so it is dropped whole
           rather than inflated and re-deflated — re-deflating would change the
           length anyway and there is no reason to carry a compressed XMP packet
           into a print job. */
        if (data[z + 1] !== 0) {
          keep = false;
          removed.push('png:xmp-compressed-dropped');
        } else {
          const langEnd = data.indexOf(0, z + 3);
          const transEnd = langEnd >= 0 ? data.indexOf(0, langEnd + 1) : -1;
          if (transEnd < 0) {
            warnings.push('png iTXt XMP header did not parse; left alone');
          } else {
            const body = data.subarray(transEnd + 1);
            const r = blankXmpLocation(body);
            if (r.changed) {
              r.buf.copy(body);
              removed.push(`png:xmp-location(${r.hits.length})`);
              touched = true;
            } else if (r.why) warnings.push(`png xmp: ${r.why}`);
          }
        }
      } else if (PNG_LOCATION_KEYWORD.test(keyword)) {
        keep = false;
        removed.push(`png:${name}-${keyword}-dropped`);
      }
    }

    if (keep) {
      const crc = touched ? pngCrc(type, data) : buf.readUInt32BE(i + 8 + len);
      const head = Buffer.alloc(4);
      head.writeUInt32BE(len, 0);
      const tail = Buffer.alloc(4);
      tail.writeUInt32BE(crc, 0);
      out.push(head, type, data, tail);
    }
    i += 12 + len;
    if (name === 'IEND') break;
  }
  if (i < buf.length) out.push(buf.subarray(i));
  return { bytes: Buffer.concat(out), removed, warnings };
}

/**
 * WebP. A RIFF container; the EXIF and XMP chunks are edited in place, and
 * because both edits are length-preserving the outer RIFF size stays correct and
 * the VP8X feature flags stay truthful (the chunks are still there, just blank).
 */
function stripWebp(input) {
  const buf = Buffer.from(input);
  const removed = [];
  const warnings = [];
  if (buf.length < 12 || buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WEBP') {
    return { bytes: buf, removed, warnings: ['not a RIFF/WEBP header; left alone'] };
  }

  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.subarray(i, i + 4).toString('latin1');
    const size = buf.readUInt32LE(i + 4);
    if (i + 8 + size > buf.length) {
      warnings.push('truncated WebP chunk; stopped scanning');
      break;
    }
    const data = buf.subarray(i + 8, i + 8 + size);
    if (fourcc === 'EXIF') {
      stripExifBlock(data, removed, warnings, 'webp');
    } else if (fourcc === 'XMP ') {
      const r = blankXmpLocation(data);
      if (r.changed) {
        r.buf.copy(data);
        removed.push(`webp:xmp-location(${r.hits.length})`);
      } else if (r.why) warnings.push(`webp xmp: ${r.why}`);
    }
    i += 8 + size + (size % 2);
  }
  return { bytes: buf, removed, warnings };
}

/** Dispatch on the extension, which is server-derived from a magic-number sniff. */
function stripLocation(bytes, ext) {
  if (ext === 'jpg') return stripJpeg(bytes);
  if (ext === 'png') return stripPng(bytes);
  if (ext === 'webp') return stripWebp(bytes);
  return { bytes: Buffer.from(bytes), removed: [], warnings: [`no strip support for .${ext}`] };
}

/* ===========================================================================
   ENUMERATE
   =========================================================================== */

console.log(`
${c.bold('[us] frame export')}  ${APPLY ? c.red('APPLY — this will write files') : c.dim('dry run')}
${c.dim('-'.repeat(72))}`);

assertLayout();

const OUT = resolve(OUT_ARG || DEFAULT_OUT);
assertOutsideRepo(OUT);

console.log(`  ${c.dim('out')}       ${OUT}${OUT_ARG ? '' : c.dim('  (default, outside the repo)')}`);
console.log(`  ${c.dim('bucket')}    ${env.R2_BUCKET}`);
console.log(`  ${c.dim('zones')}     day key ${WING_TZ}  ·  her ${HER_TZ}  ·  him ${HIS_TZ}`);
console.log(
  `  ${c.dim('bytes')}     ${
    STRIP
      ? c.yellow('--strip-location: GPS/XMP/IPTC location removed, pixels untouched')
      : c.dim('byte-for-byte from R2 (pass --strip-location to remove GPS)')
  }`,
);

/* SCAN into a Set — see the header on duplicate keys across cursor iterations. */
const dayKeys = new Set();
{
  let cursor = '0';
  let rounds = 0;
  do {
    const [out] = await redisRead([['SCAN', cursor, 'MATCH', `${DAY_KEY_PREFIX}*`, 'COUNT', 500]]);
    if (!Array.isArray(out) || out.length < 2) die('Upstash SCAN returned an unexpected shape.');
    cursor = String(out[0]);
    for (const k of out[1]) dayKeys.add(String(k));
    rounds += 1;
    // A cursor that never returns to 0 would spin forever. 10k rounds at COUNT
    // 500 is five million keys; this wing will not have them.
    if (rounds > 10_000) die('Upstash SCAN did not terminate. Refusing to spin.');
  } while (cursor !== '0');
}

/** Malformed keys are reported, never silently dropped. */
const badKeys = [];
const dates = [];
for (const key of dayKeys) {
  const date = key.slice(DAY_KEY_PREFIX.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) badKeys.push(key);
  else dates.push(date);
}
dates.sort(); // oldest first — the order the manifest and the print pile want.

const hashes = dates.length ? await redisRead(dates.map((d) => ['HGETALL', `${DAY_KEY_PREFIX}${d}`])) : [];

/** One row per person per day that the metadata says exists. */
const rows = [];
dates.forEach((date, i) => {
  const h = foldHash(hashes[i]);
  for (const who of ['her', 'him']) {
    /* The key comes from the record now (frameFrom -> keyFromHash), not from
       recomputing it here. Recomputing was correct only while the layout was a pure
       function of the day and the person, which is exactly what changed. */
    const f = frameFrom(h, who, date);
    if (f) rows.push({ date, who, ...f, orphan: false });
  }
});

/* --- orphans: bytes in R2 that no hash points at. See the header. ---------- */

let listFailed = null;
const known = new Set(rows.map((r) => r.key));
const orphans = [];
try {
  for (const key of await r2List(FRAMES_PREFIX)) {
    if (known.has(key)) continue;
    /* BOTH LAYOUTS, AND THE `-<atMs>` ONE IS NOW THE COMMON CASE.

       Orphans used to mean "something went wrong" — bytes in the bucket that no
       hash points at. Since keys became unique they are also the ORDINARY result of
       a swap: posting a second photograph on a day writes a new key and moves the
       pointer, so the first one is still there and no longer referenced. That is
       the whole safety property, and it puts real photographs down this path.

       So this regex has to recognise the unique layout, or every superseded
       photograph would be filed as `unrecognised` and, per the branch below,
       LISTED BUT NOT EXPORTED — a backup quietly omitting the exact objects the
       overwrite fix was built to preserve. */
    const m = /^frames\/(\d{4}-\d{2}-\d{2})\/(her|him)(?:-(\d{1,13}))?\.(jpg|png|webp)$/.exec(key);
    if (!m) {
      // Something under frames/ that this feature did not put there. Reported,
      // not exported: guessing a date and a person from an unknown name is how
      // a wrong caption ends up printed.
      orphans.push({ key, unrecognised: true });
      continue;
    }
    /* The suffix IS the timestamp, so a superseded photograph exports with the
       moment it was taken rather than a 0 that sorts it to the beginning of time.
       Legacy keys have no suffix and keep the old 0. */
    orphans.push({
      date: m[1],
      who: m[2],
      ext: m[4],
      key,
      atMs: m[3] ? Number(m[3]) : 0,
      note: '',
      orphan: true,
    });
  }
} catch (err) {
  // A failed LIST costs orphan detection, not the export. Said out loud, because
  // silently skipping it would turn "no orphans" into an unearned claim.
  listFailed = err instanceof Error ? err.message : String(err);
}

for (const o of orphans) if (!o.unrecognised) rows.push(o);
rows.sort((a, b) => a.date.localeCompare(b.date) || a.who.localeCompare(b.who));

/* ===========================================================================
   WHAT A PREVIOUS RUN LEFT BEHIND

   In strip mode the manifest is the only thing that can tell "stripped and
   intact" apart from "corrupted", because a stripped file cannot match R2's
   ETag by construction. Read it if it is there; its absence is not an error,
   just a reason to re-download rather than to trust.
   =========================================================================== */

const priorByKey = new Map();
let priorManifestNote = null;
{
  const p = join(OUT, 'manifest.json');
  if (existsSync(p)) {
    try {
      const prev = JSON.parse(readFileSync(p, 'utf8'));
      for (const f of prev.frames ?? []) if (f.r2Key) priorByKey.set(f.r2Key, f);
      priorManifestNote = `${priorByKey.size} row(s) from a previous run`;
    } catch (err) {
      // A corrupt manifest must not stop an export; it just costs the resume
      // shortcut. Said out loud, because silently re-downloading a year of
      // photographs is a surprising amount of bandwidth to spend without a word.
      priorManifestNote = `unreadable (${err instanceof Error ? err.message : String(err)}) — treating every file as unverified`;
    }
  }
}

/* ===========================================================================
   HEAD EVERY OBJECT — this is what makes the dry run honest about total bytes
   and about gaps, before anything is written.

   THE DECISION TABLE IS THE INTERESTING PART. See the header section on how
   stripping interacts with resume; this is that argument as code. Note what is
   NOT here: any comparison of a stripped local file against R2's ETag. That
   comparison is meaningless once bytes have been removed, and pretending
   otherwise is exactly how a strip flag turns into either an infinite
   re-download loop or a false corruption report.
   =========================================================================== */

const missing = [];
const failures = [];

function decide(r) {
  if (!existsSync(r.path)) return { action: 'fetch', why: 'not downloaded yet' };
  const size = statSync(r.path).size;
  const prior = priorByKey.get(r.key);
  /* A prior row only speaks for the R2 object it was written from. If the day
     was re-uploaded, its ETag changed and the row is stale. */
  const priorFresh = Boolean(prior && prior.r2Etag && prior.r2Etag === r.etag);

  /* MODE CHANGE. A file written in the other mode has to be rewritten.
     ---------------------------------------------------------------------------
     THE SHORTCUT HERE IS ASYMMETRIC, AND GETTING THAT WRONG IS A SILENT BUG
     THAT SHIPPED IN THE FIRST DRAFT OF THIS FUNCTION.

     `locationRemoved: false` means two completely different things depending on
     which mode wrote the row:

       written by a STRIP run  -> "we looked, and there was no location data".
                                  Both modes therefore produce identical bytes,
                                  so switching to plain is genuinely a no-op and
                                  re-downloading would be pure waste.
       written by a PLAIN run  -> "we never looked." It says NOTHING about
                                  whether the file carries GPS.

     Treating the second case like the first is what the first draft did, and the
     result was that turning the flag ON over an existing plain export skipped
     every file, reported "no location found", and left unstripped photographs on
     disk in a directory whose manifest claimed they were stripped. That is the
     worst possible outcome for this flag: it would have looked like it worked.

     So the shortcut is only taken when the PRIOR run was the one that did the
     looking. */
  if (priorFresh && typeof prior.strippedLocation === 'boolean' && prior.strippedLocation !== STRIP) {
    const priorActuallyLooked = prior.strippedLocation === true;
    if (priorActuallyLooked && prior.locationRemoved === false) {
      r.modeNoop = true;
    } else {
      return {
        action: 'fetch',
        why: STRIP ? 'mode change: rewriting stripped' : 'mode change: restoring original bytes',
        modeChange: true,
      };
    }
  }

  if (!STRIP) {
    // Unchanged from before the flag existed: the ETag alone is sufficient, so
    // this path never needs a manifest and resumes exactly as it always did.
    if (size !== r.length) return { action: 'fetch', why: 'size differs from R2' };
    return { action: 'check-plain' };
  }

  if (!priorFresh) {
    return {
      action: 'fetch',
      why: prior ? 'manifest row is for an older version of this object' : 'no manifest row to verify a stripped file against',
    };
  }
  /* `expectedSha256`, NOT `sha256`. The two differ in exactly one case and it
     matters: `sha256` records what was observed on disk, so a run that FOUND a
     corrupt file would otherwise write the corrupt digest into the manifest and
     the next run would compare the bad file against its own bad hash, agree with
     itself, and report everything fine. `expectedSha256` only ever holds a digest
     that passed verification, so corruption stays reported until it is fixed. */
  const expect = prior.expectedSha256 ?? null;
  if (!expect) return { action: 'fetch', why: 'manifest row has no verified digest' };
  if (size !== prior.bytes) return { action: 'fetch', why: 'size differs from the manifest' };
  return { action: 'check-stripped', expect, prior };
}

for (const r of rows) {
  try {
    const head = await r2Head(r.key);
    if (head.status === 404) {
      r.state = 'missing';
      missing.push(r);
      continue;
    }
    if (head.status < 200 || head.status >= 300) {
      r.state = 'error';
      r.error = `HEAD -> HTTP ${head.status}`;
      failures.push(r);
      continue;
    }
    r.length = head.length;
    r.etag = head.etag;
    /* ONE FILE PER OBJECT, WHICH `<who>.<ext>` STOPPED GUARANTEEING.

       This used to be safe because a person had at most one object per day, so the
       output name could be derived from the day and the person the same way the R2
       key was. Unique keys break that: a swapped day now yields the current
       photograph AND every superseded one, and all of them would want
       `<date>/<who>.<ext>` — so each write would clobber the previous file and the
       run would report N exported photographs having kept one. That is the original
       overwrite bug reappearing inside the tool built to survive it.

       The photograph the hash points at keeps the plain, friendly name, because it
       is the one a human is looking for. Superseded ones carry their millisecond,
       which is already unique per object. A legacy orphan has no millisecond, and
       cannot collide with another legacy orphan of the same extension — one key is
       one object — so a fixed word is enough to separate it from the current file. */
    const stamp = r.orphan ? `-${r.atMs > 0 ? r.atMs : 'legacy'}` : '';
    r.path = join(OUT, r.date, `${r.who}${stamp}.${r.ext}`);
    const d = decide(r);
    r.action = d.action;
    r.why = d.why ?? null;
    r.modeChange = Boolean(d.modeChange);
    r.expect = d.expect ?? null;
    r.prior = d.prior ?? priorByKey.get(r.key) ?? null;
    r.state = d.action === 'fetch' ? 'fetch' : 'have';
  } catch (err) {
    r.state = 'error';
    r.error = err instanceof Error ? err.message : String(err);
    failures.push(r);
  }
}

const toFetch = rows.filter((r) => r.state === 'fetch');
const have = rows.filter((r) => r.state === 'have');
const modeChanges = rows.filter((r) => r.modeChange);
const totalBytes = toFetch.reduce((n, r) => n + Math.max(0, r.length), 0);
const kb = (n) => `${(n / 1024).toFixed(0)}KB`;

/* ===========================================================================
   REPORT
   =========================================================================== */

console.log(`
${priorManifestNote ? `  ${c.dim(`manifest.json: ${priorManifestNote}`)}\n` : ''}  ${c.bold(`${dates.length} day(s)`)} in the store, ${c.bold(`${rows.length} frame(s)`)}${
  orphans.filter((o) => !o.unrecognised).length
    ? c.yellow(` (incl. ${orphans.filter((o) => !o.unrecognised).length} orphan)`)
    : ''
}
${c.dim('-'.repeat(72))}`);

for (const r of rows) {
  const when = r.atMs ? zoned(r.atMs, TZ_OF[r.who]) : null;
  const local = when
    ? `${when.time} ${when.abbr}${when.date !== r.date ? c.yellow(` (their ${when.date})`) : ''}`
    : c.yellow('time unknown');
  const tag = {
    fetch: c.green('fetch'),
    have: c.dim('have '),
    missing: c.red('GONE '),
    error: c.red('ERR  '),
  }[r.state];
  const size = r.state === 'missing' || r.state === 'error' ? '' : String(kb(r.length)).padStart(6);
  const note = r.orphan
    ? c.yellow('orphan — no metadata')
    : r.note
      ? c.dim(`note ${r.note.length} chars`)
      : c.dim('no note');
  console.log(`  ${tag} ${r.date} ${r.who.padEnd(4)} ${size}  ${local}  ${note}`);
  if (r.error) console.log(`        ${c.red(r.error)}`);
  if (r.why && r.state === 'fetch') console.log(`        ${c.dim(r.why)}`);
}

if (badKeys.length) {
  console.log(`\n  ${c.yellow('Keys under us:frame: that are not dates (ignored):')}`);
  for (const k of badKeys) console.log(`    ${k}`);
}
if (orphans.some((o) => o.unrecognised)) {
  console.log(`\n  ${c.yellow('Objects under frames/ this script does not recognise (NOT exported):')}`);
  for (const o of orphans.filter((x) => x.unrecognised)) console.log(`    ${o.key}`);
}
if (listFailed) {
  console.log(`\n  ${c.yellow('R2 LIST failed, so orphan detection did not run:')} ${listFailed}`);
}

console.log(`
${c.dim('-'.repeat(72))}
  ${c.bold('to fetch')}  ${toFetch.length} frame(s), ${kb(totalBytes)}
  ${c.bold('already have')}  ${have.length}${
  modeChanges.length
    ? `\n  ${c.yellow(`${c.bold('MODE CHANGE')}  ${modeChanges.length} file(s) will be rewritten in the new mode`)}`
    : ''
}
  ${missing.length ? c.red(`${c.bold('MISSING')}  ${missing.length} — metadata exists, R2 object 404s`) : c.dim('missing   0')}
  ${failures.length ? c.red(`${c.bold('ERRORS')}   ${failures.length}`) : c.dim('errors    0')}`);

if (!APPLY) {
  console.log(`
${c.yellow('Dry run — nothing was written, and no directory was created.')}
Re-run with ${c.bold('--apply')} to download ${toFetch.length} frame(s) to:
  ${OUT}
${
  STRIP
    ? `\n${c.dim('A dry run cannot say WHICH files carry location data — that is only knowable')}\n${c.dim('from the bytes, and a dry run does not download them. The count comes with --apply.')}\n`
    : ''
}`);
  // A dry run still fails on a gap. Finding out in October that a photograph is
  // gone is the failure this whole script exists to prevent, so it is reported
  // at the earliest possible moment and with a non-zero status a wrapper can see.
  process.exit(missing.length || failures.length ? 1 : 0);
}

/* ===========================================================================
   APPLY
   =========================================================================== */

const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

console.log(`\n${c.bold('downloading')}\n`);

const manifest = [];
let integrityFailures = 0;
let rewroteForMode = 0;
const stripWarnings = [];

for (const r of rows) {
  if (r.state === 'missing' || r.state === 'error') continue;

  mkdirSync(join(OUT, r.date), { recursive: true });

  /* What the manifest will say about the original R2 bytes and about the strip.
     On a skip these are carried forward from the prior row, because the original
     bytes are not in hand and re-downloading purely to re-record their digest
     would defeat the whole point of resuming. */
  let originalSha = r.prior?.originalSha256 ?? null;
  let removed = Array.isArray(r.prior?.removed) ? r.prior.removed : [];
  let etagOk = null;
  let verifiedAgainst = 'nothing';
  /* The last digest that actually PASSED a check. Carried forward untouched
     unless this run verifies a new one — see the comment in decide(). */
  let expectedSha = r.prior?.expectedSha256 ?? null;

  if (r.state === 'fetch') {
    try {
      const got = await r2Get(r.key);
      if (r.length >= 0 && got.bytes.length !== r.length) {
        // The HEAD and the GET disagreeing means the object changed under us or
        // the body was truncated. Either way the bytes on disk would be a lie.
        throw new Error(`length mismatch: HEAD said ${r.length}, GET returned ${got.bytes.length}`);
      }
      if (got.etag) r.etag = got.etag;

      /* INTEGRITY IS CHECKED HERE, ON THE BYTES AS DOWNLOADED, BEFORE ANY
         REMOVAL. This is the only moment the ETag comparison means anything: it
         is R2's own digest of R2's own object, so it proves the transfer was
         faithful. Everything after this point is a deliberate local edit, and
         comparing THAT to the ETag would be comparing two different files. */
      const wireMd5 = md5(got.bytes);
      const multipartWire = r.etag.includes('-');
      etagOk = !r.etag || multipartWire ? null : wireMd5 === r.etag;
      if (etagOk === false) {
        throw new Error(`download did not match R2: md5 ${wireMd5} != etag ${r.etag}`);
      }
      verifiedAgainst = etagOk === null ? 'nothing (etag unusable)' : 'R2 etag, on the wire';
      originalSha = sha256(got.bytes);

      let toWrite = got.bytes;
      if (STRIP) {
        const s = stripLocation(got.bytes, r.ext);
        toWrite = s.bytes;
        removed = s.removed;
        for (const w of s.warnings) stripWarnings.push(`${r.date}/${r.who}.${r.ext}: ${w}`);
      } else {
        removed = [];
      }
      writeFileSync(r.path, toWrite);
      /* Verified this instant: the wire bytes matched R2's ETag and this is the
         digest of what was derived from them. Safe to trust on a later run. */
      expectedSha = sha256(toWrite);
      if (r.modeChange) rewroteForMode += 1;
    } catch (err) {
      r.state = 'error';
      r.error = err instanceof Error ? err.message : String(err);
      failures.push(r);
      console.log(`  ${c.red('FAIL')}  ${r.key}  ${c.red(r.error)}`);
      continue;
    }
  }

  /* Hash from DISK, always — on a fresh download and on a skip alike. The
     manifest is then a record of what is actually in the export directory
     rather than of what this process believed it put there, which is the only
     version of it worth carrying to a print shop. See the header on why a skip
     is not a no-op. */
  const onDisk = readFileSync(r.path);
  const digest = sha256(onDisk);
  const localMd5 = md5(onDisk);

  /* THE RESUME CHECK, and the reason there are two branches rather than one.
     A file written without the flag must still equal the R2 object, so its ETag
     is the right yardstick. A stripped file cannot equal it, so the yardstick is
     the digest a previous run recorded for the stripped form. Using the ETag for
     both is the bug this structure exists to avoid. */
  if (r.state !== 'fetch') {
    if (r.action === 'check-plain') {
      const multipart = r.etag.includes('-');
      etagOk = !r.etag || multipart ? null : localMd5 === r.etag;
      verifiedAgainst = etagOk === null ? 'nothing (etag unusable)' : 'R2 etag';
    } else if (r.action === 'check-stripped') {
      etagOk = digest === r.expect;
      verifiedAgainst = 'manifest digest of the stripped file';
    }
    // A plain-mode file that matched its ETag is verified by definition; record
    // that digest so a later stripped run has a trustworthy starting point.
    if (etagOk === true) expectedSha = digest;
  }

  const locationRemoved = removed.length > 0;

  if (etagOk === false) {
    integrityFailures += 1;
    console.log(
      `  ${c.red('CORRUPT')}  ${r.path}\n` +
        `        ${c.red(
          r.action === 'check-stripped'
            ? `sha256 ${digest.slice(0, 16)}… != manifest ${String(r.expect).slice(0, 16)}…`
            : `local md5 ${localMd5} != R2 etag ${r.etag}`,
        )}\n` +
        `        ${c.dim('delete this file and re-run to refetch it.')}`,
    );
  } else {
    const verb =
      r.state === 'fetch'
        ? r.modeChange
          ? c.yellow('rewrit')
          : c.green('saved ')
        : c.dim('skip  ');
    const what = locationRemoved
      ? c.yellow(`stripped: ${removed.join(', ')}`)
      : STRIP
        ? c.dim('no location found')
        : etagOk === null
          ? c.yellow('etag unchecked')
          : c.dim('etag ok');
    console.log(
      `  ${verb} ${r.date}/${r.who}.${r.ext}` +
        `  ${String(kb(onDisk.length)).padStart(6)}  ${what}`,
    );
    if (r.modeNoop) {
      console.log(`        ${c.dim('mode changed, but this file has no location data, so both modes agree')}`);
    }
  }

  const when = r.atMs ? zoned(r.atMs, TZ_OF[r.who]) : null;
  const wing = r.atMs ? zoned(r.atMs, WING_TZ) : null;

  manifest.push({
    date: r.date,
    who: r.who,
    ext: r.ext,
    atMs: r.atMs || null,
    iso: r.atMs ? new Date(r.atMs).toISOString() : null,
    tz: TZ_OF[r.who],
    localDate: when?.date ?? null,
    localTime: when?.time ?? null,
    localWeekday: when?.weekday ?? null,
    localZoneAbbr: when?.abbr ?? null,
    /* The wing day is the FOLDER, and it is not always the poster's own date —
       see the timezone section in the header. Both are recorded so a mismatch is
       a fact in the file rather than something to re-derive. */
    wingTz: WING_TZ,
    wingDateOfTimestamp: wing?.date ?? null,
    dayKeyMatchesPosterDate: when ? when.date === r.date : null,
    note: r.note,
    orphan: Boolean(r.orphan),
    r2Key: r.key,
    file: `${r.date}/${r.who}.${r.ext}`,
    /* `bytes`/`sha256`/`md5` describe THE FILE ON DISK — which in strip mode is
       not the R2 object. The original is recorded separately so a later run can
       tell "stripped, intact" from "corrupted" without downloading anything. */
    bytes: onDisk.length,
    sha256: digest,
    /** The last digest that PASSED verification. The resume check reads this one. */
    expectedSha256: expectedSha,
    md5: localMd5,
    r2Bytes: r.length,
    r2Etag: r.etag || null,
    originalSha256: originalSha,
    /** Which mode wrote this file. The mode-change check reads exactly this. */
    strippedLocation: STRIP,
    /** Whether the strip actually found anything. False means both modes agree. */
    locationRemoved,
    removed,
    integrityVerified: etagOk,
    integrityVerifiedAgainst: verifiedAgainst,
  });
}

/* ------------------------------- manifests -------------------------------- */

const generatedAt = new Date().toISOString();

writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify(
    {
      generatedAt,
      bucket: env.R2_BUCKET,
      wingTz: WING_TZ,
      herTz: HER_TZ,
      hisTz: HIS_TZ,
      dayCount: dates.length,
      frameCount: manifest.length,
      strippedLocation: STRIP,
      locationRemovedFrom: manifest.filter((m) => m.locationRemoved).length,
      stripWarnings,
      rewrittenForModeChange: rewroteForMode,
      missing: missing.map((r) => ({ date: r.date, who: r.who, r2Key: r.key })),
      errors: failures.map((r) => ({ date: r.date, who: r.who, r2Key: r.key, error: r.error })),
      unrecognisedObjects: orphans.filter((o) => o.unrecognised).map((o) => o.key),
      nonDateDayKeys: badKeys,
      r2ListError: listFailed,
      frames: manifest,
    },
    null,
    2,
  ) + '\n',
);

/** Grouped by wing day, oldest first — the order you sort a stack of prints in. */
const md = [];
md.push('# [us] — every frame, for printing');
md.push('');
md.push(`Exported ${generatedAt}. ${manifest.length} frame(s) across ${dates.length} day(s).`);
md.push('');
md.push(
  `Folders are **${WING_TZ} calendar days** — that is what the store keys on, and it ` +
    `is nobody's home timezone. Each time below is the **poster's own wall clock** ` +
    `(her: ${HER_TZ}, him: ${HIS_TZ}). Where their own date differs from the folder, ` +
    `the line says so; that happens when somebody posts late at night or early in the ` +
    `morning and New York had already rolled over, or not yet.`,
);
md.push('');
md.push('THESE ARE PRIVATE. Do not put this folder anywhere public.');
md.push('');
if (STRIP) {
  const n = manifest.filter((m) => m.locationRemoved).length;
  md.push(
    n
      ? `**Location data removed** (\`--strip-location\`): ${n} of ${manifest.length} file(s) ` +
        `carried GPS or other location metadata, and it was removed on the way to disk. ` +
        `No pixel was re-encoded, and camera, lens, orientation and capture time were kept. ` +
        `The originals in R2 are untouched, so re-running without the flag restores them.`
      : `**Location check** (\`--strip-location\`): none of the ${manifest.length} file(s) ` +
        `carried any location metadata, so nothing needed removing and these are still ` +
        `byte-for-byte copies of what is in storage.`,
  );
  md.push('');
} else {
  md.push(
    '_These files are byte-for-byte copies of what is in storage. Some may carry GPS ' +
      'coordinates from the camera; re-run with `--strip-location` to remove them before ' +
      'sending this folder anywhere._',
  );
  md.push('');
}

for (const date of [...new Set(manifest.map((m) => m.date))]) {
  const group = manifest.filter((m) => m.date === date);
  md.push(`## ${date}`);
  md.push('');
  for (const m of group) {
    const who = m.who === 'her' ? 'Her' : 'Him';
    const when = m.localTime
      ? `${m.localWeekday} ${m.localTime} ${m.localZoneAbbr} (${m.tz})` +
        (m.dayKeyMatchesPosterDate === false ? ` — their own date was ${m.localDate}` : '')
      : 'time unknown (no timestamp in the store)';
    md.push(`- **${who}** — ${when}`);
    md.push(`  - \`${m.file}\` · ${(m.bytes / 1024).toFixed(0)}KB · sha256 \`${m.sha256.slice(0, 16)}…\``);
    md.push(`  - ${m.note ? `“${m.note}”` : '_no note_'}`);
    if (m.locationRemoved) md.push(`  - _location data removed: ${m.removed.join(', ')}_`);
    if (m.orphan) md.push('  - _orphan: the bytes were in R2 with no metadata, so there is no time or note._');
    md.push('');
  }
}

if (missing.length) {
  md.push('## Gaps');
  md.push('');
  md.push('The store has metadata for these but the image is not in R2. They cannot be printed.');
  md.push('');
  for (const r of missing) md.push(`- ${r.date} ${r.who} — \`${r.key}\``);
  md.push('');
}

writeFileSync(join(OUT, 'manifest.md'), md.join('\n'));

/* --------------------------------- done ----------------------------------- */

const bad = missing.length + failures.length + integrityFailures;

console.log(`
${c.dim('-'.repeat(72))}
  ${c.bold('wrote')}  ${manifest.length} frame(s) + manifest.json + manifest.md
  ${c.dim('into')}   ${OUT}`);

if (STRIP) {
  const n = manifest.filter((m) => m.locationRemoved).length;
  console.log(
    `\n  ${c.bold('location')}  ${
      n
        ? c.yellow(`${n} of ${manifest.length} file(s) had location data removed`)
        : c.dim(`0 of ${manifest.length} file(s) carried any location data`)
    }`,
  );
  // Named individually, because "3 of 12" is only actionable if you can see which 3.
  for (const m of manifest.filter((x) => x.locationRemoved)) {
    console.log(`    ${c.dim(m.file.padEnd(22))} ${m.removed.join(', ')}`);
  }
  if (rewroteForMode) {
    console.log(`\n  ${c.yellow(`${rewroteForMode} file(s) rewritten because the mode changed since the last run.`)}`);
  }
  if (stripWarnings.length) {
    console.log(`\n  ${c.yellow(c.bold('The strip could not fully parse these, and left them ALONE:'))}`);
    for (const w of stripWarnings) console.log(`    ${c.yellow(w)}`);
    console.log(c.dim('  Those files may still contain location data. They are byte-identical to R2.'));
  }
} else if (rewroteForMode) {
  console.log(`\n  ${c.yellow(`${rewroteForMode} file(s) restored to the original R2 bytes (mode changed since the last run).`)}`);
}

if (missing.length) {
  console.log(`
  ${c.red(c.bold(`${missing.length} NAMED GAP(S) — metadata exists, the image does not:`))}`);
  for (const r of missing) console.log(`    ${c.red(`${r.date} ${r.who}`)}  ${c.dim(r.key)}`);
  console.log(c.dim('  These are listed under "Gaps" in manifest.md too.'));
}
if (integrityFailures) {
  console.log(`\n  ${c.red(c.bold(`${integrityFailures} file(s) failed their integrity check.`))}`);
}
if (failures.length) {
  console.log(`\n  ${c.red(c.bold(`${failures.length} error(s):`))}`);
  for (const r of failures) console.log(`    ${c.red(`${r.date} ${r.who}`)}  ${r.error}`);
}

console.log(`
${bad === 0 ? c.green('Done, with nothing missing.') : c.red(`Done, but ${bad} problem(s) above.`)}
${c.dim('Nothing in either store was modified — this script cannot write to them.')}${
  STRIP ? `\n${c.dim('The unstripped originals are still in R2; re-run without the flag to get them back.')}` : ''
}
`);

process.exit(bad === 0 ? 0 : 1);
