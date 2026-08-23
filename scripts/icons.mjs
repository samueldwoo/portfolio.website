#!/usr/bin/env node
/**
 * icons.mjs — generate the `[us]` app icons.
 *
 * Usage:
 *   node scripts/icons.mjs            # dry run: report what it would write
 *   node scripts/icons.mjs --apply    # write them
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The first set was drawn by hand with ImageMagick's `-annotate`, positioning the
 * brackets and the letters as three separate draw calls. That cannot work: it makes
 * the layout a guess about font metrics, and the guess was wrong — the `s`
 * overflowed the right bracket and the letters stood taller than the brackets, so
 * the icon read as broken rather than as a wordmark.
 *
 * THE FIX IS TO LET THE TEXT ENGINE DO THE LAYOUT. `[us]` is rendered as ONE string
 * in one font, so the brackets are sized by the font's own cap height and the
 * letters sit inside them by construction. Per-character colour comes from <tspan>,
 * which does not disturb the layout.
 *
 * Rasterised with headless Chrome rather than ImageMagick's internal SVG renderer,
 * because MSVG's tspan support is unreliable and a silently mis-rendered icon is
 * exactly the failure this script exists to end. Chrome renders what a browser
 * renders, which is also what the phone will show.
 *
 * ---------------------------------------------------------------------------
 * WHAT GETS WRITTEN, AND WHY EACH ONE DIFFERS
 *
 *   icon-192, icon-512        purpose "any". Padded like a normal app icon.
 *   maskable-192, -512        purpose "maskable". Android and iOS may crop these
 *                             to a circle, so the wordmark sits inside the 80%
 *                             SAFE ZONE the spec guarantees, on a full bleed of
 *                             black. Same art, more margin — not a different icon.
 *   apple-touch-icon (180)    iOS home screen. iOS applies its own rounded-rect
 *                             mask and does NOT read the manifest, which is why
 *                             this file has to exist separately at all.
 *
 * OPAQUE, never transparent: iOS composites a transparent icon onto white, which
 * would put a white halo around a black icon. Every output is filled.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/* ===========================================================================
   CONFIG
   =========================================================================== */

const OUT_DIR = 'public/assets/us/icons';

/** Straight from us.css, so the icon cannot drift from the site. */
const VOID = '#000000';
const BLUE = '#3e7bff'; // --blue-light
const CHALK = '#ffffff'; // --chalk

/**
 * The wordmark's share of the canvas width.
 *
 * 0.62 for the padded icons: an app icon needs air, and at 1.0 the mark fights
 * the corner radius every platform applies.
 * 0.46 for maskable: the spec only guarantees the middle 80% survives a crop, and
 * a circle inscribed in that is smaller again. Measured against the worst case
 * rather than the average one.
 */
const SCALE_ANY = 0.62;
const SCALE_MASKABLE = 0.46;

const TARGETS = [
  { file: 'icon-512.png', size: 512, scale: SCALE_ANY, glow: true },
  { file: 'icon-192.png', size: 192, scale: SCALE_ANY, glow: true },
  { file: 'maskable-512.png', size: 512, scale: SCALE_MASKABLE, glow: false },
  { file: 'maskable-192.png', size: 192, scale: SCALE_MASKABLE, glow: false },
  { file: 'apple-touch-icon.png', size: 180, scale: SCALE_ANY, glow: true },
];

/* ===========================================================================
   IMPLEMENTATION
   =========================================================================== */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APPLY = process.argv.includes('--apply');

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

if (!existsSync(CHROME)) {
  console.error(c.red(`Chrome not found at ${CHROME}`));
  process.exit(1);
}
if (!MAGICK) {
  console.error(c.red('ImageMagick not found. `brew install imagemagick`'));
  process.exit(1);
}

/**
 * One icon, as an HTML document.
 *
 * The mark is a single <text> run so the brackets enclose the letters by the
 * font's own metrics. `font-variant-ligatures: none` and an explicit
 * `letter-spacing: 0` keep it from being re-kerned into a different width than
 * the viewBox was sized for.
 *
 * The glow is a radial gradient behind the mark, not a filter: a blur on text at
 * 192px turns the bracket strokes to mush.
 */
function page(size, scale, glow) {
  const fontPx = Math.round(size * scale * 0.52);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:${VOID};}
  .wrap{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;
        position:relative;overflow:hidden;background:${VOID};}
  ${glow ? `.glow{position:absolute;inset:0;
        background:radial-gradient(circle at 50% 46%, rgba(62,123,255,.30) 0%, rgba(62,123,255,.10) 38%, rgba(0,0,0,0) 68%);}` : ''}
  .mark{position:relative;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
        font-weight:700;font-size:${fontPx}px;line-height:1;letter-spacing:0;
        font-variant-ligatures:none;white-space:nowrap;color:${CHALK};}
  .b{color:${BLUE};}
  </style></head><body><div class="wrap">${glow ? '<div class="glow"></div>' : ''}<div
  class="mark"><span class="b">[</span>us<span class="b">]</span></div></div></body></html>`;
}

const work = join(tmpdir(), `us-icons-${process.pid}`);
mkdirSync(work, { recursive: true });

console.log(`\n${c.bold('[us] app icons')}  ${c.dim(APPLY ? 'writing' : 'dry run')}\n`);

const results = [];
for (const t of TARGETS) {
  const html = join(work, `${t.file}.html`);
  const shot = join(work, `${t.file}`);
  writeFileSync(html, page(t.size, t.scale, t.glow));

  const r = spawnSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--screenshot=${shot}`,
      `--window-size=${t.size},${t.size}`,
      `--user-data-dir=${join(work, 'profile')}`,
      `file://${html}`,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (!existsSync(shot)) {
    console.error(c.red(`  FAILED ${t.file}`), (r.stderr || '').split('\n')[0]);
    process.exit(1);
  }

  /* Flatten onto black and strip metadata. -flatten is what guarantees opacity;
     iOS composites a transparent icon onto WHITE, which would ring a black icon
     with a halo. */
  const final = join(work, `final-${t.file}`);
  const m = spawnSync(
    MAGICK,
    [shot, '-background', VOID, '-flatten', '-resize', `${t.size}x${t.size}`, '-strip', final],
    { encoding: 'utf8' },
  );
  if (m.status !== 0) {
    console.error(c.red(`  magick failed on ${t.file}`), (m.stderr || '').split('\n')[0]);
    process.exit(1);
  }

  const dims = spawnSync(MAGICK, ['identify', '-format', '%wx%h %[opaque]', final], {
    encoding: 'utf8',
  }).stdout.trim();
  results.push({ ...t, final, dims, bytes: statSync(final).size });
}

for (const r of results) {
  const dest = join(OUT_DIR, r.file);
  const was = existsSync(dest) ? `${statSync(dest).size}B` : 'new';
  console.log(
    `  ${r.file.padEnd(22)} ${String(r.dims).padEnd(18)} ${String(r.bytes).padStart(6)}B  ${c.dim(`was ${was}`)}`,
  );
  if (APPLY) {
    spawnSync(MAGICK, [r.final, dest], { encoding: 'utf8' });
  }
}

if (!APPLY) {
  console.log(`\n${c.yellow('Dry run.')} Re-run with ${c.bold('--apply')} to write into ${OUT_DIR}.\n`);
} else {
  console.log(`\n${c.green('Wrote')} ${results.length} icons into ${OUT_DIR}\n`);
}
rmSync(work, { recursive: true, force: true });
