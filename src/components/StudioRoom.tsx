import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { ClientMemory } from '../lib/us/photos';

/**
 * StudioRoom — the memory gallery. A black reformer studio under blue light,
 * with a carriage that carries you down a rail past every photo of us.
 *
 * ===========================================================================
 * THE ONE RULE
 *
 * The photographs are the only warm thing in this room. Everything
 * architectural is black, concrete and blue; the memories are the sole
 * full-colour, full-warmth objects on screen, and that contrast IS the design.
 *
 * That rule is enforced HERE, in code, not in a style guide:
 *
 *   1. Photo quads use MeshBasicMaterial. Unlit. The room's blue point lights
 *      physically cannot reach them, so no amount of relighting the studio can
 *      ever blue-wash a face. A MeshStandardMaterial here would have tinted
 *      every photo the moment somebody nudged a light colour.
 *   2. `toneMapped: false` on every photo material, and NoToneMapping globally.
 *      A tone mapper is a colour grade with a friendly name.
 *   3. material.color is pinned to 0xffffff whenever a map is present (see
 *      applyTexture). In three.js `color` MULTIPLIES the map, so any other
 *      value is a tint by definition.
 *   4. No post-processing. No EffectComposer, no bloom pass, no LUT. The haze
 *      is additive geometry that lives on the architecture, never in front of a
 *      panel.
 *   5. Distance fade uses Fog with colour 0x000000 — pure black, which is the
 *      absence of light rather than a hue. The panel you are actually looking
 *      at sits INSIDE fog.near, so it renders at exactly 1.0, untouched.
 *
 * If you are about to add a filter, a grade, a tint or a bloom pass, the room
 * is telling you something else is wrong.
 *
 * ===========================================================================
 * THE MECHANICS, ALL BORROWED FROM SOLIDCORE'S REAL VOCABULARY
 *
 * - THE CARRIAGE. You ride it. The camera is mounted on a matte-black plate
 *   that runs on two rails receding into the dark, and scroll drives it. This
 *   is the reading chosen over "the photos slide past a fixed camera" because
 *   it is the only one where the *unused rail* is visible — which is what makes
 *   the next rule legible instead of merely true.
 *
 * - 80%, MICRO-BEND, NEVER LOCK OUT. Their lower-body cues stop short of full
 *   extension every single time. So the rail is RAIL_LEN long and the carriage
 *   only ever travels MAX_EXTENSION - MICRO_BEND of it: 78%. You can see the
 *   remaining 22% of rail disappearing into the dark ahead and you never reach
 *   it. A brand rule expressed as geometry and an easing curve, and the curve's
 *   derivative goes to zero at the end so it eases in rather than snapping.
 *
 * - CARRIAGE LINES 1-4. The real machine has numbered position lines. Ours are
 *   the four chapters and the progress indicator, marked on the floor and lit
 *   in the HUD.
 *
 * - WARM-UP / CORE ACTIVATION. A class opens with a core-activation warm-up
 *   before the muscle-group sequence, so the room opens on ONE panel, dead
 *   centre, in low light, before it widens into the two-sided corridor.
 *
 * - TIME UNDER TENSION -> HOLD TO REVEAL. The method's organising principle is
 *   sustained time under tension. Press and hold a memory and a meter fills;
 *   at MAX TENSION the hidden note is revealed. Release early and it returns
 *   ECCENTRICALLY — the drain is ECCENTRIC_RATIO times slower than the fill,
 *   because the lengthening phase is the one you are told to do with control.
 *
 * - THE MIRROR. Every positional cue in a class references the studio mirror.
 *   The floor doubles the memory wall (see buildMirror) — done by duplicating
 *   the quads and fading them out with a shared alpha ramp rather than with a
 *   render-target Reflector, which would cost a second full scene pass every
 *   frame. On a phone that second pass is the difference between 60fps and 30.
 *
 * - "STILL ONE MORE." One panel past the apparent end of the rail. It is unlit
 *   and unloaded until the carriage reaches max extension, and then — because
 *   this is a machine that gives you one more rep — it comes to you, sliding
 *   up the rail into the viewing position.
 *
 * ===========================================================================
 * ACCESSIBILITY, WHICH IS NOT NEGOTIABLE
 *
 * A press-and-hold as the ONLY route to content fails WCAG, full stop. So the
 * note has three independent routes, and the hold is merely the nicest one:
 *
 *   pointer  hold a panel (or anywhere in the room) -> meter fills -> reveal
 *   keyboard Tab to a memory in the index, hold Enter or Space -> same meter
 *   plain    the "reveal the note" button. One activation, no timing, no hold.
 *
 * The canvas itself carries role="img" and a real aria-label, because a bare
 * WebGL canvas announces absolutely nothing. The tension meter is a real
 * role="progressbar" with a live aria-valuenow, and the revealed note is
 * announced through a polite live region.
 *
 * prefers-reduced-motion renders the FINISHED state — carriage at max
 * extension, "still one more" already revealed — as a single still frame with
 * no rAF loop and no scroll-driven camera at all. The page then hands the
 * memories over through the static grid that room.astro already ships for
 * no-WebGL and no-JS, so nothing is reachable only by moving.
 *
 * ===========================================================================
 * WHAT THIS MUST NOT DO: MELT A PHONE
 *
 * Thirteen full-resolution photographs is ~100MB of GPU memory if you upload
 * them all and leave them there, which on a mid-tier Android is a tab crash.
 * So:
 *   - AT MOST maxLive textures exist at once — five on a coarse pointer, nine
 *     otherwise — enforced on the LOAD side, not just by eviction, and worked
 *     nearest-panel-first. Textures load only within LOAD_AHEAD of the carriage
 *     and are DISPOSED past EVICT_BEYOND; the two distances differ (hysteresis)
 *     so scrubbing back and forth over a boundary cannot thrash the loader.
 *   - devicePixelRatio is capped at 2 — a 3x phone otherwise asks for 3.6M
 *     pixels of backing store to fill a 0.4M-pixel screen — with a generous
 *     total-pixel backstop for absurd viewports.
 *   - and then the guess is CHECKED. Frame time is measured, and a room that
 *     cannot hold ~45fps for two seconds drops its own pixel ratio until it
 *     can. Guessing capability from `pointer: coarse` does not work (it rates
 *     an iPad Pro below a netbook); measuring it does.
 *   - no shadow maps at all. Shadows are the single largest mobile cost in a
 *     scene like this and the room is lit by LED strips, which do not throw
 *     hard shadows anyway.
 *   - MeshLambertMaterial for the architecture, not MeshStandard. There is no
 *     metal and no roughness variation in a matte-black room, so PBR would be
 *     paying for a look nothing here uses.
 *   - two point lights on a coarse pointer, three otherwise.
 *   - the rAF loop stops on document.hidden and when the stage scrolls out of
 *     view.
 * ===========================================================================
 */

/* ===========================================================================
   PURE MATH
 *
 * Everything below is deliberately free of three.js, the DOM and React so that
 * it can be extracted from this file's source and executed under a bare `node`
 * for verification. `astro check` is not installed in this repo (PLAN.md §6
 * records that), so an assertion that actually runs is worth more here than a
 * type that nobody checks.
 *
 * The extraction slices between the two markers below and strips `: number` /
 * `: boolean` annotations, so: keep this block dependency-free, keep every
 * annotation to those two types, and do not put a colon-type anywhere the
 * regex would not survive.
 *
 * VERIFIED-BLOCK-BEGIN
 * =========================================================================== */

/** Fraction of the rail the carriage is mechanically allowed to use. */
const MAX_EXTENSION = 0.80;

/**
 * The micro-bend. Held back from MAX_EXTENSION and never given up, which is
 * what "never lock out" means when you write it as a number: the carriage's
 * limit is 0.78, so full extension is not merely unreached, it is unreachable.
 */
const MICRO_BEND = 0.02;

/** How much slower the eccentric (release) phase is than the concentric (hold). */
const ECCENTRIC_RATIO = 2.6;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Shape of the deceleration. Measured, not chosen.
 *
 * This was 3 (a plain cubic ease-out) and that was wrong in a way only a scroll
 * trace showed: a cubic covers 87.5% of the rail in the first HALF of the scroll,
 * so the carriage reached the last memory at 62% and the remaining 38% of thumb
 * travel changed nothing. Long deceleration is the brand rule; a dead third of
 * the page is just a bug wearing the rule's clothes.
 *
 * 1.4, paired with WALL_GAP below, was chosen by sweeping both together against
 * two measured criteria and is asserted on both:
 *   - the last memory needs 95% of the page (so the rail is genuinely used, with
 *     the remaining 5% left for "still one more" to arm), and
 *   - the per-panel share of the scroll varies by only ~2.2x, with the LARGEST
 *     share being the final settle — which is the one that is supposed to be
 *     long. The cubic's spread was 13x.
 * The end slope is 0.4% of the average slope, so it demonstrably arrives rather
 * than hitting a stop.
 */
const EASE_EXPONENT = 1.4;

/**
 * Scroll progress -> carriage travel, as a fraction of RAIL_LEN.
 *
 * Ease-out: fast off the mark, decelerating into the stop. Neither end is
 * cosmetic — the derivative at p=1 is zero, so the carriage arrives instead of
 * hitting something, and the limit is (MAX_EXTENSION - MICRO_BEND) rather than 1,
 * so it never locks out.
 */
function carriageEase(p: number): number {
  const c = clamp01(p);
  const eased = 1 - Math.pow(1 - c, EASE_EXPONENT);
  return (MAX_EXTENSION - MICRO_BEND) * eased;
}

/**
 * Inverse of carriageEase, by bisection.
 *
 * Needed because selecting a memory from the keyboard index has to scroll the
 * PAGE to the progress that parks the carriage in front of it — the scroll
 * position is the single source of truth for progress (GSAP's ScrollTrigger
 * owns it when GSAP is present), so we must not move the camera directly or the
 * next scroll event would snap it back. carriageEase is monotonic, so bisection
 * is exact enough in 34 iterations and needs no algebra to stay in sync if the
 * curve changes.
 */
function carriageEaseInverse(travel: number): number {
  const limit = MAX_EXTENSION - MICRO_BEND;
  /* The two endpoints are returned EXACTLY rather than left to the search, and
     that is not tidiness. Bisection lands ~3e-11 from 0 and ~4e-6 from 1 (the
     curve is flat at the top, so a wide band of p maps to the same double), and
     the only caller turns this into a scroll offset. Snapping the ends means
     "scroll to the first memory" and "scroll to still-one-more" hit the very top
     and the very bottom of the scroll range instead of a few thousandths of a
     pixel short of it. Anything past the reachable limit — which is where the
     hidden panel is parked — is the far end of the scroll, by definition. */
  if (!(travel > 0)) return 0; // also catches NaN
  if (travel >= limit) return 1;
  const target = travel;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 34; i += 1) {
    const mid = (lo + hi) / 2;
    if (carriageEase(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Frame-rate-independent exponential damping.
 *
 * `current + (target - current) * k` with a constant k is the bug this replaces:
 * it converges at a rate proportional to frame rate, so the same code feels
 * heavy at 120Hz and sloppy at 30. Expressing it as exp(-dt/tau) makes tau a
 * real time constant in seconds, identical on every display.
 */
function damp(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/**
 * One frame of TIME UNDER TENSION.
 *
 * Concentric while held, eccentric on release, and the asymmetry is the whole
 * point: letting go does not dump the meter, it lowers it with control. Reaching
 * exactly 1 is MAX TENSION.
 */
function tensionStep(t: number, dt: number, holding: boolean, fillSeconds: number): number {
  if (fillSeconds <= 0) return holding ? 1 : 0;
  const rate = dt / fillSeconds;
  return clamp01(holding ? t + rate : t - rate / ECCENTRIC_RATIO);
}

/**
 * Progress at which "still one more" is armed.
 *
 * Lives in this block, rather than beside the other room constants, because it
 * has to hold a relationship with carriageEaseInverse that is worth asserting:
 * the hidden panel is parked PAST the reachable travel, so its inverse clamps to
 * p=1, and 1 must be greater than this. If it were not, the panel would be
 * unreachable by the keyboard route and the easter egg would only exist for
 * people who scroll to the exact bottom.
 */
const ARM_HIDDEN_AT = 0.985;

/** Hermite smoothstep, clamped. Used to ramp effects in over a progress window. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Backing-store pixels -> a devicePixelRatio that will not melt the device.
 *
 * `hardCap` does almost all of the work: it stops a 3x phone from asking for
 * nine times the fragments it needs to fill a 0.4-megapixel screen. The pixel
 * BUDGET is a backstop for absurd viewports only, and it is deliberately
 * generous — an earlier version set it at 2.6M for coarse pointers and 4.8M
 * otherwise, which was measurably wrong in both directions: it rendered an iPad
 * Pro (1024x1366 css) at 1.36x and a 5K desktop (2560x1440 css) at 1.14x, both
 * of which have the GPU to run this at 2x and both of which would just look
 * soft. Guessing a device's capability from its pointer type does not work.
 *
 * The real protection against slow hardware is MEASURED, not guessed — see the
 * adaptive pixel-ratio drop in the frame loop, which watches actual frame time
 * and backs off when it is bad. This function's job is only to avoid asking for
 * something obviously insane.
 *
 * `rawDpr || 1` treats a reported 0 as 1x. Some embedded and headless browsers
 * report 0, and multiplying a size by 0 produces a canvas nothing can be drawn
 * into.
 */
function chooseDpr(cssW: number, cssH: number, rawDpr: number, hardCap: number, budget: number): number {
  const area = Math.max(1, cssW * cssH);
  const byBudget = Math.sqrt(budget / area);
  return Math.max(1, Math.min(hardCap, rawDpr || 1, byBudget));
}

/* VERIFIED-BLOCK-END */

/* ###########################################################################
   #                                                                         #
   #   ART DIRECTION — EVERY TUNABLE IN THE ROOM LIVES IN THIS ONE BLOCK.    #
   #                                                                         #
   ###########################################################################

   Sam: this is the block to edit. Nothing below it holds a magic number; the
   scene graph only ever reads names from here. Reload the page after a change —
   there is no state to lose.

   THE FIVE TO TRY FIRST, in order of how much they change the look:

     1. BACKDROP              'image' (photographic room) or 'procedural' (built)
     2. BACKDROP_IMAGE        swap the file to re-shoot the room
     3. SPRING_COLORS         the reformer springs (see the note on that line)
     4. LED_COLOR / LED_LOW_Y the blue that lights everything
     5. BACKDROP_DOLLY        how much the room zooms as the carriage advances

   =========================================================================== */

/* ---------------------------------------------------------------------------
   1. BACKDROP MODE — the biggest single switch in the file.

   'image'      A photographic studio behind the 3D content, as a DOM layer with
                `background-size: cover` (so it fills any aspect ratio without
                stretching) and a scroll-driven dolly zoom. This is the default
                because it is pixel-close to the reference immediately, and
                because swapping one file re-shoots the whole room.

                It is a DOM layer rather than a textured quad on purpose: `cover`
                is then the browser's job and is correct at every aspect ratio
                for free, the zoom is compositor-only, there is no texture in GPU
                memory, and Sam can point it at any file without touching three.

   'procedural' The room built from geometry — walls, two LED strips, the mirror
                wall, the wordmark, pendants, wall text and rows of reformers.
                Slower to match a photograph, but it moves in true perspective
                and needs no asset.

   BOTH ARE MAINTAINED. Changing this line is the whole switch.
   --------------------------------------------------------------------------- */
export type BackdropMode = 'image' | 'procedural';

/**
 * THE SWITCH.
 *
 * Written `as BackdropMode` and not as a bare `= 'image'`, and that is load-
 * bearing rather than pedantic. TypeScript narrows a `const` initialised with a
 * string literal to that literal, so `const BACKDROP = 'image'` gives it the type
 * `"image"` — after which `BACKDROP === 'procedural'` is a statically impossible
 * comparison, every procedural branch in this file is provably dead, and the
 * compiler says so (ts2367). The annotation alone is not enough for the same
 * reason: the initialiser still narrows the reference. The assertion widens the
 * initialiser to the union, so both branches stay live and flipping this line
 * actually flips the room.
 */
const BACKDROP = 'image' as BackdropMode;

/** The photographic room. Swap this file to re-shoot. 1672x940 in the original. */
const BACKDROP_IMAGE = '/assets/us/studio-backdrop.webp';
/** Served to anything that cannot decode WebP. Same framing, larger file. */
const BACKDROP_IMAGE_FALLBACK = '/assets/us/studio-backdrop.jpg';
/** 32x18 stand-in, shown for the ~80ms before the real one decodes. */
const BACKDROP_LQIP = '/assets/us/studio-backdrop-tiny.webp';

/**
 * Framing of the `cover` crop. 0 = top/left of the photo, 1 = bottom/right.
 *
 * These are the two knobs for re-framing the room, and they behave exactly like
 * `background-position`: they choose WHICH part of the photo survives the crop.
 *
 * FOCUS_Y under 0.5 because the reference's vanishing point sits just above
 * centre, so this keeps both the mirror wall and the floor wash in frame on a
 * tall viewport.
 *
 * FOCUS_X biased right, because the photo's LEFT WALL carries their vinyl text
 * and at 16:10 it landed at the very left edge, cropped mid-glyph, directly
 * behind the chapter rail — rendering as disembodied fragments ("ng", "ne",
 * "nny", "core]") stacked down the side. Pushing the crop right buries most of
 * it, and the derived edge scrims below finish the job at every aspect ratio
 * (see BACKDROP_SCRIM_LEFT_MIN / _MAX).
 *
 * Note this cannot be solved by FOCUS_X alone: `cover` crops a different NUMBER
 * of pixels at every aspect ratio (160px at 1440x900, 1111px at 390x844), so one
 * percentage cannot bury the same content on a laptop and a phone.
 */
const BACKDROP_FOCUS_X = 0.62;
const BACKDROP_FOCUS_Y = 0.46;

/* ---------------------------------------------------------------------------
   EDGE SCRIMS

   Soft darkening at the left and right edges of the BACKDROP ONLY. Two jobs, and
   the second is the load-bearing one:

     1. legibility — the chapter rail and the exit link sit on near-black.
     2. it removes the other studio's signage. The photo's left wall carries
        their vinyl and the right wall carries a `[solidcore]` mark; both live
        inside the outer ~14% of the image, so a scrim over the edges takes them
        out at every aspect ratio, which FOCUS_X alone cannot.

   CRITICAL: these render BELOW the canvas (z-index 1 vs 2). A scrim above the
   canvas would darken the corner of any photograph that drifted into it, and THE
   ONE RULE says nothing dims a memory. Measured: a left-wall panel reaches from
   3% to 42% across the frame, so it genuinely would overlap.
   --------------------------------------------------------------------------- */
/**
 * How far the other studio's signage reaches, as fractions of the backdrop
 * IMAGE. Measured off the file with a brightness profile, not estimated: their
 * left-wall vinyl ends at 0.139 and their right-wall mark begins at 0.918.
 *
 * The scrim widths are DERIVED from these under the live crop, rather than being
 * fixed percentages of the viewport, and that turned out to be necessary rather
 * than clever. A flat 30% left scrim is 432px at 1440x900 — comfortably over
 * their vinyl at 123px — but only 117px on a 390px phone, where the crop has
 * already thrown their whole left wall away and 117px instead lands squarely on
 * OUR sign at x=92. One percentage cannot be right at both.
 */
const BACKDROP_LEFT_SIGNAGE_X = 0.145;
const BACKDROP_RIGHT_SIGNAGE_X = 0.912;

/** Legibility floor: the chapter rail needs near-black behind it regardless. */
const BACKDROP_SCRIM_LEFT_MIN = 0.14;
/** Ceiling, so re-framing can never scrim away half the room. */
const BACKDROP_SCRIM_LEFT_MAX = 0.34;
const BACKDROP_SCRIM_RIGHT_MIN = 0.08;
const BACKDROP_SCRIM_RIGHT_MAX = 0.26;
const BACKDROP_SCRIM_STRENGTH = 0.97;

/**
 * How long to wait for a lost WebGL context to come back before giving up and
 * handing the room over to the static grid.
 *
 * Losing the context is NORMAL on a phone — backgrounding the tab is enough, and
 * so is a GPU reset or another tab exhausting the driver. The browser usually
 * fires `webglcontextrestored` within a frame or two of the tab becoming visible
 * again; if it does not, a frozen canvas is a worse answer than the grid.
 */
const CONTEXT_RESTORE_GRACE_MS = 4000;

/* ---------------------------------------------------------------------------
   THE `[us]` SIGN, REGISTERED ONTO THE BACKDROP'S OWN SIGN

   The photograph is THEIR studio, so its illuminated back-wall sign reads
   `[solidcore]`. Left alone, the room is branded as theirs and a private gift
   page displays another company's trademark. So a plate is laid exactly over
   that sign and our wordmark is drawn on it, with the same glow, so it sits IN
   the photograph rather than on top of it.

   The coordinates are fractions OF THE IMAGE, not of the viewport, and the
   overlay re-derives its pixel position from the live `cover` geometry on every
   resize — so it stays registered at every aspect ratio and through the dolly
   zoom, which it inherits by being a child of the backdrop layer.

   Measured off the file rather than eyeballed: a brightness column-profile puts
   the sign's glyphs between 0.46 and 0.58 of the width and 0.248 to 0.284 of the
   height, and the wall immediately around them averages #060b2b.
   --------------------------------------------------------------------------- */
const WORDMARK_ON_BACKDROP = true;
/** Centre of the sign, as a fraction of the backdrop IMAGE. */
const WORDMARK_IMG_X = 0.52;
const WORDMARK_IMG_Y = 0.266;
/** Size of the covering plate, as a fraction of the image. Must exceed the
 *  original glyphs (0.12 x 0.036) or their text peeks out at the edges. */
const WORDMARK_IMG_W = 0.16;
const WORDMARK_IMG_H = 0.072;
/** Cap height of our wordmark, as a fraction of the drawn image height. */
const WORDMARK_TEXT_SCALE = 0.052;
/** The wall colour immediately around the sign, so the plate is invisible. */
const WORDMARK_PLATE_COLOR = '#060b2b';
/** How hard the sign glows. It is a lit box in a dark room. */
const WORDMARK_GLOW = 0.75;

/**
 * The backdrop's natural size, used to compute the `cover` crop before the image
 * has decoded. Read back from the real file on load, so a wrong value here only
 * affects the first frame.
 */
const BACKDROP_NATURAL_W = 1672;
const BACKDROP_NATURAL_H = 940;

/**
 * How far the room dollies over the whole scroll. 0 disables it.
 *
 * This is what stops the photograph reading as a matte painting: as the carriage
 * advances, the room advances with it. 0.16 is a slow push down the studio toward
 * the mirror; past ~0.35 the softening from upscaling starts to show.
 */
const BACKDROP_DOLLY = 0.16;

/** The photo's vanishing point as a fraction of its height — the dolly's origin. */
const BACKDROP_ORIGIN_Y = 0.44;

/* ---------------------------------------------------------------------------
   2. THE ROOM ITSELF (procedural mode)

   Near-black blue-black, not neutral black: the reference's walls read cold even
   where no LED reaches them, and a neutral #111 next to an electric blue looks
   brown by comparison.
   --------------------------------------------------------------------------- */
const WALL_COLOR = 0x0a0c14;
const CEILING_COLOR = 0x07080f;
/** Polished concrete. Darker than the walls so the LED wash on it reads. */
const FLOOR_COLOR = 0x0b0d13;

/**
 * How strongly the floor mirrors what is above it, 0..1.
 *
 * Implemented as the floor's own opacity: the reflections are real duplicated
 * geometry UNDER the floor, so a more transparent floor is a more reflective one.
 * The reference's floor is properly polished — 0.62 here is a wet sheen, 0.85 is
 * matte sealed concrete, 0.35 is a showroom mirror.
 */
const FLOOR_REFLECTIVITY = 0.62;

/**
 * How strong the reflected copy of a memory is, before the floor dims it.
 *
 * Visible strength is MIRROR_STRENGTH x (1 - FLOOR_REFLECTIVITY). These two are
 * the pair to tune together: raise this and lower FLOOR_REFLECTIVITY for a
 * showroom mirror, do the reverse for sealed matte concrete.
 */
const MIRROR_STRENGTH = 0.7;

/** Distance fade. Pure black in procedural mode; see FOG_ENABLED for image mode. */
const FOG_COLOR = 0x000000;
const FOG_NEAR = 9.5;
const FOG_FAR = 46;
/**
 * Fog is OFF in image mode, and that is deliberate rather than lazy: fogging
 * toward black over a lit photograph turns distant panels into black rectangles
 * floating in a bright room. In image mode the distance fade below dissolves them
 * into the backdrop instead, which is what depth actually looks like there.
 */
const FOG_ENABLED = BACKDROP === 'procedural';

/* ---------------------------------------------------------------------------
   3. THE LEDS — the room's dominant light, and the reason it reads as theirs.

   Two full-width strips, exactly as in the reference: one high near the ceiling
   and one at the base of the mirror wall. The low one is the important one — it
   is what throws the blue wash across the floor.
   --------------------------------------------------------------------------- */
const LED_COLOR = 0x2f6bff;
/** The hot core of the strip itself, which reads brighter than its wash. */
const LED_CORE_COLOR = 0x9cc4ff;
const LED_HIGH_Y = 5.5;
const LED_LOW_Y = 0.62;
const LED_THICKNESS = 0.085;
/**
 * Wash intensity, in candela. Physically-correct falloff, so this number is
 * meaningful: irradiance is LED_WASH_INTENSITY / d^2 and a Lambert wall reflects
 * albedo/PI of it. At 22 the wall 2.9 units away lands at ~0.06 linear, which is
 * dark concrete catching blue. Doubling this blows the walls out to flat grey.
 */
const LED_WASH_INTENSITY = 22;
const LED_WASH_DISTANCE = 26;
const LED_WASH_COUNT_COARSE = 2;
const LED_WASH_COUNT = 3;

/* ---------------------------------------------------------------------------
   4. CEILING PENDANTS — small, tight pools. Mostly silhouette; they sell the
   ceiling's existence more than they light anything.
   --------------------------------------------------------------------------- */
const PENDANT_SPACING = 9.5;
const PENDANT_DROP = 1.15;
const PENDANT_GLOW_COLOR = 0xfff4e2;
const PENDANT_GLOW_OPACITY = 0.5;

/* ---------------------------------------------------------------------------
   5. THE MIRROR WALL, THE WORDMARK AND THE VINYL

   The reference's back wall is a full mirror with a glowing wordmark box on it
   and dimmer repeats inside the reflection. The side walls carry vinyl text.
   --------------------------------------------------------------------------- */
/** Ours, not theirs. Lowercase and bracketed, mirroring their lockup. */
const WORDMARK_TEXT = '[us]';
const WORDMARK_WIDTH = 4.6;
const WORDMARK_Y = 2.5;
/** Their real tagline, and it happens to be literally true of a year of this. */
const WALL_TEXT = 'stronger for it.';
/** The green EXIT sign. Small, and it is most of why the room reads as real. */
const EXIT_SIGN = true;
const EXIT_SIGN_COLOR = 0x22c55e;

/* ---------------------------------------------------------------------------
   6. THE REFORMERS

   Matte-black beds receding toward the mirror, with the numbered carriage lines
   painted on them.
   --------------------------------------------------------------------------- */
const REFORMER_COLUMNS = 4;
const REFORMER_ROWS = 5;
const REFORMER_COL_GAP = 2.55;
const REFORMER_ROW_GAP = 6.2;
const REFORMER_BED_COLOR = 0x121319;
const REFORMER_FRAME_COLOR = 0x090a0e;

/**
 * Carriage line numbers 1-4, painted on the bed.
 *
 * BOTH EDGES, unlike the reference photograph, which only numbers the left rail
 * of each carriage. Sam asked for them mirrored on the right as well — and he is
 * right that it is better: whichever side of the machine you are on, the line you
 * are being cued to is legible without leaning over.
 */
const CARRIAGE_LINE_LABELS = ['1', '2', '3', '4'];
const CARRIAGE_LINES_BOTH_EDGES = true;
const CARRIAGE_LINE_COLOR = 0xe8eaee;

/**
 * SPRING COLOURS — SAM, THIS IS THE LINE TO EDIT.  <<<<<<<<<<<<<<<<<<<<<<<<<<<
 *
 * One entry per spring, front to back, and the array length sets the count.
 *
 * The reference photograph is AI-generated and its springs are wrong — real
 * reformer springs at a studio like this are bare steel coils, and the blue ones
 * in the image are an invention. So the default here is chrome/steel with a
 * little variation down the row, which is defensible and matches the machine
 * rather than the render. If you want their real colour-coded resistance
 * springs, put the hexes in this array; five entries, front-most first.
 */
const SPRING_COLORS = [0xc4c7cd, 0xa8abb2, 0xc4c7cd, 0x93969c, 0xb4b7bd];
const SPRING_COUNT_FROM_COLORS = true;

/* ---------------------------------------------------------------------------
   7. THE RAIL, THE CARRIAGE AND THE CAMERA PATH

   World units are metres-ish. The room is ~10 wide, 6 tall and RAIL_LEN long.
   --------------------------------------------------------------------------- */

/** Full mechanical travel of the rail. The carriage uses 78% of it. */
const RAIL_LEN = 82;

/** How far ahead of the carriage the "viewing position" sits. */
const VIEW_AHEAD = 7;

/** Camera height. Roughly seated on the carriage rather than standing. */
const CAM_Y = 1.55;

/**
 * Field of view. 42 is close to the reference's lens; wider than ~55 and the
 * one-point perspective down the room stops reading.
 */
const CAM_FOV = 42;

/** Centre height of every panel. */
const PANEL_Y = 1.86;

/**
 * How much of the visible frame height a panel takes at the viewing distance.
 *
 * The memories should dominate — they are the only warm thing in a cold room and
 * that contrast is the whole design — but over a photographic backdrop, 0.58 had
 * two of them covering most of the studio at once and the room stopped reading.
 * 0.52 lets it breathe. Raise it for bigger memories, lower it for more room.
 */
const PANEL_HEIGHT_FRACTION = 0.52;
/** Absolute ceiling, so a very short wide viewport cannot produce a huge panel. */
const PANEL_HEIGHT_MAX = 3.5;
/** Same pair for narrow viewports, where the panel is width-driven instead. */
const PANEL_HEIGHT_FRACTION_NARROW = 0.62;
const PANEL_HEIGHT_MAX_NARROW = 3.0;

/* ---- the carriage you ride ----
   Sized against the photographed room's centre aisle. The first version was 2.0
   wide and 6.4 long and fully opaque, which in image mode punched a solid black
   wedge straight through the photograph's lit floor — a hole, not a machine. It
   is now slimmer, shorter, and translucent over the backdrop so the floor reads
   through it. Opaque in procedural mode, where there is no floor to read. */
const CARRIAGE_WIDTH = 1.5;
const CARRIAGE_LENGTH = 4.8;
const CARRIAGE_OPACITY_ON_IMAGE = 0.46;
/** Brightness of the carriage's lit front edge, 0..1. */
const CARRIAGE_EDGE_OPACITY = 0.5;

/** z of the warm-up panel: dead centre, one viewing distance from the origin. */
const WARMUP_Z = -VIEW_AHEAD;

/**
 * Where "still one more" arrives, measured ahead of the carriage.
 *
 * Deliberately NEARER than VIEW_AHEAD, and the difference is doing real work.
 * At max extension the last wall panel is sitting almost exactly at the viewing
 * position, so bringing the hidden panel to VIEW_AHEAD too would land the two
 * within a hair of the same z — z-fighting on a desktop, and on a phone (where
 * the wall collapses toward the centre) the wall panel would simply cover it.
 * 2.0 units closer means the hidden one unambiguously occludes, and arriving
 * visibly larger in frame is right for the panel you were not promised. It was
 * 2.6, which at max extension had it covering most of the studio.
 */
const HIDDEN_VIEW_AHEAD = VIEW_AHEAD - 2.0;

/**
 * z of the first wall panel, and the gap between them.
 *
 * WALL_GAP is not a free choice: it decides where the LAST memory sits, and the
 * last memory has to be inside the carriage's reachable travel. At 5.6 it landed
 * at z=-71, needing 0.7805 of the rail against a hard limit of 0.78 — unreachable
 * by four thousandths, so carriageEaseInverse clamped it to p=1 and the whole
 * final approach collapsed into one dead gap. 5.5 puts it at 0.768, reached at
 * 95% of the scroll. A geometry constant with an arithmetic constraint on it;
 * the assertion in the test suite is what stops it drifting back.
 */
const WALL_START_Z = -15;
const WALL_GAP = 5.5;

/** Seconds of hold to reach MAX TENSION. */
const TENSION_FILL_SEC = 1.15;

/** Time constant for the no-GSAP fallback scrub. ~matches GSAP's `scrub: 1` feel. */
const SCRUB_TAU = 0.26;

/* ---------------------------------------------------------------------------
   PASSING A PANEL

   The carriage travels the rail, so it passes every memory on the way — and a
   panel at arm's length fills the entire viewport no matter how far to the side
   it is hung. This was not a hypothetical: at max extension the camera comes to
   rest 0.49 units from m11, and m11 is a 1.5:1 landscape panel 4.68 units wide,
   so the last frame of the room rendered as a single flat #0e0f12 rectangle with
   the whole studio behind it. Verified by reading the scene graph, not guessed.

   So panels DISSOLVE as they are passed, and fade back in on the way out. Note
   what this is not: it is not a filter or a grade on a photograph. It is the same
   category of thing as the fog — an occlusion rule about where the camera is —
   and the panel you are looking at, at VIEW_AHEAD, is always at exactly 1.0.
   --------------------------------------------------------------------------- */
/** Fully present at this distance and beyond. */
const PASS_FADE_FAR = 3.4;
/** Completely gone by this distance, so nothing is ever flown through. */
const PASS_FADE_NEAR = 1.5;

/**
 * And the far end of the same rule.
 *
 * In procedural mode the black fog already dissolves distance, so this is only a
 * light assist. In IMAGE mode it is the whole mechanism — fog is off there (see
 * FOG_ENABLED), so this is what makes a panel forty units away recede into the
 * photographed room instead of hovering in front of it at full opacity.
 */
const FAR_FADE_START = 24;
const FAR_FADE_END = 40;

/** Texture residency. See the mobile notes in the header. */
const LOAD_AHEAD = 22;
const EVICT_BEYOND = 34;

/** Scroll length, in viewport heights, contributed by each panel. */
const SCREENS_PER_PANEL = 0.42;

/** Strength of the CSS blue haze over the canvas. Lower in image mode: the
 *  photograph already carries the LED bloom, and doubling it goes muddy. */
const HAZE_STRENGTH = BACKDROP === 'image' ? 0.35 : 1;

/* ===========================================================================
   COMPONENT
   =========================================================================== */

interface Props {
  memories: ClientMemory[];
  /** Chapter lines, for the HUD indicator. Line number -> label. */
  lines: Array<{ line: number; label: string; blurb: string }>;
}

/** Everything we own per panel, so teardown is a single loop. */
interface PanelRig {
  memory: ClientMemory;
  group: THREE.Group;
  photo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  backing: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  rim: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  mirror: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  mirrorGroup: THREE.Group;
  /** Live width/height of the image, once known. Starts as the manifest hint. */
  aspect: number;
  /** Parked z. The hidden panel's actual z is animated away from this. */
  parkZ: number;
  texture: THREE.Texture | null;
  image: HTMLImageElement | null;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** True once the cross-origin attempt failed and we fell back to the inline card. */
  usedFallback: boolean;
  tension: number;
  revealed: boolean;
  /** 0..1 dissolve, from how close the carriage is. See PASS_FADE_NEAR. */
  fade: number;
}

export default function StudioRoom({ memories, lines }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const wordmarkRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    /* ---------------------------------------------------------------------
       THE FOUR ELEMENTS THIS EFFECT OWNS

       Read once, checked once, then RE-BOUND with non-nullable types.

       The re-binding is not ceremony. TypeScript does not carry the narrowing
       from the guard below into a nested function, and nearly everything here
       lives in one: layout(), scrollProgress(), panelAt(), onPointerDown(),
       scrollToPanel() and the teardown closure all touch these. Declaring the
       narrowed types explicitly makes non-nullness part of the TYPE rather than
       something the compiler has to prove across a closure boundary.

       Deliberately not `!` and not `as any`. These references run inside rAF
       callbacks, resize handlers and cleanup — exactly the places where a ref
       genuinely can be null after unmount — so silencing the check here would
       trade a compile error for a crash in her browser.
       --------------------------------------------------------------------- */
    const stageEl = stageRef.current;
    const stickyEl = stickyRef.current;
    const canvasEl = canvasRef.current;
    const hudEl = hudRef.current;
    /* `backdrop` stays nullable on purpose: procedural mode removes the element,
       so every use of it is guarded rather than assumed. */
    const backdrop = backdropRef.current;
    const scrim = scrimRef.current;
    const wordmarkEl = wordmarkRef.current;
    if (!stageEl || !stickyEl || !canvasEl || !hudEl || memories.length === 0) return;

    const stage: HTMLDivElement = stageEl;
    const sticky: HTMLDivElement = stickyEl;
    const canvas: HTMLCanvasElement = canvasEl;
    const hud: HTMLDivElement = hudEl;

    /* ---------------------------------------------------------------------
       WEBGL, OR NOTHING

       three r163 dropped WebGL1, so WebGLRenderer needs a webgl2 context and
       probing for 'webgl' would be a false positive. If the probe fails we
       return WITHOUT touching `data-room-fallback`, which means the static grid
       room.astro already rendered stays visible and this island simply never
       appears. Progressive enhancement in the literal sense: the fallback is
       the default and the canvas is the upgrade.
       --------------------------------------------------------------------- */
    /* The probe context MUST be explicitly destroyed, not just dereferenced.
       `probe = null` releases the JavaScript handle but NOT the GPU context —
       that survives until garbage collection, and browsers cap the number of
       simultaneous WebGL contexts (Chrome around 16). Every mount, every HMR
       reload and every React StrictMode double-invoke therefore leaked one, and
       once the cap was reached the browser silently killed the OLDEST contexts.
       The symptom was not "probe failed": it was `new WebGLRenderer` below
       receiving an already-dead context, so three.js's getMaxPrecision() called
       getShaderPrecisionFormat() on it, got null, and threw
       "Cannot read properties of null (reading 'precision')" — a crash three
       frames deep in a library, with nothing pointing back at this probe.
       WEBGL_lose_context is the only way to hand the context back immediately. */
    const probe: HTMLCanvasElement = document.createElement('canvas');
    let hasWebGL = false;
    try {
      const probeGl = probe.getContext('webgl2');
      hasWebGL = Boolean(probeGl);
      probeGl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      hasWebGL = false;
    }
    if (!hasWebGL) {
      stage.setAttribute('data-webgl', 'no');
      return;
    }

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarse =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

    /* ---------------------------------------------------------------------
       HUD HANDLES

       Queried once rather than carried as a dozen React refs, and mutated
       imperatively from the frame loop. Driving a 60fps meter through React
       state would re-render this component sixty times a second to change one
       CSS custom property, which is the entire reason canvas islands in this
       repo hold zero state (see HeroCanvas.tsx).

       If any handle is missing the markup and this file have diverged, so we
       bail out and leave the static grid up rather than crash mid-frame.
       --------------------------------------------------------------------- */
    const elMonth = hud.querySelector<HTMLElement>('[data-us="month"]');
    const elCaption = hud.querySelector<HTMLElement>('[data-us="caption"]');
    const elMeter = hud.querySelector<HTMLElement>('[data-us="meter"]');
    const elFill = hud.querySelector<HTMLElement>('[data-us="fill"]');
    const elState = hud.querySelector<HTMLElement>('[data-us="state"]');
    const elNote = hud.querySelector<HTMLElement>('[data-us="note"]');
    const elNoteText = hud.querySelector<HTMLElement>('[data-us="note-text"]');
    const elReveal = hud.querySelector<HTMLButtonElement>('[data-us="reveal"]');
    const elLive = hud.querySelector<HTMLElement>('[data-us="live"]');
    const elHint = hud.querySelector<HTMLElement>('[data-us="hint"]');
    const elMore = hud.querySelector<HTMLElement>('[data-us="more"]');
    const lineEls = Array.from(hud.querySelectorAll<HTMLElement>('[data-line]'));
    const indexButtons = Array.from(hud.querySelectorAll<HTMLButtonElement>('[data-memory]'));

    if (
      !elMonth || !elCaption || !elMeter || !elFill || !elState ||
      !elNote || !elNoteText || !elReveal || !elLive || !elHint || !elMore
    ) {
      console.error('[us] StudioRoom HUD markup is missing an element; keeping the static grid.');
      return;
    }

    /* =====================================================================
       RENDERER
       ===================================================================== */

    const imageBackdrop = BACKDROP === 'image';

    /* ---------------------------------------------------------------------
       THE BACKDROP LAYER

       Set up entirely from the ART DIRECTION block, so swapping BACKDROP_IMAGE is
       the only edit needed to re-shoot the room.

       The LQIP goes on first and the real file is swapped in on decode. That is
       not a nicety here: the backdrop is the whole room, and without it the first
       frame is a black rectangle with thirteen lit panels floating in it, which
       looks broken rather than loading.
       --------------------------------------------------------------------- */
    /** Natural size of the backdrop, corrected once the real file decodes. */
    let backdropW = BACKDROP_NATURAL_W;
    let backdropH = BACKDROP_NATURAL_H;

    /**
     * Put our sign exactly where the photograph's sign is.
     *
     * This has to reproduce `background-size: cover` in JS, because a child of
     * the backdrop div is positioned against the DIV, while the sign's
     * coordinates are fractions of the IMAGE — and under `cover` the image
     * overflows the div on one axis, by a different amount at every aspect ratio.
     * So: scale by the larger ratio, then offset exactly as
     * `background-position: X% Y%` does (align the X% point of the image with the
     * X% point of the box), and the two agree by construction.
     *
     * The dolly is NOT accounted for here and must not be: the sign is a child of
     * the transformed layer, so it is carried along for free. Doing it here as
     * well would move it twice.
     */
    function layoutBackdropOverlay(): void {
      if (!imageBackdrop) return;
      const cw = sticky.clientWidth;
      const ch = sticky.clientHeight;
      if (cw <= 0 || ch <= 0) return;

      const scale = Math.max(cw / backdropW, ch / backdropH);
      const drawnW = backdropW * scale;
      const drawnH = backdropH * scale;
      // Identical formula to background-position's percentage resolution.
      const originX = (cw - drawnW) * BACKDROP_FOCUS_X;
      const originY = (ch - drawnH) * BACKDROP_FOCUS_Y;

      if (wordmarkEl && WORDMARK_ON_BACKDROP) {
        const plateW = drawnW * WORDMARK_IMG_W;
        const plateH = drawnH * WORDMARK_IMG_H;
        const s = wordmarkEl.style;
        s.setProperty('--sign-left', `${originX + drawnW * WORDMARK_IMG_X - plateW / 2}px`);
        s.setProperty('--sign-top', `${originY + drawnH * WORDMARK_IMG_Y - plateH / 2}px`);
        s.setProperty('--sign-w', `${plateW}px`);
        s.setProperty('--sign-h', `${plateH}px`);
        s.setProperty('--sign-size', `${drawnH * WORDMARK_TEXT_SCALE}px`);
      }

      if (scrim) {
        /* Cover exactly as much as the crop actually leaves of their signage,
           bounded by a legibility floor and a sanity ceiling. Derived rather than
           fixed because `cover` throws away a different number of pixels at every
           aspect ratio — see BACKDROP_LEFT_SIGNAGE_X for the phone case this
           exists to fix. `+ 3% of the width` is feather room so the gradient's
           soft tail, not its hard start, is what lands on their last glyph. */
        const vinylEndsAt = originX + drawnW * BACKDROP_LEFT_SIGNAGE_X + cw * 0.03;
        const markStartsAt = originX + drawnW * BACKDROP_RIGHT_SIGNAGE_X - cw * 0.03;
        const left = Math.max(
          cw * BACKDROP_SCRIM_LEFT_MIN,
          Math.min(cw * BACKDROP_SCRIM_LEFT_MAX, vinylEndsAt),
        );
        const right = Math.max(
          cw * BACKDROP_SCRIM_RIGHT_MIN,
          Math.min(cw * BACKDROP_SCRIM_RIGHT_MAX, cw - markStartsAt),
        );
        scrim.style.setProperty('--scrim-left', `${Math.round(left)}px`);
        scrim.style.setProperty('--scrim-right', `${Math.round(right)}px`);
      }
    }

    if (backdrop) {
      if (!imageBackdrop) {
        // Procedural mode owns the whole frame; leaving an image layer under a
        // transparent canvas would show through everywhere the geometry is not.
        backdrop.remove();
      } else {
        backdrop.style.setProperty('--backdrop-url', `url("${BACKDROP_LQIP}")`);
        backdrop.style.setProperty('--backdrop-focus-x', `${BACKDROP_FOCUS_X * 100}%`);
        backdrop.style.setProperty('--backdrop-focus-y', `${BACKDROP_FOCUS_Y * 100}%`);
        backdrop.style.setProperty('--backdrop-origin-y', `${BACKDROP_ORIGIN_Y * 100}%`);
        backdrop.style.setProperty('--backdrop-zoom', '1');

        if (wordmarkEl) {
          if (!WORDMARK_ON_BACKDROP) wordmarkEl.remove();
          else {
            wordmarkEl.style.setProperty('--sign-plate', WORDMARK_PLATE_COLOR);
            wordmarkEl.style.setProperty('--sign-glow', String(WORDMARK_GLOW));
          }
        }

        const full = new Image();
        full.decoding = 'async';
        full.onload = () => {
          backdrop.style.setProperty('--backdrop-url', `url("${full.src}")`);
          backdrop.setAttribute('data-loaded', 'true');
          /* Trust the file over the constants. If Sam swaps in a differently
             shaped photograph, the cover geometry — and therefore where the sign
             lands — changes, and the natural size is the only honest source for
             it. */
          if (full.naturalWidth > 0 && full.naturalHeight > 0) {
            backdropW = full.naturalWidth;
            backdropH = full.naturalHeight;
          }
          layoutBackdropOverlay();
        };
        full.onerror = () => {
          /* WebP is universal in every browser that has WebGL2, so this is really
             a "the file moved" path. Try the JPEG, then give up and keep the LQIP,
             which is blurry but is still recognisably the room. */
          if (full.src.endsWith('.webp') && BACKDROP_IMAGE_FALLBACK) {
            full.src = BACKDROP_IMAGE_FALLBACK;
            return;
          }
          console.warn(`[us] backdrop image failed to load: ${BACKDROP_IMAGE}`);
        };
        full.src = BACKDROP_IMAGE;
      }
    }

    if (scrim) {
      if (!imageBackdrop) {
        // Nothing to scrim in procedural mode — there is no photograph carrying
        // another studio's signage, and the fog already darkens the edges.
        scrim.remove();
      } else {
        // Widths are derived per-layout from the live crop; only the strength is
        // a straight constant.
        scrim.style.setProperty('--scrim-strength', String(BACKDROP_SCRIM_STRENGTH));
      }
    }

    // Haze strength is art direction, so it comes from the config rather than
    // being hard-coded in two places.
    sticky.style.setProperty('--haze', String(HAZE_STRENGTH));

    /* Wrapped, because constructing a renderer is genuinely fallible at runtime
       and not only when WebGL is unsupported. The context can be lost between the
       probe above and this line — a backgrounded tab, a GPU reset, a driver
       hiccup, or simply too many live contexts on the page — and three.js does
       not degrade in that case, it THROWS from inside WebGLCapabilities. Left
       unguarded that exception escapes the effect, React tears the island down,
       and she gets an error boundary instead of a room. Caught, we leave
       data-webgl unset so the static grid room.astro already rendered stays on
       screen. The fallback is the default; the canvas is only ever the upgrade. */
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: !coarse, // MSAA on a 2x phone buys nothing you can see and costs fill rate.
        /* In image mode the canvas has to composite OVER the photographic backdrop
           layer, so it needs an alpha channel and a transparent clear. In
           procedural mode it is opaque black, which lets the driver keep the
           cheaper path — hence the switch rather than always-on alpha. */
        alpha: imageBackdrop,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
        stencil: false,
        depth: true,
      });
    } catch (err) {
      console.error('[us] WebGL renderer could not be created; keeping the static grid.', err);
      stage.setAttribute('data-webgl', 'no');
      return;
    }
    renderer.setClearColor(0x000000, imageBackdrop ? 0 : 1);
    // NoToneMapping is the default; set explicitly because a tone mapper is a
    // colour grade, and THE ONE RULE says the photos are never graded.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = false;

    const maxAniso = renderer.capabilities.getMaxAnisotropy();

    const scene = new THREE.Scene();
    scene.background = null;
    /* Pure black, so distance reads as darkness and never as a hue — and OFF
       entirely in image mode, where fogging toward black over a lit photograph
       would turn far panels into black rectangles hanging in a bright room. The
       distance fade in the frame loop covers that case instead. */
    scene.fog = FOG_ENABLED ? new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR) : null;

    const camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.1, FOG_FAR + 6);
    camera.position.set(0, CAM_Y, 0);

    /* =====================================================================
       SHARED RESOURCES

       One unit plane, scaled per instance. Thirteen panels x four quads plus
       thirteen mirrors is 65 meshes off ONE geometry, so there are four
       geometries in the whole scene to dispose instead of sixty-five.
       ===================================================================== */

    const quad = new THREE.PlaneGeometry(1, 1);
    const railGeo = new THREE.BoxGeometry(1, 1, 1);
    const disposableGeometries: THREE.BufferGeometry[] = [quad, railGeo];
    const disposableMaterials: THREE.Material[] = [];
    const disposableTextures: THREE.Texture[] = [];

    function ownMaterial<T extends THREE.Material>(m: T): T {
      disposableMaterials.push(m);
      return m;
    }

    /**
     * The mirror's alpha ramp: opaque at the floor line, gone a panel-height
     * later.
     *
     * One 4x64 texture shared by all thirteen reflections. It is an alphaMap,
     * which three samples from the GREEN channel, hence greyscale. flipY is
     * true by default and PlaneGeometry's v=0 is its bottom edge, so WHITE goes
     * at the BOTTOM of the canvas to land alpha=1 on local v=0 — which, after
     * the mirror's scale.y = -1, is the edge nearest the floor. Get this
     * backwards and the reflection fades out exactly where it should be
     * strongest.
     */
    function makeMirrorRamp(): THREE.CanvasTexture {
      const c = document.createElement('canvas');
      c.width = 4;
      c.height = 64;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, 0, 64);
      grad.addColorStop(0, '#000000'); // top of image  -> v=1 -> far from floor
      grad.addColorStop(0.55, '#3a3a3a');
      grad.addColorStop(1, '#ffffff'); // bottom of image -> v=0 -> at the floor
      g.fillStyle = grad;
      g.fillRect(0, 0, 4, 64);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.NoColorSpace; // a mask, not colour: never sRGB-decode it
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    }

    /** Soft radial falloff, for the LED bloom halos. Additive, never over a photo. */
    function makeGlow(): THREE.CanvasTexture {
      const S = 128;
      const c = document.createElement('canvas');
      c.width = S;
      c.height = S;
      const g = c.getContext('2d')!;
      const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.35, 'rgba(255,255,255,0.36)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.NoColorSpace;
      return t;
    }

    const mirrorRamp = makeMirrorRamp();
    const glowTex = makeGlow();
    disposableTextures.push(mirrorRamp, glowTex);

    /* ---------------------------------------------------------------------
       TEXT IN THE ROOM

       The wordmark, the wall vinyl, the exit sign and the carriage line numbers
       are all one function: text rasterised to a canvas and hung on a quad.

       Not a font loader, not troika-three-text, not an SDF atlas. Every one of
       those is a dependency, and this repo adds none — and for six short signs
       viewed at a distance, a 2D canvas is not merely adequate, it is sharper,
       because the glyphs are rasterised by the same engine that draws the rest
       of the page.
       --------------------------------------------------------------------- */
    interface TextPlaneOpts {
      /** World width. Height follows from the rasterised aspect, never stretched. */
      width: number;
      /** Padding around the glyphs, in ems. */
      pad?: number;
      /** Box behind the text, or 'transparent' for vinyl lettering. */
      bg?: string;
      fg?: string;
      bold?: boolean;
      opacity?: number;
    }

    function makeTextPlane(text: string, o: TextPlaneOpts): THREE.Mesh {
      const PX = 96;
      const pad = (o.pad ?? 0.2) * PX;
      /* Space Grotesk is already being fetched by this page for the HUD. If it has
         not landed by the time this runs the stack falls back to system-ui, which
         at wall-sign distance is a difference nobody will ever see — so this
         deliberately does NOT wait on document.fonts.ready and delay the room. */
      const font = `${o.bold ? 700 : 500} ${PX}px "Space Grotesk", system-ui, -apple-system, sans-serif`;

      const probe = document.createElement('canvas').getContext('2d');
      let textW = PX * text.length * 0.6;
      if (probe) {
        probe.font = font;
        textW = probe.measureText(text).width;
      }

      const c = document.createElement('canvas');
      c.width = Math.max(8, Math.ceil(textW + pad * 2));
      c.height = Math.max(8, Math.ceil(PX * 1.3 + pad * 2));
      const g = c.getContext('2d');
      if (g) {
        if (o.bg && o.bg !== 'transparent') {
          g.fillStyle = o.bg;
          g.fillRect(0, 0, c.width, c.height);
        }
        g.font = font;
        g.fillStyle = o.fg ?? '#ffffff';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(text, c.width / 2, c.height / 2 + PX * 0.04);
      }

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(4, maxAniso);
      disposableTextures.push(tex);

      const mesh = new THREE.Mesh(
        quad,
        ownMaterial(
          new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            opacity: o.opacity ?? 1,
            depthWrite: false,
            toneMapped: false, // a sign is not a photograph, but it is not graded either
          }),
        ),
      );
      mesh.scale.set(o.width, o.width * (c.height / c.width), 1);
      return mesh;
    }

    /* ---------------------------------------------------------------------
       ROWS OF REFORMERS

       Twenty machines is 20 x (frame + bed + two rests + a handlebar + five
       springs + a numbered decal) = ~200 meshes, which is ~200 draw calls for
       set dressing that is never closer than eighteen units. So every repeated
       part is ONE InstancedMesh: six draw calls for the whole far end of the
       studio, instead of two hundred.

       They live only in the FAR portion of the room, past the end of the
       carriage's reachable travel. That is deliberate on two counts: the middle
       of our room is the rail with the memories over it and must stay clear, and
       putting the rest of the studio in the part of the rail you are told you
       will never reach is the same joke as the unused 22%.
       --------------------------------------------------------------------- */
    const instanced: THREE.InstancedMesh[] = [];

    function buildReformers(parent: THREE.Object3D): void {
      const BED_L = 2.3;
      const BED_W = 0.78;
      const BED_Y = 0.52;
      const springCount = SPRING_COUNT_FROM_COLORS ? SPRING_COLORS.length : 5;

      const cols = REFORMER_COLUMNS;
      const rows = REFORMER_ROWS;
      const count = cols * rows;
      /* Between the far end of the reachable rail and the mirror wall. */
      const nearZ = -RAIL_LEN - 2;
      const farZ = Math.min(nearZ - (rows - 1) * REFORMER_ROW_GAP, MIRROR_WALL_Z + 3);
      const rowGap = rows > 1 ? (nearZ - farZ) / (rows - 1) : 0;

      const spots: Array<[number, number]> = [];
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          spots.push([(c - (cols - 1) / 2) * REFORMER_COL_GAP, nearZ - r * rowGap]);
        }
      }

      const m = new THREE.Matrix4();
      const place = (
        geo: THREE.BufferGeometry,
        mat: THREE.Material,
        per: (i: number, out: THREE.Matrix4) => void,
        n = count,
      ) => {
        const im = new THREE.InstancedMesh(geo, mat, n);
        for (let i = 0; i < n; i += 1) {
          per(i, m);
          im.setMatrixAt(i, m);
        }
        im.instanceMatrix.needsUpdate = true;
        im.frustumCulled = false; // one bounding box for the whole far end
        parent.add(im);
        instanced.push(im);
        return im;
      };

      const frameMat = ownMaterial(new THREE.MeshLambertMaterial({ color: REFORMER_FRAME_COLOR }));
      const bedMat = ownMaterial(new THREE.MeshLambertMaterial({ color: REFORMER_BED_COLOR }));

      // Frame, bed, and the two shoulder rests.
      place(railGeo, frameMat, (i, out) => {
        const [x, z] = spots[i];
        out.makeScale(BED_W + 0.16, 0.42, BED_L + 0.5);
        out.setPosition(x, 0.21, z);
      });
      place(railGeo, bedMat, (i, out) => {
        const [x, z] = spots[i];
        out.makeScale(BED_W, 0.13, BED_L);
        out.setPosition(x, BED_Y, z);
      });
      place(railGeo, bedMat, (i, out) => {
        const [x, z] = spots[i % count];
        const back = i < count ? 1 : -1;
        out.makeScale(BED_W * 0.92, 0.17, 0.3);
        out.setPosition(x, BED_Y + 0.14, z + back * (BED_L / 2 + 0.2));
      }, count * 2);

      /* The handlebars — the black hoops that read so strongly in the reference.
         A flattened box rather than a torus: at eighteen units a torus's 400
         triangles buy nothing a 12-triangle box does not. */
      const barMat = ownMaterial(new THREE.MeshLambertMaterial({ color: 0x0b0c11 }));
      place(railGeo, barMat, (i, out) => {
        const [x, z] = spots[i];
        out.makeScale(0.07, 1.1, 0.07);
        out.setPosition(x - BED_W * 0.42, 0.95, z + BED_L / 2 + 0.3);
      });
      place(railGeo, barMat, (i, out) => {
        const [x, z] = spots[i];
        out.makeScale(0.07, 1.1, 0.07);
        out.setPosition(x + BED_W * 0.42, 0.95, z + BED_L / 2 + 0.3);
      });

      /* THE SPRINGS.
         One InstancedMesh per colour, because an InstancedMesh has exactly one
         material — which is what makes SPRING_COLORS a per-spring array rather
         than a single value. Cylinders, 8 radial segments: they are coils seen
         from six metres, and 8 segments is already generous. */
      const springGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.34, 8, 1, true);
      disposableGeometries.push(springGeo);
      for (let s = 0; s < springCount; s += 1) {
        const springMat = ownMaterial(
          new THREE.MeshLambertMaterial({
            color: SPRING_COLORS[s % SPRING_COLORS.length],
            // Bare steel. Not emissive, not metallic-PBR — Lambert with a bright
            // albedo reads as brushed chrome under a blue wash, which is the look.
          }),
        );
        place(springGeo, springMat, (i, out) => {
          const [x, z] = spots[i];
          const spread = (s - (springCount - 1) / 2) * 0.115;
          out.makeRotationX(Math.PI / 2);
          out.setPosition(x + spread, 0.3, z - BED_L / 2 - 0.34);
        });
      }

      /* THE NUMBERED CARRIAGE LINES on each bed, baked into one texture and
         instanced — so all twenty beds cost one draw call and one texture.
         BOTH EDGES: see CARRIAGE_LINES_BOTH_EDGES. */
      const decal = makeCarriageDecal(BED_W, BED_L);
      if (decal) {
        place(quad, decal, (i, out) => {
          const [x, z] = spots[i];
          out.makeRotationX(-Math.PI / 2);
          out.scale(new THREE.Vector3(BED_W, BED_L, 1));
          out.setPosition(x, BED_Y + 0.068, z);
        });
      }
    }

    /**
     * The bed's top face: the white cross grid and the numbered position lines.
     *
     * Numbers go down BOTH edges. The reference photograph only numbers the left
     * rail of each carriage, and Sam asked for them mirrored — which is the better
     * call anyway: whichever side of the machine you are on, the line you are
     * being cued to should be readable without leaning across it.
     */
    function makeCarriageDecal(bedW: number, bedL: number): THREE.MeshBasicMaterial | null {
      const H = 512;
      const W = Math.max(8, Math.round((H * bedW) / bedL));
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      if (!g) return null;

      g.fillStyle = '#' + REFORMER_BED_COLOR.toString(16).padStart(6, '0');
      g.fillRect(0, 0, W, H);

      const ink = '#' + CARRIAGE_LINE_COLOR.toString(16).padStart(6, '0');
      g.strokeStyle = ink;
      g.globalAlpha = 0.5;
      g.lineWidth = Math.max(1, W * 0.014);
      // The cross grid.
      g.beginPath();
      g.moveTo(W / 2, H * 0.1);
      g.lineTo(W / 2, H * 0.9);
      g.moveTo(W * 0.12, H / 2);
      g.lineTo(W * 0.88, H / 2);
      g.stroke();

      // The numbered position lines.
      g.globalAlpha = 0.85;
      g.fillStyle = ink;
      const size = Math.round(W * 0.2);
      g.font = `600 ${size}px ui-monospace, "DM Mono", Menlo, monospace`;
      g.textBaseline = 'middle';
      const n = CARRIAGE_LINE_LABELS.length;
      for (let i = 0; i < n; i += 1) {
        const y = H * (0.2 + (0.6 * i) / Math.max(1, n - 1));
        g.textAlign = 'left';
        g.fillText(CARRIAGE_LINE_LABELS[i], W * 0.07, y);
        if (CARRIAGE_LINES_BOTH_EDGES) {
          g.textAlign = 'right';
          g.fillText(CARRIAGE_LINE_LABELS[i], W * 0.93, y);
        }
      }

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(4, maxAniso);
      disposableTextures.push(tex);
      return ownMaterial(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    }

    /* =====================================================================
       ARCHITECTURE

       Lambert, not Standard. A matte-black room has no metalness and no
       roughness variation, so PBR would be paying for a look nothing here
       uses — and it is the fragment shader that decides frame time in a scene
       this transparent and this fogged.
       ===================================================================== */

    const room = new THREE.Group();
    scene.add(room);

    const ROOM_LEN = RAIL_LEN + 30;
    const ROOM_MID_Z = -ROOM_LEN / 2 + 6;
    const ROOM_HALF_W = 5.3;
    const ROOM_H = 6.2;
    /** Far end of the room, where the mirror wall stands. */
    const MIRROR_WALL_Z = ROOM_MID_Z - ROOM_LEN / 2;

    /**
     * The floor IS the mirror, in both modes.
     *
     * Transparent dark concrete laid over the duplicated panels below it, so what
     * you see through it is a dimmed, ramped copy of the wall. The reference's
     * floor is properly polished, and the number that decides how polished ours
     * looks is FLOOR_REFLECTIVITY: the reflection's visible strength is
     * (mirror opacity) x (1 - floor opacity), so 0.70 x 0.38 lands at ~0.27, a wet
     * sheen. Raise it to hide the seam and the mirror disappears; drop it and the
     * room loses its floor.
     *
     * In IMAGE mode the photograph already has a floor, so ours is only there to
     * carry the panels' reflections — hence the extra transparency there.
     */
    const floorMat = ownMaterial(
      new THREE.MeshLambertMaterial({
        color: FLOOR_COLOR,
        transparent: true,
        opacity: imageBackdrop ? FLOOR_REFLECTIVITY * 0.55 : FLOOR_REFLECTIVITY,
        depthWrite: false,
      }),
    );
    const floor = new THREE.Mesh(quad, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.scale.set(16, ROOM_LEN, 1);
    floor.position.set(0, 0, ROOM_MID_Z);
    floor.renderOrder = 2;
    room.add(floor);

    /* =====================================================================
       PROCEDURAL ROOM

       Everything from here to the end of this block is skipped in image mode,
       where the photograph IS the room. Drawing our own walls, LED strips and
       reformers on top of a photograph of walls, LED strips and reformers would
       double every one of them.

       Kept in full, and kept working, because 'procedural' is a supported mode:
       it needs no asset and it moves in true perspective.
       ===================================================================== */
    if (!imageBackdrop) {
      const wallMat = ownMaterial(new THREE.MeshLambertMaterial({ color: WALL_COLOR }));
      for (const sx of [-1, 1]) {
        const wall = new THREE.Mesh(quad, wallMat);
        wall.scale.set(ROOM_LEN, ROOM_H, 1);
        wall.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
        wall.position.set(sx * ROOM_HALF_W, ROOM_H / 2, ROOM_MID_Z);
        room.add(wall);
      }

      const ceilMat = ownMaterial(new THREE.MeshLambertMaterial({ color: CEILING_COLOR }));
      const ceiling = new THREE.Mesh(quad, ceilMat);
      ceiling.rotation.x = Math.PI / 2;
      ceiling.scale.set(ROOM_HALF_W * 2 + 0.4, ROOM_LEN, 1);
      ceiling.position.set(0, ROOM_H, ROOM_MID_Z);
      room.add(ceiling);

      /* THE MIRROR WALL at the far end.
         Not a render-target reflection — that is a second full scene pass every
         frame, which on a phone is the difference between 60fps and 30. Instead
         it is a dark, slightly reflective plane carrying its own dimmer repeat of
         the wordmark, which is exactly what reads in the reference photograph:
         you register "mirror" from the doubled wordmark and the doubled LED line,
         not from a true reflection of the geometry. */
      const mirrorWallMat = ownMaterial(
        new THREE.MeshLambertMaterial({ color: 0x0d1018, transparent: true, opacity: 0.96 }),
      );
      const mirrorWall = new THREE.Mesh(quad, mirrorWallMat);
      mirrorWall.scale.set(ROOM_HALF_W * 2, ROOM_H, 1);
      mirrorWall.position.set(0, ROOM_H / 2, MIRROR_WALL_Z);
      room.add(mirrorWall);

      /* THE TWO LED STRIPS — the room's dominant light and its signature.
         Full width, one high near the ceiling and one at the base of the mirror
         wall. Two boxes each: a bright core and a wider, dimmer additive bloom,
         which is what makes a thin emissive line read as a light rather than as
         a painted stripe. */
      const ledCoreMat = ownMaterial(new THREE.MeshBasicMaterial({ color: LED_CORE_COLOR, fog: true }));
      const ledBloomMat = ownMaterial(
        new THREE.MeshBasicMaterial({
          color: LED_COLOR,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: true,
        }),
      );

      /** One strip: a core, a bloom, on any wall, at any height. */
      const addStrip = (
        y: number,
        len: number,
        axis: 'x' | 'z',
        pos: [number, number, number],
      ) => {
        for (const [mat, thick, order] of [
          [ledBloomMat, LED_THICKNESS * 4.5, 3],
          [ledCoreMat, LED_THICKNESS, 4],
        ] as const) {
          const s = new THREE.Mesh(railGeo, mat as THREE.MeshBasicMaterial);
          if (axis === 'z') s.scale.set(thick, thick, len);
          else s.scale.set(len, thick, thick);
          s.position.set(pos[0], y, pos[2]);
          s.renderOrder = order;
          room.add(s);
        }
      };

      // Side walls, running the length of the room, at both heights.
      for (const sx of [-1, 1]) {
        addStrip(LED_HIGH_Y, ROOM_LEN, 'z', [sx * (ROOM_HALF_W - 0.06), 0, ROOM_MID_Z]);
        addStrip(LED_LOW_Y, ROOM_LEN, 'z', [sx * (ROOM_HALF_W - 0.06), 0, ROOM_MID_Z]);
      }
      // And across the mirror wall, which is where the reference's read from.
      addStrip(LED_HIGH_Y, ROOM_HALF_W * 2, 'x', [0, 0, MIRROR_WALL_Z + 0.08]);
      addStrip(LED_LOW_Y, ROOM_HALF_W * 2, 'x', [0, 0, MIRROR_WALL_Z + 0.08]);

      /* THE WORDMARK BOX on the mirror wall, plus its dimmer repeat below —
         which is the cheapest possible way to say "this wall is a mirror". */
      const wordmark = makeTextPlane(WORDMARK_TEXT, {
        width: WORDMARK_WIDTH,
        pad: 0.28,
        bg: '#f2f5ff',
        fg: '#05070d',
        bold: true,
      });
      wordmark.position.set(0, WORDMARK_Y, MIRROR_WALL_Z + 0.12);
      wordmark.renderOrder = 4;
      room.add(wordmark);

      const wordmarkEcho = makeTextPlane(WORDMARK_TEXT, {
        width: WORDMARK_WIDTH * 0.55,
        pad: 0.28,
        bg: '#f2f5ff',
        fg: '#05070d',
        bold: true,
        opacity: 0.3,
      });
      wordmarkEcho.position.set(0, WORDMARK_Y * 0.42, MIRROR_WALL_Z + 0.11);
      wordmarkEcho.renderOrder = 4;
      room.add(wordmarkEcho);

      /* SIDE-WALL VINYL. The reference's left wall reads "strong is the new
         skinny"; ours is Sam's own line. Painted, not lit — vinyl, not neon. */
      for (const sx of [-1, 1]) {
        const vinyl = makeTextPlane(WALL_TEXT, {
          width: 4.2,
          pad: 0.1,
          bg: 'transparent',
          fg: '#e6e9f0',
          opacity: 0.82,
        });
        vinyl.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
        vinyl.position.set(sx * (ROOM_HALF_W - 0.05), 3.4, ROOM_MID_Z + ROOM_LEN * 0.22);
        vinyl.renderOrder = 4;
        room.add(vinyl);
      }

      /* THE EXIT SIGN. Tiny, and it is most of why the room reads as a real
         building rather than as a set. */
      if (EXIT_SIGN) {
        const exit = makeTextPlane('EXIT', {
          width: 0.62,
          pad: 0.16,
          bg: '#04120a',
          fg: '#7cf0a8',
          bold: true,
        });
        exit.position.set(ROOM_HALF_W - 0.9, ROOM_H - 1.5, MIRROR_WALL_Z + 0.2);
        exit.renderOrder = 4;
        room.add(exit);
        const exitGlow = new THREE.Mesh(
          quad,
          ownMaterial(
            new THREE.MeshBasicMaterial({
              map: glowTex,
              color: EXIT_SIGN_COLOR,
              transparent: true,
              opacity: 0.4,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          ),
        );
        exitGlow.scale.set(1.8, 1.8, 1);
        exitGlow.position.copy(exit.position);
        exitGlow.position.z += 0.02;
        exitGlow.renderOrder = 3;
        room.add(exitGlow);
      }

      /* CEILING PENDANTS. Black cylinders with a small tight pool under each. */
      const pendantBodyMat = ownMaterial(new THREE.MeshLambertMaterial({ color: 0x05060a }));
      const pendantGlowMat = ownMaterial(
        new THREE.MeshBasicMaterial({
          map: glowTex,
          color: PENDANT_GLOW_COLOR,
          transparent: true,
          opacity: PENDANT_GLOW_OPACITY,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: true,
        }),
      );
      const pendantCount = Math.max(1, Math.round(ROOM_LEN / PENDANT_SPACING));
      for (let i = 0; i < pendantCount; i += 1) {
        const z = ROOM_MID_Z + ROOM_LEN / 2 - (i + 0.5) * PENDANT_SPACING;
        for (const sx of [-1, 1]) {
          const body = new THREE.Mesh(railGeo, pendantBodyMat);
          body.scale.set(0.22, PENDANT_DROP, 0.22);
          body.position.set(sx * 3.1, ROOM_H - PENDANT_DROP / 2, z);
          room.add(body);
          const pool = new THREE.Mesh(quad, pendantGlowMat);
          pool.scale.set(1.5, 1.5, 1);
          pool.position.set(sx * 3.1, ROOM_H - PENDANT_DROP - 0.15, z);
          pool.renderOrder = 3;
          room.add(pool);
        }
      }

      /* ROWS OF REFORMERS receding toward the mirror. */
      buildReformers(room);
    }

    /* The rails. They run the FULL RAIL_LEN, which is the point: 22% of what you
       can see is travel the carriage will never use. Present in BOTH modes —
       they are the machine you are riding, not part of the set. */
    const railMat = ownMaterial(new THREE.MeshLambertMaterial({ color: 0x15161c }));
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.scale.set(0.1, 0.07, RAIL_LEN + 4);
      rail.position.set(sx * 0.86, 0.045, -RAIL_LEN / 2);
      room.add(rail);
    }

    /* Carriage lines 1-4, painted on the floor where each chapter begins.
       Additive so they read as light on concrete rather than paint. */
    const lineMat = ownMaterial(
      new THREE.MeshBasicMaterial({
        color: LED_COLOR,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

    /* =====================================================================
       LIGHTS

       Two on a coarse pointer, three otherwise. Every extra light in a Lambert
       scene is another full lighting term per fragment, and this scene is
       fill-rate bound.

       Ambient is near-black rather than absent: with zero ambient, a Lambert
       surface facing away from every light renders at pure #000 and the room
       loses its edges entirely.
       ===================================================================== */
    const ambient = new THREE.AmbientLight(0x0c0f16, imageBackdrop ? 2.1 : 1.35);
    scene.add(ambient);

    /* Intensity and placement are ARITHMETIC, not taste.
       three r155+ uses physically-correct falloff, so a PointLight's irradiance is
       intensity/d^2 and a Lambert surface reflects albedo/PI of it. The walls are
       #14151a — albedo 0.078 — and they must read as dark concrete catching blue
       light, call it 0.06 linear at closest approach:

         0.078/PI * I/d^2 = 0.06   ->   I/d^2 ~= 2.4

       The first version put these at x = +/-3.6 with intensity 62. That is 1.7
       units from a wall at +/-5.3, so I/d^2 = 21 — nine times over — and the
       left third of the frame rendered as a flat mid-grey sheet instead of as a
       wall. At x = +/-2.4 the gap is 2.9 units, so intensity 22 gives I/d^2 =
       2.6. Same reasoning keeps them off the ceiling (y 4.0, not 4.9) and off the
       floor (y 1.9, not 1.1). */
    const wash: THREE.PointLight[] = [];
    const washCount = coarse ? LED_WASH_COUNT_COARSE : LED_WASH_COUNT;
    for (let i = 0; i < washCount; i += 1) {
      // `distance` bounds the light's influence so fragments outside it skip the
      // term entirely; decay 2 is the physically-correct default.
      const p = new THREE.PointLight(
        LED_COLOR,
        // In image mode the photograph supplies the room's light; these are only
        // here to light OUR machine, so they are pulled well back.
        imageBackdrop ? LED_WASH_INTENSITY * 0.55 : LED_WASH_INTENSITY,
        LED_WASH_DISTANCE,
        2,
      );
      scene.add(p);
      wash.push(p);
    }

    /* =====================================================================
       THE CARRIAGE

       A matte platform running forward from under the camera, with a lit front
       edge and a pool of blue on the floor around it. You are seated at the BACK
       of it and it extends away toward the memory — which is what a reformer
       carriage actually looks like from on top of it.

       WHY IT EXTENDS FORWARD AND IS NOT A PLATE UNDER THE CAMERA: with a level
       camera at CAM_Y and a 42-degree fov, the bottom of the frustum crosses the
       floor at 1.55 / tan(21deg) = 4.0 units ahead. Anything below eye level and
       nearer than that is simply outside the frame. A plate directly beneath the
       camera is therefore invisible unless you pitch the camera down ~4 degrees,
       which tilts the whole composition and shoves the panels toward the top of
       frame for no gain. So the carriage starts at the camera and runs to 6.6
       units out, and its visible span is the 3 units of it past the floor line.
       ===================================================================== */
    const carriage = new THREE.Group();
    scene.add(carriage);

    /* Darker than --machine (#15161a) on purpose. The nearest wash light sits
       about 3 units from the front of the plate, so at Lambert's inverse-square
       falloff the plate is the brightest lit surface in frame and #15161a read as
       mid-grey rather than as matte black. The colour compensates for where the
       light is, which is what you would do with paint in a real room. */
    const plateMat = ownMaterial(
      new THREE.MeshLambertMaterial({
        color: 0x0d0e11,
        transparent: imageBackdrop,
        opacity: imageBackdrop ? CARRIAGE_OPACITY_ON_IMAGE : 1,
        depthWrite: !imageBackdrop,
      }),
    );
    const plate = new THREE.Mesh(railGeo, plateMat);
    plate.scale.set(CARRIAGE_WIDTH, 0.09, CARRIAGE_LENGTH);
    // Still wide enough to cover the rails it rides on (x = +/-0.86): a carriage
    // you can see the rail through is a floating slab.
    plate.position.set(0, 0.105, -CARRIAGE_LENGTH / 2 - 0.1);
    plate.renderOrder = 2;
    carriage.add(plate);

    /* The carriage's lit front edge. Additive, so it reads as an LED strip
       rather than as paint, and it is the thing that actually makes the motion
       legible: a moving line of light on an otherwise featureless platform. */
    const edgeMat = ownMaterial(
      new THREE.MeshBasicMaterial({
        color: LED_CORE_COLOR,
        transparent: true,
        opacity: CARRIAGE_EDGE_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const frontEdge = new THREE.Mesh(railGeo, edgeMat);
    frontEdge.scale.set(CARRIAGE_WIDTH + 0.06, 0.03, 0.06);
    frontEdge.position.set(0, 0.16, -CARRIAGE_LENGTH - 0.1);
    frontEdge.renderOrder = 3;
    carriage.add(frontEdge);

    const underglowMat = ownMaterial(
      new THREE.MeshBasicMaterial({
        map: glowTex,
        color: LED_COLOR,
        transparent: true,
        // Turned down over a photograph that already has a lit floor.
        opacity: imageBackdrop ? 0.3 : 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // No fog on the glow: it is a light source, and fogging a light toward
        // black is the one place the black-fog trick reads as a bug.
        fog: false,
      }),
    );
    const underglow = new THREE.Mesh(quad, underglowMat);
    underglow.rotation.x = -Math.PI / 2;
    underglow.scale.set(4.2, 5.4, 1);
    // Centred under the working position, not under the camera: the machine's
    // light pools where the rep is happening.
    underglow.position.set(0, 0.02, -4.6);
    underglow.renderOrder = 3;
    carriage.add(underglow);

    /* ---------------------------------------------------------------------
       CARRIAGE LINES 1-4, ON BOTH EDGES OF OUR OWN CARRIAGE.

       This is where Sam's correction actually lands. The reference photograph
       numbers only the left rail of each carriage; he asked for them mirrored on
       the right, and he is right — whichever side of the machine you are on, the
       line you are being cued to should be readable without leaning across it.

       They are also the in-world half of the progress indicator: the line for the
       chapter you are in lights up, on both edges, while the other three stay
       painted-on. So the HUD's `01 02 03 04` and the numbers on the machine under
       you are the same fact, shown twice — which is exactly what the real rail
       positions are for.

       Separate planes rather than one baked texture precisely so that one of them
       can be lit. Eight small quads is a rounding error next to the panels.
       --------------------------------------------------------------------- */
    interface CarriageMark {
      line: number;
      mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    }
    const carriageMarks: CarriageMark[] = [];
    {
      const n = CARRIAGE_LINE_LABELS.length;
      const edges = CARRIAGE_LINES_BOTH_EDGES ? [-1, 1] : [-1];
      for (let i = 0; i < n; i += 1) {
        for (const sx of edges) {
          const mark = makeTextPlane(CARRIAGE_LINE_LABELS[i], {
            width: 0.3,
            pad: 0.24,
            bg: 'transparent',
            fg: '#ffffff',
            bold: true,
            opacity: 0.3,
          }) as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
          mark.rotation.x = -Math.PI / 2;
          // Spread along the visible span of the plate (z -4.0 to -6.3), which is
          // the part past the floor line — see the carriage comment above.
          mark.position.set(
            sx * (CARRIAGE_WIDTH / 2 - 0.13),
            0.155,
            -3.5 - (i / Math.max(1, n - 1)) * (CARRIAGE_LENGTH - 3.7),
          );
          mark.renderOrder = 4;
          carriage.add(mark);
          carriageMarks.push({ line: i + 1, mesh: mark });
        }
      }
    }

    /* =====================================================================
       PANELS
       ===================================================================== */

    const panelGroup = new THREE.Group();
    const mirrorsRoot = new THREE.Group();
    scene.add(panelGroup, mirrorsRoot);

    const rigs: PanelRig[] = [];
    /** Only the photo quads are raycast against — thirteen quads, not the room. */
    const pickable: THREE.Object3D[] = [];

    for (let i = 0; i < memories.length; i += 1) {
      const memory = memories[i];

      const group = new THREE.Group();

      /* The blue rim. Furthest back, largest, additive: it is a light spilling
         from behind the panel, so it can never land ON the photograph. Opacity
         runs from wash (idle, focused) to glow (max tension). */
      const rim = new THREE.Mesh(
        quad,
        ownMaterial(
          new THREE.MeshBasicMaterial({
            color: LED_COLOR,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        ),
      );
      rim.position.z = -0.03;
      rim.renderOrder = 3;

      /* Soft halo behind the rim — the cheap stand-in for a bloom pass. Also
         additive, also strictly behind the photo. */
      const halo = new THREE.Mesh(
        quad,
        ownMaterial(
          new THREE.MeshBasicMaterial({
            map: glowTex,
            color: LED_CORE_COLOR,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        ),
      );
      halo.position.z = -0.05;
      halo.renderOrder = 3;

      /* Matte-black machined backing, one hairline larger than the photo.
         `transparent` so it dissolves WITH the photo — fading only the photo
         would reveal this behind it instead of revealing the room. */
      const backing = new THREE.Mesh(
        quad,
        ownMaterial(
          new THREE.MeshBasicMaterial({
            color: 0x08090b,
            transparent: true,
            opacity: 1,
          }),
        ),
      );
      backing.position.z = -0.015;
      backing.renderOrder = 4;

      /* THE PHOTOGRAPH. MeshBasicMaterial, toneMapped:false, colour pinned to
         white the moment a map exists. See THE ONE RULE at the top.

         `transparent: true` is here for the pass/distance dissolve and nothing
         else. It is NOT a grade: the panel at the viewing position renders at
         exactly opacity 1, and the only thing that moves it is where the camera
         is — the same category of rule as the fog. Render order 5 puts it after
         the rim, the halo and its own backing, so it composites over all three. */
      const photo = new THREE.Mesh(
        quad,
        ownMaterial(
          new THREE.MeshBasicMaterial({
            color: 0x0e0f12, // unloaded: matte concrete, NOT a tint of a photo
            transparent: true,
            opacity: 1,
            toneMapped: false,
          }),
        ),
      );
      photo.renderOrder = 5;

      group.add(halo, rim, backing, photo);
      panelGroup.add(group);
      pickable.push(photo);

      /* The reflection. Same texture object, second material: one upload, two
         draws. scale.y = -1 mirrors it through the floor plane, which inverts
         the winding, which is why DoubleSide is mandatory here and not a
         nicety — without it the reflection is invisible. */
      const mirrorMeshGroup = new THREE.Group();
      const mirror = new THREE.Mesh(
        quad,
        ownMaterial(
          new THREE.MeshBasicMaterial({
            color: 0x0e0f12,
            transparent: true,
            opacity: MIRROR_STRENGTH,
            alphaMap: mirrorRamp,
            side: THREE.DoubleSide,
            depthWrite: false,
            toneMapped: false,
          }),
        ),
      );
      mirror.scale.y = -1;
      mirror.renderOrder = 1;
      mirrorMeshGroup.add(mirror);
      mirrorsRoot.add(mirrorMeshGroup);

      rigs.push({
        memory,
        group,
        photo,
        backing,
        rim,
        halo,
        mirror,
        mirrorGroup: mirrorMeshGroup,
        aspect: memory.aspect > 0 ? memory.aspect : 1,
        parkZ: 0, // set by layout()
        texture: null,
        image: null,
        state: 'idle',
        usedFallback: false,
        tension: 0,
        revealed: false,
        fade: 1,
      });
    }

    /** Hoisted so the frame loop is not scanning thirteen rigs for it 60 times a second. */
    const hiddenRig = rigs.find((r) => r.memory.hidden) ?? null;
    const hiddenIndex = hiddenRig ? rigs.indexOf(hiddenRig) : -1;

    /** Floor marks for the four carriage lines, placed in layout(). */
    const lineMarks: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i += 1) {
      const mark = new THREE.Mesh(quad, lineMat);
      mark.rotation.x = -Math.PI / 2;
      mark.scale.set(3.2, 0.12, 1);
      mark.position.y = 0.012;
      mark.renderOrder = 3;
      room.add(mark);
      lineMarks.push(mark);
    }

    /* =====================================================================
       LAYOUT

       Panel positions are DERIVED from what the camera can actually see at the
       viewing distance, not hardcoded. Hardcoding x = +/-2.95 looks correct on
       a laptop and puts every panel completely off-screen on a phone: at fov 42
       and 7 units, a 9:19.5 portrait viewport sees 1.24 world units either side
       of centre. So on a narrow viewport the wall collapses toward a centre
       column and the panels grow instead.
       ===================================================================== */

    let cssW = 1;
    let cssH = 1;
    /** Uniform panel height, used on wide viewports. */
    let panelH = 3.2;
    let wallX = 2.9;
    /** World units visible across the frame at the viewing distance. */
    let visW = 8;
    /** True when the frame is too narrow for a two-sided corridor. */
    let narrow = false;

    /**
     * Fraction of the visible width the widest panel may occupy on a narrow
     * viewport. 0.84 rather than 1.0 because a panel that exactly fills the
     * frustum has its edges ON the frame edge, which reads as a cropped photo
     * rather than as a hung one.
     */
    const NARROW_FILL = 0.84;

    /** Minimum lateral offset for a two-sided corridor to read as two-sided. */
    const MIN_WALL_X = 0.5;

    /**
     * The widest panel the wall has to accommodate.
     *
     * Tracked as a variable, not a constant, because applyTexture() re-derives a
     * panel's aspect from its DECODED image — so a photograph wider than its
     * manifest hint can arrive after layout has already decided the wall fits.
     * When that happens the loader bumps this and re-runs layout, which is the
     * only way the "does the widest panel fit?" test below can stay true.
     */
    let widestAspect = Math.max(1.5, ...memories.map((m) => (m.aspect > 0 ? m.aspect : 1)));
    /** Stage height in px; only recomputed when it is safe to (see layout()). */
    let stagePx = 0;
    let lastStageW = -1;
    /**
     * How far the sticky frame stays pinned: the stage's real height minus its
     * own. This is the exact denominator for scroll progress, and it is measured
     * rather than derived from `window.innerHeight` for two independent reasons:
     *
     *  1. On iOS the URL bar collapsing changes window.innerHeight by ~100px
     *     mid-scroll. Deriving the span from it means progress reaches 1 early,
     *     which would arm "still one more" before the carriage got there.
     *  2. The reduced-motion stylesheet overrides the inline stage height with
     *     `!important`, so the value we WROTE is not always the value in effect.
     *     Reading it back is the only way to be right in both cases.
     */
    let spanPx = 0;

    /* ---- adaptive resolution -------------------------------------------
       The pixel budget above is a guess about hardware. This is a
       measurement of it. If the room sustains frame times worse than
       SLOW_FRAME_MS we drop the pixel ratio and keep dropping until it is
       interactive, which is the acceptance criterion PLAN.md R4 actually
       states ("interactive on a mid-tier phone or the fallback ships
       instead"). Soft beats 25fps, every time.

       It is one-way on purpose. Ratcheting back up when things briefly
       improve produces a room that visibly pulses between two
       resolutions, which is worse than either. */
    const SLOW_FRAME_MS = 22; // ~45fps
    const SLOW_FRAME_BUDGET = 90; // ~2s of sustained slowness, net of good frames
    let baseDpr = 1;
    let dprScale = 1;
    let slowFrames = 0;

    function applyPixelRatio(): void {
      renderer.setPixelRatio(Math.max(1, baseDpr * dprScale));
    }

    /**
     * WIDE: every panel shares a height, so the wall reads as hung on one centre
     * line — which is what a gallery looks like and what the mirror doubles well.
     *
     * NARROW: every panel shares a WIDTH instead, and the height follows from the
     * aspect. Sizing by height on a phone was measurably wrong: at 390x844 the
     * frame is only 2.48 world units across at the viewing distance, so a
     * 3.0-tall portrait panel came out 2.4 wide and bled off both edges, and a
     * 1.5:1 landscape one would have been 4.5 wide against 2.48 of frame — nearly
     * two thirds of the photograph off-screen. On a phone the constraint is the
     * width, so the width is what gets fixed.
     */
    function sizeRig(rig: PanelRig): void {
      const h = narrow
        ? Math.min(panelH, (visW * NARROW_FILL) / Math.max(0.2, rig.aspect))
        : panelH;
      const w = h * rig.aspect;
      rig.photo.scale.set(w, h, 1);
      rig.backing.scale.set(w + 0.07, h + 0.07, 1);
      rig.rim.scale.set(w + 0.34, h + 0.34, 1);
      rig.halo.scale.set(w * 2.1 + 1.4, h * 2.1 + 1.4, 1);
      rig.mirror.scale.set(w, -h, 1);
    }

    function layout(): void {
      const rect = sticky.getBoundingClientRect();
      cssW = Math.max(1, Math.round(rect.width));
      cssH = Math.max(1, Math.round(rect.height));

      baseDpr = chooseDpr(
        cssW,
        cssH,
        window.devicePixelRatio || 1,
        2,
        /* Generous backstops, not policy. At 2x these clear every real device:
           a phone is 1.6M, an iPad Pro is 5.6M, a 5K desktop's 2560x1440 css
           viewport is 14.7M. Only a viewport larger than about 2800x2800 css
           gets scaled by the budget rather than by the hard cap. Actual slow
           hardware is caught by the frame-time measurement, not here. */
        coarse ? 6_000_000 : 16_000_000,
      );
      applyPixelRatio();
      renderer.setSize(cssW, cssH, false);

      camera.aspect = cssW / cssH;
      camera.updateProjectionMatrix();

      // What the camera actually sees at the viewing distance.
      const visH = 2 * VIEW_AHEAD * Math.tan((camera.fov * Math.PI) / 360);
      visW = visH * camera.aspect;

      /* WIDE OR NARROW — DERIVED, NOT A BREAKPOINT.
         This was `visW < 3.4`, a number picked by looking at a phone, and it was
         wrong for the case in between: an iPad in portrait (820x1180) sees 3.73
         units across, so it took the wide path, and its 1.5:1 panels then stuck
         0.89 units past the frame edge because the wide path's wallX clamp
         silently gave up when there was no room. The honest question is not "how
         many CSS pixels is this" but "does the widest panel I might have to hang
         actually fit beside a real lateral offset", so that is what is asked. */
      const heightCap = Math.min(PANEL_HEIGHT_MAX, visH * PANEL_HEIGHT_FRACTION);
      const widestAtCap = heightCap * widestAspect;
      narrow = MIN_WALL_X + widestAtCap / 2 > visW * 0.5 * 0.92;

      // On narrow this is only a CEILING — sizeRig() derives each panel's real
      // height from the shared width. On wide it is the height.
      panelH = narrow
        ? Math.min(PANEL_HEIGHT_MAX_NARROW, visH * PANEL_HEIGHT_FRACTION_NARROW)
        : heightCap;

      if (narrow) {
        /* One column, with only a hint of alternation. There is no room for two:
           a panel already occupies NARROW_FILL of the frame, so any meaningful
           lateral offset pushes it off an edge. The corridor's depth does the
           work instead of its width. */
        wallX = Math.max(0.05, visW * (0.5 - NARROW_FILL / 2) * 0.9);
      } else {
        // Keep the widest panel's outer edge inside the frustum with a margin.
        // The `narrow` test above has already guaranteed this has a solution.
        wallX = Math.max(
          MIN_WALL_X,
          Math.min(2.95, visW * 0.5 - (panelH * widestAspect) / 2 - 0.25),
        );
      }

      let wallIndex = 0;
      for (let i = 0; i < rigs.length; i += 1) {
        const rig = rigs[i];
        sizeRig(rig);

        let x: number;
        let z: number;
        if (i === 0) {
          // WARM-UP / CORE ACTIVATION: one panel, dead centre, before the room
          // widens into chapters.
          x = 0;
          z = WARMUP_Z;
        } else if (rig.memory.hidden) {
          // "still one more", parked past the far end of the used travel.
          x = 0;
          z = -RAIL_LEN * (MAX_EXTENSION - MICRO_BEND) - VIEW_AHEAD - 6.5;
        } else {
          x = wallIndex % 2 === 0 ? -wallX : wallX;
          z = WALL_START_Z - wallIndex * WALL_GAP;
          wallIndex += 1;
        }

        rig.parkZ = z;
        rig.group.position.set(x, PANEL_Y, z);
        // Turn each panel to face the rail. Scaled by how far out it actually
        // sits, so on a phone (wallX ~0.5) the panels stay nearly square-on
        // instead of showing you their edges.
        rig.group.rotation.y = -(x / 2.95) * 0.3;

        rig.mirrorGroup.position.set(x, -PANEL_Y, z);
        rig.mirrorGroup.rotation.y = rig.group.rotation.y;
      }

      // Carriage line marks: one on the floor at the first panel of each chapter.
      for (let l = 0; l < lineMarks.length; l += 1) {
        const first = rigs.find((r) => !r.memory.hidden && r.memory.line === l + 1);
        lineMarks[l].position.z = first ? first.parkZ : -RAIL_LEN;
        lineMarks[l].visible = Boolean(first);
      }

      /* Scroll length.
         Recomputed only when the WIDTH changed, or on the first pass. On iOS the
         URL bar collapsing fires resize with a ~100px height delta mid-scroll;
         rewriting the stage height at that moment moves the scroll span under
         the user's thumb and the carriage jumps. Width is the honest signal that
         the layout actually changed. */
      if (lastStageW !== cssW || stagePx === 0) {
        lastStageW = cssW;
        const screens = reduced ? 1 : 1 + SCREENS_PER_PANEL * rigs.length;
        stagePx = Math.round(window.innerHeight * screens);
        stage.style.height = `${stagePx}px`;
        // The scroll span just changed under ScrollTrigger's feet. Without this
        // its start/end are still calibrated to the old height and progress
        // saturates early (or never reaches 1, which would make "still one more"
        // unreachable). `invalidateOnRefresh` on the tween handles the rest.
        refreshScrollTrigger();
      }

      // One forced layout read per resize, deliberately AFTER the height write
      // above so it reflects whatever is actually in effect.
      spanPx = Math.max(0, stage.offsetHeight - sticky.offsetHeight);

      // The `cover` crop just changed, so where the photograph's sign landed
      // changed with it. Re-register ours onto it.
      layoutBackdropOverlay();
    }

    /* =====================================================================
       TEXTURES

       The lazy loader, the residency cap, and the single place where a photo's
       colour is set.
       ===================================================================== */

    let corsWarned = false;

    /**
     * Which variant of a photograph to ask for.
     *
     * On a coarse pointer, the downscaled one. This is the single biggest lever on
     * the texture budget that PLAN.md R4 is actually about: a decoded 1600px
     * photograph is ~7.7MB of GPU memory, five of them is 38MB, and asking for a
     * half-size file instead cuts that by roughly four. Safe unconditionally —
     * /api/us/photo falls back to the full-size object when no `@sm` sibling
     * exists yet, and to a placeholder when neither does.
     */
    function photoSrc(m: ClientMemory): string {
      return coarse ? m.srcSmall : m.src;
    }

    /**
     * The ONLY function that attaches a photo to a material.
     *
     * `color = 0xffffff` is the invariant: in three.js `color` multiplies the
     * map, so anything else here is a tint, and a tint is the one thing this
     * room is not allowed to do to a memory. Keeping the assignment in one
     * function is what makes that checkable by reading rather than by grepping.
     */
    function applyTexture(rig: PanelRig, img: HTMLImageElement): void {
      const tex = new THREE.Texture(img);
      // sRGB, because the file is sRGB. Skipping this renders every photo
      // washed out and everybody blames the fog.
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      // 4 is the knee of the quality/bandwidth curve for a panel viewed at a
      // shallow angle; 16 costs real bandwidth for a difference nobody sees.
      tex.anisotropy = Math.min(4, maxAniso);
      tex.needsUpdate = true;

      rig.texture = tex;
      rig.photo.material.map = tex;
      rig.photo.material.color.setHex(0xffffff); // INVARIANT: never tint a photo
      rig.photo.material.needsUpdate = true;

      rig.mirror.material.map = tex;
      rig.mirror.material.color.setHex(0xffffff);
      rig.mirror.material.needsUpdate = true;

      /* Trust the DECODED image over the manifest.
         `aspect` in photos.ts is a layout hint so the panel has a shape before
         the bytes land. Re-deriving it here means a stale manifest value can
         never stretch a face — which matters because that field would otherwise
         have to be hand-synced with a file in a bucket, forever. */
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        rig.aspect = img.naturalWidth / img.naturalHeight;
        if (rig.aspect > widestAspect) {
          /* This photograph is wider than anything the wall was laid out for, so
             the wide/narrow decision and wallX were both made against a stale
             maximum and this panel would hang off the frame edge. Re-deciding is
             the only correct response; it happens at most once per new widest
             photo, and never in the steady state. */
          widestAspect = rig.aspect;
          layout();
        } else {
          sizeRig(rig);
        }
      }

      rig.state = 'ready';
      invalidate();
    }

    function clearTexture(rig: PanelRig): void {
      if (rig.image) {
        rig.image.onload = null;
        rig.image.onerror = null;
        // Abort a flight in progress. Assigning '' is the documented way to tell
        // the browser to stop fetching an image it no longer needs.
        rig.image.src = '';
        rig.image = null;
      }
      if (rig.texture) {
        rig.photo.material.map = null;
        rig.photo.material.color.setHex(0x0e0f12);
        rig.photo.material.needsUpdate = true;
        rig.mirror.material.map = null;
        rig.mirror.material.color.setHex(0x0e0f12);
        rig.mirror.material.needsUpdate = true;
        rig.texture.dispose();
        rig.texture = null;
      }
      rig.state = 'idle';
    }

    function loadTexture(rig: PanelRig, url: string, isFallback: boolean): void {
      const img = new Image();
      rig.image = img;
      rig.state = 'loading';
      /* crossOrigin is REQUIRED and it is the sharp edge of this whole design.
         /api/us/photo/[id] 302s to a presigned R2 URL, and WebGL refuses to
         upload a cross-origin image that was not fetched with CORS — texImage2D
         throws a SecurityError on a tainted image, so the failure is a hard
         exception rather than a black panel. The R2 bucket therefore needs a
         CORS rule allowing this origin (see the report/README). In the
         unconfigured path the endpoint serves the SVG itself, same-origin,
         where this attribute is a no-op. */
      if (!isFallback) img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        if (rig.image !== img) return; // superseded by an evict/reload
        applyTexture(rig, img);
      };
      img.onerror = () => {
        if (rig.image !== img) return;
        if (!isFallback) {
          /* Degrade to the inline card rather than to a hole in the wall. The
             overwhelmingly likely cause is the missing R2 CORS rule, and a room
             full of labelled placeholders diagnoses that in one glance where
             thirteen black rectangles diagnose nothing. */
          if (!corsWarned) {
            corsWarned = true;
            console.warn(
              '[us] a photo failed to load for WebGL. If R2 is configured, the bucket ' +
                'almost certainly needs a CORS rule allowing this origin — a texture ' +
                'from a cross-origin image without CORS cannot be uploaded. Falling ' +
                'back to the inline placeholder cards.',
            );
          }
          rig.usedFallback = true;
          loadTexture(rig, rig.memory.placeholder, true);
          return;
        }
        rig.state = 'failed';
        rig.image = null;
      };
      img.src = url;
    }

    const maxLive = coarse ? 5 : 9;

    /**
     * Scratch list, allocated once and re-sorted in place every frame.
     *
     * Thirteen small objects per frame is not a lot, but it is 780 allocations a
     * second handed to the GC for no reason, and a GC pause in a scroll-driven
     * camera is visible as a stutter.
     */
    const byDistance = rigs.map((rig) => ({ rig, d: 0 }));

    /** Loads started per frame. Ordering matters more than throughput here. */
    const LOADS_PER_FRAME = 2;

    /**
     * Residency pass. Load what is close, dispose what is far, and NEVER hold
     * more than maxLive textures.
     *
     * The cap is enforced on the LOAD side, which is the part an earlier version
     * got wrong. Evicting only what is beyond EVICT_BEYOND sounds sufficient
     * until you notice that panels are WALL_GAP apart: within LOAD_AHEAD of the
     * carriage there are eight of them, none of which is beyond the eviction
     * distance, so the cap of five was silently unenforceable and a phone held
     * eight full-resolution photographs at once. Refusing to START a load past
     * the cap makes "at most maxLive textures exist" an invariant instead of an
     * aspiration.
     *
     * Nearest-first, so the panel she is actually looking at is the one that
     * arrives first and the one that is never evicted.
     *
     * LOAD_AHEAD (22) and EVICT_BEYOND (34) are deliberately different. With one
     * threshold, parking the carriage on the boundary and jiggling would upload
     * and dispose the same multi-megabyte texture every frame; the gap is the
     * hysteresis that makes that impossible.
     */
    function updateResidency(camZ: number): void {
      let live = 0;
      for (const entry of byDistance) {
        entry.d = Math.abs(entry.rig.group.position.z - camZ);
        if (entry.rig.state === 'ready' || entry.rig.state === 'loading') live += 1;
      }
      byDistance.sort((a, b) => a.d - b.d);

      /* ---- evict, furthest first ---- */
      for (let i = byDistance.length - 1; i >= 0 && live > maxLive; i -= 1) {
        const { rig, d } = byDistance[i];
        const resident = rig.state === 'ready' || rig.state === 'loading';
        /* Distance is the ONLY criterion. An earlier draft also spared anything
           already revealed, which reintroduced the exact bug the cap exists to
           prevent: reveal all thirteen and nothing is ever evictable again. A
           revealed panel thirty-four units behind the carriage is not being
           looked at, and its note lives in the HUD, not in the texture. */
        if (resident && d > EVICT_BEYOND) {
          clearTexture(rig);
          live -= 1;
        }
      }

      /* ---- load, nearest first, within the cap ---- */
      let started = 0;
      for (const { rig, d } of byDistance) {
        if (live >= maxLive || started >= LOADS_PER_FRAME) break;
        // The hidden panel stays dark until the carriage has earned it. Loading
        // it early would put "still one more" in the fog where it can be seen.
        if (rig.memory.hidden && !hiddenArmed) continue;
        if (rig.state !== 'idle' || d >= LOAD_AHEAD) continue;
        loadTexture(rig, photoSrc(rig.memory), rig.usedFallback);
        live += 1;
        started += 1;
      }
    }

    /* =====================================================================
       PROGRESS: SCROLL -> CARRIAGE

       Two implementations of one number.
       ===================================================================== */

    /**
     * The raw 0..1 scroll position of the stage.
     *
     * `-rect.top` is exactly how far the sticky frame has been pinned, so
     * dividing by spanPx is the geometry rather than an approximation of it.
     */
    function scrollProgress(): number {
      if (spanPx <= 0) return reduced ? 1 : 0;
      const top = stage.getBoundingClientRect().top;
      return clamp01(-top / spanPx);
    }

    interface GsapLike {
      to: (target: unknown, vars: Record<string, unknown>) => { kill: () => void };
      registerPlugin: (...p: unknown[]) => void;
    }

    const g = window as unknown as {
      gsap?: GsapLike;
      ScrollTrigger?: { refresh?: () => void };
    };

    /** What the frame loop reads when GSAP owns progress. */
    const scrub = { p: 0 };
    let gsapTween: { kill: () => void } | null = null;
    let usingGsap = false;

    let progress = reduced ? 1 : 0;
    let targetProgress = progress;

    /* Declared HERE, above attachGsap, and not down in the boot block where it
       is registered. attachGsap() removes this listener when GSAP takes over,
       and attachGsap() can run synchronously during hydration — a `const`
       declared later would be in its temporal dead zone and the whole island
       would throw on the one path where GSAP is already loaded. */
    const onScroll = () => {
      targetProgress = scrollProgress();
      // A scroll while the loop is parked (out of view, or a hidden tab that is
      // still being scrolled by a restored session) still needs one repaint.
      if (!running) invalidate();
    };

    /**
     * Try to hand progress over to GSAP. Returns whether it took.
     *
     * `scrub: 1` is the whole reason to reach for GSAP at all: the one-second lag
     * between the scrollbar and the carriage IS the spring resistance of the
     * machine. Note this is a scrubbed TWEEN, not an onEnter callback — onEnter
     * fires once at a threshold, so a camera path built on it snaps from station
     * to station instead of travelling, which is the documented wrong tool here.
     */
    function attachGsap(): boolean {
      if (usingGsap || reduced || !g.gsap || !g.ScrollTrigger) return false;
      try {
        g.gsap.registerPlugin(g.ScrollTrigger);
        gsapTween = g.gsap.to(scrub, {
          p: 1,
          ease: 'none',
          scrollTrigger: {
            trigger: stage,
            start: 'top top',
            end: 'bottom bottom',
            scrub: 1,
            invalidateOnRefresh: true,
          },
        });
        usingGsap = true;
        // ScrollTrigger owns progress now; a second scroll listener feeding the
        // damped path would just be dead weight running on every scroll event.
        window.removeEventListener('scroll', onScroll);
        return true;
      } catch (err) {
        /* A GSAP that is present but unhappy must not take the room down with
           it. The damped path below is a complete implementation, not a stub. */
        console.warn('[us] GSAP present but ScrollTrigger failed; using the damped scrub.', err);
        usingGsap = false;
        gsapTween = null;
        return false;
      }
    }

    /* -------------------------------------------------------------------
       WHY THIS IS A WAIT AND NOT A ONE-SHOT CHECK

       room.astro loads gsap.min.js and ScrollTrigger.min.js at the END of the
       body, so they do not block first paint. But an Astro `client:load` island
       hydrates from its own <astro-island> element's connectedCallback, which
       fires while the parser is still working — and the component module is
       modulepreloaded, so on a warm cache it can evaluate BEFORE the parser
       reaches those two script tags.

       A plain `if (window.gsap)` at hydration time is therefore a race. It would
       lose silently: the room would take the damped path, look almost right, and
       nobody would ever find out that the `scrub: 1` the plan specifies was
       never running. So: check now, and if GSAP is merely LATE rather than
       ABSENT, upgrade when it lands. The damped scrub runs in the meantime, so
       there is no loading state and no jump — ScrollTrigger seeds `scrub.p` from
       the real scroll position the moment it is created.
       ------------------------------------------------------------------- */
    const gsapWaitOff: Array<() => void> = [];

    function waitForGsap(): void {
      // Is GSAP even supposed to be here? If no tag references it, this page has
      // chosen the damped path deliberately and there is nothing to wait for.
      const tags = Array.from(
        document.querySelectorAll<HTMLScriptElement>('script[src*="gsap" i], script[src*="ScrollTrigger" i]'),
      );
      if (tags.length === 0) return;

      let timer = 0;
      const attempt = () => {
        if (!attachGsap()) return;
        for (const off of gsapWaitOff) off();
        gsapWaitOff.length = 0;
      };
      for (const tag of tags) {
        tag.addEventListener('load', attempt);
        gsapWaitOff.push(() => tag.removeEventListener('load', attempt));
      }
      // Backstops: `load` has already fired if the script came from cache before
      // we attached the listener, and a script that 404s never fires it at all.
      window.addEventListener('load', attempt);
      gsapWaitOff.push(() => window.removeEventListener('load', attempt));
      timer = window.setTimeout(attempt, 2500);
      gsapWaitOff.push(() => window.clearTimeout(timer));
    }

    /** Safe no-op unless GSAP is driving. Called whenever the scroll span changes. */
    function refreshScrollTrigger(): void {
      if (!usingGsap) return;
      try {
        g.ScrollTrigger?.refresh?.();
      } catch {
        // A refresh that throws is not worth taking the frame loop down for.
      }
    }

    /* NOT called here. See the boot block: ScrollTrigger measures its trigger
       element on creation, and `.room-stage` is display:none until the component
       proves WebGL works — so creating the tween before that point would size
       the whole scroll animation against a 0px element. */

    /* =====================================================================
       FOCUS, TENSION, REVEAL
       ===================================================================== */

    let focusIndex = 0;
    let selectedIndex = 0;
    let holding = false;
    let hiddenArmed = reduced; // reduced motion opens on the finished state
    let hiddenSlide = reduced ? 1 : 0;
    let activeLine = 1;
    /** Last strings written to the HUD, so we do not touch the DOM for nothing. */
    let hudMonth = '';
    let hudCaption = '';
    let hudMeter = -1;
    let hudStateText = '';
    let hintHidden = false;
    /** Last written backdrop zoom, so the layer is not dirtied for nothing. */
    let backdropZoom = 1;

    function viewZ(camZ: number): number {
      return camZ - VIEW_AHEAD;
    }

    function pickFocus(camZ: number): number {
      /* Once the machine has given you one more, that IS what you are looking
         at — stated explicitly rather than left to the nearest-z search, which
         would keep choosing the last wall panel because it sits at exactly the
         viewing distance while the hidden one arrives 1.8 units nearer. */
      if (hiddenIndex >= 0 && hiddenSlide > 0.5) return hiddenIndex;
      const target = viewZ(camZ);
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < rigs.length; i += 1) {
        if (rigs[i].memory.hidden && !hiddenArmed) continue;
        const d = Math.abs(rigs[i].group.position.z - target);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }

    function announce(text: string): void {
      // Replacing the whole text node is what makes a polite live region fire;
      // appending to it is unreliable across screen readers.
      elLive!.textContent = text;
    }

    function setSelected(i: number, announceIt: boolean): void {
      if (i < 0 || i >= rigs.length) return;
      if (selectedIndex === i) return;
      // Leaving a panel drops its tension; nothing carries between memories.
      if (!rigs[selectedIndex].revealed) rigs[selectedIndex].tension = 0;
      selectedIndex = i;
      for (let n = 0; n < indexButtons.length; n += 1) {
        indexButtons[n].setAttribute('aria-current', n === i ? 'true' : 'false');
      }
      syncPlate();
      if (announceIt) announce(`${rigs[i].memory.month}. ${rigs[i].memory.caption}`);
      invalidate();
    }

    /** Writes the caption block for whatever is selected. */
    function syncPlate(): void {
      const rig = rigs[selectedIndex];
      if (hudMonth !== rig.memory.month) {
        hudMonth = rig.memory.month;
        elMonth!.textContent = rig.memory.month;
      }
      if (hudCaption !== rig.memory.caption) {
        hudCaption = rig.memory.caption;
        elCaption!.textContent = rig.memory.caption;
      }
      if (rig.revealed) {
        elNoteText!.textContent = rig.memory.note;
        elNote!.hidden = false;
        elReveal!.hidden = true;
      } else {
        elNote!.hidden = true;
        elNoteText!.textContent = '';
        elReveal!.hidden = false;
      }
    }

    function reveal(i: number): void {
      const rig = rigs[i];
      if (rig.revealed) return;
      rig.revealed = true;
      rig.tension = 1;
      if (selectedIndex === i) syncPlate();
      announce(`max tension. ${rig.memory.note}`);
      invalidate();
    }

    /* =====================================================================
       INPUT
       ===================================================================== */

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    /** Which panel is under a client-space point, or -1. */
    function panelAt(clientX: number, clientY: number): number {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return -1;
      /* Against the RECT, not against cssW/cssH.
         getBoundingClientRect already accounts for any CSS transform on an
         ancestor. Dividing by the canvas's attribute size instead is the bug
         that broke the hero's hit test when the pinned section scaled
         (commit c1ee0e5) — the pointer and the ray disagreed by the scale
         factor and picks silently missed. */
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(pickable, false);
      if (hits.length === 0) return -1;
      const i = pickable.indexOf(hits[0].object);
      /* Raycaster does NOT skip a mesh whose PARENT group is invisible — it only
         consults layers, and we hand it the photo quads directly. So the hidden
         panel, parked in the dark past the end of the rail, is pickable through
         geometry it is not yet supposed to have. Refuse it here rather than
         letting a stray tap select a memory that has not been earned. */
      if (i >= 0 && rigs[i].memory.hidden && !hiddenArmed) return -1;
      /* And refuse a panel that has dissolved. Raycaster does not consult
         opacity either, so without this a press could select the memory the
         carriage is in the middle of passing through — one you cannot see. */
      if (i >= 0 && rigs[i].fade < 0.15) return -1;
      return i;
    }

    let holdPointerId: number | null = null;
    let holdStartX = 0;
    let holdStartY = 0;
    const prevTouchAction = canvas.style.touchAction;

    function startHold(i: number): void {
      setSelected(i, false);
      holding = true;
      if (reduced) {
        /* No timed hold under reduced motion. A meter that has to be watched for
           1.15s is motion, and the content behind it must not require it. */
        reveal(i);
        holding = false;
        return;
      }
      start();
    }

    function endHold(): void {
      holding = false;
      if (holdPointerId !== null) {
        canvas.style.touchAction = prevTouchAction;
        holdPointerId = null;
      }
    }

    function onPointerDown(e: PointerEvent): void {
      // Primary button / single touch only. A right-click is not a rep.
      if (e.button !== 0) return;
      const hit = panelAt(e.clientX, e.clientY);
      /* Falling back to the FOCUSED panel when the ray misses is deliberate
         generosity: on a phone the panel is a small target and the intent of
         "press and hold in the room" is unambiguous. The raycast only refines
         which memory you meant. */
      const target = hit >= 0 ? hit : focusIndex;
      holdPointerId = e.pointerId;
      holdStartX = e.clientX;
      holdStartY = e.clientY;
      /* Claim the gesture for the hold. Without touch-action:none iOS can decide
         a press is the start of a pan before the first pointermove arrives, and
         preventDefault() is then too late — the page scrolls out from under the
         hold. Restored the moment the hold ends, because scrolling is how the
         carriage moves and we must not keep it. */
      canvas.style.touchAction = 'none';
      startHold(target);
    }

    function onPointerMove(e: PointerEvent): void {
      if (holdPointerId === null || e.pointerId !== holdPointerId) return;
      const moved = Math.hypot(e.clientX - holdStartX, e.clientY - holdStartY);
      /* 12px of travel means she was trying to scroll, not to hold. Give the
         gesture back to the page rather than swallowing a scroll — the
         alternative is a room that feels stuck whenever a swipe starts on a
         photo. */
      if (moved > 12) {
        endHold();
      }
    }

    function onPointerUp(e: PointerEvent): void {
      if (holdPointerId !== null && e.pointerId !== holdPointerId) return;
      endHold();
    }

    function onContextMenu(e: Event): void {
      // A long press on iOS otherwise raises the image callout menu, which lands
      // squarely on top of the interaction the long press exists for.
      if (holding) e.preventDefault();
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('contextmenu', onContextMenu);

    /* ---------------------------------------------------------------------
       LOSING THE GPU CONTEXT

       Same failure class as the leaked probe context, and just as normal: on a
       phone, backgrounding the tab is enough to lose the context, and so is a GPU
       reset or another tab exhausting the driver. Unhandled, the room comes back
       as a frozen or blank canvas with no indication that anything is wrong.

       three.js already calls preventDefault() on `webglcontextlost` and
       re-initialises on `webglcontextrestored`, and it re-uploads textures from
       their source images — which is why applyTexture keeps `rig.image` alive
       rather than dropping it after the upload. What three does NOT know is our
       bookkeeping: that the loop must stop, that the frame loop must not run
       against a dead context, and that if the context never returns the honest
       answer is the static grid rather than a black rectangle.

       preventDefault() is called here too. It is what tells the browser we intend
       to restore, and without it `webglcontextrestored` is never fired at all —
       it is idempotent alongside three's own handler.
       --------------------------------------------------------------------- */
    let restoreTimer = 0;

    const onContextLost = (e: Event) => {
      e.preventDefault();
      contextLost = true;
      stop();
      window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(() => {
        if (!contextLost) return;
        console.warn('[us] the WebGL context did not come back; falling back to the grid.');
        stage.setAttribute('data-webgl', 'no');
        const fb = document.querySelector<HTMLElement>('[data-room-fallback]');
        if (fb) fb.hidden = false;
      }, CONTEXT_RESTORE_GRACE_MS);
    };

    const onContextRestored = () => {
      window.clearTimeout(restoreTimer);
      contextLost = false;
      /* Every GPU-side resource was destroyed and rebuilt, including the drawing
         buffer's size, so re-measure before drawing into it. */
      stage.setAttribute('data-webgl', 'yes');
      const fb = document.querySelector<HTMLElement>('[data-room-fallback]');
      if (fb && !reduced) fb.hidden = true;
      layout();
      invalidate();
      sync();
    };

    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    /* ---- keyboard: the index list -------------------------------------- */

    function scrollToPanel(i: number): void {
      const rig = rigs[i];
      const travel = (-rig.parkZ - VIEW_AHEAD) / RAIL_LEN;
      const p = carriageEaseInverse(travel);
      if (spanPx <= 0) return;
      const stageTop = stage.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({
        top: Math.round(stageTop + spanPx * p),
        // 'smooth' is animation, and reduced motion means she asked for none.
        behavior: reduced ? 'auto' : 'smooth',
      });
    }

    const keyCleanups: Array<() => void> = [];
    indexButtons.forEach((button, i) => {
      const onClick = () => {
        setSelected(i, true);
        if (!reduced) scrollToPanel(i);
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        /* preventDefault on both: Space would scroll the page (which would fight
           the carriage) and would ALSO synthesise a click on keyup, double-
           handling the activation. Enter auto-repeats, hence the e.repeat guard —
           without it every repeat restarts the hold and the meter never fills. */
        e.preventDefault();
        if (e.repeat) return;
        if (!reduced) scrollToPanel(i);
        startHold(i);
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        e.preventDefault();
        endHold();
      };
      // Losing focus mid-hold (alt-tab, a screen reader moving on) must not
      // leave `holding` true forever with nothing able to clear it.
      const onBlur = () => endHold();
      const onFocus = () => setSelected(i, false);

      button.addEventListener('click', onClick);
      button.addEventListener('keydown', onKeyDown);
      button.addEventListener('keyup', onKeyUp);
      button.addEventListener('blur', onBlur);
      button.addEventListener('focus', onFocus);
      keyCleanups.push(() => {
        button.removeEventListener('click', onClick);
        button.removeEventListener('keydown', onKeyDown);
        button.removeEventListener('keyup', onKeyUp);
        button.removeEventListener('blur', onBlur);
        button.removeEventListener('focus', onFocus);
      });
    });

    /* The non-timed route. This button is the reason the hold is allowed to
       exist at all: hold-to-reveal as the ONLY path to content fails WCAG
       2.1.1 and 2.5.x, and "it is discoverable" is not a defence. */
    const onRevealClick = () => reveal(selectedIndex);
    elReveal.addEventListener('click', onRevealClick);

    /* =====================================================================
       FRAME
       ===================================================================== */

    let raf = 0;
    let running = false;
    let onceQueued = false;
    let visible = true;
    let last = 0;
    let clock = 0;
    /** True between `webglcontextlost` and `webglcontextrestored`. */
    let contextLost = false;

    /**
     * Ask for exactly one more frame.
     *
     * Under reduced motion there is no loop at all, so every state change —
     * a texture arriving, a reveal, a resize — has to schedule its own repaint.
     * In the animated case the loop is already running and this is a no-op.
     */
    function invalidate(): void {
      if (running || onceQueued || contextLost) return;
      onceQueued = true;
      requestAnimationFrame((t) => {
        onceQueued = false;
        if (!running) frame(t, 0);
      });
    }

    function frame(now: number, dt: number): void {
      /* Rendering into a lost context is not a crash — three guards it — but it
         is pointless work, and every read of renderer.capabilities during one is
         a chance to touch a null. */
      if (contextLost) return;
      clock += dt;

      /* ---- progress ---- */
      if (reduced) {
        progress = 1;
      } else if (usingGsap) {
        // GSAP has already applied the scrub lag; damping it again would stack
        // two filters and make the carriage feel underwater.
        progress = clamp01(scrub.p);
      } else {
        targetProgress = scrollProgress();
        progress = damp(progress, targetProgress, SCRUB_TAU, dt);
      }

      /* ---- the carriage ---- */
      const travel = carriageEase(progress);
      /* The micro-bend, alive. A machine under load is never perfectly still,
         and the cue is to hold the bend rather than to arrive. Amplitude grows
         with how loaded the carriage is, so it is a whisper at the start and a
         held breath at max extension — and it means the room never freezes into
         a screenshot even when the scroll has stopped. */
      const breath = reduced
        ? 0
        : Math.sin(clock * 1.05) * 0.055 * (0.3 + 0.7 * progress);
      const camZ = -travel * RAIL_LEN + breath;

      camera.position.set(0, CAM_Y + breath * 0.12, camZ);
      camera.lookAt(0, CAM_Y - 0.05, camZ - 12);

      // The carriage's geometry is authored in FRONT of its origin (local z 0 to
      // -6.4), so the group sits exactly at the camera and the platform runs away
      // from her. Offsetting it +0.1 here, as an earlier version did, pushed the
      // whole thing behind the near plane.
      carriage.position.z = camZ;

      for (let i = 0; i < wash.length; i += 1) {
        /* All AHEAD of the carriage, alternating side and height.
           An earlier version spread them symmetrically around camZ, which put
           one light BEHIND the camera lighting a wall nobody can see — a full
           per-fragment lighting term spent on nothing. The corridor needs to be
           lit where the panels are. */
        wash[i].position.set(
          i % 2 === 0 ? -2.4 : 2.4,
          i % 2 === 0 ? 1.9 : 4.0,
          camZ - 3.5 - i * 9,
        );
      }

      /* ---- "still one more" ---- */
      if (!hiddenArmed && progress > ARM_HIDDEN_AT) {
        hiddenArmed = true;
        elMore!.hidden = false;
        announce('still one more.');
      }
      /* It slides in while she is at max extension and RETREATS when she is not.
         Not a one-way latch: pickFocus() prefers the hidden panel whenever
         hiddenSlide > 0.5, so a latched slide would leave the caption plate stuck
         on "still one more" forever the moment she scrolled back up the rail.
         `hiddenArmed` stays true — the secret does not un-happen — but the panel
         itself goes back into the dark until she comes for it again. */
      if (hiddenArmed) {
        const wanted = progress > ARM_HIDDEN_AT ? dt / 1.4 : -dt / 0.9;
        hiddenSlide = clamp01(hiddenSlide + wanted);
      }
      if (hiddenRig) {
        /* It comes to YOU. A machine that gives you one more rep brings the
           carriage to the viewing position rather than asking for travel it has
           already told you, in geometry, that it will not give. */
        const eased = smoothstep(0, 1, hiddenSlide);
        const arrive = camZ - HIDDEN_VIEW_AHEAD;
        hiddenRig.group.position.z = hiddenRig.parkZ + (arrive - hiddenRig.parkZ) * eased;
        hiddenRig.mirrorGroup.position.z = hiddenRig.group.position.z;
        // Visibility is set for every rig, hidden included, in the panel-light
        // loop below — which also folds in the dissolve. Setting it twice would
        // just mean two places to keep in step.
      }

      /* ---- focus ---- */
      const nextFocus = pickFocus(camZ);
      if (nextFocus !== focusIndex) {
        focusIndex = nextFocus;
        // Scrolling past a memory selects it, so the caption plate and the
        // tension meter always describe what is in front of you. A hold that is
        // in flight is left alone — being carried past a panel mid-rep should
        // not silently retarget the meter.
        if (!holding) setSelected(focusIndex, false);
      }

      const line = rigs[focusIndex].memory.line;
      if (line !== activeLine) {
        activeLine = line;
        for (const el of lineEls) {
          el.setAttribute('data-active', el.dataset.line === String(line) ? 'true' : 'false');
        }
        /* The same fact on the machine itself: the numbered position line for the
           chapter you are in lights up, on BOTH edges of the carriage. The HUD's
           01-04 and these are one indicator shown twice, which is exactly what the
           real rail positions are for. */
        for (const mark of carriageMarks) {
          mark.mesh.material.opacity = mark.line === line ? 0.95 : 0.26;
          mark.mesh.material.color.setHex(mark.line === line ? LED_CORE_COLOR : 0xffffff);
        }
      }

      /* ---- time under tension ---- */
      const sel = rigs[selectedIndex];
      if (!sel.revealed) {
        sel.tension = tensionStep(sel.tension, dt, holding, TENSION_FILL_SEC);
        if (sel.tension >= 1) reveal(selectedIndex);
      }

      /* ---- panel light, and the pass/distance dissolve ---- */
      for (let i = 0; i < rigs.length; i += 1) {
        const rig = rigs[i];
        const isFocus = i === focusIndex;
        const isSel = i === selectedIndex;
        const t = isSel ? sel.tension : 0;

        /* THE DISSOLVE.
           Near: a panel the carriage is about to pass fills the frame however far
           to the side it is hung, so it is gone before that can happen. Far: it
           recedes into the room — which in image mode is the only thing doing that
           job, because fog is off there (see FOG_ENABLED).

           This is an occlusion rule about where the camera is, not a grade: the
           panel at the viewing position is at exactly 1.0, always. */
        const dist = camZ - rig.group.position.z;
        const fade =
          smoothstep(PASS_FADE_NEAR, PASS_FADE_FAR, dist) *
          (1 - smoothstep(FAR_FADE_START, FAR_FADE_END, dist));
        rig.fade = fade;
        rig.photo.material.opacity = fade;
        rig.backing.material.opacity = fade;
        rig.mirror.material.opacity = MIRROR_STRENGTH * fade;
        /* Skip the whole rig once it has dissolved. Saves five draws each and,
           more importantly, stops a fully-transparent quad from still costing a
           full-screen fill when it is one unit from the lens. */
        const alive = fade > 0.004;
        rig.group.visible = alive && (!rig.memory.hidden || hiddenArmed);
        rig.mirrorGroup.visible = rig.group.visible;

        /* Blue from WASH to GLOW as the meter fills, which is the palette rule
           doing the state work: --blue-light is ambient light, --blue-glow is
           the hot core of a source. */
        const base = isFocus ? 0.2 : 0.06;
        rig.rim.material.opacity = (base + t * 0.72) * fade;
        rig.halo.material.opacity = ((isFocus ? 0.1 : 0) + t * 0.5) * fade;
        rig.rim.material.color.setHex(t > 0.6 ? LED_CORE_COLOR : LED_COLOR);
        // The photograph's COLOUR is never touched — only the light around it.
      }

      /* ---- HUD ---- */
      const shown = Math.round((sel.revealed ? 1 : sel.tension) * 100);
      if (shown !== hudMeter) {
        hudMeter = shown;
        /* A UNITLESS 0..1 custom property, consumed by us-studio.css as
           `transform: scaleX(var(--fill))`. Writing `width: N%` instead would
           be a layout invalidation on every frame of the meter; a transform is
           composited and costs nothing. */
        elFill!.style.setProperty('--fill', (shown / 100).toFixed(4));
        elMeter!.setAttribute('aria-valuenow', String(shown));
        elMeter!.setAttribute('data-max', shown >= 100 ? 'true' : 'false');
        const label =
          shown >= 100 ? 'max tension' : shown > 0 ? `${shown}%` : 'hold to reveal';
        if (label !== hudStateText) {
          hudStateText = label;
          elState!.textContent = label;
        }
      }
      // Guarded, because writing the same boolean 60 times a second still
      // touches the attribute and invalidates style on every frame.
      if (!reduced) {
        const hideHint = progress > 0.02;
        if (hideHint !== hintHidden) {
          hintHidden = hideHint;
          elHint!.hidden = hideHint;
        }
      }

      /* ---- the backdrop dolly ----
         What stops a photographic room reading as a matte painting: as the
         carriage advances down the rail, the room advances with it. A transform,
         so it is compositor-only and costs nothing per frame. Guarded, because
         writing the same transform every frame still dirties the layer. */
      if (backdrop && imageBackdrop && BACKDROP_DOLLY > 0) {
        const zoom = 1 + BACKDROP_DOLLY * travel / (MAX_EXTENSION - MICRO_BEND);
        if (Math.abs(zoom - backdropZoom) > 0.0004) {
          backdropZoom = zoom;
          backdrop.style.setProperty('--backdrop-zoom', zoom.toFixed(4));
        }
      }

      /* ---- textures ---- */
      updateResidency(camZ);

      renderer.render(scene, camera);
    }

    const tick = (now: number) => {
      raf = 0;
      const first = last === 0;
      const rawMs = first ? 1000 / 60 : now - last;
      // Clamped for the SIMULATION so a backgrounded tab does not teleport the
      // carriage on return, but the UNCLAMPED value is what the health check
      // reads — clamping first would hide exactly the frames we are looking for.
      const dt = Math.min(0.05, rawMs / 1000);
      last = now;

      /* Net counting, not a streak: a single 30ms hitch from a texture upload
         must not trigger a resolution drop, but two seconds of 25fps must. */
      if (!first && rawMs > SLOW_FRAME_MS) slowFrames += 1;
      else if (slowFrames > 0) slowFrames -= 1;
      if (slowFrames > SLOW_FRAME_BUDGET && baseDpr * dprScale > 1) {
        dprScale *= 0.75;
        slowFrames = 0;
        // three's setPixelRatio re-applies the last setSize internally, so this
        // is all that is needed to resize the backing store.
        applyPixelRatio();
        console.info(
          `[us] the room is not holding frame rate; dropping the pixel ratio to ` +
            `${(Math.max(1, baseDpr * dprScale)).toFixed(2)}. Soft beats stuttering.`,
        );
      }

      frame(now, dt);
      if (running) raf = requestAnimationFrame(tick);
    };

    function start(): void {
      // Under reduced motion there is no loop, ever. The finished state is a
      // still frame and interactions repaint it on demand.
      if (reduced || running || contextLost) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(tick);
    }

    function stop(): void {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    function sync(): void {
      if (reduced) return;
      if (visible && !document.hidden) start();
      else stop();
    }

    /* =====================================================================
       BOOT
       ===================================================================== */

    /* ORDER MATTERS HERE.
       `.room-stage` ships as data-webgl="pending" and us-studio.css keeps it
       display:none until it is "yes" — which is what stops a no-JS or no-WebGL
       visitor from getting a full-screen black rectangle above the static grid.
       But a display:none element measures 0x0, so this attribute has to be set
       BEFORE layout() or the first frame renders into a 1x1 canvas and the
       ResizeObserver has to clean it up a frame later. */
    stage.setAttribute('data-webgl', 'yes');
    stage.setAttribute('data-reduced', reduced ? 'true' : 'false');

    layout();

    /* Only NOW is it safe to create the ScrollTrigger: the stage is visible and
       its height has been written, so the trigger measures the real scroll span
       instead of a display:none 0px box. If GSAP has not finished loading yet,
       waitForGsap() upgrades the damped scrub in place when it arrives. */
    if (!reduced && !attachGsap()) waitForGsap();

    // Announce the room before the first frame, so a screen reader gets a
    // description rather than "graphic".
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      `A dark studio under blue light. ${memories.length} photographs of us ride a carriage ` +
        'on a rail into the dark, doubled in the mirrored floor. Use the memory list below to ' +
        'move between them; hold Enter on one to build time under tension and reveal its note.',
    );

    // Hand over from the static grid ONLY now that the renderer, the scene and
    // the HUD all exist. Anything that threw above leaves the grid in place,
    // which is the whole point of doing it here rather than on mount.
    const fallback = document.querySelector<HTMLElement>('[data-room-fallback]');
    if (fallback && !reduced) fallback.hidden = true;

    setSelected(0, false);
    syncPlate();
    for (let n = 0; n < indexButtons.length; n += 1) {
      indexButtons[n].setAttribute('aria-current', n === 0 ? 'true' : 'false');
    }
    if (reduced) {
      // The finished state: carriage at max extension, one more already given.
      progress = 1;
      hiddenArmed = true;
      hiddenSlide = 1;
      elMore.hidden = false;
      elHint.hidden = true;
      elMeter.setAttribute('data-reduced', 'true');
    }

    frame(performance.now(), 0);

    const ro = new ResizeObserver(() => {
      layout();
      invalidate();
    });
    ro.observe(sticky);

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
        sync();
      },
      { threshold: 0 },
    );
    io.observe(sticky);

    const onVis = () => sync();
    document.addEventListener('visibilitychange', onVis);

    /* Only needed for the no-GSAP path: with GSAP, ScrollTrigger drives `scrub`
       off its own listener and this would be a second, redundant one. It is
       registered even when GSAP is merely LATE, and attachGsap() removes it at
       the moment it takes over. */
    if (!usingGsap && !reduced) {
      window.addEventListener('scroll', onScroll, { passive: true });
    }

    sync();

    /* =====================================================================
       TEARDOWN

       Everything allocated above is released here. A three.js island that skips
       this leaks a whole GPU context per navigation, and this room holds up to
       nine multi-megabyte textures at a time.
       ===================================================================== */
    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      window.clearTimeout(restoreTimer);
      canvas.style.touchAction = prevTouchAction;
      elReveal.removeEventListener('click', onRevealClick);
      for (const off of keyCleanups) off();
      for (const off of gsapWaitOff) off();
      if (gsapTween) gsapTween.kill();

      for (const rig of rigs) clearTexture(rig);
      for (const t of disposableTextures) t.dispose();
      for (const m of disposableMaterials) m.dispose();
      for (const geo of disposableGeometries) geo.dispose();
      // Releases the WebGL context itself. Browsers cap live contexts (~16 in
      // Chrome) and silently kill the oldest, so skipping this eventually
      // blanks a room that used to work.
      renderer.dispose();
      renderer.forceContextLoss();
    };
    // memories/lines are server-rendered props for one page load; re-running
    // this effect would rebuild the entire scene for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="room-stage" ref={stageRef} data-webgl="pending">
      <div className="room-sticky" ref={stickyRef}>
        {/*
          THE PHOTOGRAPHIC BACKDROP (BACKDROP === 'image').

          A DOM layer, not a textured quad, and that is a deliberate choice with
          three concrete payoffs: `background-size: cover` makes correct framing
          at every aspect ratio the browser's problem rather than ours, the dolly
          is a compositor-only transform, and it costs no GPU texture memory on a
          phone that is already holding up to five photographs.

          Rendered unconditionally so the markup is stable; the component removes
          it in procedural mode. It is decorative — the room, not content — so it
          is aria-hidden and the canvas keeps the description.
        */}
        <div className="room-backdrop" ref={backdropRef} aria-hidden="true">
          {/*
            OUR sign, laid exactly over the photograph's own. A child of the
            backdrop so it inherits the dolly zoom for free; its pixel position is
            re-derived from the live `cover` geometry on resize.
            aria-hidden because the canvas's aria-label already describes the room
            and a screen reader does not need "[us]" three times on one page.
          */}
          <div className="room-wordmark" ref={wordmarkRef} aria-hidden="true">
            <span className="room-wordmark-plate" />
            <span className="room-wordmark-text">{WORDMARK_TEXT}</span>
          </div>
        </div>
        {/*
          Edge scrims. Between the backdrop and the canvas on purpose — see
          BACKDROP_LEFT_SIGNAGE_X. Above the canvas they would dim a photograph.
        */}
        <div className="room-scrim" ref={scrimRef} aria-hidden="true" />
        <canvas className="room-canvas" ref={canvasRef} />

        <div className="room-hud" ref={hudRef}>
          <div className="room-top">
            <span className="room-mark">
              <span className="room-mark-bracket" aria-hidden="true">[</span>us
              <span className="room-mark-bracket" aria-hidden="true">]</span>
            </span>
            <span className="room-where">the studio</span>
            <a className="room-exit" href="/stronger/vault">exit</a>
          </div>

          {/* Carriage lines 1-4. A real list, because it is one. */}
          <ol className="room-lines" aria-label="carriage lines">
            {lines.map((l) => (
              <li key={l.line} className="room-line" data-line={l.line} data-active={l.line === 1 ? 'true' : 'false'}>
                <span className="room-line-n">{`0${l.line}`}</span>
                <span className="room-line-label">{l.label}</span>
                <span className="room-line-blurb">{l.blurb}</span>
              </li>
            ))}
          </ol>

          <div className="room-plate">
            <p className="room-month" data-us="month" />
            <p className="room-caption" data-us="caption" />

            {/*
              A real progressbar, not a styled div. aria-valuenow is written
              every time the rounded percentage changes, so a screen reader can
              follow the rep instead of being told nothing until the end.
            */}
            <div
              className="room-tension"
              data-us="meter"
              role="progressbar"
              aria-label="time under tension"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={0}
              data-max="false"
            >
              <span className="room-tension-label">time under tension</span>
              <span className="room-tension-track">
                <span className="room-tension-fill" data-us="fill" />
              </span>
              <span className="room-tension-state" data-us="state">hold to reveal</span>
            </div>

            <button className="room-reveal" type="button" data-us="reveal">
              reveal the note
            </button>

            <div className="room-note" data-us="note" hidden>
              <p className="room-note-text" data-us="note-text" />
            </div>
          </div>

          {/*
            The keyboard route, and the monthly-focus calendar in one control.
            Every memory is a real <button> in DOM order, so Tab walks the year.
          */}
          <ol className="room-index" aria-label="memories, by month">
            {memories.map((m, i) => (
              <li key={m.id} className="room-index-item">
                <button
                  type="button"
                  className="room-index-btn"
                  data-memory={m.id}
                  data-hidden={m.hidden ? 'true' : 'false'}
                  aria-current={i === 0 ? 'true' : 'false'}
                >
                  <span className="room-index-n">{m.hidden ? '+1' : String(i + 1).padStart(2, '0')}</span>
                  <span className="room-index-month">{m.month}</span>
                </button>
              </li>
            ))}
          </ol>

          <p className="room-hint" data-us="hint">scroll — the carriage follows</p>
          <p className="room-more" data-us="more" hidden>still one more.</p>

          {/* Off-screen but not display:none, which would stop it announcing. */}
          <p className="room-live" data-us="live" aria-live="polite" aria-atomic="true" />
        </div>
      </div>
    </div>
  );
}
