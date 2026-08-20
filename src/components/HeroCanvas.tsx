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

    const onPointer = (e: PointerEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      ptrX = e.clientX - rect.left;
      ptrY = e.clientY - rect.top;
      lastPtr = performance.now();
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

      for (let i = 0; i < rings.length; i++) {
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
      if (hairGrad) {
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
      for (let k = 0; k < dotPts.length; k++) {
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

      ctx.globalAlpha = 1;
    };

    /* ---------------- reduced motion: one frame, no loop, ever ---------------- */

    if (reduced) {
      layout();
      render(0, 1);
      w.__heroFrames = 1;
      w.__heroReducedMotion = true;
      const ro = new ResizeObserver(() => {
        layout();
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
      intro = Math.min(1, intro + dt * 1.3);
      render(clock, intro);
      w.__heroFrames = ++frames;
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
    render(0, 0.001); // paint something immediately; intro ramps from here

    const ro = new ResizeObserver(() => {
      layout();
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

    sync();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('mousemove', onPointer as EventListener);
    };
  }, []);

  return (
    <div className="hero-canvas-wrap" ref={wrapRef} aria-hidden="true">
      <canvas className="hero-canvas" ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
