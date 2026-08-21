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
 * - The undulation is two octaves at a lower amplitude, which bends the line
 *   without ever reversing it. This is what makes different parts of the green
 *   play differently instead of everything draining one way.
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
  const undul =
    fbm(nx * 1.25 + seed, ny * 1.25 - seed) * 0.42 +
    fbm(nx * 2.9 - seed * 1.7, ny * 2.9 + seed * 1.3) * 0.16;
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
     * Wide viewports fade the ink out horizontally (left third is clean, so the
     * name/subtitle/intro sit on empty canvas). Narrow viewports have no
     * horizontal gutter, so they fade VERTICALLY instead — clean at the top
     * where the copy lives, ink only in the lower band.
     */
    const grad = (rgb: string, a: number): CanvasGradient => {
      if (narrow) {
        const g = ctx.createLinearGradient(0, 0, 0, cssH);
        g.addColorStop(0, `rgba(${rgb},0)`);
        g.addColorStop(0.5, `rgba(${rgb},0)`);
        g.addColorStop(0.72, `rgba(${rgb},${(a * 0.28).toFixed(4)})`);
        g.addColorStop(0.9, `rgba(${rgb},${a.toFixed(4)})`);
        g.addColorStop(1, `rgba(${rgb},${a.toFixed(4)})`);
        return g;
      }
      // Stops chosen so that at 1440 the copy column (which ends around x/W
      // ~0.52 for the subtitle, ~0.41 for the intro) sits under <10% of the
      // ring alpha even when the pointer drags contours leftward. Verified by
      // check 4f, which samples real glyph rects.
      const g = ctx.createLinearGradient(0, 0, cssW, 0);
      g.addColorStop(0, `rgba(${rgb},0)`);
      g.addColorStop(0.42, `rgba(${rgb},0)`);
      g.addColorStop(0.58, `rgba(${rgb},${(a * 0.16).toFixed(4)})`);
      g.addColorStop(0.75, `rgba(${rgb},${(a * 0.66).toFixed(4)})`);
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
     *  viewports that is low-centre (under the copy); on wide, right-of-centre. */
    const home = () => (narrow ? { x: cssW * 0.5, y: cssH * 0.82 } : { x: cssW * 0.7, y: cssH * 0.5 });

    const orbit = (t: number) => {
      const hm = home();
      return {
        x: hm.x + Math.cos(t * 0.17) * cssW * (narrow ? 0.09 : 0.14),
        y: hm.y + Math.sin(t * 0.23) * cssH * (narrow ? 0.05 : 0.2),
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
    let pullX = 0; // current drag vector (from ball toward the pointer)
    let pullY = 0;
    let putts = 0;
    let sunkAt = 0; // clock time the ball dropped, for the flourish
    let flagSway = 0;
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
        return { x: cssW * 0.1, y: cssH * 0.56, w: cssW * 0.8, h: cssH * 0.34 };
      }
      return { x: cssW * 0.48, y: cssH * 0.16, w: cssW * 0.46, h: cssH * 0.68 };
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
        startFx = bestFx;
        startFy = bestFy;
      }
      ballX = b.x + b.w * startFx;
      ballY = b.y + b.h * startFy;
      velX = 0;
      velY = 0;
      phase = 'idle';
      pullX = 0;
      pullY = 0;
    };

    /** Boxed so resetBall can read the animation clock without forward refs. */
    const clockRef = { v: 0 };

    const inBall = (x: number, y: number) => {
      const dx = x - ballX;
      const dy = y - ballY;
      return dx * dx + dy * dy <= 26 * 26; // generous grab radius
    };

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
      if (ballX < b.x) { ballX = b.x; velX = 0; velY *= 0.5; }
      if (ballX > b.x + b.w) { ballX = b.x + b.w; velX = 0; velY *= 0.5; }
      if (ballY < b.y) { ballY = b.y; velY = 0; velX *= 0.5; }
      if (ballY > b.y + b.h) { ballY = b.y + b.h; velY = 0; velX *= 0.5; }

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
      const slopeMag = Math.hypot(s.gx, s.gy);
      const holds = slopeMag < SLOPE_ACCEL * 0.014;
      if (speed < STOP_SPEED && holds) {
        velX = 0;
        velY = 0;
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

    const onPointer = (e: PointerEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      ptrX = e.clientX - rect.left;
      ptrY = e.clientY - rect.top;
      lastPtr = performance.now();

      // Aiming: the pull vector runs from the pointer BACK to the ball, like
      // drawing a putter back — so you drag away from your intended line.
      if (phase === 'aiming') {
        const dx = ballX - ptrX;
        const dy = ballY - ptrY;
        const len = Math.sqrt(dx * dx + dy * dy);
        const clamped = Math.min(len, MAX_PULL);
        pullX = len ? (dx / len) * clamped : 0;
        pullY = len ? (dy / len) * clamped : 0;
      }
    };

    /* ---------------- game input ----------------
       Listeners live on the WRAPPER, not the window, and the wrapper is
       pointer-events:none except for the ball hit area, so the hero copy stays
       selectable and the nav/explore-cue stay clickable. */

    const localPt = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onDown = (e: PointerEvent) => {
      if (phase === 'rolling') return;
      const p = localPt(e);
      if (!inBall(p.x, p.y)) return;
      // Only now do we capture the pointer — before this the event passes through.
      phase = 'aiming';
      pullX = 0;
      pullY = 0;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch { /* older Safari — the move/up listeners still fire */ }
      e.preventDefault();
    };

    const onUp = (e: PointerEvent) => {
      if (phase !== 'aiming') return;
      const power = Math.sqrt(pullX * pullX + pullY * pullY) / MAX_PULL;
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
        const hy = narrow ? cssH * 0.66 + (focusY - cssH * 0.66) * 0.1 : cy + cssH * 0.33;
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
          // Every third band is inked a little stronger — an index contour, the
          // way a real slope chart marks its major intervals.
          // Index contours (every 3rd) are heavier — standard slope-chart
          // convention, giving the eye a rhythm to judge steepness by.
          const major = li % 3 === 0;
          ctx.lineWidth = major ? 1.4 : 0.85;
          ctx.strokeStyle = `rgba(${major ? SAGE_DEEP : SAGE},${((major ? 0.5 : 0.28) * globalAlpha).toFixed(3)})`;
          ctx.stroke();
        }

        /* Fall-line arrows on a sparse grid. Contours tell you WHERE it is
           steep; these tell you WHICH WAY without having to infer it. Sparse
           enough (every 4th cell) to stay editorial rather than busy. */
        for (let r = 1; r < rowsN; r += 4) {
          for (let c = 1; c < cols; c += 4) {
            const px = b.x + c * gw;
            const py = b.y + r * gh;
            const sg = slopeAt(px, py, hm2.x, hm2.y, span2, tiltAng, tiltMag, gSeed);
            const m = Math.hypot(sg.gx, sg.gy);
            if (m < 1) continue;
            const ux = sg.gx / m;
            const uy = sg.gy / m;
            const len = 7 + Math.min(7, m / 260);   // longer arrow = steeper
            ctx.beginPath();
            ctx.moveTo(px - ux * len * 0.5, py - uy * len * 0.5);
            ctx.lineTo(px + ux * len * 0.5, py + uy * len * 0.5);
            // small chevron head
            ctx.lineTo(px + ux * len * 0.5 - ux * 3 - uy * 2.2, py + uy * len * 0.5 - uy * 3 + ux * 2.2);
            ctx.strokeStyle = `rgba(${OLIVE},${(0.4 * globalAlpha).toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
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

    /* Game input listens on the hero SECTION, not the canvas wrapper: the
       wrapper is pointer-events:none (so it cannot swallow clicks on the copy or
       the explore cue), which also means it never receives events itself.
       onDown claims the gesture only when the press lands on the ball, so
       ordinary clicks, links and text selection are untouched. */
    const host: HTMLElement = wrap.closest('.band-home') ?? wrap.parentElement ?? wrap;
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointerdown', onTapReset);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointercancel', onUp);

    sync();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('mousemove', onPointer as EventListener);
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointerdown', onTapReset);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onUp);
      delete w.__puttTest;
    };
  }, []);

  return (
    <div className="hero-canvas-wrap" ref={wrapRef} aria-hidden="true">
      <canvas className="hero-canvas" ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
