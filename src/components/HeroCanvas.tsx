import { useEffect, useRef } from 'react';

/**
 * HeroCanvas — the hero's generative atmosphere layer.
 *
 * Replaces the old static `<svg class="hero-motif">` line-draw signature with a
 * living version of the same hand-drawn sage register: a field of nested
 * contour rings (a topographic / agate-slice look) that breathe on a value-noise
 * field and swell toward the pointer.
 *
 * Design contract
 * ---------------
 * - Canvas 2D only. No WebGL, no new dependencies.
 * - Sage stroke register (--sage / --sage-deep / --olive), very low alpha.
 * - Composition mass sits right-of-centre and is faded to *nothing* over the
 *   left third by a horizontal gradient stroke, so `.hero-name`,
 *   `.hero-subtitle` and `.hero-intro` never fight it.
 * - Absolutely positioned behind `.band-inner` (z-index 0 vs 1),
 *   `pointer-events: none`, `aria-hidden`.
 *
 * Motion budget (per frame)
 * -------------------------
 *   14 contour rings x 44 nodes  = 616 points (2 noise octaves each)
 * +  1 editorial hairline x 22   =  22 points
 * +  5 accent dots
 *   ------------------------------------------
 *   ~640 sampled points, 20 stroke calls.
 * Backing store capped at devicePixelRatio 2.
 *
 * Pause conditions: IntersectionObserver on the wrapper (hero out of view) and
 * `document.hidden`. Both cancel the rAF; either clearing resumes it.
 *
 * prefers-reduced-motion
 * ----------------------
 * We render EXACTLY ONE frame and never call requestAnimationFrame. The static
 * frame is composed at t=0 with the focus parked off-centre-right, which is a
 * deliberate, attractive still. Critically the canvas element's own opacity is
 * never animated by JS — the intro ramp lives inside the draw call as an alpha
 * multiplier — so there is no way for this layer to be stranded invisible.
 */

/* ---------- deterministic 2D value noise (periodic when sampled on a circle) ---------- */

function hash2(i: number, j: number): number {
  let n = (i * 374761393 + j * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Two octaves, centred on 0. Enough wander to read as a drawn contour. */
function fbm(x: number, y: number): number {
  return (vnoise(x, y) - 0.5) * 1.34 + (vnoise(x * 2.17 + 11.3, y * 2.17 - 4.1) - 0.5) * 0.62;
}

/* ---------- composition constants ---------- */

const RINGS = 14;
const NODES = 44;
const HAIR_NODES = 22;
const TAU = Math.PI * 2;
const SQUASH = 0.82; // rings are slightly wider than tall — less "circle", more organic

const SAGE = '95,122,79';
const SAGE_DEEP = '78,102,64';
const OLIVE = '138,154,91';

interface RingSpec {
  r: number;
  rgb: string;
  alpha: number;
  width: number;
  seed: number;
  amp: number;
  /** Per-ring centre nudge — kills the "perfect concentric target" look. */
  ox: number;
  oy: number;
  grad: CanvasGradient | null;
}

/** Accent dots: [ring index, angle turns] — echoes the old motif's terminal circles. */
const DOTS: Array<[number, number]> = [
  [3, 0.02],
  [6, 0.86],
  [9, 0.17],
  [11, 0.61],
  [13, 0.95],
];

/* ============================================================
   Putting green
   The contour nest is already a slope chart — that is literally how greens are
   mapped — so the green is not a new drawing, it is a reading of the existing
   one. `slopeAt()` takes the gradient of the SAME fbm field that displaces the
   rings, so a ball rolls the way the drawn contours say it should: tight
   contours (steep gradient) push harder. Reading the picture genuinely helps.
   ============================================================ */

const BALL_R = 5.5;
const CUP_R = 13;
/** Below this speed (px/s) the ball is considered stopped. */
const STOP_SPEED = 26;
/**
 * Rolling friction (fraction of velocity retained per second). Raised from an
 * initial 0.34, which stopped the ball in under 0.4s — far too short for slope
 * to bend the line. A real putt rolls for seconds; this needs to as well or the
 * break is invisible no matter how strong the gradient is.
 */
const FRICTION = 0.12;
/**
 * Slope strength. The raw fbm gradient over this field is only ~0.01-0.15 per
 * 6px step, so it needs a large multiplier to matter against a ~700px/s putt.
 * Measured: at 2100 the ball deviated 1.2px (straight); this produces a clear,
 * readable break without the ball behaving like it is on ice.
 */
const SLOPE_ACCEL = 2400;
/**
 * How gentle the ground must be, as a fraction of SLOPE_ACCEL, for a slow ball to
 * come to REST on it rather than keep trickling (see `holds` in stepBall).
 *
 * Raised 0.014 -> 0.030 when the undulation went up 2.5x. It has to move with the
 * amplitude, and the reason is measurable: the mean |gradient| over a play box
 * went 76.8 -> 130.7, so at the old threshold the share of the green flat enough
 * to hold a ball FELL from 10.4% to 5.4%. With nowhere to rest, a putt could only
 * stop by hitting a play-box wall or timing out on MAX_ROLL — which is exactly
 * the reported "the ball always rolls to the edge of the screen".
 *
 * Measured restable area at x2.5 undulation:
 *     0.014 ->  5.4%      0.030 -> 22.0%      0.050 -> 50.6%      0.080 -> 81.0%
 * 0.030 is "the flattest fifth of the green" — hollows and shelves, which is
 * where a ball should stop. 0.050+ starts parking it on visibly sloped ground,
 * which is the inert-mid-slope look this file already fixed once.
 */
const REST_SLOPE = 0.03;
/** Hard ceiling on how long one putt may roll (seconds). See the roll-time
 *  cap in step(): a ball on a constant fall line never drops below
 *  STOP_SPEED, so without this a putt can trickle for 11s+ and the player
 *  simply waits, unable to aim. */
const MAX_ROLL = 7;
/** Max drag length in px that maps to full power. */
const MAX_PULL = 150;
const MAX_SPEED = 900;

type Phase = 'idle' | 'aiming' | 'rolling' | 'sunk';

/**
 * The green's height field.
 *
 * Composed as a BROAD FALL LINE plus undulation, deliberately in that order:
 *
 * - The fall line is a plane. A plane has no local minima, so nothing can act
 *   as an attractor. The first version used raw fbm, whose basins behaved as
 *   gravity wells — every putt from every start converged to the same point
 *   (measured: three starts ending within 5px of each other). A dominant plane
 *   gradient makes that impossible.
 * - The undulation is two octaves. Its amplitude used to be deliberately LOW so
 *   it could bend the fall line without ever reversing it — no local minima, so
 *   nothing could act as an attractor. That was over-cautious: it also meant the
 *   green had no ridges or valleys at all, and read as a bare tilt.
 *   Raised 2.5x on review. VALLEYS AND LOCAL MINIMA ARE NOW ACCEPTABLE — a ball
 *   coming to rest in a hollow mid-green is real golf, and is preferable to the
 *   old behaviour where the plane pushed almost every putt into a play-box wall.
 *   The pathology to avoid was never "a local minimum exists"; it was ONE basin
 *   deep enough to swallow every putt from every start (measured once at three
 *   starts finishing within 5px). A dominant-enough plane plus a bounded
 *   amplitude prevents that without flattening the green.
 *
 * `tiltAng`/`tiltMag`/`seed` are per-round, so each re-tee is a new green.
 */
function heightAt(
  x: number,
  y: number,
  cx: number,
  cy: number,
  span: number,
  tiltAng: number,
  tiltMag: number,
  seed: number
): number {
  const nx = (x - cx) / span;
  const ny = (y - cy) / span;
  const plane = (nx * Math.cos(tiltAng) + ny * Math.sin(tiltAng)) * tiltMag;
  /* AMPLITUDES RAISED 2.5x (0.42/0.16 -> 1.05/0.40). Measured, not guessed.
     At 0.42/0.16 the plane was 62-77% of all relief, which left 0-4 local peaks
     across the whole play box and an arrow-direction spread as low as 22 deg. The
     visible consequence: contours ran near-parallel, every arrow pointed the same
     way, and the fall-line arrows never diverged across a ridge or converged into
     a valley — there was no ridge and no valley to read.
     The offline sweep (tools/golf_sweep.py, port verified bit-exact against this
     file) says one-stroke solvability holds at 100% for x2.0, x2.5 and x3.0 with
     the minimum aim tolerance steady at 4 deg; it breaks at x4.0. So x3 is the
     edge and 2.5 is the value with margin. */
  const undul =
    fbm(nx * 1.25 + seed, ny * 1.25 - seed) * 1.05 +
    fbm(nx * 2.9 - seed * 1.7, ny * 2.9 + seed * 1.3) * 0.4;
  return plane + undul;
}

/** Downhill gradient (central difference), scaled to px/s^2. */
function slopeAt(
  x: number,
  y: number,
  cx: number,
  cy: number,
  span: number,
  tiltAng: number,
  tiltMag: number,
  seed: number
): { gx: number; gy: number } {
  const h = 7;
  const hx =
    heightAt(x + h, y, cx, cy, span, tiltAng, tiltMag, seed) -
    heightAt(x - h, y, cx, cy, span, tiltAng, tiltMag, seed);
  const hy =
    heightAt(x, y + h, cx, cy, span, tiltAng, tiltMag, seed) -
    heightAt(x, y - h, cx, cy, span, tiltAng, tiltMag, seed);
  return { gx: -hx * SLOPE_ACCEL, gy: -hy * SLOPE_ACCEL };
}

export default function HeroCanvas() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = window as unknown as Record<string, unknown>;
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------------- geometry / layout state ---------------- */

    let cssW = 0;
    let cssH = 0;
    let rings: RingSpec[] = [];
    let hairGrad: CanvasGradient | null = null;
    let globalAlpha = 1;
    /** true below 900px, where the copy goes full-bleed and there is no
     *  right-hand gutter to hide the composition in. */
    let narrow = false;

    /**
     * How far right the hero copy actually reaches, as a fraction of the canvas
     * box. Drives the WIDE horizontal ink fade.
     *
     * WHY MEASURED AND NOT HARDCODED: the fade used to be *calibrated* against a
     * copy column assumed to end at x/W ~0.52. That assumption is fragile in a
     * specific, already-observed way -- `.hero-lower` is sized in `ch`, and `ch`
     * resolves against the inherited font-size, so raising body text once
     * silently widened the column by 53px and pushed copy into the ink zone.
     * Deriving the stop positions from a live measurement makes the fade
     * self-correcting: change the type scale and the ink moves out of the way.
     *
     * Verified behaviour-preserving: at 1440 with the current type scale the
     * measurement yields 0.515, producing stops 0.415 / 0.575 / 0.745 against
     * the original hand-tuned 0.42 / 0.58 / 0.75. Inflating body text to 28px
     * moves it to 0.658, which is the adaptation the old constants could not do.
     *
     * SCOPE: only the wide/horizontal fade is derived. The NARROW vertical fade
     * keeps its original hand-tuned constants deliberately -- the documented
     * failure mode is horizontal (a `ch` column widening), which only exists
     * where there is a horizontal gutter. On narrow the copy is full-bleed and
     * measuring its bottom edge just saturates the safety clamp without saying
     * anything useful. Fix what was fragile; don't churn what was verified.
     */
    const COPY_EDGE_FALLBACK = 0.52;
    let copyEdge = COPY_EDGE_FALLBACK;

    /**
     * Measures ranges over TEXT NODES -- not element boxes, and not a Range over
     * an element's *contents*. This distinction is the whole trick and it has
     * bitten this file before (see the lesson about measuring glyph boxes rather
     * than element boxes): a block element's box, and a contents-Range over it,
     * both span the full content width no matter how short the text is. That
     * reports 0.917 here instead of the true 0.515.
     *
     * `.explore-cue` is deliberately EXCLUDED: it is a small secondary
     * affordance sitting at 0.587, right of the copy block, and was never part
     * of the original calibration. Including it would drag the fade rightward
     * and thin the composition for no readability gain. The set below is exactly
     * the copy the original comment named.
     */
    const COPY_SEL = '.hero-meta, .hero-name, .hero-subtitle, .hero-intro';

    /**
     * On narrow viewports the copy is full-bleed, so there is no horizontal
     * gutter and the green has to live in a BAND BELOW the copy instead. This is
     * the bottom of everything the green must clear, as a fraction of the canvas.
     *
     * `.explore-cue` IS included here (unlike the horizontal measurement, which
     * excludes it): vertically it is the last thing in the copy column and the
     * green must not sit on it.
     *
     * Fallback 0.72 roughly matches what layout.css reserves; the clamp floor of
     * 0.86 guarantees the green always keeps at least 14% of the hero even if the
     * measurement goes wrong.
     */
    const COPY_BOTTOM_FALLBACK = 0.72;
    let copyBottom = COPY_BOTTOM_FALLBACK;
    const COPY_BOTTOM_SEL =
      '.hero-meta, .hero-name, .hero-subtitle, .hero-intro, .explore-cue';

    /** Max right / bottom of the real glyph rects under `sel`, or null. */
    const inkExtent = (inner: Element, sel: string) => {
      let right = -Infinity;
      let bottom = -Infinity;
      inner.querySelectorAll(sel).forEach((el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.nodeValue || !node.nodeValue.trim()) continue;
          let rects: DOMRect[] = [];
          try {
            const range = document.createRange();
            range.selectNodeContents(node);
            rects = Array.from(range.getClientRects());
          } catch {
            rects = [];
          }
          rects.forEach((r) => {
            if (r.width <= 1 || r.height <= 1) return;
            right = Math.max(right, r.right);
            bottom = Math.max(bottom, r.bottom);
          });
        }
      });
      return {
        right: Number.isFinite(right) ? right : null,
        bottom: Number.isFinite(bottom) ? bottom : null,
      };
    };

    const measureCopy = () => {
      const inner = document.querySelector('.home-inner');
      const wrapRect = wrap.getBoundingClientRect();
      if (!inner || !wrapRect.width || !wrapRect.height) {
        copyEdge = COPY_EDGE_FALLBACK;
        copyBottom = COPY_BOTTOM_FALLBACK;
        return;
      }

      // Horizontal onset — excludes .explore-cue (see COPY_SEL's note).
      const h = inkExtent(inner, COPY_SEL);
      copyEdge =
        h.right === null
          ? COPY_EDGE_FALLBACK
          // Clamp so a pathological measurement can neither erase the
          // composition (too high) nor expose copy to full ink (too low).
          /* Ceiling 0.66 -> 0.80. At 0.66 the clamp bound BEFORE the copy did once the
             gutter narrowed: measured copy edge is 0.622 at 1024 and 0.694 at 900, so the
             fade began left of the text and ink reached the glyphs (maxAlpha 251 at 1024,
             250 at 900 -- the solid cup, not a faint contour). The clamp is a guard rail,
             not the value; measuring is the point. */
          : Math.min(0.8, Math.max(0.3, (h.right - wrapRect.left) / wrapRect.width));

      // Vertical onset — includes .explore-cue.
      const v = inkExtent(inner, COPY_BOTTOM_SEL);
      copyBottom =
        v.bottom === null
          ? COPY_BOTTOM_FALLBACK
          : Math.min(0.86, Math.max(0.35, (v.bottom - wrapRect.top) / wrapRect.height));
    };

    /**
     * Wide viewports fade the ink out horizontally (the left third stays clean,
     * so the name/subtitle/intro sit on empty canvas). Narrow viewports have no
     * horizontal gutter, so they fade VERTICALLY instead -- clean at the top
     * where the copy lives, ink only in the lower band.
     *
     * The wide ramp is expressed as offsets from the measured copy edge, so the
     * copy always lands in the clear zone with the same relative margin it was
     * originally calibrated with (<10% of ring alpha at the copy edge).
     */
    const grad = (rgb: string, a: number): CanvasGradient => {
      if (narrow) {
        /* Derived from the measured copy BOTTOM, not the old hardcoded
           0.5/0.72/0.9. Those constants predated the reserved green band and
           started inking at 0.5 -- half way up the intro paragraph -- which is
           why contours and the cup were drawn straight over the body copy on a
           phone. The clear zone now covers every line of copy, and the ramp
           lives entirely inside the band layout.css reserves below it. */
        const e = copyBottom;
        const g = ctx.createLinearGradient(0, 0, 0, cssH);
        g.addColorStop(0, `rgba(${rgb},0)`);
        g.addColorStop(Math.max(0.02, e - 0.02), `rgba(${rgb},0)`);
        g.addColorStop(Math.min(0.98, e + 0.05), `rgba(${rgb},${(a * 0.32).toFixed(4)})`);
        g.addColorStop(Math.min(0.99, e + 0.13), `rgba(${rgb},${a.toFixed(4)})`);
        g.addColorStop(1, `rgba(${rgb},${a.toFixed(4)})`);
        return g;
      }
      // edge 0.52 reproduces the original 0.42 / 0.58 / 0.75.
      const e = copyEdge;
      const g = ctx.createLinearGradient(0, 0, cssW, 0);
      g.addColorStop(0, `rgba(${rgb},0)`);
      g.addColorStop(Math.max(0.02, e - 0.1), `rgba(${rgb},0)`);
      g.addColorStop(Math.min(0.98, e + 0.06), `rgba(${rgb},${(a * 0.16).toFixed(4)})`);
      g.addColorStop(Math.min(0.99, e + 0.23), `rgba(${rgb},${(a * 0.66).toFixed(4)})`);
      g.addColorStop(1, `rgba(${rgb},${a.toFixed(4)})`);
      return g;
    };

    const layout = () => {
      const rect = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(rect.width));
      cssH = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      narrow = cssW < 900;
      globalAlpha = narrow ? 0.72 : 1;

      // Must run before any grad() call below — every ring caches its own
      // gradient, so a stale copyEdge would be baked into all of them.
      measureCopy();

      const maxR = narrow ? cssW * 0.78 : Math.min(cssW * 0.6, cssH * 1.0);
      rings = [];
      for (let i = 0; i < RINGS; i++) {
        const t = i / (RINGS - 1);
        const ink = i % 5 === 3; // two-ish "ink" rings read as drawn-over accents
        const rgb = ink ? SAGE_DEEP : i % 7 === 5 ? OLIVE : SAGE;
        const alpha = (ink ? 0.5 : 0.32) * globalAlpha;
        const r = maxR * (0.12 + 0.88 * Math.pow(t, 1.2));
        rings.push({
          r,
          rgb,
          alpha,
          width: ink ? 1.5 : 1.1,
          seed: i * 3.71,
          amp: r * (0.09 + 0.1 * t),
          // Drift the centres outward-ish so the nest reads hand-stacked.
          ox: (hash2(i, 17) - 0.5) * maxR * 0.2 * t,
          oy: (hash2(i, 91) - 0.5) * maxR * 0.16 * t,
          grad: grad(rgb, alpha),
        });
      }
      hairGrad = grad(SAGE, 0.4 * globalAlpha);
    };

    /* ---------------- pointer / focus state ---------------- */

    let ptrX = 0;
    let ptrY = 0;
    let lastPtr = -1e9;
    let idleMix = 1; // 1 = fully on the idle orbit, 0 = fully following the pointer
    let focusX = 0;
    let focusY = 0;
    let seeded = false;

    /** Where the composition rests when nothing is pointing at it. On narrow
     *  viewports that is the centre of the reserved band below the copy; on
     *  wide, right-of-centre. Derived rather than fixed at 0.82, which sat
     *  inside the copy. */
    const home = () =>
      narrow
        ? { x: cssW * 0.5, y: cssH * (copyBottom + (1 - copyBottom) * 0.52) }
        : { x: cssW * 0.7, y: cssH * 0.5 };

    const orbit = (t: number) => {
      const hm = home();
      // Narrow drift is scaled to the BAND, not the whole hero — a full-height
      // amplitude would swing the focus back up into the copy.
      const ampY = narrow ? (1 - copyBottom) * cssH * 0.16 : cssH * 0.2;
      return {
        x: hm.x + Math.cos(t * 0.17) * cssW * (narrow ? 0.09 : 0.14),
        y: hm.y + Math.sin(t * 0.23) * ampY,
      };
    };

    /* ---------------- putting-green state ---------------- */

    let phase: Phase = 'idle';
    let ballX = 0;
    let ballY = 0;
    let velX = 0;
    let velY = 0;
    let cupX = 0;
    let cupY = 0;
    /** host's inline touch-action, saved while a drag holds it at 'none'. */
    let prevTouchAction = '';
    let pullX = 0; // current drag vector (from ball toward the pointer)
    let pullY = 0;
    let putts = 0;
    let sunkAt = 0; // clock time the ball dropped, for the flourish
    let flagSway = 0;
    /** True while the ball was already touching a wall last frame. Tangential
     *  damping is applied only on the frame contact BEGINS — see the wall block
     *  in step() for why re-damping every frame kills a slide along a wall. */
    let onWall = false;
    /** Seconds the ball has been below STOP_SPEED without qualifying to stop.
     *  Backstop against a soft-lock; see the stall guard in step(). */
    let stalled = 0;
    /** Seconds the current putt has been rolling; capped by MAX_ROLL. */
    let rollTime = 0;
    /** Ball start, expressed as a fraction of the play box so it survives resize. */
    let startFx = 0.28;
    let startFy = 0.72;
    /* Per-round green: a fall-line direction + steepness, plus an undulation
       seed. Re-rolled on every re-tee so each hole reads differently and the
       player cannot memorise one line. */
    let tiltAng = 0;
    let tiltMag = 0.85;
    let gSeed = 3.1;
    let round = 0;

    /**
     * The play box is the region where the contour ink actually lives, so the
     * green can never sit under the copy: right of the gradient onset on wide
     * viewports, the lower band on narrow ones. Mirrors grad()'s stops.
     */
    const playBox = () => {
      if (narrow) {
        /* The band BELOW the copy, measured — not the old fixed
           y 0.56 -> 0.90, which at 390x844 put the box at 472->760 while the
           intro paragraph ran 382->666 and the explore cue 702->750. The green
           was laid out on top of the body copy.
           layout.css reserves the space this now sits in; the 130px floor keeps
           the hole playable if a short landscape viewport squeezes the band. */
        /* 0.022 not 0.015: at 360x780 the tighter value left only a 5px gap,
           because `copyBottom` is a fraction captured at the last layout() and
           a late reflow can move the real copy edge a few px. This is the
           slack that absorbs that without eating the band. */
        const pad = Math.max(18, cssH * 0.022);
        const top = copyBottom * cssH + pad;
        const h = Math.max(130, cssH - top - pad);
        /* 0.16/0.68 rather than 0.08/0.84. You aim by dragging BACK from the
           ball, so the margin outside the box is the drag runway. At 0.08 the
           ball could rest 31px from the screen edge at 390px wide, which capped
           power at ~20% and made putting away from that wall impossible. 0.16
           leaves ~62px of runway against a 90px narrow maxPull() — ~69% power
           available even in the worst lie, and more from anywhere else. */
        return { x: cssW * 0.16, y: top, w: cssW * 0.68, h };
      }
      /* Derived from the measured copy edge, not a fixed 0.48. The narrow branch
         already keys off copyBottom; this is the same rule horizontally, and it is what
         stops the cup drifting onto the copy as the gutter narrows between 900 and
         1280. The 0.44 floor keeps the green from swallowing a very wide hero.
   RIGHT BOUND 0.94, not 0.97: the section rail lives in the right gutter from
   1024 up (its ticks are 44px wide since the a11y pass), and at 0.97 the ball
   could rest underneath it -- elementFromPoint returned OL.rail-list and the
   press never reached the game. Measured: golfmouse's "right edge" lie failed at
   both 1440 and 1024 until this came in. */
      const left = Math.max(0.44, copyEdge + 0.05);
      return { x: cssW * left, y: cssH * 0.16, w: cssW * (0.94 - left), h: cssH * 0.68 };
    };

    /* Randomise the green itself: fall-line angle, steepness and undulation.
       Called on every re-tee, so sinking a putt genuinely produces a new hole. */
    const rollGreen = () => {
      round += 1;
      const r1 = hash2(round * 7 + 1, 13);
      const r2 = hash2(round * 11 + 5, 29);
      const r3 = hash2(round * 17 + 3, 71);
      tiltAng = r1 * TAU;
      tiltMag = 0.6 + r2 * 0.75;   // shallow to properly severe
      gSeed = 2 + r3 * 9;
    };

    /** Cup goes somewhere in the middle band of the play box, not dead centre. */
    const placeCup = () => {
      const b = playBox();
      const m = CUP_R * 3.2;
      const rx = hash2(round * 23 + 9, 41);
      const ry = hash2(round * 31 + 4, 53);
      cupX = b.x + m + (b.w - m * 2) * (0.25 + rx * 0.5);
      cupY = b.y + m + (b.h - m * 2) * (0.2 + ry * 0.6);
    };

    /**
     * How far a FULL-POWER putt from (px,py) can actually roll toward the cup.
     *
     * WHY THIS EXISTS: the tee used to be chosen on distance alone, and a green
     * has a hard reach ceiling. Rolling friction is exponential, so a putt's
     * total run is v0/k with k = -ln(FRICTION) — at MAX_SPEED that is
     * 900/2.12 = 425px on the FLAT, and materially less uphill, where the fall
     * line decelerates the ball as well. The play box at 1440x900 is 662x612,
     * so the sampler below could and did deal an uphill cup ~470px away: a hole
     * where no (aim, power) whatsoever sinks the ball. Audited exhaustively at
     * 0.1deg x 0.002 power — 1.7M lines per hole — 18 of 301 consecutive rounds
     * were unwinnable at 1440x900 and 78 of 201 at 1920x1080, where the box is
     * bigger and the holes longer. The ball's closest possible approach on those
     * was 20-114px on a 13px cup: it never even reached the lip, so this is a
     * REACH failure, NOT the rim-out rule (`speed < 520` in stepBall). Raising
     * that threshold, or MAX_SPEED, or FRICTION, cannot fix this and was
     * measured not to: the tee has to be dealt inside the reach envelope.
     *
     * Closed form of dv/dt = -k*v - up, solved for v -> 0, where `up` is the
     * mean slope acceleration OPPOSING the putt sampled along the line.
     *
     * Downhill (up < 0) the slope feeds the ball instead, and the credit it earns
     * is deliberately SMALL — one time constant 1/k, the lifetime of the putt's
     * own impulse. An earlier version credited the full MAX_ROLL of downhill
     * drift and that was measurably wrong: a ball past its friction range
     * (MAX_SPEED/k = 425px) is only still moving because the fall line is
     * carrying it, and a ball carried by the fall line goes where the SLOPE
     * points, not where it was aimed. Crediting that drift as reach left 7 of
     * 201 rounds unwinnable at 1920x1080 — every one of them a cup 453-527px
     * away, i.e. past 425px, "reachable" only by uncontrollable trickle.
     */
    const reachToward = (px: number, py: number): number => {
      const hm = home();
      const span = Math.min(cssW, cssH) * 0.5;
      const dx = cupX - px;
      const dy = cupY - py;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      let up = 0;
      // Five samples, not one at the ball: the undulation means the slope the
      // putt actually fights is the average over the line, not at the tee.
      for (const f of [0.15, 0.35, 0.55, 0.75, 0.95]) {
        const s = slopeAt(px + ux * d * f, py + uy * d * f, hm.x, hm.y, span, tiltAng, tiltMag, gSeed);
        up -= s.gx * ux + s.gy * uy;
      }
      up /= 5;
      const k = -Math.log(FRICTION);
      const flat = MAX_SPEED / k;
      if (up > 1e-6) return flat - (up / (k * k)) * Math.log1p((k * MAX_SPEED) / up);
      return flat - up / (k * k);   // downhill: one time constant of help, no more
    };

    /**
     * Fraction of the reach budget a hole is allowed to use.
     *
     * Calibrated, not guessed. Over 301 consecutive rounds at 1440x900 the ratio
     * distance/reachToward separates the two populations cleanly: every solvable
     * hole sat at <= 1.013 and every unsolvable one at >= 1.036 (bar one, round
     * 157, whose line the fall line bent 54px wide — curvature, not reach). 0.90
     * keeps margin under that boundary for the model's own approximation, since
     * it assumes a straight line and a mean slope.
     *
     * Cost, measured, at 1440x900 over 301 rounds: 23% of tees move by a median
     * 32px, median hole distance holds at 317px vs 318px, p10 distance and
     * median aim tolerance are unchanged (267px, 9deg), and the WORST aim
     * tolerance improves from 1deg to 4deg. 0.85 shortens more for no gain in
     * solvability; 0.95 also reaches 100% here but leaves a 1deg hole and less
     * margin, so 0.90 it is.
     */
    const REACH_BUDGET = 0.9;

    /**
     * Re-tee. `vary` re-rolls the green and drops the ball at a random spot that
     * is far enough from the cup to be a real putt — rejection-sampled rather
     * than nudged, so the ball genuinely moves around the green between rounds.
     */
    const resetBall = (vary: boolean) => {
      const b = playBox();
      if (vary) {
        rollGreen();
        placeCup();
        const minD = Math.min(b.w, b.h) * 0.42;
        let bestFx = 0.2;
        let bestFy = 0.7;
        let bestD = -1;
        for (let k = 0; k < 12; k++) {
          const fx = 0.08 + hash2(round * 97 + k, 17) * 0.84;
          const fy = 0.08 + hash2(round * 89 + k, 23) * 0.84;
          const px = b.x + b.w * fx;
          const py = b.y + b.h * fy;
          const dd = Math.hypot(px - cupX, py - cupY);
          if (dd > bestD) { bestD = dd; bestFx = fx; bestFy = fy; }
          if (dd > minD) break;   // good enough, stop early
        }
        /* Then pull the tee IN along its own line until a full-power putt can
           reach it. Moving the tee rather than touching the physics is the
           point: the cup stays 13px, the rim-out speed stays 520, friction and
           the slope are untouched, so nothing about how a putt PLAYS is made
           easier — the only thing removed is holes that were never winnable.
           `minD` is a hard floor, so this can never collapse into a gimme
           (without it, one round in the sample teed off 4px from the cup). */
        let px = b.x + b.w * bestFx;
        let py = b.y + b.h * bestFy;
        for (let i = 0; i < 6; i++) {
          const dd = Math.hypot(px - cupX, py - cupY);
          const cap = reachToward(px, py) * REACH_BUDGET;
          if (dd <= cap || dd <= minD) break;
          // Iterated because shortening the line changes the slope it crosses.
          const t = Math.max(cap, minD) / dd;
          px = cupX + (px - cupX) * t;
          py = cupY + (py - cupY) * t;
        }
        startFx = (px - b.x) / b.w;
        startFy = (py - b.y) / b.h;
      }
      ballX = b.x + b.w * startFx;
      ballY = b.y + b.h * startFy;
      velX = 0;
      velY = 0;
      phase = 'idle';
      pullX = 0;
      pullY = 0;
      onWall = false;
      stalled = 0;
      rollTime = 0;
    };

    /** Boxed so resetBall can read the animation clock without forward refs. */
    const clockRef = { v: 0 };

    /** Coarse pointer = finger. Checked once; a mouse and a touch screen want
     *  very different grab radii and pull lengths. */
    const coarse =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;

    const inBall = (x: number, y: number) => {
      const dx = x - ballX;
      const dy = y - ballY;
      // 26px is fine for a cursor and far too small for a fingertip — the
      // recommended minimum touch target is 44px across, i.e. a 22px radius
      // just to cover the contact patch, before any aiming precision.
      const r = coarse ? 42 : 26;
      return dx * dx + dy * dy <= r * r;
    };

    /**
     * How far you must drag for full power.
     *
     * On a phone this CANNOT be the desktop 150px. You aim by dragging back
     * AWAY from your target, so the usable drag length is however much screen
     * lies behind the ball — and at 390px wide with the ball near the edge of
     * the play box that was as little as 31px, capping power at ~20% and making
     * a putt off the side wall impossible. Shorter pull + a play box inset
     * further from the screen edge (see playBox) is what makes every lie
     * playable.
     */
    const maxPull = () => (narrow ? 90 : MAX_PULL);

    /** Advance the ball one step. Returns true while it is still moving. */
    const stepBall = (dt: number) => {
      const hm = home();
      const span = Math.min(cssW, cssH) * 0.5;
      const s = slopeAt(ballX, ballY, hm.x, hm.y, span, tiltAng, tiltMag, gSeed);
      velX += s.gx * dt;
      velY += s.gy * dt;
      // Exponential friction — frame-rate independent.
      const keep = Math.pow(FRICTION, dt);
      velX *= keep;
      velY *= keep;
      ballX += velX * dt;
      ballY += velY * dt;

      // Soft walls: nudge back into the play box rather than hard-clamping, so
      // a wayward putt does not stick to an invisible edge.
      const b = playBox();
      /* Edges absorb rather than bounce. An early version reflected at 0.4,
         which let a strong putt ricochet around the box for seconds and ended
         every attempt in the same corner — that masked the slope entirely and
         made two putts from opposite sides look identical. */
      let atL = false;
      let atR = false;
      let atT = false;
      let atB = false;
      if (ballX < b.x) { ballX = b.x; velX = 0; atL = true; }
      if (ballX > b.x + b.w) { ballX = b.x + b.w; velX = 0; atR = true; }
      if (ballY < b.y) { ballY = b.y; velY = 0; atT = true; }
      if (ballY > b.y + b.h) { ballY = b.y + b.h; velY = 0; atB = true; }
      const touching = atL || atR || atT || atB;
      /* Damp the TANGENTIAL component only on the frame contact begins.
         Applying it every frame (as this used to) meant a ball held against a
         wall by the slope had its along-the-wall speed halved on every single
         frame, so it could never slide to a corner and never build enough speed
         to leave — it just died in place against the wall. */
      if (touching && !onWall) {
        if (atL || atR) velY *= 0.5;
        if (atT || atB) velX *= 0.5;
      }
      onWall = touching;

      // Cup capture: close enough AND slow enough. Too hot and it rims out,
      // which is both realistic and stops the game being trivial.
      const dcx = cupX - ballX;
      const dcy = cupY - ballY;
      const dist = Math.sqrt(dcx * dcx + dcy * dcy);
      const speed = Math.sqrt(velX * velX + velY * velY);
      if (dist < CUP_R) {
        if (speed < 520) {
          phase = 'sunk';
          sunkAt = clockRef.v;
          ballX = cupX;
          ballY = cupY;
          velX = 0;
          velY = 0;
          return false;
        }
        // Rim-out: deflect around the lip instead of dropping.
        const nx = dcx / (dist || 1);
        const ny = dcy / (dist || 1);
        velX -= nx * speed * 0.9;
        velY -= ny * speed * 0.9;
      }

      /* A ball only comes to rest where the ground is flat enough to hold it.
         The first version stopped on speed alone, so a slow ball parked
         mid-slope and then sat there inert — measured as literally zero drift
         from a standstill on every green, which made the slope feel absent no
         matter how steep it was. Now the stop test also requires the local
         gradient to be gentle; on a real incline the ball keeps trickling. */
      /* A WALL CAN HOLD THE BALL. The green is built on a dominant constant
         fall-line plane (deliberately — a plane has no local minima, so nothing
         acts as an attractor), which means `slopeMag` is roughly 70 almost
         everywhere against a 33.6 threshold. So `holds` was essentially never
         true on open ground: every putt trickled downhill until it reached the
         edge of the play box, and there the clamp above zeroed its normal
         velocity while `holds` stayed false — so `phase` never returned to
         'idle', and since aiming requires 'idle' the ball became permanently
         unplayable. That is the "ball sticks at the bottom and dies" bug.

         The fix is physical rather than a fudge: a wall the slope is pressing
         the ball INTO supplies a reaction force, so that component of the
         gradient is supported and must not count toward "is this ground too
         steep to rest on". Zero the supported components and test the
         remainder. A ball pressed straight into a wall now rests; a ball whose
         slope runs ALONG the wall still slides, down to the corner. */
      let rgx = s.gx;
      let rgy = s.gy;
      if (atL && rgx < 0) rgx = 0;
      if (atR && rgx > 0) rgx = 0;
      if (atT && rgy < 0) rgy = 0;
      if (atB && rgy > 0) rgy = 0;
      const slopeMag = Math.hypot(rgx, rgy);
      const holds = slopeMag < SLOPE_ACCEL * REST_SLOPE;

      /* Stall backstop. The wall-support rule above is the real fix, but the
         game must not be able to soft-lock for ANY geometry we did not think
         of — an unplayable hero is far worse than a ball that parks slightly
         early. If the ball has crawled below the stop speed for a sustained
         moment without qualifying, let it rest anyway. */
      if (speed < STOP_SPEED) stalled += dt;
      else stalled = 0;

      /* Roll-time cap. Distinct from the stall guard: a ball trickling down a
         constant fall line stays ABOVE the stop speed indefinitely, so `stalled`
         never accumulates and the putt just keeps going. Measured one putt still
         rolling at 11.2s — not soft-locked, but you cannot putt again until it
         rests, and eleven seconds of waiting reads as broken. Cap the roll and
         let it settle where it lies. */
      rollTime += dt;

      if (rollTime > MAX_ROLL || (speed < STOP_SPEED && (holds || stalled > 0.9))) {
        velX = 0;
        velY = 0;
        stalled = 0;
        rollTime = 0;
        phase = 'idle';
        return false;
      }
      // Creep cap: keep a trickling ball from looking like it is vibrating.
      if (speed < 6 && !holds) {
        velX += s.gx * dt * 0.5;
        velY += s.gy * dt * 0.5;
      }
      return true;
    };

    /**
     * Client coords -> UNTRANSFORMED canvas coords.
     *
     * The divide is not cosmetic. gsap-motion.js's pinned hero scrubs a scale on
     * `.hero-canvas-wrap` (1 -> ~1.12), so getBoundingClientRect() returns the
     * TRANSFORMED box while ballX/ballY live in untransformed canvas pixels. Using
     * the raw rect offset therefore put the hit test up to ~69px away from where
     * the ball is actually painted (measured at scale 1.0991 with ballX ~700),
     * far outside the 26-42px grab radius: on desktop, once you had scrolled at
     * all, clicking the visible ball did nothing.
     *
     * rect.width / cssW recovers the live scale, since cssW is the canvas's own
     * untransformed CSS width.
     */
    const toCanvas = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const sx = cssW > 0 && rect.width > 0 ? rect.width / cssW : 1;
      const sy = cssH > 0 && rect.height > 0 ? rect.height / cssH : 1;
      return { x: (clientX - rect.left) / sx, y: (clientY - rect.top) / sy };
    };

    const localPt = (e: PointerEvent) => toCanvas(e.clientX, e.clientY);

    const onPointer = (e: PointerEvent | MouseEvent) => {
      // Same scale correction as localPt — the pull vector is measured against
      // ball coords, so it has to be in the same space.
      const p = toCanvas(e.clientX, e.clientY);
      ptrX = p.x;
      ptrY = p.y;
      lastPtr = performance.now();

      // Aiming: the pull vector runs from the pointer BACK to the ball, like
      // drawing a putter back — so you drag away from your intended line.
      if (phase === 'aiming') {
        const dx = ballX - ptrX;
        const dy = ballY - ptrY;
        const len = Math.sqrt(dx * dx + dy * dy);
        const clamped = Math.min(len, maxPull());
        pullX = len ? (dx / len) * clamped : 0;
        pullY = len ? (dy / len) * clamped : 0;
      }
    };

    /* ---------------- game input ----------------
       Listeners live on the WRAPPER, not the window, and the wrapper is
       pointer-events:none except for the ball hit area, so the hero copy stays
       selectable and the nav/explore-cue stay clickable. */

    /* Game input listens on the hero SECTION, not the canvas wrapper: the wrapper
       is pointer-events:none (so it cannot swallow clicks on the copy or the
       explore cue), which also means it never receives events itself.
       Declared here rather than beside the listener registrations because
       onDown/onUp reach for it to lock touch-action for the gesture. */
    const host: HTMLElement = wrap.closest('.band-home') ?? wrap.parentElement ?? wrap;

    /* THE BALL HANDLE — why this element exists.
       `touch-action` is resolved by the browser at TOUCHSTART, from the hit-test
       element and its ancestors. Setting it from a pointerdown handler is already
       too late: the compositor has committed to a pan and the page scrolls out
       from under the drag. Measured before this: 5 of 7 lies scrolled mid-putt.

       It cannot go on the hero section either -- `touch-action: none` there would
       mean a swipe anywhere over the hero (or, on mobile, over the whole green
       band) no longer scrolls the page, which is far worse than a fiddly putt.

       So the only element that declines the pan is a small circle that tracks the
       ball. Touches ON THE BALL are ours; every other touch on the green still
       scrolls normally. `pointer-events: auto` is explicit because the wrapper
       above it is `pointer-events: none`. */
    const handle = document.createElement('div');
    handle.setAttribute('aria-hidden', 'true');
    const HANDLE_R = coarse ? 44 : 30;
    handle.style.cssText =
      'position:absolute;width:' + HANDLE_R * 2 + 'px;height:' + HANDLE_R * 2 + 'px;' +
      'margin:' + -HANDLE_R + 'px 0 0 ' + -HANDLE_R + 'px;' +
      'border-radius:50%;background:transparent;pointer-events:auto;' +
      'touch-action:none;-ms-touch-action:none;cursor:grab;z-index:1;';
    wrap.appendChild(handle);

    /** Park the handle on the ball. Only has to be right when the ball is at
     *  rest, since you cannot aim a moving ball. */
    const syncHandle = () => {
      handle.style.left = ballX + 'px';
      handle.style.top = ballY + 'px';
      handle.style.display = phase === 'rolling' ? 'none' : 'block';
    };


    const onDown = (e: PointerEvent) => {
      // 'aiming' too: the press can reach us twice (handle target, then bubbling
      // to host). Re-entering would reset the pull and re-capture mid-gesture.
      if (phase === 'rolling' || phase === 'aiming') return;
      const p = localPt(e);
      if (!inBall(p.x, p.y)) return;
      // Only now do we capture the pointer — before this the event passes through.
      phase = 'aiming';
      pullX = 0;
      pullY = 0;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch { /* older Safari — the move/up listeners still fire */ }
      /* Hand the whole gesture to us for its duration. On iOS the compositor can
         claim a pan BEFORE the first pointermove arrives, and by then
         preventDefault is too late — so the scroll has to be disabled up front
         and restored on release. Only set while actually aiming, so normal
         scrolling over the hero is unaffected. */
      prevTouchAction = host.style.touchAction;
      host.style.touchAction = 'none';
      if (e.cancelable) e.preventDefault();
    };

    const onUp = (e: PointerEvent) => {
      if (phase !== 'aiming') return;
      // Restore scrolling first, before any early return below.
      host.style.touchAction = prevTouchAction;
      const power = Math.sqrt(pullX * pullX + pullY * pullY) / maxPull();
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch { /* ignore */ }
      if (power < 0.06) {
        // A tap, not a putt — do not burn a stroke.
        phase = 'idle';
        pullX = 0;
        pullY = 0;
        return;
      }
      const len = Math.sqrt(pullX * pullX + pullY * pullY) || 1;
      velX = (pullX / len) * power * MAX_SPEED;
      velY = (pullY / len) * power * MAX_SPEED;
      pullX = 0;
      pullY = 0;
      phase = 'rolling';
      onWall = false;
      stalled = 0;
      rollTime = 0;
      putts += 1;
      start(); // make sure the loop is running to animate the roll
    };

    /** Re-tee after a sunk putt so it can be replayed. */
    /** Optional: tap anywhere on the green to skip the celebration and re-tee
     *  immediately. Purely an accelerator — the auto re-tee in tick() means the
     *  game never depends on the player finding this. */
    const onTapReset = (e: PointerEvent) => {
      if (phase !== 'sunk') return;
      const p = localPt(e);
      const b = playBox();
      if (p.x < b.x || p.x > b.x + b.w || p.y < b.y || p.y > b.y + b.h) return;
      resetBall(true);
      e.preventDefault();
    };

    /* ---------------- drawing ---------------- */

    const closedCurve = (px: Float32Array, py: Float32Array, n: number) => {
      ctx.beginPath();
      ctx.moveTo((px[n - 1] + px[0]) / 2, (py[n - 1] + py[0]) / 2);
      for (let k = 0; k < n; k++) {
        const nx = px[(k + 1) % n];
        const ny = py[(k + 1) % n];
        ctx.quadraticCurveTo(px[k], py[k], (px[k] + nx) / 2, (py[k] + ny) / 2);
      }
      ctx.closePath();
    };

    const bx = new Float32Array(NODES);
    const by = new Float32Array(NODES);
    const dotPts: Array<[number, number]> = [];

    /**
     * @param time  seconds of animation clock (0 for the static frame)
     * @param intro 0..1 alpha ramp so the layer settles in rather than snapping
     */
    const render = (time: number, intro: number) => {
      // Focus point: eased toward the pointer, or the idle orbit when the
      // pointer has gone quiet (or never existed — touch / no-pointer).
      const orb = orbit(time);
      if (!seeded) {
        focusX = orb.x;
        focusY = orb.y;
        ptrX = orb.x;
        ptrY = orb.y;
        seeded = true;
      }
      const stale = (performance.now() - lastPtr) / 1000 > 2.2 ? 1 : 0;
      idleMix += (stale - idleMix) * 0.02;
      const tx = orb.x * idleMix + ptrX * (1 - idleMix);
      const ty = orb.y * idleMix + ptrY * (1 - idleMix);
      focusX += (tx - focusX) * 0.075;
      focusY += (ty - focusY) * 0.075;

      // The whole nest drifts toward the focus — a parallax echo of the GSAP
      // motif parallax this layer replaces.
      const hm = home();
      const cx = hm.x + (focusX - hm.x) * 0.16;
      const cy = hm.y + (focusY - hm.y) * 0.14;

      const infl = Math.max(240, Math.min(cssW, cssH) * 0.62);
      const bulge = Math.min(cssW, cssH) * 0.1;
      const shear = bulge * 0.42;

      ctx.clearRect(0, 0, cssW, cssH);
      ctx.globalAlpha = intro;
      dotPts.length = 0;

      /* ONE SOURCE OF TRUTH.
         The decorative ring nest and the physics iso-contours are both contour
         maps, so drawing both made it impossible to tell which lines described
         the surface the ball actually rolls on — the green became unreadable.
         The rings are therefore skipped while the green is playable; the only
         lines on screen are the real ones. Under reduced motion (no game) the
         rings come back, because there the layer is pure decoration. */
      const decorative = reduced;

      for (let i = 0; decorative && i < rings.length; i++) {
        const ring = rings[i];
        const nOffX = ring.seed + time * 0.055;
        const nOffY = ring.seed * 0.62 - time * 0.041;
        const nScale = 1.15 + i * 0.05;

        const rcx = cx + ring.ox;
        const rcy = cy + ring.oy;

        for (let j = 0; j < NODES; j++) {
          const ang = (j / NODES) * TAU;
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);

          // Sampling noise ON a circle keeps the ring seamless at ang=0.
          const n = fbm(ca * nScale + nOffX, sa * nScale + nOffY);
          const r = ring.r + n * 2 * ring.amp;

          const ux = ca;
          const uy = sa * SQUASH;
          let x = rcx + ux * r;
          let y = rcy + uy * r;

          // Pointer swell: nodes near the focus bloom outward with a touch of
          // tangential shear, so the contour map "parts" around the cursor.
          const dx = x - focusX;
          const dy = y - focusY;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < infl) {
            const f = 1 - d / infl;
            // smoothstep — a soft shoulder rather than a visible influence edge
            const f2 = f * f * (3 - 2 * f);
            x += ux * f2 * bulge - uy * f2 * shear;
            y += uy * f2 * bulge + ux * f2 * shear;
          }

          bx[j] = x;
          by[j] = y;
        }

        closedCurve(bx, by, NODES);
        ctx.strokeStyle = ring.grad ?? `rgba(${ring.rgb},${ring.alpha})`;
        ctx.lineWidth = ring.width;
        ctx.stroke();

        for (let k = 0; k < DOTS.length; k++) {
          if (DOTS[k][0] !== i) continue;
          const j = Math.min(NODES - 1, Math.round(DOTS[k][1] * NODES));
          dotPts.push([bx[j], by[j]]);
        }
      }

      // One editorial hairline — the descendant of the motif's `M40 250 L360 250`
      // baseline. Bows gently toward the focus.
      if (decorative && hairGrad) {
        // Narrow: sit inside the reserved band below the copy. The old fixed
        // 0.66 landed in the middle of the intro paragraph.
        const hBase = narrow ? cssH * (copyBottom + (1 - copyBottom) * 0.4) : 0;
        const hy = narrow ? hBase + (focusY - hBase) * 0.1 : cy + cssH * 0.33;
        ctx.beginPath();
        for (let j = 0; j < HAIR_NODES; j++) {
          const t = j / (HAIR_NODES - 1);
          const x = -cssW * 0.04 + cssW * 1.08 * t;
          let y = hy + fbm(t * 2.6 + time * 0.06, 7.3) * 12;
          const d = Math.abs(x - focusX) + Math.abs(y - focusY) * 0.8;
          if (d < infl) {
            const f = 1 - d / infl;
            y += f * f * (3 - 2 * f) * 26 * (y > focusY ? 1 : -1);
          }
          if (j === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = hairGrad;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Accent dots — small open circles, alpha ramped by hand (too few to
      // justify a gradient).
      for (let k = 0; decorative && k < dotPts.length; k++) {
        const [dx2, dy2] = dotPts[k];
        // Dots honour the same fade axis + onset as the ring gradients.
        const ramp = narrow
          ? Math.max(0, Math.min(1, (dy2 / cssH - 0.52) / 0.34))
          : Math.max(0, Math.min(1, (dx2 / cssW - 0.44) / 0.4));
        if (ramp <= 0.02) continue;
        ctx.beginPath();
        ctx.arc(dx2, dy2, 3.8, 0, TAU);
        ctx.strokeStyle = `rgba(${SAGE_DEEP},${(0.62 * ramp * globalAlpha).toFixed(4)})`;
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }

      /* ---------------- the green: cup, flag, ball, aim ----------------
         Drawn last so it reads as ink laid over the contour map. Everything is
         stroke-first in the sage register — an editorial illustration, not a
         game sprite. */

      /* --- Slope contours of the ACTUAL physics field ---
         The decorative rings above sample noise on a circle in their own
         animated space; they are atmosphere and they do NOT describe the surface
         the ball rolls on. Without this layer "read the green" is impossible,
         because the picture and the physics disagree.

         So: march a coarse grid over the play box, evaluate the same heightAt()
         the ball integrates, and stroke marching-squares iso-lines. Tight bands
         therefore genuinely mean steep, and the direction of the bands is the
         fall line. A downhill tick marks which way is low. */
      {
        const b = playBox();
        const hm2 = home();
        const span2 = Math.min(cssW, cssH) * 0.5;
        const STEP = 26;
        const cols = Math.max(2, Math.ceil(b.w / STEP));
        const rowsN = Math.max(2, Math.ceil(b.h / STEP));
        const gw = b.w / cols;
        const gh = b.h / rowsN;

        // Height grid (one extra row/col so every cell has four corners).
        const H: number[] = [];
        let hMin = Infinity;
        let hMax = -Infinity;
        for (let r = 0; r <= rowsN; r++) {
          for (let c = 0; c <= cols; c++) {
            const hv = heightAt(b.x + c * gw, b.y + r * gh, hm2.x, hm2.y, span2, tiltAng, tiltMag, gSeed);
            H[r * (cols + 1) + c] = hv;
            if (hv < hMin) hMin = hv;
            if (hv > hMax) hMax = hv;
          }
        }
        const at = (r: number, c: number) => H[r * (cols + 1) + c];

        /* No background wash: an early version filled the cells to show
           elevation, but a filled rect made the play box read as a UI panel
           bolted onto the hero — a hard grey edge at its left boundary. Instead
           the LINES carry everything, and they are faded at the box edges by the
           same gradient discipline the rest of the layer uses, so the green has
           no visible border. */
        const LEVELS = 9;
        ctx.lineWidth = 1;

        /* THE CUP IS THE DATUM, and each quantity gets ITS OWN CHANNEL.

             contour SPACING          steepness      (tight = steep)
             contour WEIGHT + ALPHA   elevation      (bolder = higher)
             contour DASHING          elevation sign (dashed = below the hole)
             arrow LENGTH             steepness      (same signal as spacing)
             arrow DIRECTION          the fall line
             arrow weight             CONSTANT — see the note at the arrows

           The first attempt at this put elevation on contour WEIGHT — darker
           above the cup, lighter below. It was measured and it worked, and it was
           still wrong: arrow weight already means steepness, so "boldness" carried
           two unrelated meanings on the same drawing. Height and gradient are
           mathematically independent (you can be high on flat ground, or low on a
           steep face), so the two never correlated and the whole thing read as
           noise. Reported as exactly that — "no behavior from the dark vs light
           lines impacting the magnitude nor direction of the arrows". Correct
           observation; the encoding was the bug, not the rendering.

           Dashing is a free channel and a real cartographic convention for
           below-datum contours, so elevation moved there and weight is now used
           for one thing only.

           HONEST LIMIT — do NOT claim ridge/valley readability from this field.
           A closed loop of solid bands would be a rise and a closed loop of
           dashed bands a hollow, but this terrain has almost no closed loops.
           Measured over the play box, 44x44 grid, three rounds:

             plane share of relief   70% / 62% / 77%
             local peaks              1  /  4  /  0
             local hollows            1  /  5  /  2
             arrow direction spread  34.7 / 68.1 / 22.7 deg (circular SD)

           It is a tilted plane with a light dressing of noise, so contours run
           near-parallel and nearly every arrow points the same way. The
           consequence, raised in review: arrows never diverge across a ridge or
           converge into a valley, because there is no ridge and no valley. The
           encoding above is coherent — arrows are perpendicular to contours
           (mean 1.8% tangential height change) and |gradient| tracks contour
           spacing at r = -0.81 — but coherent about a surface with little to say.

           This is a side effect of a deliberate earlier fix: raw fbm basins acted
           as gravity wells (every putt converged within 5px) and letting a plane
           dominate cured it, because a plane has no local minima. It also removed
           the structure worth reading.

           The distinction that fix missed: HOLLOWS are the problem, ridges and
           saddles are not. A local minimum traps the ball; a ridge only deflects
           it, and a channel draining toward the cup is good golf. So the
           undulation amplitude (0.42 + 0.16 against a plane of 0.62-1.10) CAN
           rise — it must simply not form a closed basin away from the cup. Any
           such change needs the soft-lock suite plus a putt-endpoint spread test
           to prove no new attractor, and a one-stroke solvability check to prove
           the green is still winnable.

           This replaces an "index contour every 3rd line" rule borrowed from
           topo maps. That convention only works because a real map LABELS its
           index contours with an elevation; unlabelled it carried no information
           at all. It was also barely visible — with LEVELS = 9 the loop draws 8
           lines and `li % 3 === 0` matched exactly two of them, so there was no
           rhythm to read. And because the levels are re-normalised to each
           frame's hMin..hMax, those two lines drifted as the field moved, so
           they were not even a stable landmark.

           The cup-relative pass that replaced it (dashed below the hole, one
           heavier band at cup height) is also gone. A single monotonic ramp beats
           a ramp plus two exceptions, and the exceptions restated something the
           flag and cup already say literally. */
        for (let li = 1; li < LEVELS; li++) {
          const lv = hMin + ((hMax - hMin) * li) / LEVELS;
          ctx.beginPath();
          for (let r = 0; r < rowsN; r++) {
            for (let c = 0; c < cols; c++) {
              const x0 = b.x + c * gw;
              const y0 = b.y + r * gh;
              const h00 = at(r, c);
              const h10 = at(r, c + 1);
              const h01 = at(r + 1, c);
              const h11 = at(r + 1, c + 1);
              // Interpolated crossings on each edge, then join them pairwise.
              const pts: Array<[number, number]> = [];
              if ((h00 < lv) !== (h10 < lv)) pts.push([x0 + gw * ((lv - h00) / (h10 - h00)), y0]);
              if ((h10 < lv) !== (h11 < lv)) pts.push([x0 + gw, y0 + gh * ((lv - h10) / (h11 - h10))]);
              if ((h01 < lv) !== (h11 < lv)) pts.push([x0 + gw * ((lv - h01) / (h11 - h01)), y0 + gh]);
              if ((h00 < lv) !== (h01 < lv)) pts.push([x0, y0 + gh * ((lv - h00) / (h01 - h00))]);
              for (let k = 0; k + 1 < pts.length; k += 2) {
                ctx.moveTo(pts[k][0], pts[k][1]);
                ctx.lineTo(pts[k + 1][0], pts[k + 1][1]);
              }
            }
          }
          /* ONE QUANTITY PER VISUAL CHANNEL. See the note above the level loop —
             weight is NOT used here, because weight already means steepness on
             the arrows. Elevation gets its own channel: dash pattern.

               solid            at or above cup height
               dashed           below cup height  (an uphill putt from there)
               solid + heavier  the one band through cup height — the landmark

             Steepness is left entirely to contour SPACING, which encodes it
             exactly and for free: iso-lines of a fixed interval crowd together
             where the surface is steep. That is also why spacing agrees with the
             arrows automatically — both are reading the gradient. */
          /* BOLDNESS = ELEVATION. Bolder and darker is higher ground, lighter and
             finer is lower. Both channels on this contour now encode the SAME
             quantity at different granularity, which is why they reinforce rather
             than compete:

               weight + alpha   continuous elevation across the band stack
               dash pattern     the binary: below cup height or not

             The dash boundary IS the cup line, so the hole needs no separate
             heavier band — a bolded datum would read as "highest", contradicting
             the ramp. (An earlier version did bold it; removed.)

             Elevation is normalised to THIS frame's hMin..hMax, the same datum
             the band positions use, so the ramp cannot drift out of step with the
             levels it is colouring. */
          /* ONE CONTINUOUS GRADIENT: darkness and weight both ramp with
             elevation. Dark and heavy is high ground, pale and fine is low.
             Every band is solid.

             Dashing used to mark bands below cup height, and a heavier band
             marked cup height itself. Both are gone: a single monotonic ramp is
             easier to read at a glance than a ramp plus two exceptions, and the
             exceptions were encoding a second fact (where the hole sits) that the
             flag and cup already state literally.

             Normalised to THIS frame's hMin..hMax — the same datum the band
             positions use — so the ramp can never drift out of step with the
             levels it is colouring. */
          const t = hMax > hMin ? (lv - hMin) / (hMax - hMin) : 0.5;
          /* Colour is INTERPOLATED, not switched. A `t > 0.5 ? SAGE_DEEP : SAGE`
             ternary put a hard step in the middle of the stack, which reads as a
             band boundary — the opposite of a standard gradient. Lerping sage ->
             sage-deep keeps weight, alpha and hue all monotonic in elevation.
             Measured span across the 8 drawn levels (t = 0.111 .. 0.889):
               width 0.67 -> 1.83px (2.7x)   alpha 0.177 -> 0.503 (2.8x) */
          const cr = Math.round(95 + (78 - 95) * t);
          const cg = Math.round(122 + (102 - 122) * t);
          const cb = Math.round(79 + (64 - 79) * t);
          ctx.lineWidth = 0.5 + 1.5 * t;
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${((0.13 + 0.42 * t) * globalAlpha).toFixed(3)})`;
          ctx.stroke();
        }

        /* Fall-line arrows on a sparse grid. Contours tell you WHERE it is
           steep; these tell you WHICH WAY, and how hard.

           THE ARROWS AND THE CONTOURS MUST AGREE, and they did not.

           Direction was never wrong — arrows, contours and the ball all read the
           same field through the same home()/span, so an arrow is always
           perpendicular to its contour by construction. What was broken was
           MAGNITUDE.

           The old length was `7 + min(7, m / 260)`. Measured over a real play
           box, |gradient| ranges about 5 -> 224 (a 28-58x spread depending on the
           round's tilt), so m/260 only ever reached 0.86 and arrow length varied
           from 7.02px to 7.86px — a 1.09x spread. Reaching the intended +7 would
           have needed m = 1820, eight times anything the field produces. So every
           arrow drew the same length while the contour bands visibly tightened
           and loosened around them. That is the disconnect: not direction, but an
           arrow that claimed to encode steepness and did not.

           The contour bands are normalised to THIS FRAME's hMin..hMax (9 equal
           levels), so they express steepness relative to the green in front of
           you, not on an absolute scale. The arrows now do the same: length,
           weight and alpha all key off m / mMax over the same sampled grid. Both
           encodings are frame-relative, so "tight bands" and "long dark arrow"
           now mean the same thing. Matching the arrows to an absolute constant
           instead would have re-broken them on the next re-tee, because tiltMag
           is re-rolled per round and moves the whole range. */
        const arrows: Array<{ px: number; py: number; ux: number; uy: number; m: number }> = [];
        let mMax = 0;
        /* Every 7th cell, not every 4th. At 4 the desktop box carried ~36
           arrows, which fought the contours for attention and read as clutter;
           7 gives ~12-16 and lets the bands do the talking. The arrows are the
           annotation, not the drawing. */
        for (let r = 2; r < rowsN; r += 7) {
          for (let c = 2; c < cols; c += 7) {
            const px = b.x + c * gw;
            const py = b.y + r * gh;
            const sg = slopeAt(px, py, hm2.x, hm2.y, span2, tiltAng, tiltMag, gSeed);
            const m = Math.hypot(sg.gx, sg.gy);
            if (m < 1) continue;
            arrows.push({ px, py, ux: sg.gx / m, uy: sg.gy / m, m });
            if (m > mMax) mMax = m;
          }
        }
        for (let i = 0; i < arrows.length; i++) {
          const a = arrows[i];
          /* Normalised steepness, gamma-corrected. sqrt() because the raw ratio
             spends most of its range near the low end (the plane dominates, so
             most cells sit well under the peak) and a linear map left almost
             every arrow stubby — the same "no visible variation" failure in a
             new disguise. */
          const t = mMax > 0 ? Math.sqrt(Math.min(1, a.m / mMax)) : 0;
          const len = 6 + 12 * t;                        // 6 -> 18px
          const head = 3 + 1.6 * t;
          ctx.beginPath();
          ctx.moveTo(a.px - a.ux * len * 0.5, a.py - a.uy * len * 0.5);
          ctx.lineTo(a.px + a.ux * len * 0.5, a.py + a.uy * len * 0.5);
          // chevron head, scaled with the shaft so steep arrows read as heavier
          ctx.lineTo(
            a.px + a.ux * len * 0.5 - a.ux * head - a.uy * head * 0.73,
            a.py + a.uy * len * 0.5 - a.uy * head + a.ux * head * 0.73,
          );
          /* Weight and alpha are CONSTANT here, deliberately. They used to ramp
             with steepness, but contour boldness now means ELEVATION — and one
             visual language cannot mean two things on one drawing without reading
             as noise, which is the mistake this section already made once. So
             steepness is carried by arrow LENGTH alone (6 -> 18px, a 2.2-2.4x
             spread), and every arrow is drawn at one weight. */
          ctx.strokeStyle = `rgba(${OLIVE},${(0.42 * globalAlpha).toFixed(3)})`;
          ctx.lineWidth = 1.1;
          ctx.stroke();
        }

        /* Soft-edge the green so it has no visible boundary. destination-out
           with a radial gradient erases the outer band of everything drawn
           above, which is what stops the play box reading as a panel. */
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        const vg = ctx.createRadialGradient(
          b.x + b.w * 0.5, b.y + b.h * 0.5, Math.min(b.w, b.h) * 0.22,
          b.x + b.w * 0.5, b.y + b.h * 0.5, Math.max(b.w, b.h) * 0.62
        );
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(0.62, 'rgba(0,0,0,0)');
        vg.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = vg;
        ctx.fillRect(b.x - 40, b.y - 40, b.w + 80, b.h + 80);
        ctx.restore();

        // Fall-line tick at the cup: shows which way the green runs away.
        const sc = slopeAt(cupX, cupY, hm2.x, hm2.y, span2, tiltAng, tiltMag, gSeed);
        const sl = Math.hypot(sc.gx, sc.gy) || 1;
        ctx.beginPath();
        ctx.moveTo(cupX, cupY);
        ctx.lineTo(cupX + (sc.gx / sl) * 26, cupY + (sc.gy / sl) * 26);
        ctx.strokeStyle = `rgba(${OLIVE},${(0.55 * globalAlpha).toFixed(3)})`;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      // Cup: a filled ellipse (reads as a hole in the surface) with a lip.
      ctx.beginPath();
      ctx.ellipse(cupX, cupY, CUP_R, CUP_R * 0.62, 0, 0, TAU);
      ctx.fillStyle = `rgba(${SAGE_DEEP},0.5)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${SAGE_DEEP},0.85)`;
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // Flagstick + pennant, leaning with a slow sway.
      flagSway = Math.sin(time * 1.1) * 0.06;
      const poleH = 40;
      const topX = cupX + flagSway * poleH;
      const topY = cupY - poleH;
      ctx.beginPath();
      ctx.moveTo(cupX, cupY);
      ctx.lineTo(topX, topY);
      ctx.strokeStyle = `rgba(${SAGE_DEEP},0.8)`;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.lineTo(topX + 15, topY + 5);
      ctx.lineTo(topX, topY + 10);
      ctx.closePath();
      ctx.fillStyle = `rgba(${SAGE},0.75)`;
      ctx.fill();

      // Aim line while dragging: dotted, pointing the way the ball will START
      // (opposite the pull), plus a power arc at the ball.
      if (phase === 'aiming') {
        const len = Math.sqrt(pullX * pullX + pullY * pullY);
        if (len > 4) {
          const ux = pullX / len;
          const uy = pullY / len;
          ctx.save();
          ctx.setLineDash([3, 6]);
          ctx.beginPath();
          ctx.moveTo(ballX, ballY);
          ctx.lineTo(ballX + ux * len * 1.7, ballY + uy * len * 1.7);
          ctx.strokeStyle = `rgba(${SAGE_DEEP},0.7)`;
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.restore();

          // Power ring fills clockwise as you pull further back.
          const p = Math.min(1, len / MAX_PULL);
          ctx.beginPath();
          ctx.arc(ballX, ballY, 13, -Math.PI / 2, -Math.PI / 2 + p * TAU);
          ctx.strokeStyle = `rgba(${OLIVE},0.95)`;
          ctx.lineWidth = 2.4;
          ctx.stroke();

          // The drawn-back "putter" ghost behind the ball.
          ctx.beginPath();
          ctx.moveTo(ballX - ux * 6, ballY - uy * 6);
          ctx.lineTo(ballX - ux * (len + 6), ballY - uy * (len + 6));
          ctx.strokeStyle = `rgba(${SAGE},0.35)`;
          ctx.lineWidth = 1.1;
          ctx.stroke();
        }
      }

      // Ball. Sunk = a small sage ripple out of the cup instead of a ball.
      if (phase === 'sunk') {
        const age = Math.max(0, time - sunkAt);
        const rr = 10 + age * 46;
        const fade = Math.max(0, 1 - age / 1.1);
        if (fade > 0) {
          ctx.beginPath();
          ctx.ellipse(cupX, cupY, rr, rr * 0.62, 0, 0, TAU);
          ctx.strokeStyle = `rgba(${SAGE},${(0.7 * fade).toFixed(3)})`;
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.arc(ballX, ballY, BALL_R, 0, TAU);
        ctx.fillStyle = 'rgba(253,253,250,0.96)';
        ctx.fill();
        ctx.strokeStyle = `rgba(${SAGE_DEEP},0.9)`;
        ctx.lineWidth = 1.3;
        ctx.stroke();
      }

      ctx.globalAlpha = 1;

      // Keep the touch handle parked on the ball. Two style writes per frame;
      // cheaper than tracking every place the ball can move.
      syncHandle();
    };

    /* ---------------- reduced motion: one frame, no loop, ever ---------------- */

    if (reduced) {
      // Static composition still shows the cup, flag and a placed ball — it
      // reads as a drawn green rather than a broken game. No listeners are
      // attached, so there is nothing to play and nothing to animate.
      layout();
      placeCup();
      resetBall(false);
      render(0, 1);
      w.__heroFrames = 1;
      w.__heroReducedMotion = true;
      const ro = new ResizeObserver(() => {
        layout();
        placeCup();
        resetBall(false);
        render(0, 1); // re-lay-out only; deliberately does NOT bump __heroFrames
      });
      ro.observe(wrap);
      return () => ro.disconnect();
    }

    /* ---------------- animated path ---------------- */

    let frames = 0;
    let raf = 0;
    let running = false;
    let visible = true;
    let clock = 0;
    let last = 0;
    let intro = 0;

    w.__heroFrames = 0;
    w.__heroReducedMotion = false;

    const tick = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      clock += dt;
      clockRef.v = clock;
      intro = Math.min(1, intro + dt * 1.3);
      if (phase === 'rolling') stepBall(dt);
      /* Auto re-tee. The first version required tapping within 60px of the cup,
         which nobody would ever discover — the ball just appeared to be stuck in
         the hole. Now the sink flourish plays and the next hole sets itself up,
         so the game keeps offering itself without asking for anything. */
      if (phase === 'sunk' && clock - sunkAt > 1.5) {
        resetBall(true);
      }
      render(clock, intro);
      w.__heroFrames = ++frames;
      w.__putt = { phase, putts, ball: [Math.round(ballX), Math.round(ballY)], cup: [Math.round(cupX), Math.round(cupY)] };
      // Instrumentation for the verification suite: the eased focus point the
      // field is currently reacting to. Read-only; nothing depends on it.
      w.__heroFocus = [Math.round(focusX), Math.round(focusY)];
      if (running) raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const sync = () => {
      if (visible && !document.hidden) start();
      else stop();
    };

    layout();
    placeCup();
    resetBall(false);
    render(0, 0.001); // paint something immediately; intro ramps from here

    /* Test hook: lets the verification suite drive a putt deterministically
       without synthesising drag gestures. Read/write; nothing in the component
       depends on it existing. */
    w.__puttTest = {
      aim(dx: number, dy: number, power: number) {
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        velX = (dx / len) * power * MAX_SPEED;
        velY = (dy / len) * power * MAX_SPEED;
        phase = 'rolling';
      onWall = false;
      stalled = 0;
      rollTime = 0;
        putts += 1;
        start();
      },
      place(fx: number, fy: number) {
        const b = playBox();
        ballX = b.x + b.w * fx;
        ballY = b.y + b.h * fy;
        velX = 0;
        velY = 0;
        phase = 'idle';
      },
      /** Mirrors the in-game tap-to-re-tee exactly (new green + new cup). */
      reset() {
        putts = 0;
        resetBall(true);
      },
      state() {
        return {
          phase,
          putts,
          ball: [ballX, ballY],
          cup: [cupX, cupY],
          speed: Math.sqrt(velX * velX + velY * velY),
          box: playBox(),
          // The measured copy extent the ink fade is derived from, so a test can
          // assert the fade adapts instead of inferring it from pixel sampling.
          copyEdge,
          copyBottom,
          narrow,
        };
      },
    };

    const ro = new ResizeObserver(() => {
      layout();
      placeCup();
      // Keep the ball inside the (possibly resized) play box.
      const b = playBox();
      ballX = Math.min(b.x + b.w, Math.max(b.x, ballX));
      ballY = Math.min(b.y + b.h, Math.max(b.y, ballY));
      if (!running) render(clock, Math.max(intro, 0.001));
    });
    ro.observe(wrap);

    /* Re-measure once webfonts swap in. The ResizeObserver above cannot cover
       this: a font swap changes the copy's GLYPH widths without changing the
       canvas wrap's box, so the observer never fires and the fade would stay
       calibrated against fallback-font metrics (Space Grotesk and Inter are
       both meaningfully wider than the system fallbacks). Cheap and idempotent
       — one extra layout() on the font-ready microtask. */
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready
        .then(() => {
          layout();
          if (!running) render(clock, Math.max(intro, 0.001));
        })
        .catch(() => {});
    }

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
        sync();
      },
      { threshold: 0 }
    );
    io.observe(wrap);

    const onVis = () => sync();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('pointerdown', onPointer, { passive: true });
    window.addEventListener('mousemove', onPointer as EventListener, { passive: true });

    /* onDown claims the gesture only when the press lands on the ball, so
       ordinary clicks, links and text selection are untouched. */
    /* BIND ON BOTH THE HANDLE AND THE SECTION, and here is why.
       The handle sits inside `.hero-canvas-wrap` at z-index 0, but `.band-inner`
       is z-index 1 — so wherever the ball lies under the content column, the copy
       wrapper is ON TOP of the handle and swallows the press. Binding aiming to
       the handle alone broke desktop putting in 5 of 10 lies, with
       elementFromPoint on the ball returning `DIV.band-inner home-inner`.

       `host` is an ANCESTOR of both, so it receives the bubbled pointerdown no
       matter which child was hit — that is what makes the gesture reliable. The
       handle keeps its own listeners purely so that on touch the press lands on
       an element that already declares `touch-action: none` (see its comment);
       onDown's phase guard stops the two paths double-firing. */
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointerdown', onTapReset);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointercancel', onUp);

    /* THE DRAG MUST BEAT THE PAGE SCROLL.
       The window `pointermove` above is `passive: true`, which by definition
       cannot call preventDefault() — so on a touch screen the browser treated an
       aiming drag as a page pan and scrolled the hero away mid-putt. That is the
       whole of "the touch and pull mechanism is iffy on mobile".

       This second listener is deliberately NON-passive and only cancels the
       default while `phase === 'aiming'`, i.e. only after onDown decided the
       press landed on the ball. Every other touch on the hero still scrolls
       normally. `touch-action: none` is also set on the host for the duration of
       the gesture (see onDown/onUp) because on iOS the browser can claim a pan
       before the first move event arrives, and preventDefault alone is too late
       in that case. */
    const onDragMove = (e: PointerEvent) => {
      if (phase !== 'aiming') return;
      onPointer(e);
      if (e.cancelable) e.preventDefault();
    };
    handle.addEventListener('pointermove', onDragMove, { passive: false });
    host.addEventListener('pointermove', onDragMove, { passive: false });

    sync();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('mousemove', onPointer as EventListener);
      host.removeEventListener('pointerdown', onTapReset);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onUp);
      host.removeEventListener('pointermove', onDragMove);
      host.style.touchAction = prevTouchAction;
      handle.removeEventListener('pointerdown', onDown);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      handle.removeEventListener('pointermove', onDragMove);
      handle.remove();
      delete w.__puttTest;
    };
  }, []);

  return (
    <div className="hero-canvas-wrap" ref={wrapRef} aria-hidden="true">
      <canvas className="hero-canvas" ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
