#!/usr/bin/env node
/**
 * carriage-numbers.mjs — draw the carriage line numbers onto a generated
 * backdrop, because a diffusion model cannot.
 *
 * Usage:
 *   node scripts/carriage-numbers.mjs --in room.png                # place them
 *   node scripts/carriage-numbers.mjs --in room.png --guides       # + a grid overlay to read coords off
 *   node scripts/carriage-numbers.mjs --in room.png --apply        # write the real output
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Each carriage needs `1 2 3 4` on BOTH long edges. Four machines is 32 tiny
 * numerals that must all be correct, in order, unrepeated, and mirrored
 * left-to-right. Image models cannot do that — the observed failures are exactly
 * what you would predict (`1 2 3 1`, duplicated digits, mirrored glyphs,
 * invented symbols), and they do not improve with a more explicit prompt because
 * the model is not reasoning about the sequence at all.
 *
 * So the labour is split at the point where each tool is strong. The prompt asks
 * for the room and for FIVE WHITE LINES AND NO TEXT. This script puts the
 * numbers on. It is deterministic, correct every time, and re-runnable, which
 * also means regenerating the room does not mean re-rolling the dice on the type.
 *
 * It also makes the photograph agree with the 3D layer: StudioRoom.tsx already
 * has CARRIAGE_LINES_BOTH_EDGES = true, so previously the rendered room and the
 * backdrop underneath it disagreed about how a carriage is marked.
 *
 * ---------------------------------------------------------------------------
 * HOW PLACEMENT WORKS
 *
 * There is no image analysis here and that is deliberate — edge-detecting a
 * carriage in a dark blue photograph is far less reliable than you reading four
 * corners off a grid once.
 *
 * For each machine you give the FOUR CORNERS of its carriage quad in the source
 * image, in this order: near-left, near-right, far-right, far-left. ("Near" =
 * closest to the camera, the spring-bay end.) The script then bilinearly
 * interpolates inside that quad, so numerals inherit the perspective
 * foreshortening for free — the far pair sits closer together and is drawn
 * smaller, exactly as real markings would photograph.
 *
 * Run with `--guides` first: it writes a copy with a labelled 10% grid over it
 * so you can read the corner coordinates off directly, as fractions of width and
 * height. Then paste them into MACHINES below.
 * --------------------------------------------------------------------------- */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

/* ===========================================================================
   CONFIG — the part you edit
   =========================================================================== */

/**
 * One entry per machine, left to right across the frame.
 *
 * Corners are FRACTIONS of the image (0..1), not pixels, so the same numbers
 * keep working if you re-export the room at another size.
 *
 *   nl = near-left   (closest to camera, left edge of the carriage)
 *   nr = near-right
 *   fr = far-right   (nearest the mirror)
 *   fl = far-left
 *
 * The placeholder values below assume a symmetrical four-machine row shot down
 * the centre aisle. They WILL be wrong for your image — run `--guides` and
 * replace them. They are laid out so the shape of the data is obvious.
 */
const MACHINES = [
  { nl: [0.045, 0.92], nr: [0.225, 0.92], fr: [0.300, 0.52], fl: [0.170, 0.52] },
  { nl: [0.275, 0.94], nr: [0.455, 0.94], fr: [0.455, 0.53], fl: [0.330, 0.53] },
  { nl: [0.545, 0.94], nr: [0.725, 0.94], fr: [0.670, 0.53], fl: [0.545, 0.53] },
  { nl: [0.775, 0.92], nr: [0.955, 0.92], fr: [0.830, 0.52], fl: [0.700, 0.52] },
];

/**
 * Where the four transverse lines sit along the carriage, as a fraction from the
 * NEAR end (0) to the FAR end (1). Line 1 is nearest the camera.
 *
 * Not 0.2/0.4/0.6/0.8: on the reference the marked band occupies the middle of
 * the pad, with unmarked pad at both ends where the shoulder pad and foot
 * platform sit.
 */
const LINE_POS = [0.14, 0.38, 0.62, 0.86];

/** How far in from each long edge the numeral sits, as a fraction of the width. */
const EDGE_INSET = 0.055;

/** Numeral height at the NEAR end and at the FAR end, as a fraction of image height. */
const SIZE_NEAR = 0.020;
const SIZE_FAR = 0.011;

/**
 * Rotation, degrees. The reference photographs show the numerals turned to read
 * ALONG the carriage rather than upright, which is why they look like small
 * ticks at a glance. 90 puts the digit's baseline parallel to the long edge.
 */
const ROTATE = 90;

/** White, slightly held back — painted markings on a dark pad are never pure #fff. */
const INK = '#e8ebee';
/** Opacity, so the numerals sit in the photograph rather than on top of it. */
const INK_ALPHA = 0.82;
/** A hairline dark edge, so a numeral stays legible where the pad catches light. */
const HALO = '#00000055';

const FONT = 'Helvetica-Narrow';

/* ===========================================================================
   IMPLEMENTATION
   =========================================================================== */

const argv = process.argv.slice(2);
const arg = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const IN = arg('in');
const APPLY = has('apply');
const GUIDES = has('guides');

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
if (!IN || !existsSync(IN)) {
  console.error(c.red(`Pass an existing image: --in <file>. Got ${IN ?? '(nothing)'}`));
  process.exit(1);
}

const dims = spawnSync(MAGICK, ['identify', '-format', '%w %h', IN], { encoding: 'utf8' })
  .stdout.split(' ')
  .map(Number);
const [W, H] = dims;
if (!W || !H) {
  console.error(c.red('Could not read image dimensions.'));
  process.exit(1);
}

const OUT_DIR = join(dirname(IN), 'numbered');
mkdirSync(OUT_DIR, { recursive: true });
const stem = basename(IN, extname(IN));
const OUT = join(OUT_DIR, `${stem}-numbered.png`);
const GUIDE_OUT = join(OUT_DIR, `${stem}-guides.png`);

/* ---- guides mode: read your coordinates off this -------------------------- */

if (GUIDES) {
  const args = [IN, '-fill', 'none', '-stroke', '#00ff88', '-strokewidth', '1'];
  for (let i = 1; i < 10; i += 1) {
    const x = Math.round((W * i) / 10);
    const y = Math.round((H * i) / 10);
    args.push('-draw', `line ${x},0 ${x},${H}`);
    args.push('-draw', `line 0,${y} ${W},${y}`);
  }
  args.push('-stroke', 'none', '-fill', '#00ff88', '-pointsize', String(Math.round(H * 0.022)));
  for (let i = 1; i < 10; i += 1) {
    const x = Math.round((W * i) / 10);
    const y = Math.round((H * i) / 10);
    args.push('-draw', `text ${x + 4},${Math.round(H * 0.03)} '${(i / 10).toFixed(1)}'`);
    args.push('-draw', `text 6,${y - 4} '${(i / 10).toFixed(1)}'`);
  }
  args.push(GUIDE_OUT);
  const r = spawnSync(MAGICK, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(c.red(r.stderr.trim().split('\n')[0]));
    process.exit(1);
  }
  console.log(`
${c.green('Wrote')} ${GUIDE_OUT}
${c.dim('Read the four corners of each carriage off the grid (fractions of W and H)')}
${c.dim('and paste them into MACHINES at the top of this script:')}

  { nl: [x, y], nr: [x, y], fr: [x, y], fl: [x, y] }

${c.dim('nl = near-left (camera end), then clockwise: nr, fr (mirror end), fl.')}
`);
  process.exit(0);
}

/* ---- placement ------------------------------------------------------------ */

/** Bilinear interpolation inside the carriage quad. u across (0=left), v along (0=near). */
function inQuad(m, u, v) {
  const near = [m.nl[0] + (m.nr[0] - m.nl[0]) * u, m.nl[1] + (m.nr[1] - m.nl[1]) * u];
  const far = [m.fl[0] + (m.fr[0] - m.fl[0]) * u, m.fl[1] + (m.fr[1] - m.fl[1]) * u];
  return [near[0] + (far[0] - near[0]) * v, near[1] + (far[1] - near[1]) * v];
}

const draws = [];
let placed = 0;

for (const m of MACHINES) {
  for (let li = 0; li < LINE_POS.length; li += 1) {
    const v = LINE_POS[li];
    const label = String(li + 1); // 1 nearest the camera. Never derived from anything else.

    // Foreshortening: a numeral further from the camera is smaller.
    const size = SIZE_NEAR + (SIZE_FAR - SIZE_NEAR) * v;
    const px = Math.max(6, Math.round(size * H));

    for (const u of [EDGE_INSET, 1 - EDGE_INSET]) {
      const [fx, fy] = inQuad(m, u, v);
      const x = Math.round(fx * W);
      const y = Math.round(fy * H);
      draws.push({ x, y, px, label });
      placed += 1;
    }
  }
}

/* Each numeral is composited individually because each needs its own point size
   and its own rotation origin. One -annotate per glyph, which is slow in theory
   and instant in practice at 32 glyphs. */
const args = [IN];
for (const d of draws) {
  args.push('-font', FONT, '-pointsize', String(d.px));
  // Halo first, offset by a pixel, then the ink over it.
  args.push('-fill', HALO, '-annotate', `${ROTATE}x${ROTATE}+${d.x + 1}+${d.y + 1}`, d.label);
  args.push('-fill', `rgba(${hexToRgb(INK)},${INK_ALPHA})`);
  args.push('-annotate', `${ROTATE}x${ROTATE}+${d.x}+${d.y}`, d.label);
}
args.push(OUT);

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');
}

console.log(`
${c.bold('carriage numbers')}  ${c.dim(`${basename(IN)}  ${W}x${H}`)}
  machines        ${MACHINES.length}
  lines each      ${LINE_POS.length}
  numerals total  ${placed}  ${c.dim(`(${MACHINES.length} x ${LINE_POS.length} x 2 edges)`)}
  rotation        ${ROTATE}deg
  size            ${Math.round(SIZE_NEAR * H)}px near -> ${Math.round(SIZE_FAR * H)}px far
`);

if (!APPLY) {
  console.log(`${c.yellow('Dry run.')} Re-run with ${c.bold('--apply')} to write ${OUT}.
${c.dim('If the coordinates are placeholders, run --guides first or the numbers land in the wrong place.')}
`);
  process.exit(0);
}

const r = spawnSync(MAGICK, args, { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(c.red(`ImageMagick failed: ${(r.stderr || '').trim().split('\n')[0]}`));
  process.exit(1);
}

/* Assert the count, because the whole point of this script is that the number of
   numerals is not left to chance. A silent miscount here would reintroduce
   exactly the bug it exists to prevent. */
const expected = MACHINES.length * LINE_POS.length * 2;
if (placed !== expected) {
  console.error(c.red(`placed ${placed} numerals, expected ${expected}`));
  process.exit(1);
}

console.log(`${c.green('Wrote')} ${OUT}  ${c.dim(`${placed}/${expected} numerals`)}

${c.dim('Then re-encode into the site:')}
  magick ${OUT} -resize 1672x -strip -quality 84 public/assets/us/studio-backdrop.webp
  magick ${OUT} -resize 1672x -strip -quality 86 public/assets/us/studio-backdrop.jpg
  magick ${OUT} -resize 32x   -strip -quality 55 public/assets/us/studio-backdrop-tiny.webp
`);
