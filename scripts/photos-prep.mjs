#!/usr/bin/env node
/**
 * photos-prep.mjs — turn phone photos into gallery-ready assets, and
 * optionally upload them to R2.
 *
 * Usage:
 *   node scripts/photos-prep.mjs                 # prep photos/in -> photos/out
 *   node scripts/photos-prep.mjs --push          # prep, then upload to R2
 *   node scripts/photos-prep.mjs --push --only=k # just one key
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Three separate problems, one pass:
 *
 * 1. SIZE. A phone photo is ~1-4 MB. The studio loads them as WebGL textures,
 *    and a dozen full-size JPEGs is tens of megabytes of her mobile data plus
 *    enough GPU memory to kill the tab on a mid-range phone. 2000px WebP is
 *    visually identical on screen at roughly a tenth the bytes.
 *
 * 2. PRIVACY. Phone photos carry EXIF, and EXIF carries **GPS coordinates**.
 *    Uploading them unstripped would publish the exact latitude and longitude
 *    of wherever each photo was taken — including, in all likelihood, both of
 *    your homes. This is the single most important thing this script does, and
 *    it is the reason not to just drag files into the Cloudflare dashboard.
 *
 * 3. CACHING. R2 serves whatever Cache-Control was set at upload time. Set it
 *    once here and her browser stops re-downloading photos it already has.
 *
 * ---------------------------------------------------------------------------
 * THE ORDERING BUG THIS SCRIPT AVOIDS
 *
 * `-auto-orient` MUST run before `-strip`.
 *
 * Phones almost never rotate pixels; they write the sensor orientation into an
 * EXIF tag and let the viewer rotate. `-strip` deletes that tag. So stripping
 * first throws away the only record of which way is up, and every portrait
 * photo silently ends up sideways in the gallery with nothing in the file left
 * to explain why. `-auto-orient` bakes the rotation into the pixels first;
 * then the tag is safe to destroy.
 * ---------------------------------------------------------------------------
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const IN_DIR = join(ROOT, 'photos/in');
const OUT_DIR = join(ROOT, 'photos/out');

const PUSH = process.argv.includes('--push');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

/** Long-edge cap. 2000px covers a retina full-screen panel with headroom. */
const MAX_EDGE = 2000;
/** Also emit a small texture for panels far from the camera. */
const THUMB_EDGE = 480;
const QUALITY = 82;
/** One year, immutable: filenames are content-addressed by you, not mutated. */
const CACHE_CONTROL = 'private, max-age=31536000, immutable';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function which(bin) {
  return spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' }).status === 0;
}

const MAGICK = which('magick') ? 'magick' : which('convert') ? 'convert' : null;
if (!MAGICK) {
  console.error(c.red('ImageMagick not found. `brew install imagemagick`'));
  process.exit(1);
}

mkdirSync(IN_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const SOURCES = readdirSync(IN_DIR).filter((f) => /\.(jpe?g|png|heic|heif|webp|tiff?)$/i.test(f));

if (SOURCES.length === 0) {
  console.log(`
${c.bold('No photos found.')}
Drop images into ${c.bold('photos/in/')} and re-run.
${c.dim('That folder is gitignored — the repo is public, so photos must never be committed.')}
`);
  process.exit(0);
}

/** Does this file still carry GPS EXIF? Used to PROVE the strip worked. */
function hasGps(file) {
  const r = spawnSync(MAGICK, ['identify', '-format', '%[EXIF:*]', file], { encoding: 'utf8' });
  return /GPS/i.test(r.stdout || '');
}

console.log(`\n${c.bold('photo prep')} ${c.dim(`${SOURCES.length} source file(s)`)}\n`);

const manifest = [];
let failed = 0;

for (const src of SOURCES) {
  const stem = basename(src, extname(src)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (ONLY && stem !== ONLY) continue;

  const from = join(IN_DIR, src);
  const full = join(OUT_DIR, `${stem}.webp`);
  const thumb = join(OUT_DIR, `${stem}@sm.webp`);
  const gpsBefore = hasGps(from);

  // -auto-orient BEFORE -strip. See the header. Do not reorder.
  const args = (out, edge, q) => [
    from,
    '-auto-orient',
    '-resize', `${edge}x${edge}>`, // '>' = only shrink, never upscale
    '-strip',
    '-quality', String(q),
    out,
  ];

  const a = spawnSync(MAGICK, args(full, MAX_EDGE, QUALITY), { encoding: 'utf8' });
  const b = spawnSync(MAGICK, args(thumb, THUMB_EDGE, 70), { encoding: 'utf8' });

  if (a.status !== 0 || b.status !== 0) {
    failed += 1;
    console.log(`  ${c.red('FAIL')}  ${src}  ${(a.stderr || b.stderr || '').trim().split('\n')[0]}`);
    continue;
  }

  const inKb = Math.round(statSync(from).size / 1024);
  const outKb = Math.round(statSync(full).size / 1024);
  const dims = spawnSync(MAGICK, ['identify', '-format', '%wx%h', full], { encoding: 'utf8' }).stdout;
  const gpsAfter = hasGps(full);

  // Assert, don't assume. If GPS survived, say so loudly rather than uploading it.
  const gpsNote = gpsBefore
    ? gpsAfter
      ? c.red('GPS STILL PRESENT — do not upload')
      : c.green('GPS stripped')
    : c.dim('no GPS in source');

  console.log(
    `  ${c.green('ok')}    ${stem.padEnd(28)} ${dims.padEnd(11)} ${String(inKb).padStart(5)}KB -> ${String(outKb).padStart(4)}KB  ${gpsNote}`,
  );

  manifest.push({ key: `photos/${stem}.webp`, thumbKey: `photos/${stem}@sm.webp`, stem });
}

/* ------------------------------- upload ---------------------------------- */

if (PUSH) {
  const envPath = join(ROOT, '.env');
  const env = existsSync(envPath)
    ? Object.fromEntries(
        readFileSync(envPath, 'utf8')
          .split('\n')
          .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l))
          .filter(Boolean)
          .map((m) => [m[1], m[2]]),
      )
    : {};

  const need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) {
    console.log(`\n${c.red('Cannot push:')} missing ${missing.join(', ')} in .env\n`);
    process.exit(1);
  }

  const { AwsClient } = await import('aws4fetch');
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    service: 's3',
  });
  const base = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}`;

  console.log(`\n${c.bold('uploading to R2')} ${c.dim(env.R2_BUCKET)}\n`);

  for (const m of manifest) {
    for (const [key, file] of [
      [m.key, join(OUT_DIR, `${m.stem}.webp`)],
      [m.thumbKey, join(OUT_DIR, `${m.stem}@sm.webp`)],
    ]) {
      const res = await aws.fetch(`${base}/${key}`, {
        method: 'PUT',
        body: readFileSync(file),
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': CACHE_CONTROL },
      });
      console.log(`  ${res.ok ? c.green('ok') : c.red('FAIL')}    ${key}  ${c.dim(`HTTP ${res.status}`)}`);
      if (!res.ok) failed += 1;
    }
  }
}

/* ------------------------------ manifest ---------------------------------- */

console.log(`\n${c.bold('Manifest entries')} ${c.dim('— paste into the MEMORIES array in src/lib/us/photos.ts')}`);
console.log(c.dim('-'.repeat(72)));
for (const m of manifest) {
  console.log(`  {
    key: '${m.key}',
    thumbKey: '${m.thumbKey}',
    caption: 'TODO',
    note: 'TODO — the line revealed at max tension',
    chapter: 'signature50',
  },`);
}
console.log(c.dim('-'.repeat(72)));
console.log(
  PUSH
    ? `\n${failed ? c.red(`${failed} failure(s).`) : c.green('Uploaded.')} ${c.dim('Photos are private; only /api/us/photo/[id] can mint a URL.')}\n`
    : `\n${c.dim('Nothing uploaded. Re-run with --push to send these to R2.')}\n`,
);
process.exit(failed === 0 ? 0 : 1);
