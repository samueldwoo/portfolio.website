/* ============================================================
   Samuel Woo — micro-interaction layer  (motion-ux.js)

   Spring-physics hover / press states, magnetic primary CTAs, and
   the sliding nav indicator. Built on Motion (motion.dev) 13.1.1,
   vendored as public/motion.min.js — its `dist/motion.js` is a UMD
   bundle, so it loads from a plain <script> and hangs the whole
   vanilla API off `window.Motion`. No bundler, no npm dep.

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

   ---- Reduced motion ----
   We bail out at the top, BEFORE adding the flag or touching a single
   element. Under `prefers-reduced-motion: reduce` this file is a no-op
   and the plain CSS hovers (which that media query already de-animates)
   are what the reader gets. We also listen for a runtime change and
   fully unwind — clearing every inline transform we ever wrote — so a
   reader flipping the OS setting mid-visit can't be left with a
   half-applied lift.

   ---- Two deliberate restrictions on Motion's own gestures ----
   1. `Motion.press()` sets `tabIndex = 0` on any target that is not
      natively focusable, to give the gesture keyboard support. That is
      the right default for a framework and the WRONG thing here: our
      chips are plain `<li>` text and our project cards on projects.html
      are `<article>`s. Making them focusable would inject a dozen dead
      stops into the tab order. `press()` is therefore gated on
      `isNativelyFocusable()` — links, buttons and form controls only,
      which is also the only place a press state means anything.
   2. Hover/press never run through separate tweens. Both feed one
      per-element state object which resolves to a single `animate()`
      call, so the two gestures can never write `transform` at once.
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

    /* ---------- Spring vocabulary ----------
       Calm and editorial: nothing overshoots more than a hair. Small
       elements get a stiffer, faster spring than large ones so a chip
       doesn't feel as heavy as a boarding pass. */
    var SPRING = {
        card:   { type: "spring", stiffness: 260, damping: 26, mass: 1 },
        chip:   { type: "spring", stiffness: 460, damping: 24, mass: 0.7 },
        button: { type: "spring", stiffness: 400, damping: 26, mass: 0.8 },
        press:  { type: "spring", stiffness: 700, damping: 32, mass: 0.6 },
        magnet: { type: "spring", stiffness: 170, damping: 18, mass: 0.9 },
        nav:    { type: "spring", stiffness: 380, damping: 30, mass: 0.8 }
    };

    /* Only these can take a press gesture — see restriction (1) above. */
    var FOCUSABLE = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1 };
    function isNativelyFocusable(el) {
        return FOCUSABLE[el.tagName] === 1;
    }

    /* Strip every property Motion may have written, so the element lands
       back in the exact state the stylesheet expects — including its own
       `:hover` transform once `.motion-spring` comes off. */
    function clearTransform(el) {
        var s = el.style;
        s.removeProperty("transform");
        s.removeProperty("translate");
        s.removeProperty("scale");
        s.removeProperty("rotate");
        s.removeProperty("will-change");
    }

    /* ============================================================
       1. Spring hover / press
       `state` is the single source of truth for the element's
       transform. Both gestures mutate it and call apply(), so there is
       never more than one live tween per element.
       ============================================================ */
    function springify(el, opts) {
        if (el.__motionSpring) return;      // never claim an element twice
        el.__motionSpring = true;
        el.classList.add("motion-spring");
        claimed.push(el);

        var spring = opts.spring;
        var state = { hover: false, press: false, mx: 0, my: 0 };
        var settleFrame = null;

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
           flag) and, if it is a reveal, `.is-visible` is on. Before that
           we ignore the gesture entirely rather than queue it — a hover
           that happened during the entrance is not worth replaying, and
           attempting it is what caused the stuck state. */
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
                    if (ready()) apply();
                }
            }, 80);
        }

        function apply(instant) {
            if (!ready()) { retry(); return; }
            var lift = 0, scale = 1, x = 0;
            if (state.hover) { lift = opts.lift; scale = opts.hoverScale || 1; }
            if (state.press) { lift = opts.pressLift; scale = opts.pressScale; }
            if (state.hover && opts.magnet) { x = state.mx; lift += state.my; }

            el.style.willChange = "transform";
            M.animate(el, { x: x, y: lift, scale: scale },
                instant ? SPRING.press : (state.press ? SPRING.press : spring));
        }

        /* Returning to rest is the only moment we are allowed to drop the
           inline transform. We wait for the spring to actually finish and
           re-check that the pointer really is still away — otherwise a
           quick out-and-back would clear a transform that the new hover
           tween is already writing. */
        function settle() {
            if (settleFrame) clearTimeout(settleFrame);
            settleFrame = setTimeout(function () {
                settleFrame = null;
                // `ready()` again: if an entrance tween is mid-flight it owns
                // `transform`, and stripping it here would fight that tween
                // instead of tidying up after ours.
                if (!state.hover && !state.press && ready()) clearTransform(el);
            }, 620);
        }

        M.hover(el, function () {
            state.hover = true;
            if (settleFrame) { clearTimeout(settleFrame); settleFrame = null; }
            apply();
            return function () {                 // hover end
                state.hover = false;
                state.mx = state.my = 0;
                apply();
                settle();
            };
        });

        if (opts.pressable && isNativelyFocusable(el) && typeof M.press === "function") {
            M.press(el, function () {
                state.press = true;
                apply();
                return function () {             // press end (up / cancel / blur)
                    state.press = false;
                    apply();
                    if (!state.hover) settle();
                };
            });
        }

        /* Magnetic pull: the element leans a few px toward the cursor.
           Pointer-only and rAF-throttled, matching the existing spotlight
           handler's budget. Deliberately tiny — this should register as
           responsiveness, not as a toy. */
        if (opts.magnet && finePointer) {
            var frame = null;
            el.addEventListener("mousemove", function (e) {
                if (frame) return;
                frame = window.requestAnimationFrame(function () {
                    frame = null;
                    if (!state.hover || !ready()) return;
                    var r = el.getBoundingClientRect();
                    if (!r.width || !r.height) return;
                    // -1..1 from centre, clamped, then scaled to a few px.
                    var nx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
                    var ny = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
                    state.mx = Math.max(-1, Math.min(1, nx)) * opts.magnet;
                    state.my = Math.max(-1, Math.min(1, ny)) * (opts.magnet * 0.5);
                    el.style.willChange = "transform";
                    M.animate(el, {
                        x: state.mx,
                        y: opts.lift + state.my,
                        scale: opts.hoverScale || 1
                    }, SPRING.magnet);
                });
            }, { passive: true });
        }
    }

    function claimAll(selector, opts) {
        Array.prototype.forEach.call(document.querySelectorAll(selector), function (el) {
            springify(el, opts);
        });
    }

    /* ---- Cards: the big surfaces. Lift matches the CSS values they
            replace (-5 / -4) so the visual language is unchanged; only
            the physics of getting there is new. ---- */
    claimAll(".project-card", {
        spring: SPRING.card, lift: -5, pressLift: -2, pressScale: 0.994, pressable: true
    });
    claimAll(".contact-link", {
        spring: SPRING.card, lift: -4, pressLift: -1, pressScale: 0.994, pressable: true
    });
    claimAll(".pass", {
        spring: SPRING.card, lift: -5, pressLift: -2, pressScale: 0.994, pressable: true
    });
    /* Plain `.card`s that are neither a project nor a contact link had no
       CSS lift of their own; giving them one would flatten the hierarchy,
       so they are intentionally not claimed. */
    claimAll(".favorite-item", {
        spring: SPRING.chip, lift: -2, pressLift: -1, pressScale: 0.985, pressable: true
    });

    /* ---- Chips: small, so a stiffer spring and a touch of scale. ---- */
    claimAll(".bubble", {
        spring: SPRING.chip, lift: -3, hoverScale: 1.025,
        pressLift: -1, pressScale: 0.97, pressable: true
    });
    claimAll(".skills-list li", {
        spring: SPRING.chip, lift: -3, hoverScale: 1.025,
        pressLift: -1, pressScale: 0.97, pressable: true
    });

    /* ---- Buttons + primary CTAs: magnetic. ---- */
    claimAll(".btn-resume", {
        spring: SPRING.button, lift: -2, pressLift: 0, pressScale: 0.96,
        pressable: true, magnet: 4
    });
    claimAll(".nav-cta", {
        spring: SPRING.button, lift: -1, pressLift: 0, pressScale: 0.96,
        pressable: true, magnet: 3
    });
    claimAll(".contact-form button[type='submit']", {
        spring: SPRING.button, lift: -2, pressLift: 0, pressScale: 0.96, pressable: true
    });
    claimAll(".nav-toggle", {
        spring: SPRING.button, lift: 0, pressLift: 0, pressScale: 0.9, pressable: true
    });

    /* ============================================================
       2. Sliding active-nav indicator (desktop)

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
                M.animate(ind, { opacity: 0 }, { duration: 0.18 });
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
                M.animate(ind, { opacity: 1 }, { duration: instant ? 0 : 0.2 });
                shown = true;
                return;
            }
            M.animate(ind, { left: left + "px", width: width + "px", opacity: 1 }, SPRING.nav);
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
       3. Mobile menu panel — staggered entrance

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

            M.animate(rows,
                { opacity: [0, 1], y: [-10, 0] },
                {
                    delay: M.stagger ? M.stagger(0.035) : 0,
                    duration: 0.34,
                    type: "spring", stiffness: 420, damping: 30
                }
            ).finished.then(clearRows, clearRows);
        }).observe(navLinks, { attributes: true, attributeFilter: ["class"] });
    })();

    /* ============================================================
       4. Runtime reduced-motion unwind
       If the reader turns the OS setting on mid-visit, drop the flag
       (returning every claimed element to its CSS hover state) and wipe
       every inline transform we wrote. Cheap insurance against the one
       way this file could leave something stuck.
       ============================================================ */
    function unwind() {
        root.classList.remove("motion-on");
        claimed.forEach(function (el) {
            clearTransform(el);
            el.classList.remove("motion-spring");
        });
    }
    if (typeof reduceQuery.addEventListener === "function") {
        reduceQuery.addEventListener("change", function (e) { if (e.matches) unwind(); });
    }

    // Claiming succeeded — only now is it safe for the CSS to stand down.
    root.classList.add("motion-on");
})();
