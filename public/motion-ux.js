/* ============================================================
   Samuel Woo — micro-interaction layer  (motion-ux.js)

   Everything that reacts to a cursor or a finger: spring hover/press
   physics, magnetism, the cursor companion, the perceived page
   transition, the travelling focus halo and form feedback. Built on
   Motion (motion.dev) 13.1.1, vendored as public/motion.min.js — its
   `dist/motion.js` is a UMD bundle, so it loads from a plain <script>
   and hangs the whole vanilla API off `window.Motion`. No bundler, no
   npm dep.

   ---- Ownership, and why the CSS has to be told to let go ----
   Almost every element here already had a CSS `:hover` transform
   (`.project-card` -5px, `.pass` -5px, `.bubble` -2px, ...). An inline
   transform beats those rules, so if we animate `transform` while the
   CSS rule is still live we get two owners and a stuck lift the moment
   a tween is interrupted mid-hover.

   So we follow the pattern gsap-motion.js already established with
   `html.gsap-on`: this file adds `html.motion-on`, and styles.css uses
   that flag to hand `transform` over to us for the elements we claim
   (tagged `.motion-spring`) while KEEPING colour / border / shadow on
   the CSS side. One owner per property. If this script never runs —
   404, old browser, reduced motion — the flag is absent, the original
   CSS hover states are untouched, and the site behaves exactly as it
   did before. Nothing here is load-bearing for layout or content.

   ---- THE AXIS PARTITION (read this before touching section 1) ----
   Magnetism and the hover/press spring used to fight. Both wrote `y`:
   the gesture spring wrote the lift, and the per-frame magnet handler
   wrote `lift + magnetY`. Whichever ran last won the next frame, so a
   press mid-hover, or a magnet frame landing between two gesture
   tweens, snapped the element. gsap-motion.js hit the identical bug on
   the brand wordmark and papered over it by KILLING magnetism for as
   long as the pointer was on the mark (`if (overMark) return`), which
   is why the mark goes dead exactly when you are touching it.

   The real fix is not to take turns, it is to never share a property:

       magnetism owns   x, rotate, rotateX, rotateY, transformPerspective
       the gesture      y, scale
       spring owns

   Two `Motion.animate()` calls on one element compose instead of
   clobbering — Motion keeps a per-element value store and rebuilds the
   transform string from it, so animating `x` leaves an in-flight `y`
   spring running (measured: y continued to its -40px target while a
   fresh x spring ran over the top of it, final transform
   `translateX(14px) translateY(-40px)`). Because the two channels can
   never disagree, magnetism STAYS LIVE through hover and through
   press. Vertical attraction is expressed as tilt (rotateX / rotate),
   not as translation, precisely so it stays out of the spring's lane.

   If you add a channel, add it to exactly one of those two lists.

   ---- Reduced motion ----
   We bail out at the top, BEFORE adding the flag, building the cursor
   or touching a single element. Under `prefers-reduced-motion: reduce`
   this file is a no-op: no transforms, no cursor, no page transition,
   no focus halo, and the plain CSS hovers (which that media query
   already de-animates) are what the reader gets. Every node this file
   creates is created lazily, so a bail-out cannot leave anything
   stranded — there is nothing to strand. We also listen for a runtime
   change and fully unwind: inline transforms cleared, cursor and halo
   removed, flag dropped.

   THE UNWIND MUST DISARM, NOT JUST TIDY UP. This was a real bug, and
   the shape of it is worth keeping in mind because it is the kind that
   passes every "is anything stranded?" check.

   Dropping `html.motion-on` and `.motion-spring` is what hands
   `transform` back to the stylesheet — but those two classes are also
   the ONLY hooks the reduced-motion belts in styles.css are keyed on
   (`html.motion-on .motion-spring { transform: none !important }`). So
   an unwind that removed the flags while leaving the gesture handlers
   attached made things WORSE than doing nothing: the next hover wrote a
   fresh inline spring, and the belt that would have neutralised it had
   just been unhooked.

   Measured, on a mid-session flip with the pointer then moved onto
   `.btn-resume`: computed transform `matrix(1, 0, 0, 1, 0, -3)`, a live
   spring, after the reader had asked for reduced motion. It read as
   `none` on `.pass` / `.project-card` / `.bubble` only because those
   elements happen to ALSO be matched by unrelated belts
   (`.reveal { transform: none !important }`, `.skills-list > *`), which
   is luck, not design — the four button-shaped claims
   (`.btn-resume`, `.nav-cta`, `.nav-toggle`, the submit button) match
   none of them and were uncovered.

   So `unwind()` now sets `live = false` FIRST. Every write in this file
   goes through `animate()` below, which is inert once that flag drops,
   and every gesture binding is collected in `bindings` and torn down.
   Nothing here can start moving again afterwards, whether or not any
   stylesheet is there to catch it.

   ---- Three deliberate restrictions on Motion's own gestures ----
   1. `Motion.press()` sets `tabIndex = 0` on any target that is not
      natively focusable, to give the gesture keyboard support. That is
      the right default for a framework and the WRONG thing here: our
      chips are plain `<li>` text and our project cards on projects.html
      are `<article>`s. Measured on this build: `press()` on
      `article.project-card` and on `li.bubble` both leave
      `tabindex="0"` behind, i.e. a dozen dead stops in the tab order.
      So `press()` is used ONLY on natively-focusable elements, where it
      also buys real keyboard (Enter / Space) press support. Everything
      else goes through `pressPointer()` below, which is pointer-only
      and never touches an attribute.
   2. Hover and press never run through separate tweens. Both feed one
      per-element state object that resolves to a single `animate()`
      call on the y/scale channel, so those two gestures can never
      write `transform` at once.
   3. Nothing here calls `preventDefault` on a pointer event and every
      pointer listener is `passive`, so no gesture can ever eat a
      scroll. A press that turns into a drag past PRESS_SLOP is
      cancelled rather than held, which is what makes the press states
      survive a flick-scroll on a phone.
   ============================================================ */
(function () {
    "use strict";

    var M = window.Motion;
    var reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    // Hard stop before the DOM is touched: a bail-out must leave the page
    // exactly as the stylesheet painted it.
    if (!M || typeof M.animate !== "function" || typeof M.hover !== "function") return;
    if (reduceQuery.matches) return;

    var root = document.documentElement;
    var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

    /* Every element we ever wrote an inline transform to, so the
       reduced-motion unwind below can guarantee it clears all of them. */
    var claimed = [];
    /* Every node this file appended to the document, for the same reason. */
    var injected = [];
    /* Teardown functions from Motion's own gesture helpers (`hover()` and
       `press()` each return one), so the unwind can genuinely unbind rather
       than leave live listeners behind a flag. */
    var bindings = [];

    /* ---------- The one gate every write goes through ----------
       `live` is true for the whole normal life of the document and false
       for good once the reader turns reduced motion on. Nothing in this
       file may call `M.animate` directly: routing every call through here
       is what makes the unwind a single assignment instead of a promise to
       remember nine call sites. See the reduced-motion note in the header
       for why "tidy up but stay armed" was not good enough.

       In-flight animations are tracked so the unwind can stop them too — a
       spring created one frame before the flip would otherwise keep writing
       all the way to its target. */
    var live = true;
    var inflight = [];

    function animate(target, props, transition) {
        if (!live) return null;
        var controls = M.animate(target, props, transition);
        if (controls) {
            inflight.push(controls);
            // Keep the list short; a finished animation cannot write anything.
            if (controls.finished && typeof controls.finished.then === "function") {
                var drop = function () {
                    var i = inflight.indexOf(controls);
                    if (i > -1) inflight.splice(i, 1);
                };
                controls.finished.then(drop, drop);
            }
        }
        return controls;
    }

    function stopInflight() {
        inflight.forEach(function (c) {
            try {
                if (typeof c.stop === "function") c.stop();
                else if (typeof c.cancel === "function") c.cancel();
            } catch (err) { /* already finished: nothing to stop */ }
        });
        inflight.length = 0;
    }

    /* ---------- Spring vocabulary ----------
       Calm and editorial: nothing overshoots more than a hair, except
       `release`, where the overshoot IS the point — it is what makes
       letting go of a button feel like letting go of a button. Small
       elements get a stiffer, faster spring than large ones so a chip
       doesn't feel as heavy as a boarding pass. */
    var SPRING = {
        card:    { type: "spring", stiffness: 260, damping: 26, mass: 1 },
        chip:    { type: "spring", stiffness: 460, damping: 24, mass: 0.7 },
        button:  { type: "spring", stiffness: 400, damping: 26, mass: 0.8 },
        /* Press DOWN is the one place a spring must not wobble: the
           finger is still there, so any bounce reads as slop. Stiff and
           heavily damped — it arrives in ~90ms and stops dead. */
        press:   { type: "spring", stiffness: 900, damping: 38, mass: 0.5 },
        /* Press RELEASE is the opposite: damping ratio ~0.45, so it
           overshoots its resting point by a couple of percent and
           settles. This is the "click" you feel rather than hear. */
        release: { type: "spring", stiffness: 520, damping: 18, mass: 0.7 },
        /* The magnet chase re-targets every frame the pointer moves, so
           it wants to cover ground fast and never ring. */
        magnet:  { type: "spring", stiffness: 340, damping: 30, mass: 0.6 },
        /* Letting go of the pointer: a slower, softer return to centre
           than the chase, so leaving an element reads as release rather
           than as a snap. */
        home:    { type: "spring", stiffness: 200, damping: 22, mass: 0.9 },
        nav:     { type: "spring", stiffness: 380, damping: 30, mass: 0.8 },
        halo:    { type: "spring", stiffness: 440, damping: 34, mass: 0.7 },
        cursor:  { type: "spring", stiffness: 520, damping: 30, mass: 0.6 }
    };

    /* Only these can take a `Motion.press()` — see restriction (1). */
    var FOCUSABLE = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1 };
    function isNativelyFocusable(el) {
        return FOCUSABLE[el.tagName] === 1;
    }

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /* Strip every property Motion may have written, so the element lands
       back in the exact state the stylesheet expects — including its own
       `:hover` transform once `.motion-spring` comes off. */
    function clearTransform(el) {
        var s = el.style;
        s.removeProperty("transform");
        s.removeProperty("translate");
        s.removeProperty("scale");
        s.removeProperty("rotate");
        s.removeProperty("perspective");
        s.removeProperty("will-change");
    }

    /* ============================================================
       0. Shared press manager

       One set of window listeners for every pointer press on the page,
       instead of three per claimed element (~40 elements = ~120
       listeners). Elements register a pointerdown; the manager owns the
       release, the cancel, and the slop test that distinguishes a press
       from the beginning of a scroll.

       All listeners are passive and none preventDefault: a press must
       never cost the reader a scroll. PRESS_SLOP is generous because a
       finger always moves a few px before a flick registers.
       ============================================================ */
    var PRESS_SLOP = 12;

    var activePress = null;             // { el, end, id, x, y }

    function endActivePress(kind) {
        if (!activePress) return;
        var p = activePress;
        activePress = null;
        p.end(kind);
    }

    window.addEventListener("pointerup", function (e) {
        if (activePress && (activePress.id === e.pointerId || e.pointerId === undefined)) {
            endActivePress("up");
        }
    }, { passive: true });
    window.addEventListener("pointercancel", function () { endActivePress("cancel"); }, { passive: true });
    window.addEventListener("blur", function () { endActivePress("cancel"); });
    window.addEventListener("pointermove", function (e) {
        if (!activePress) return;
        if (Math.abs(e.clientX - activePress.x) > PRESS_SLOP ||
            Math.abs(e.clientY - activePress.y) > PRESS_SLOP) {
            endActivePress("cancel");        // reader is scrolling, not pressing
        }
    }, { passive: true });
    window.addEventListener("scroll", function () { endActivePress("cancel"); }, { passive: true });

    /* Pointer-only press for elements that are NOT natively focusable.
       Deliberately does not touch tabIndex, aria or any attribute — the
       element gains a tactile state and nothing else, so a decorative
       chip does not become a keyboard stop that goes nowhere. */
    function pressPointer(el, onStart) {
        el.addEventListener("pointerdown", function (e) {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            endActivePress("cancel");                 // only one at a time
            var end = onStart();
            if (typeof end !== "function") return;
            activePress = { el: el, end: end, id: e.pointerId, x: e.clientX, y: e.clientY };
        }, { passive: true });
    }

    /* ============================================================
       1. Spring hover / press / magnetism — the axis partition

       Two channels, disjoint property sets, one owner each:

         lift channel   y, scale          driven by gesture STATE
         magnet channel x, rotate,        driven by pointer POSITION
                        rotateX, rotateY

       `state` is the single source of truth for the lift channel; both
       gestures mutate it and call applyLift(), so there is never more
       than one live tween on y/scale. The magnet channel is a separate
       animate() call and is allowed to run at the same time, because it
       cannot touch y or scale.
       ============================================================ */
    function springify(el, opts) {
        if (el.__motionSpring) return;      // never claim an element twice
        el.__motionSpring = true;
        el.classList.add("motion-spring");
        claimed.push(el);

        var state = { hover: false, press: false, released: false };
        var mag = { x: 0, rx: 0, ry: 0, rz: 0, live: false };
        var settleTimer = null;

        /* ---- Don't fight the entrance animation ----
           Most of these elements are ALSO `.reveal` / `.gsap-reveal`
           nodes, so anime.js (translateY) or GSAP (its y/scale
           from-state) may already own `transform` when the pointer
           arrives. Measured: hovering a `.bubble` while GSAP's chip
           stagger was still running left it pinned at the from-state
           `translate(0,12px) scale(.92)`, because both were writing the
           same property and GSAP's tween won the next frame.

           So a claimed element is only "ours" once its entrance has
           finished: `.gsap-busy` is off (gsap-motion.js's own in-flight
           flag) and, if it is a reveal, `.is-visible` is on. */
        function ready() {
            if (el.classList.contains("gsap-busy")) return false;
            if ((el.classList.contains("reveal") || el.classList.contains("gsap-reveal")) &&
                !el.classList.contains("is-visible")) return false;
            return true;
        }

        /* If the entrance is still running we can't write `transform` yet, but
           dropping the gesture outright would strand a real hover (pointer
           resting on a chip while its stagger finishes → nothing ever
           happens). So we retry on a short timer and let the *current*
           state win whenever readiness arrives. */
        var waitFrame = null;
        function retry() {
            if (waitFrame) return;
            var tries = 0;
            waitFrame = setInterval(function () {
                if (++tries > 24 || ready()) {     // ~2s ceiling
                    clearInterval(waitFrame);
                    waitFrame = null;
                    if (ready()) applyLift();
                }
            }, 80);
        }

        /* ---- lift channel: y + scale, nothing else, ever ---- */
        function applyLift() {
            if (!ready()) { retry(); return; }
            var y = 0, scale = 1;
            if (state.hover) { y = opts.lift; scale = opts.hoverScale || 1; }
            if (state.press) { y = opts.pressLift; scale = opts.pressScale || 0.99; }
            el.style.willChange = "transform";
            animate(el, { y: y, scale: scale },
                state.press ? SPRING.press
                            : (state.released ? SPRING.release : opts.spring));
        }

        /* ---- magnet channel: x + tilt, nothing else, ever ----
           Re-targeted from the pointermove handler while the pointer is
           inside the element. Motion re-creates the x/tilt springs each
           time, which is what makes this a chase rather than a single
           tween — and because the pointermove handler stops firing the
           moment the cursor stops, the last spring always runs to
           completion on the true target. */
        function applyMagnet(transition) {
            var t = { x: mag.x };
            if (opts.lean) t.rotate = mag.rz;
            if (opts.tilt) {
                t.rotateX = mag.rx;
                t.rotateY = mag.ry;
                t.transformPerspective = opts.perspective || 900;
            }
            el.style.willChange = "transform";
            animate(el, t, transition || SPRING.magnet);
        }

        /* Releasing the magnet has to cancel any pointermove frame that is
           still queued. Measured without this: mousemove schedules a frame,
           the pointer leaves, homeMagnet() animates x back to 0, and THEN
           the queued frame runs with the stale event and re-applies the
           lean — leaving the card parked at its hover tilt with the cursor
           nowhere near it. `magFrame` is cancelled here and the callback
           re-checks `state.hover` as a second line of defence. */
        var magFrame = null;
        function homeMagnet() {
            if (magFrame) { window.cancelAnimationFrame(magFrame); magFrame = null; }
            if (!mag.live) return;
            mag.live = false;
            mag.x = mag.rx = mag.ry = mag.rz = 0;
            if (ready()) applyMagnet(SPRING.home);
        }

        /* Returning to rest is the only moment we are allowed to drop the
           inline transform. We wait for both channels to have finished and
           re-check that the pointer really is still away — otherwise a
           quick out-and-back would clear a transform the new hover tween
           is already writing. */
        function settle() {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(function () {
                settleTimer = null;
                // `ready()` again: if an entrance tween is mid-flight it owns
                // `transform`, and stripping it here would fight that tween
                // instead of tidying up after ours. `__mxProxLean` is the
                // proximity field in section 2 — if it is still holding this
                // element off-centre, its x/rotate are live and not ours to
                // wipe.
                if (!state.hover && !state.press && !mag.live &&
                    !el.__mxProxLean && ready()) clearTransform(el);
            }, 760);
        }

        // Motion's gesture helpers each return their own teardown; keep it so
        // the reduced-motion unwind can unbind rather than merely flag.
        bindings.push(M.hover(el, function () {
            if (!live) return;
            state.hover = true;
            state.released = false;
            if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
            applyLift();
            if (opts.enter) opts.enter(el, true);
            return function () {                 // hover end
                state.hover = false;
                state.released = false;
                applyLift();
                homeMagnet();
                if (opts.enter) opts.enter(el, false);
                settle();
            };
        }));

        if (opts.pressable) {
            var onPress = function () {
                if (!live) return;
                state.press = true;
                state.released = false;
                if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
                applyLift();
                return function () {             // press end (up / cancel / blur)
                    state.press = false;
                    state.released = true;       // → release spring, with overshoot
                    applyLift();
                    if (!state.hover) settle();
                };
            };
            if (isNativelyFocusable(el) && typeof M.press === "function") {
                bindings.push(M.press(el, onPress));   // keyboard press too
            } else {
                pressPointer(el, onPress);       // pointer only, no tabIndex
            }
        }

        /* Magnetic pull + tilt. Pointer-only and rAF-throttled, matching
           the existing spotlight handler's budget. The threshold test is
           what lets the final spring land exactly on target: an unmoved
           cursor issues no new animate() call. */
        if ((opts.magnet || opts.tilt || opts.lean) && finePointer) {
            el.addEventListener("mousemove", function (e) {
                if (magFrame) return;
                magFrame = window.requestAnimationFrame(function () {
                    magFrame = null;
                    // The pointer may have left between the event and this
                    // frame; applying a stale lean then would strand it.
                    if (!state.hover || !ready()) return;
                    var r = el.getBoundingClientRect();
                    if (!r.width || !r.height) return;
                    // -1..1 from centre, clamped.
                    var nx = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2), -1, 1);
                    var ny = clamp((e.clientY - (r.top + r.height / 2)) / (r.height / 2), -1, 1);
                    var nextX = (opts.magnet || 0) * nx;
                    var nextRz = (opts.lean || 0) * nx;
                    // Tilt AWAY from the cursor on the vertical axis (the
                    // near edge comes toward you) — that is the direction a
                    // real card leans when you push a finger into it.
                    var nextRx = (opts.tilt || 0) * -ny;
                    var nextRy = (opts.tilt || 0) * nx;
                    if (mag.live &&
                        Math.abs(nextX - mag.x) < 0.25 &&
                        Math.abs(nextRx - mag.rx) < 0.05 &&
                        Math.abs(nextRy - mag.ry) < 0.05 &&
                        Math.abs(nextRz - mag.rz) < 0.05) return;
                    mag.x = nextX; mag.rx = nextRx; mag.ry = nextRy; mag.rz = nextRz;
                    mag.live = true;
                    applyMagnet();
                });
            }, { passive: true });
            el.addEventListener("mouseleave", homeMagnet, { passive: true });
        }
    }

    function claimAll(selector, opts) {
        Array.prototype.forEach.call(document.querySelectorAll(selector), function (el) {
            springify(el, opts);
        });
    }

    /* ---- Cards: the big surfaces. The lift matches the CSS values they
            replace (-5 / -4) so the visual language is unchanged; the
            physics of getting there, the magnetic lean and the press are
            new. Tilt is kept tiny on the text-heavy cards — a card full
            of body copy at ±4° reads as blurry, not as depth. ---- */
    claimAll(".project-card", {
        spring: SPRING.card, lift: -6, hoverScale: 1.006,
        pressLift: -2, pressScale: 0.988, pressable: true,
        magnet: 5, tilt: 1.6, perspective: 1100
    });
    claimAll(".contact-link", {
        spring: SPRING.card, lift: -4, pressLift: -1, pressScale: 0.99, pressable: true,
        magnet: 5, tilt: 1.4, perspective: 900
    });
    /* Boarding passes are the one place a real tilt belongs: they are
       mostly display type on a solid plate, they read as physical
       objects, and the wall is the page's most tactile surface. */
    claimAll(".pass", {
        spring: SPRING.card, lift: -7, hoverScale: 1.008,
        pressLift: -3, pressScale: 0.985, pressable: true,
        magnet: 4, tilt: 4.5, perspective: 800,
        enter: planeTaxi
    });
    /* Plain `.card`s that are neither a project nor a contact link had no
       CSS lift of their own; giving them one would flatten the hierarchy,
       so they are intentionally not claimed. */
    claimAll(".favorite-item", {
        spring: SPRING.chip, lift: -3, hoverScale: 1.01,
        pressLift: -1, pressScale: 0.985, pressable: true,
        magnet: 3, lean: 0.5
    });

    /* ---- Chips: small, so a stiffer spring, a touch of scale, and a
            lean toward the cursor instead of a tilt. ---- */
    claimAll(".bubble", {
        spring: SPRING.chip, lift: -3, hoverScale: 1.035,
        pressLift: -1, pressScale: 0.94, pressable: true,
        magnet: 3, lean: 1.2
    });
    claimAll(".skills-list li", {
        spring: SPRING.chip, lift: -3, hoverScale: 1.035,
        pressLift: -1, pressScale: 0.94, pressable: true,
        magnet: 3, lean: 1.2
    });

    /* ---- Buttons + primary CTAs. NO `magnet` here on purpose: their
            x/rotate belong to the proximity field in section 2, which
            already covers the inside of the element as well as its
            approach. Two owners for one property is the bug this whole
            file is organised around. ---- */
    claimAll(".btn-resume", {
        spring: SPRING.button, lift: -3, pressLift: 0, pressScale: 0.94, pressable: true
    });
    claimAll(".nav-cta", {
        spring: SPRING.button, lift: -1, pressLift: 0, pressScale: 0.94, pressable: true
    });
    claimAll(".contact-form button[type='submit']", {
        spring: SPRING.button, lift: -3, pressLift: 0, pressScale: 0.94, pressable: true
    });
    claimAll(".nav-toggle", {
        spring: SPRING.button, lift: 0, pressLift: 0, pressScale: 0.88, pressable: true
    });

    /* The little plane on a boarding pass taxis forward on hover. Its own
       element, its own property (x), nobody else's — the CSS only ever
       set its opacity. */
    function planeTaxi(pass, on) {
        var plane = pass.querySelector(".pass-plane");
        if (!plane) return;
        animate(plane, { x: on ? 7 : 0 },
            on ? { type: "spring", stiffness: 420, damping: 15, mass: 0.5 } : SPRING.home);
    }

    /* ============================================================
       2. Proximity magnets — CTAs that lean before you arrive

       Hover magnetism only starts once the pointer is already inside the
       element, which for a small pill button is too late: by then you
       have committed. A CTA that leans toward an approaching cursor is
       what makes it read as magnetic rather than merely springy.

       This is the SOLE owner of x/rotate for the elements it claims
       (they are deliberately declared without `magnet`/`lean` above), so
       one formula covers both the approach and the inside of the
       element — no handover, nothing to race. It never touches y or
       scale, so it composes with the lift spring and with press.

       One rAF-throttled document listener for the whole set.
       ============================================================ */
    (function proximityMagnets() {
        if (!finePointer) return;
        var targets = Array.prototype.slice.call(
            document.querySelectorAll(".btn-resume, .nav-cta, .contact-form button[type='submit']"));
        if (!targets.length) return;

        var RADIUS = 160;               // px of reach beyond the element's edge
        var frame = null, lastX = -9999, lastY = -9999;

        function lean(el, x, rz) {
            if (Math.abs(x - (el.__mxProxX || 0)) < 0.2) return;
            el.__mxProxX = x;
            el.__mxProxLean = Math.abs(x) > 0.2;   // tells settle() to keep its hands off
            /* `will-change` is a hint with a real cost, and section 1 hands it
               back in settle(); this block never did, so a single mouse move
               anywhere within 160px of a CTA promoted it to its own compositor
               layer for the rest of the document's life. Registered in
               `claimed` for the same reason — the unwind has to know this
               element was written to, and `lean()` is reachable on elements
               springify() never claimed (the submit button is claimed, but the
               selector sets here and there are maintained separately and have
               drifted apart before). */
            if (claimed.indexOf(el) === -1) claimed.push(el);
            if (el.__mxProxLean) {
                el.style.willChange = "transform";
            } else {
                // Back at rest: drop the hint once the return spring has run.
                var controls = animate(el, { x: x, rotate: rz }, SPRING.home);
                var release = function () {
                    if (!el.__mxProxLean) el.style.removeProperty("will-change");
                };
                if (controls && controls.finished && controls.finished.then) {
                    controls.finished.then(release, release);
                } else {
                    release();
                }
                return;
            }
            animate(el, { x: x, rotate: rz }, SPRING.magnet);
        }

        function update() {
            frame = null;
            for (var i = 0; i < targets.length; i++) {
                var el = targets[i];
                var r = el.getBoundingClientRect();
                if (!r.width || r.bottom < -200 || r.top > window.innerHeight + 200) continue;
                var cx = r.left + r.width / 2;
                // Distance to the element's BOX, not its centre, so a wide
                // button pulls along its whole length.
                var dx = Math.max(r.left - lastX, 0, lastX - r.right);
                var dy = Math.max(r.top - lastY, 0, lastY - r.bottom);
                var dist = Math.sqrt(dx * dx + dy * dy);
                var pull = dist >= RADIUS ? 0 : (1 - dist / RADIUS);
                pull *= pull;                       // ease in — barely anything far out
                // Direction from the element's centre, normalised on its own
                // half-width so the lean saturates just outside the element.
                var nx = clamp((lastX - cx) / (r.width / 2), -1, 1);
                lean(el, nx * 7 * pull, nx * 1.3 * pull);
            }
        }

        document.addEventListener("mousemove", function (e) {
            lastX = e.clientX; lastY = e.clientY;
            if (frame) return;
            frame = window.requestAnimationFrame(update);
        }, { passive: true });

        /* Pointer gone from the window: no more mousemove will ever arrive,
           so release everything rather than leaving a button leaning. */
        function release() {
            lastX = lastY = -9999;
            targets.forEach(function (el) { lean(el, 0, 0); });
        }
        root.addEventListener("pointerleave", release, { passive: true });
        window.addEventListener("blur", release);
        window.addEventListener("scroll", function () {
            if (frame) return;
            frame = window.requestAnimationFrame(update);
        }, { passive: true });
    })();

    /* ============================================================
       3. Cursor companion

       A sage dot that tracks the pointer almost 1:1 and a ring that
       trails it on a spring, reading what it is over and reshaping:
       small and quiet over the page, open over a link, wide over a card,
       a caret over a text field, compressed while pressing, light on the
       dark band. Links also get a one-word label pulled from the DOM
       (`.card-cta`'s own text, "Email", "Open ↗"), so the companion
       never claims an affordance the markup doesn't have — chips and
       boarding passes get the shape change but no label, because they
       are not links.

       The native cursor is deliberately LEFT VISIBLE. Hiding it is the
       usual move here and it is a real accessibility regression: system
       cursor size and high-contrast cursor settings stop applying, and
       any frame where this layer stalls leaves the reader with no
       pointer at all. This is a companion, not a replacement.

       Ownership inside the layer is split the same way as everything
       else: the outer follower element is the only thing this file
       translates (from a rAF integrator, since a spring re-targeted
       every frame is a chase, not a spring), and Motion animates
       scale/opacity on the inner nodes. One property, one owner.

       Fine pointers only — `(hover: hover) and (pointer: fine)` — so a
       touch device never pays for it, and it is `pointer-events: none`
       throughout, so it can never eat a tap or a scroll.
       ============================================================ */
    (function cursorCompanion() {
        if (!finePointer) return;

        var ringHost = document.createElement("div");
        ringHost.className = "mx-follow mx-follow--ring";
        ringHost.setAttribute("aria-hidden", "true");
        var ring = document.createElement("span");
        ring.className = "mx-ring";
        var label = document.createElement("span");
        label.className = "mx-label";
        ringHost.appendChild(ring);
        ringHost.appendChild(label);

        var dotHost = document.createElement("div");
        dotHost.className = "mx-follow mx-follow--dot";
        dotHost.setAttribute("aria-hidden", "true");
        var dot = document.createElement("span");
        dot.className = "mx-dot";
        dotHost.appendChild(dot);

        document.body.appendChild(ringHost);
        document.body.appendChild(dotHost);
        injected.push(ringHost, dotHost);

        /* ---- state table, most specific first ---- */
        function cardCtaLabel(el) {
            var cta = el.querySelector(".card-cta");
            if (!cta) return "";
            // Strip the trailing arrow span; keep it to two words.
            var txt = (cta.textContent || "").replace(/[→↗\s]+$/, "").trim();
            return txt.length > 18 ? txt.split(/\s+/).slice(-2).join(" ") : txt;
        }
        var RULES = [
            { sel: "input, textarea, select", state: "field" },
            { sel: "a.project-card", state: "card", label: cardCtaLabel },
            { sel: "a.contact-link", state: "card", label: function (el) {
                return (el.getAttribute("href") || "").indexOf("mailto:") === 0 ? "Email" : "Profile ↗";
            } },
            { sel: ".pass", state: "card" },
            { sel: "article.project-card", state: "card" },
            { sel: ".btn-resume", state: "link", label: "PDF ↗" },
            { sel: ".nav-cta", state: "link", label: "Say hi" },
            { sel: "button", state: "link", label: function (el) {
                return el.classList.contains("nav-toggle") ? "" : "Send";
            } },
            { sel: "a.bubble", state: "chip", label: "Quote ↗" },
            { sel: ".bubble, .skills-list li, .favorite-item", state: "chip" },
            { sel: ".nav-link, .brand, .explore-cue", state: "link" },
            { sel: "a[href]", state: "link", label: function (el) {
                return el.getAttribute("target") === "_blank" ? "Open ↗" : "";
            } }
        ];

        // Ring scale per state. The dot shrinks as the ring opens — the
        // classic inversion, and it keeps the pair from reading as one
        // thick blob when they overlap.
        var SHAPE = {
            idle:  { ring: 0.34, dot: 1,    op: 0.7 },
            link:  { ring: 1,    dot: 0.45, op: 1 },
            card:  { ring: 1.55, dot: 0.35, op: 1 },
            chip:  { ring: 0.78, dot: 0.5,  op: 1 },
            field: { ring: 1,    dot: 0,    op: 1 }
        };

        var visible = false, pressed = false, stateName = "idle";
        var tx = -100, ty = -100;                       // pointer target
        var rx = -100, ry = -100, dx = -100, dy = -100; // follower positions
        var running = false;

        function shape() {
            var s = SHAPE[stateName] || SHAPE.idle;
            var k = pressed ? 0.8 : 1;
            animate(ring, { scale: s.ring * k, opacity: visible ? s.op : 0 }, SPRING.cursor);
            animate(dot, { scale: s.dot * (pressed ? 0.7 : 1), opacity: visible ? 1 : 0 }, SPRING.cursor);
            ring.classList.toggle("is-field", stateName === "field");
        }

        /* Press state is read from the window, not from the press manager:
           `Motion.press()` handles the focusable elements and the manager
           handles the rest, but the companion should compress for ANY
           press — including one on a surface neither of them claims. */
        function setPressed(on) {
            if (pressed === on) return;
            pressed = on;
            shape();
        }
        window.addEventListener("pointerdown", function (e) {
            if (e.pointerType === "touch") return;
            setPressed(true);
        }, { passive: true });
        window.addEventListener("pointerup", function () { setPressed(false); }, { passive: true });
        window.addEventListener("pointercancel", function () { setPressed(false); }, { passive: true });
        window.addEventListener("blur", function () { setPressed(false); });

        function setLabel(text) {
            if (label.textContent === text) return;
            label.textContent = text || "";
            label.classList.toggle("is-on", !!text);
            animate(label, { opacity: text ? 1 : 0 }, { duration: 0.16 });
        }

        function resolve(target) {
            if (!target || target.nodeType !== 1) return { state: "idle", label: "" };
            for (var i = 0; i < RULES.length; i++) {
                var hit = target.closest(RULES[i].sel);
                if (!hit) continue;
                var lb = RULES[i].label;
                return {
                    state: RULES[i].state,
                    label: typeof lb === "function" ? lb(hit) : (lb || "")
                };
            }
            return { state: "idle", label: "" };
        }

        /* `pointerover` fires once per element crossing, which is a tenth
           of the work of testing the DOM on every move. */
        document.addEventListener("pointerover", function (e) {
            if (e.pointerType === "touch") return;
            var r = resolve(e.target);
            /* "Dark" is a statement about the surface directly under the
               cursor, not about the band. On the inverted band the résumé
               CTA is deliberately the BRIGHTEST object on the page
               (`.band--dark .btn-resume` fills with --sage), so the light
               companion would vanish into it — that one surface wants the
               light-ground treatment back. */
            var inDark = !!(e.target.closest && e.target.closest(".band--dark"));
            var onBrightCta = inDark && !!e.target.closest(".btn-resume, .contact-form button");
            var dark = inDark && !onBrightCta;
            ring.classList.toggle("is-dark", dark);
            dot.classList.toggle("is-dark", dark);
            label.classList.toggle("is-dark", dark);
            if (r.state !== stateName) { stateName = r.state; shape(); }
            setLabel(r.label);
        }, { passive: true });

        function tick() {
            // The follow hosts are written directly rather than through
            // `animate()` (a spring re-targeted every frame is a chase, not a
            // spring), so this is the one write in the file the `live` gate
            // does not cover on its own. Unwind removes these nodes, so the
            // writes would be harmless — but the rAF loop would keep running
            // for the rest of the session, which is not.
            if (!live) { running = false; return; }
            // Critically-damped follow: the dot is nearly locked to the
            // pointer, the ring lags a frame or two, and that lag is the
            // whole reason the pair reads as alive.
            dx += (tx - dx) * 0.55;
            dy += (ty - dy) * 0.55;
            rx += (tx - rx) * 0.19;
            ry += (ty - ry) * 0.19;
            dotHost.style.transform = "translate3d(" + dx + "px," + dy + "px,0)";
            ringHost.style.transform = "translate3d(" + rx + "px," + ry + "px,0)";
            var settled = Math.abs(tx - rx) < 0.15 && Math.abs(ty - ry) < 0.15;
            if (settled) { running = false; return; }
            window.requestAnimationFrame(tick);
        }
        function kick() {
            if (running) return;
            running = true;
            window.requestAnimationFrame(tick);
        }

        document.addEventListener("pointermove", function (e) {
            if (e.pointerType === "touch") return;
            tx = e.clientX; ty = e.clientY;
            if (!visible) {
                // First real pointer movement: jump into place rather than
                // flying in from 0,0, then fade up.
                rx = dx = tx; ry = dy = ty;
                visible = true;
                shape();
            }
            kick();
        }, { passive: true });

        function hide() {
            if (!visible) return;
            visible = false;
            shape();
        }
        root.addEventListener("pointerleave", hide, { passive: true });
        window.addEventListener("blur", hide);
        // A cursor companion over a native scrollbar drag or a context menu
        // is noise; so is one left frozen on a page the reader has left.
        document.addEventListener("visibilitychange", function () {
            if (document.hidden) hide();
        });
    })();

    /* ============================================================
       4. Sliding active-nav indicator (desktop)

       Replaces the per-link `.nav-link::after` scaleX underline with one
       shared hairline that travels between links, so changing section
       reads as a single continuous movement instead of one bar fading
       out while another fades in.

       The scroll-spy in script.js is NOT touched. We observe the
       `class` attribute it already toggles, which keeps this purely
       additive: spy logic, hash sync and `aria-current` are all still
       exactly where they were.
       ============================================================ */
    (function navIndicator() {
        var navLinks = document.getElementById("nav-links");
        if (!navLinks) return;
        var links = Array.prototype.slice.call(navLinks.querySelectorAll(".nav-link"));
        if (!links.length) return;

        // aria-hidden + pointer-events:none in CSS: decoration only, and it
        // must never intercept a click meant for the link beneath it.
        var ind = document.createElement("span");
        ind.className = "nav-indicator";
        ind.setAttribute("aria-hidden", "true");
        navLinks.appendChild(ind);
        injected.push(ind);

        var shown = false;

        function place(instant) {
            // The indicator is a desktop affordance; on mobile the open
            // panel gives the active link a filled background instead.
            if (!window.matchMedia("(min-width: 761px)").matches) {
                ind.style.opacity = "0";
                shown = false;
                return;
            }
            var active = null;
            for (var i = 0; i < links.length; i++) {
                if (links[i].classList.contains("is-active")) { active = links[i]; break; }
            }
            if (!active) {                       // hero / no section claimed
                animate(ind, { opacity: 0 }, { duration: 0.18 });
                shown = false;
                return;
            }
            var r = active.getBoundingClientRect();
            var host = navLinks.getBoundingClientRect();
            // Inset 12px each side to line up with the old ::after, which
            // was drawn inside the link's horizontal padding.
            var left = r.left - host.left + 12;
            var width = Math.max(0, r.width - 24);

            if (!shown || instant) {
                // First appearance: no slide in from a meaningless origin.
                ind.style.left = left + "px";
                ind.style.width = width + "px";
                animate(ind, { opacity: 1 }, { duration: instant ? 0 : 0.2 });
                shown = true;
                return;
            }
            animate(ind, { left: left + "px", width: width + "px", opacity: 1 }, SPRING.nav);
        }

        var scheduled = false;
        function schedule(instant) {
            if (scheduled) return;
            scheduled = true;
            window.requestAnimationFrame(function () {
                scheduled = false;
                place(instant);
            });
        }

        new MutationObserver(function () { schedule(false); })
            .observe(navLinks, { subtree: true, attributes: true, attributeFilter: ["class"] });

        window.addEventListener("resize", function () { schedule(true); }, { passive: true });
        // Webfonts swap after first paint and change link widths.
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function () { schedule(true); });
        }
        schedule(true);
    })();

    /* ============================================================
       5. Mobile menu panel — staggered entrance

       The panel itself is still animated by CSS (`.nav-links.is-open`),
       including the scrim; we only stagger the rows inside it. Watching
       the class means script.js's open/close, the `body.nav-open`
       scroll lock and the Escape handling are all untouched.

       Inline opacity here is the one place this file could strand
       content, so props are cleared on complete AND unconditionally on
       close — a row can never be left at opacity 0 in a panel that is
       about to be shown again.
       ============================================================ */
    (function mobilePanel() {
        var navLinks = document.getElementById("nav-links");
        if (!navLinks) return;
        var rows = Array.prototype.slice.call(
            navLinks.querySelectorAll(".nav-link, .nav-cta"));
        if (!rows.length) return;

        function clearRows() {
            rows.forEach(function (r) {
                r.style.removeProperty("opacity");
                r.style.removeProperty("transform");
                r.style.removeProperty("translate");
                r.style.removeProperty("will-change");
            });
        }

        var wasOpen = false;
        new MutationObserver(function () {
            var open = navLinks.classList.contains("is-open");
            if (open === wasOpen) return;
            wasOpen = open;

            if (!open) { clearRows(); return; }
            if (!window.matchMedia("(max-width: 760px)").matches) return;

            /* Same conditional-`.finished` reasoning as section 7, and it
               matters more here: this is the one animation in the file that
               writes `opacity: 0`, so the row cleanup is what keeps the panel
               from opening onto invisible links. If `animate()` is inert
               (post-unwind) the rows were never hidden, and clearing straight
               away is exactly right. */
            var rowsIn = animate(rows,
                { opacity: [0, 1], y: [-10, 0] },
                {
                    delay: M.stagger ? M.stagger(0.035) : 0,
                    duration: 0.34,
                    type: "spring", stiffness: 420, damping: 30
                }
            );
            if (rowsIn && rowsIn.finished) rowsIn.finished.then(clearRows, clearRows);
            else clearRows();
        }).observe(navLinks, { attributes: true, attributeFilter: ["class"] });
    })();

    /* ============================================================
       6. Travelling focus halo

       A single sage bloom that springs from the previously focused
       element to the next one, so tabbing reads as one continuous
       movement — the keyboard equivalent of the nav indicator.

       Deliberately ADDITIVE: the native `:focus-visible` outline in
       styles.css is left exactly where it is. Replacing it with a
       JS-drawn ring would mean a keyboard user's focus indicator
       depends on this file not throwing, which is not a trade worth
       making. The halo is a transparent-centred ring drawn outside the
       outline, so it cannot reduce the contrast of the focused content.

       Gated on `:focus-visible` matching, so it appears for keyboard
       and assistive focus and NOT for a mouse click on a card.
       ============================================================ */
    (function focusHalo() {
        var halo = document.createElement("div");
        halo.className = "mx-focus-halo";
        halo.setAttribute("aria-hidden", "true");
        document.body.appendChild(halo);
        injected.push(halo);

        var current = null, shown = false;

        function isKeyboardFocus(el) {
            try { return el.matches(":focus-visible"); }
            catch (err) { return false; }        // very old engines: stay quiet
        }

        function place(el, instant) {
            var r = el.getBoundingClientRect();
            if (!r.width && !r.height) return;
            /* 10px, not 6: the native `:focus-visible` outline sits 3px out
               and is 2px thick, so a 6px halo left a 1px gap and the two
               read as one muddy double ring. At 10px the halo is clearly a
               bloom AROUND the outline. */
            var pad = 10;
            var radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 8;
            // Spring only when travelling from one focused element to
            // another. The first appearance, and every scroll re-pin, is
            // instant — a halo flying in from a stale position reads as a
            // glitch, and a spring chasing the scroll offset reads as lag.
            animate(halo, {
                x: r.left - pad,
                y: r.top - pad,
                width: r.width + pad * 2,
                height: r.height + pad * 2,
                borderRadius: (radius + pad) + "px",
                opacity: 1
            }, (shown && !instant) ? SPRING.halo : { duration: 0 });
            shown = true;
        }

        function hide() {
            current = null;
            if (!shown) return;
            shown = false;
            animate(halo, { opacity: 0 }, { duration: 0.16 });
        }

        document.addEventListener("focusin", function (e) {
            var el = e.target;
            if (!el || el.nodeType !== 1 || el === document.body) { hide(); return; }
            if (!isKeyboardFocus(el)) { hide(); return; }
            current = el;
            place(el, false);
        });
        document.addEventListener("focusout", function () {
            // A focusout with no incoming focusin means focus left the page.
            window.setTimeout(function () {
                if (!document.activeElement ||
                    document.activeElement === document.body ||
                    !isKeyboardFocus(document.activeElement)) hide();
            }, 0);
        });

        // A fixed halo would drift off its element as the page scrolls, so
        // it is re-pinned instantly (duration 0) rather than re-sprung.
        var frame = null;
        function repin() {
            frame = null;
            if (current && shown) place(current, true);
        }
        function onMove() {
            if (!current || frame) return;
            frame = window.requestAnimationFrame(repin);
        }
        window.addEventListener("scroll", onMove, { passive: true });
        window.addEventListener("resize", onMove, { passive: true });
    })();

    /* ============================================================
       7. Form feedback

       The form's own semantics are untouched: no preventDefault, no
       submit hijack, no aria rewriting. We listen for the browser's own
       `invalid` event (which fires on a submit attempt, before the
       native bubble) and give the offending field a damped shake plus a
       red-ish ring, and we clear both the moment the value becomes
       valid. `x` on an input is nobody else's property.
       ============================================================ */
    (function formFeedback() {
        var fields = Array.prototype.slice.call(
            document.querySelectorAll(".contact-form input, .contact-form textarea"));
        if (!fields.length) return;

        fields.forEach(function (el) {
            var wrap = el.closest(".field") || el;

            el.addEventListener("invalid", function () {
                wrap.classList.add("mx-invalid");
                // Registered so the reduced-motion unwind can wipe a shake
                // that is still mid-flight when the setting flips.
                if (claimed.indexOf(el) === -1) claimed.push(el);
                // Amplitude decays 8 → 0 so it reads as a shake settling,
                // not as a vibration.
                /* `animate()` returns null once the unwind has run, so the
                   `.finished` chain has to be conditional — a form submitted
                   after a mid-session preference flip would otherwise throw a
                   TypeError inside a native `invalid` handler. Running the
                   cleanup directly reaches the same end state. */
                var shake = animate(el, { x: [0, -8, 6, -4, 2, 0] },
                    { duration: 0.42, ease: [0.2, 0.7, 0.2, 1] });
                var wipe = function () { el.style.removeProperty("transform"); };
                if (shake && shake.finished) shake.finished.then(wipe, wipe);
                else wipe();
            });

            var clear = function () {
                if (!wrap.classList.contains("mx-invalid")) return;
                if (el.checkValidity && !el.checkValidity()) return;
                wrap.classList.remove("mx-invalid");
            };
            el.addEventListener("input", clear);
            el.addEventListener("blur", clear);
        });
    })();

    /* ============================================================
       8. Perceived page transition

       The three pages are separate documents, so a nav click is a full
       load: white flash, scroll jump, everything re-entering at once.
       This gives the click somewhere to land — the page dissolves to the
       site's own canvas colour with a sage hairline sweeping the top,
       then navigates; the next document fades that same veil back out,
       so the two loads read as one movement.

       Failsafes, because a navigation that does not happen is a broken
       site and a veil that does not leave is a blank page:
         - The veil's fade is a CSS `animation ... forwards`, not a JS
           tween. If this file dies mid-transition the keyframes still
           finish, so the veil cannot be stranded opaque by a JS error.
         - It is `pointer-events: none` in every state, so even a
           stranded veil cannot swallow a click.
         - Navigation is fired by whichever comes first: the animation
           ending, or a hard timeout.
         - `pageshow` unwinds the exit state, so a back-button restore
           out of the bfcache never shows the previous page's veil.
       ============================================================ */
    (function pageTransition() {
        var EXIT_MS = 240;              // must match .mx-veil.is-out in motion.css
        var FLAG = "mx-nav";
        var veil = null;

        function store(op, val) {
            try {
                if (op === "set") window.sessionStorage.setItem(FLAG, val);
                else if (op === "get") return window.sessionStorage.getItem(FLAG);
                else window.sessionStorage.removeItem(FLAG);
            } catch (err) { /* private mode / file:// — transition just degrades */ }
            return null;
        }

        function makeVeil(cls) {
            var v = document.createElement("div");
            v.className = "mx-veil " + cls;
            v.setAttribute("aria-hidden", "true");
            var bar = document.createElement("span");
            bar.className = "mx-veil-bar";
            v.appendChild(bar);
            document.body.appendChild(v);
            injected.push(v);
            return v;
        }

        function dropVeil() {
            if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
            veil = null;
        }

        /* ---- Arrival: fade the veil we handed over from the last page ---- */
        if (store("get") === "1") {
            store("clear");
            veil = makeVeil("is-in");
            // The bar child animates too and its animationend bubbles, so
            // only the veil's own animation counts as "finished".
            veil.addEventListener("animationend", function (e) {
                if (e.target === veil) dropVeil();
            });
            window.setTimeout(dropVeil, 1200);      // belt and braces
        }

        /* ---- Departure ---- */
        function isInternalNav(a) {
            if (!a || a.getAttribute("download") !== null) return false;
            var target = a.getAttribute("target");
            if (target && target !== "_self") return false;
            if (a.hasAttribute("data-mx-noexit")) return false;
            var href = a.getAttribute("href") || "";
            if (!href || href.charAt(0) === "#") return false;       // script.js owns these
            var url;
            try { url = new URL(a.href, window.location.href); }
            catch (err) { return false; }
            if (url.protocol !== "http:" && url.protocol !== "https:") return false;
            if (url.origin !== window.location.origin) return false;
            // Same document, different hash → an in-page jump, not a nav.
            if (url.pathname === window.location.pathname &&
                url.search === window.location.search) return false;
            return url.href;
        }

        document.addEventListener("click", function (e) {
            if (e.defaultPrevented) return;         // script.js already handled it
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            var a = e.target.closest ? e.target.closest("a[href]") : null;
            if (!a) return;
            var href = isInternalNav(a);
            if (!href) return;

            e.preventDefault();
            store("set", "1");
            root.classList.add("mx-exiting");
            veil = makeVeil("is-out");

            var went = false;
            var exiting = veil;
            var go = function () {
                if (went) return;
                went = true;
                window.location.href = href;
            };
            exiting.addEventListener("animationend", function (e) {
                if (e.target === exiting) go();     // not the sweeping bar
            });
            window.setTimeout(go, EXIT_MS + 140);   // never wait on an animation
            if (document.visibilityState === "hidden") go();

            /* If the navigation never actually happens — offline, blocked,
               a failed request — `pagehide` never fires and the reader is
               left looking at a washed-out page with no way back. Unwind
               after a generous wait. Cancelled the moment the document
               starts to leave, so a merely SLOW load keeps its veil (which
               is the loading state we want). */
            var abandon = window.setTimeout(function () {
                root.classList.remove("mx-exiting");
                dropVeil();
                store("clear");
            }, 6000);
            window.addEventListener("pagehide", function () { window.clearTimeout(abandon); });
        });

        /* A bfcache restore replays the DOM as it was when we left — veil
           and all. Unwind unconditionally on every show. */
        window.addEventListener("pageshow", function (e) {
            if (!e.persisted) return;
            root.classList.remove("mx-exiting");
            dropVeil();
            store("clear");
        });
    })();

    /* ============================================================
       9. Runtime reduced-motion unwind
       If the reader turns the OS setting on mid-visit: DISARM first, then
       tidy. The order matters and is the whole point — see the
       reduced-motion note in the file header for the bug that taught it.

       Disarming is three things, and none of them is optional:
         1. `live = false`, so every `animate()` in this file is inert from
            this instant. Nothing new can start.
         2. `stopInflight()`, so a spring created on the frame before the
            flip cannot keep writing its way to a target. Without this the
            element lands wherever that tween was headed — which, if the
            pointer happened to be resting on it, is the hover lift.
         3. `bindings`, Motion's own `hover()` / `press()` teardowns, so the
            listeners are gone rather than merely gated.

       Only then do we drop `motion-on` / `.motion-spring`, because those
       two classes are what the reduced-motion belts in styles.css are keyed
       on: removing them while anything here was still armed left the page
       with a live spring and nothing able to override it.

       `clearTransform` runs twice — now, and once more after the longest
       spring in SPRING could possibly have settled — because step 2 depends
       on Motion exposing a stop API on its playback controls, and this file
       should not be one API rename away from stranding a lift.
       ============================================================ */
    function unwind() {
        live = false;                       // 1. nothing new may start
        stopInflight();                     // 2. nothing in flight may finish
        bindings.forEach(function (off) {   // 3. nothing may fire again
            if (typeof off === "function") {
                try { off(); } catch (err) { /* helper already torn down */ }
            }
        });
        bindings.length = 0;

        root.classList.remove("motion-on");
        root.classList.remove("motion-cursor");
        root.classList.remove("mx-exiting");

        var tidy = function () {
            claimed.forEach(function (el) {
                clearTransform(el);
                el.classList.remove("motion-spring");
                delete el.__mxProxX;
                delete el.__mxProxLean;
            });
        };
        tidy();
        window.setTimeout(tidy, 1200);      // longer than any SPRING here

        injected.forEach(function (el) {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        });
        injected.length = 0;
    }
    if (typeof reduceQuery.addEventListener === "function") {
        reduceQuery.addEventListener("change", function (e) { if (e.matches) unwind(); });
    }

    // Claiming succeeded — only now is it safe for the CSS to stand down.
    root.classList.add("motion-on");
    if (finePointer) root.classList.add("motion-cursor");
})();
