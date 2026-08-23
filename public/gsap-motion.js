/* ============================================================
   Samuel Woo — GSAP motion layer  (gsap-motion.js)

   This file is ADDITIVE to script.js / anime.js. The two libraries
   are kept strictly separated so they can never fight over a node:

     anime.js  owns : hero letter stagger, .hero-motif/.projects-motif
                      line-draw (the .motif-draw paths), .kicker-num
                      count-ups, and every .reveal EXCEPT .gsap-reveal.
     CSS       owns : .reveal-clip clip-wipe, all :hover states.
     Motion    owns : `transform` on hover/press for .pass, .project-card,
                      .favorite-item, .bubble, .skills-list li (motion-ux.js).
                      NOTHING here may write transform on those nodes — see
                      NOTHING here writes transform on those nodes.
     GSAP (here) owns: the brand springy wordmark, the decorative
                      .shape-field line-art layer (its scroll-linked
                      self-draw AND its parallax plane), the pinned hero
                      depth stack, the pinned horizontal boarding-pass
                      hero/glow parallax, contour density from
                      scroll velocity, the timeline progress rail, chip
                      staggers, every element tagged .gsap-reveal, and —
                      via SplitText (section 8) — the masked line-rise on
                      .section-title / .case-title / .case-tagline /
                      .subhead / .case-head. Section 8 STRIPS .reveal
                      and .reveal-clip off those nodes at init so
                      anime.js and the CSS clip-wipe never see them.

   SCROLL IS THE SUBJECT. Three things carry it, and each one is a
   scroll-linked mechanism rather than a triggered fade:

     1. A PINNED, SCRUBBED HERO (§4a). The section holds still while five
        layers separate at different rates. The five were chosen by
        elimination: they are the only hero nodes that neither `.reveal`
        (which owns transform + a .6s CSS transition on it) nor Motion
        writes to.
     2. (REMOVED — §6b). This was a pinned horizontal boarding-pass
        filmstrip scrubbed sideways by vertical scroll. Cut on review: it
        welded sideways motion to the page scroll, and a filmstrip showed
        one or two of eleven trips at a time. The bento grid underneath
        shows them all. See §6b for the full note.
     3. SCROLL-LINKED LINE-ART (§2). `.shape-field` strokes draw themselves
        against scroll progress instead of playing a fixed tween on enter,
        parallax on an injected plane, and thicken with scroll VELOCITY via
        one inherited `--contour` custom property (§2b).

   NO SMOOTH-SCROLL LIBRARY. Lenis was measured and rejected: its
   virtual-scroll event is notify-only, so momentum cannot be clamped and
   the pinned sections above drift out of sync with the scrollbar. Native
   scroll + CSS `scroll-behavior: smooth` only. ScrollTrigger's own `scrub`
   supplies all the smoothing this page needs, and it is applied to the
   ANIMATION, never to the scroll position.

   The handoff is explicit: this file adds `html.gsap-on` and script.js
   only skips .gsap-reveal elements when that class is present. If GSAP
   fails to load, script.js animates them normally — nothing is ever
   left hidden because a script 404'd.

   prefers-reduced-motion: we bail out at the top BEFORE touching a
   single element. Everything GSAP animates therefore has a *visible*
   CSS resting state (shapes are static line-art, rails sit at full
   scale, .gsap-reveal falls back to the existing `.reveal { opacity:1
   !important }` rule). Nothing can be stranded invisible, because we
   never hide anything until we know we're allowed to animate it.
   ============================================================ */
(function () {
    "use strict";

    var reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    var reduceMotion = reduceQuery.matches;
    var gsap = window.gsap;

    // Hard stop before any gsap.set(): a bail-out here must leave the DOM
    // exactly as the CSS painted it (all content visible).
    if (!gsap || reduceMotion) return;

    /* Callbacks the §10 unwind runs if the reader turns reduced motion ON
       mid-visit. Anything below that hides a node, pins a section, or starts a
       `repeat: -1` tween registers here — those three are exactly the states
       that a CSS `!important` belt cannot reach on its own. */
    var unwindHooks = [];

    var ScrollTrigger = window.ScrollTrigger;
    var hasST = !!ScrollTrigger;
    if (hasST) {
        gsap.registerPlugin(ScrollTrigger);
        /* Mobile browsers fire `resize` every time the URL bar slides, which
           on a page with two pins means a full recalculation (and a visible
           re-snap of the pinned section) mid-gesture. Height-only resizes are
           ignored; width changes still refresh, which is what the pin
           measurements actually depend on. */
        ScrollTrigger.config({ ignoreMobileResize: true });
    }

    // Tell script.js it is safe to hand .gsap-reveal elements over to us.
    document.documentElement.classList.add("gsap-on");

    var toArray = gsap.utils.toArray;
    var rand = gsap.utils.random;

    /* ============================================================
       1. Brand mark — springy wordmark
       The old waving-hand icon read as a formal nametag; this is the
       type itself as the mark. On hover the letters lift and settle on
       an elastic spring in a stagger, the sage period pops, and a rule
       sweeps in underneath.

       Magnetism (letters leaning toward the cursor as you approach) is
       gated on POINTER STATE, not on the spring finishing. Gating on the
       timeline's onComplete was a real bug: the moment the spring ended
       while the cursor was still on the mark, magnetism re-engaged and
       snapped the letters. Both were writing `y` and fought each other.
       ============================================================ */
    toArray(".brand").forEach(function (brand) {
        var letters = toArray(brand.querySelectorAll(".brand-ltr"));
        if (!letters.length) return;
        var dot = brand.querySelector(".brand-dot");
        var rule = brand.querySelector(".brand-rule");
        var topbar = brand.closest(".topbar") || brand;

        gsap.set(letters, { transformOrigin: "50% 100%" });

        var overMark = false;
        var springTl = null;
        // quickTo gives a cheap per-frame setter for the magnetism pass.
        var pull = letters.map(function (l) {
            return gsap.quickTo(l, "y", { duration: 0.5, ease: "power3.out" });
        });

        /* While the pointer is in the top bar but NOT on the mark, each
           letter leans up in proportion to how close the cursor is. */
        topbar.addEventListener("mousemove", function (e) {
            if (overMark) return;              // hovered: the spring owns `y`
            letters.forEach(function (l, i) {
                var r = l.getBoundingClientRect();
                var cx = r.left + r.width / 2;
                var near = Math.max(0, 1 - Math.abs(e.clientX - cx) / 110);
                pull[i](-7 * near);
            });
        });
        topbar.addEventListener("mouseleave", function () {
            if (!overMark) letters.forEach(function (l, i) { pull[i](0); });
        });

        var playSpring = function () {
            overMark = true;
            // Hand `y` over cleanly so magnetism tweens cannot overlap.
            gsap.killTweensOf(letters, "y,scaleY");
            if (springTl) springTl.kill();
            springTl = gsap.timeline()
                .to(letters, {
                    y: -9, scaleY: 1.08,
                    duration: 0.2, stagger: 0.045, ease: "power2.out"
                }, 0)
                .to(letters, {
                    y: 0, scaleY: 1,
                    duration: 0.95, stagger: 0.045, ease: "elastic.out(1.1, 0.33)"
                }, 0.2);
            if (dot) {
                springTl.to(dot, {
                    scale: 1.6, duration: 0.18, yoyo: true, repeat: 1,
                    ease: "power2.out", transformOrigin: "50% 80%"
                }, 0.26);
            }
            if (rule) {
                springTl.fromTo(rule, { scaleX: 0 },
                    { scaleX: 1, duration: 0.5, ease: "power3.out", transformOrigin: "0% 50%" }, 0.08);
            }
        };

        var settle = function () {
            overMark = false;
            gsap.to(letters, { y: 0, scaleY: 1, duration: 0.4, ease: "power2.out" });
            if (rule) {
                gsap.to(rule, { scaleX: 0, duration: 0.28, ease: "power2.in", transformOrigin: "100% 50%" });
            }
        };

        brand.addEventListener("mouseenter", playSpring);
        brand.addEventListener("focus", playSpring);
        brand.addEventListener("mouseleave", settle);
        brand.addEventListener("blur", settle);
    });


    /* ============================================================
       2. Decorative line-art shape fields — SCROLL-LINKED self-draw
       Same visual language as the existing .motif-draw signature: sage
       strokes that draw themselves in. What changed is WHAT drives them.

       Before: a fixed 1.9s tween on a `once: true` trigger. The draw was
       an event that happened near the section, and after that the field
       was inert scenery for the rest of the scroll.

       Now: `scrub` against the band's own pass through the viewport, so
       the stroke length IS the scroll position. Scroll down and the
       contours extend under your gesture; scroll back and they retract.
       That is the difference between decoration that reacts to scrolling
       and decoration that reacts to *scroll*.

       THREE PROPERTIES, THREE NODES. The field carries a CSS transform
       already (`.shape-field--travel` is centred with translateY(-50%)),
       and GSAP resolves an existing computed transform into px — so a
       single `y` write on the field itself would silently destroy that
       centring. So each field gets a two-group spine, injected here:

         <svg class="shape-field">            <- CSS transform (untouched)
           <g class="shape-plx">              <- scroll parallax plane
             <g class="shape-drift">          <- endless ambient drift
               ...strokes...                  <- scrubbed dash-draw

       One property per node, so no two timelines ever share a matrix.
       ============================================================ */
    var SVGNS = "http://www.w3.org/2000/svg";

    toArray(".shape-field").forEach(function (field, fi) {
        var strokes = toArray(field.querySelectorAll(".shape-line, .shape-ring"));
        var dots = toArray(field.querySelectorAll(".shape-dot"));
        var ticks = toArray(field.querySelectorAll(".shape-tick"));
        var drifter = field.querySelector(".shape-drift") || field;
        var band = field.closest(".band") || field;

        /* Inject the parallax plane between the field and its drift group.
           Only if there IS a drift group — otherwise the field's own node is
           the drifter and wrapping it would put us back on the contested
           transform. */
        var plx = null;
        if (drifter !== field && drifter.parentNode) {
            plx = document.createElementNS(SVGNS, "g");
            plx.setAttribute("class", "shape-plx");
            drifter.parentNode.insertBefore(plx, drifter);
            plx.appendChild(drifter);
        }

        // Arm the dash-draw. Guard getTotalLength: it throws on some
        // shapes in older engines, and a 0 length would mean an
        // invisible stroke — so we simply skip drawing that one.
        var lens = [];
        strokes = strokes.filter(function (el) {
            var len = 0;
            try { len = el.getTotalLength(); } catch (e) { len = 0; }
            if (!len) return false;
            gsap.set(el, { strokeDasharray: len, strokeDashoffset: len });
            lens.push(len);
            return true;
        });

        /* Seal / unseal the dash.

           A scrubbed dash-draw cannot use the old `onComplete: clearProps`
           trick, because "complete" is not a one-way door any more — scroll
           back up and the tween runs in reverse. But leaving `dasharray`
           on forever reintroduces the sub-pixel seam at the joins that the
           clearProps was there to avoid in the first place.

           So the dash is sealed only once the band is genuinely BEHIND you
           (`onLeave`), where the stroke is fully drawn and the seam would
           show, and re-armed the moment you come back (`onEnterBack`) so
           the retraction still works. Both directions end in a fully-drawn
           stroke; neither can leave a stroke part-drawn at rest. */
        var seal = function () {
            if (strokes.length) gsap.set(strokes, { clearProps: "strokeDasharray,strokeDashoffset" });
        };
        var unseal = function () {
            strokes.forEach(function (el, i) { gsap.set(el, { strokeDasharray: lens[i] }); });
        };

        var tl = gsap.timeline({
            defaults: { ease: "none" },
            scrollTrigger: hasST
                ? {
                    trigger: band,
                    /* The band's own pass, front-loaded: fully drawn by the
                       time its top third is at the reading line, so the art
                       is finished scenery while you read the copy. */
                    start: "top 94%",
                    end: "top 24%",
                    scrub: 0.8,
                    invalidateOnRefresh: true,
                    onLeave: seal,
                    onEnterBack: unseal
                }
                : undefined
        });

        if (strokes.length) {
            tl.to(strokes, {
                strokeDashoffset: 0,
                duration: 1.9,
                stagger: 0.22
            }, 0);
        }
        if (dots.length) {
            tl.from(dots, {
                scale: 0,
                opacity: 0,
                duration: 0.7,
                ease: "back.out(2.2)",
                stagger: 0.1,
                transformOrigin: "50% 50%"
            }, 1.4);
        }
        if (ticks.length) {
            // Tick grids are too small to read a dash-draw, so they
            // bloom in place instead.
            tl.from(ticks, {
                scale: 0.2,
                opacity: 0,
                duration: 0.55,
                ease: "power2.out",
                stagger: { each: 0.045, from: "random" },
                transformOrigin: "50% 50%"
            }, 0);
        }

        /* Parallax plane. Runs across the band's WHOLE pass (not the draw's
           window) so the field keeps travelling against the copy long after
           it has finished drawing — that separation is what reads as depth.
           SVG user units, so the amount scales with each field's viewBox
           rather than being a px value tuned for one of them. */
        if (hasST && plx) {
            gsap.fromTo(plx,
                { y: -26 },
                {
                    y: 26,
                    ease: "none",
                    scrollTrigger: {
                        trigger: band,
                        start: "top bottom",
                        end: "bottom top",
                        scrub: 0.9
                    }
                }
            );
        }

        // Slow ambient drift — long durations + yoyo so it never draws
        // the eye. Staggered start so fields don't move in lockstep.
        gsap.to(drifter, {
            x: rand(-7, 7, 1),
            y: rand(-9, 9, 1),
            rotation: rand(-3.5, 3.5, 0.5),
            transformOrigin: "50% 50%",
            duration: rand(16, 26, 1),
            ease: "sine.inOut",
            repeat: -1,
            yoyo: true,
            delay: fi * 0.9
        });
    });

    /* ============================================================
       2b. Contour density — scroll VELOCITY, not scroll position
       The line-art layer thickens while you are moving fast and settles
       back to its resting hairline when you coast. It is the one effect
       on the page that reads your *speed*, which is what makes the
       scroll feel like it has weight.

       ONE VALUE, NOT N INLINE STYLES. Velocity drives a single inherited
       custom property on <html>; scroll.css multiplies the resting
       stroke-widths by it. Three consequences that all matter:
         - `opacity` on every stroke is left completely alone, so
           styles.css keeps ownership of the .24/.18/.2 register and the
           `.band--dark` overrides still apply.
         - the resting value 1 reproduces the original weights exactly,
           so "no velocity" is byte-identical to "no effect".
         - it is one tweened number for the whole page instead of ~40
           inline stroke-widths written per frame.

       The property is tweened on a PLAIN OBJECT and written out in
       onUpdate rather than tweened on the element directly — a numeric
       value is unambiguous to interpolate, and the write is a single
       setProperty call we control.

       SETTLING IS GUARANTEED BY A TIMER, not by the velocity reaching 0.
       `getVelocity()` is only sampled while scroll events arrive, so the
       last sample before you stop is a large number, not zero. Without
       the timer the contours would stay thick forever after a hard flick
       — a half-animated resting state, which is the failure mode this
       repo cares most about.
       ============================================================ */
    if (hasST) {
        var root = document.documentElement;
        var contour = { v: 1 };
        var writeContour = function () { root.style.setProperty("--contour", contour.v.toFixed(3)); };
        var setContour = gsap.quickTo(contour, "v", {
            duration: 0.5,
            ease: "power2.out",
            onUpdate: writeContour
        });
        var calmTimer = null;

        ScrollTrigger.create({
            trigger: root,
            start: 0,
            end: "max",
            onUpdate: function (self) {
                var v = Math.abs(self.getVelocity());
                setContour(1 + gsap.utils.clamp(0, 0.55, v / 4200));
                if (calmTimer) clearTimeout(calmTimer);
                calmTimer = setTimeout(function () { setContour(1); }, 120);
            }
        });
    }

    /* ============================================================
       3. Travel page — a dot flying the arc
       Cheap MotionPath substitute: sample the arc with
       getPointAtLength and write cx/cy. Only runs on travel.html.
       ============================================================ */
    (function flight() {
        var arc = document.querySelector(".flight-arc");
        var dot = document.querySelector(".flight-dot");
        if (!arc || !dot) return;
        var len = 0;
        try { len = arc.getTotalLength(); } catch (e) { return; }
        if (!len) return;
        var pos = { t: 0 };
        gsap.to(pos, {
            t: 1,
            duration: 11,
            ease: "sine.inOut",
            repeat: -1,
            repeatDelay: 1.2,
            delay: 2.2,
            onUpdate: function () {
                var p = arc.getPointAtLength(pos.t * len);
                gsap.set(dot, { attr: { cx: p.x, cy: p.y } });
            }
        });
    })();

    /* ============================================================
       4. Parallax depth
       Only on elements nothing else animates: the <g> wrapper inside
       the hero motifs (anime.js animates the .motif-draw children's
       stroke, not this transform) and the fixed background glows.
       ============================================================ */
    if (hasST) {
        toArray(".motif-parallax").forEach(function (g) {
            var host = g.closest("section") || g;
            gsap.fromTo(g,
                { y: -16 },
                {
                    y: 16,
                    ease: "none",
                    scrollTrigger: { trigger: host, start: "top bottom", end: "bottom top", scrub: 0.7 }
                }
            );
        });

        // Background wash drifts against the scroll for a little depth.
        var glowST = { trigger: document.body, start: "top top", end: "bottom bottom", scrub: 1.2 };
        if (document.querySelector(".glow-sage")) {
            gsap.to(".glow-sage", { yPercent: 9, ease: "none", scrollTrigger: glowST });
        }
        if (document.querySelector(".glow-olive")) {
            gsap.to(".glow-olive", { yPercent: -9, ease: "none", scrollTrigger: glowST });
        }

        /* Content plane. Each section's head leads its band very slightly
           against the shape-field behind it, which is what turns two
           independently-moving layers into a readable depth order. Range is
           deliberately tiny (±11px): `.section-head` contains the
           SplitText-claimed `.section-title`, whose trigger is measured from
           the element's rect, so a large offset would drag its start line
           around. 11px against a `top 86%` start is noise.

           `.section-head` itself is a plain wrapper — its children are the
           `.reveal`s. That is the whole reason it, and not the title or the
           intro, is the node that moves. */
        toArray(".section-head").forEach(function (head) {
            var band = head.closest(".band") || head;
            gsap.fromTo(head,
                { y: 11 },
                {
                    y: -11,
                    ease: "none",
                    scrollTrigger: { trigger: band, start: "top bottom", end: "bottom top", scrub: 0.8 }
                }
            );
        });
    }

    /* ============================================================
       4a. PINNED HERO — a five-plane depth stack, scrubbed
       The first gesture on the site should be the site reacting to you.
       So `#home` pins at the top of the scroll and, while it holds still,
       its layers separate at five different rates: the generative canvas
       sinks and pushes in, the whole block drifts up, the wordmark leads
       it, the intro column drags behind it, and an injected line-art
       plane races past in FRONT of the copy. Then it releases and the
       page scrolls on normally.

       WHICH NODES ARE LEGAL TO MOVE — this is the whole design of the
       block. `transform` on this page is contested by two other systems:
         - `.reveal` carries `transform: translateY(22px)` AND a .6s CSS
           transition on transform. A per-frame inline transform on a
           `.reveal` node puts GSAP in a race with that transition on the
           same property. That is the exact bug this repo has paid for
           three times.
         - Motion (motion-ux.js) owns transform on hover for the cards.
       Of everything in the hero, only these five are written by neither:
         .hero-canvas-wrap  positioned box, no .reveal, no hover claim
         .home-inner        the band-inner wrapper
         .hero-name         the <h1>; its `.hero-line` CHILDREN are .reveals
         .hero-lower        plain grid wrapper; its children are .reveals
         .hero-fg           injected below, owned by nobody else
       `.hero-meta`, `.hero-subtitle`, `.hero-intro` and `.explore-cue`
       are all `.reveal`, so they are NOT animated here — they ride
       `.home-inner`, which is why it is the plane that carries the most
       of the movement.

       NO OPACITY, ANYWHERE. Every plane moves and scales only. A scrubbed
       opacity would rest at whatever value the scroll position implies,
       and the resting value at the end of a pin is exactly the state a
       stranding check reads — so the <h1> and every `.reveal` in the hero
       stay at full opacity through the entire pin, by construction rather
       than by a safety net.
       ============================================================ */
    if (hasST) {
        (function pinnedHero() {
            var heroBand = document.querySelector(".band-home");
            if (!heroBand) return;
            var heroInner = heroBand.querySelector(".home-inner");
            var heroName = heroBand.querySelector(".hero-name");
            var heroLower = heroBand.querySelector(".hero-lower");
            var heroCanvas = heroBand.querySelector(".hero-canvas-wrap");
            if (!heroInner) return;

            /* Foreground plane, built here rather than in the markup: it
               exists ONLY when we are allowed to animate, so there is no
               static state of it to get wrong, and a reduced-motion visitor
               never has an inert decorative overlay sitting on their copy.
               aria-hidden + pointer-events:none (scroll.css) — it is
               atmosphere, not content. */
            var fg = document.createElementNS(SVGNS, "svg");
            fg.setAttribute("class", "hero-fg");
            fg.setAttribute("viewBox", "0 0 300 220");
            fg.setAttribute("fill", "none");
            fg.setAttribute("aria-hidden", "true");
            /* The two long STRAIGHT VERTICALS this plane used to carry
               (`M232 24 L 232 208` and `M262 52 L 262 208`) were removed after
               review: they ran the full height of the copy column and read as
               hard UI rules ruled straight through the subtitle and the intro
               paragraph. Two organic curves and one terminal dot carry the same
               parallax read without ever crossing a line of type as a
               straight edge. Nothing else references them.

               If a vertical accent is ever wanted back here, keep it SHORT and
               out of the text block — a full-height rule over body copy is the
               exact thing that failed. */
            fg.innerHTML =
                '<g class="hero-fg-plx">' +
                '<path class="hero-fg-line" d="M12 196 C 74 120, 150 176, 214 96"/>' +
                '<path class="hero-fg-line" d="M46 214 C 108 138, 184 194, 248 114"/>' +
                '<circle class="hero-fg-dot" cx="214" cy="96" r="4"/>' +
                '</g>';
            heroBand.appendChild(fg);
            var fgPlx = fg.querySelector(".hero-fg-plx");

            var planes = [heroInner, heroName, heroLower, heroCanvas, fgPlx].filter(Boolean);

            /* Short viewports opt out. A pin needs a viewport tall enough
               that holding the section still reads as intent rather than as
               a stuck page; below ~560px (landscape phones, split-screen)
               the hero barely fits as it is. gsap.matchMedia's revert also
               clears every inline prop when the query stops matching, so a
               rotate-to-landscape cannot leave a plane offset. */
            /* ALSO min-width 820px, not just min-height.
               The hero pins at `top top`, which (as scroll.css says) wants a
               section exactly one viewport tall. On narrow viewports the hero is
               now deliberately TALLER than that: layout.css reserves a band below
               the copy for the putting green, because a phone has no side gutter
               to put it in. Pinning a 1.25-viewport section would hold the page
               still for ~445px of scrolling while the green sat below the fold
               the entire time — the reader would scroll and see nothing move.
               So on narrow the hero is a normal tall section: read the copy,
               scroll, the green arrives. The pin stays a wide-viewport flourish.

               900px, NOT 820px: it must match HeroCanvas.tsx's own
               `narrow = cssW < 900` and layout.css's `max-width: 899px` band
               reservation. At 820-899 the first attempt reserved the band AND
               pinned, which is the exact combination this avoids (measured:
               959px hero pinned in a 900px viewport).

               matchMedia's revert clears every inline prop when the query stops
               matching, so resizing or rotating across the breakpoint cannot
               leave a plane offset. */
            var mmHero = gsap.matchMedia();
            mmHero.add("(min-height: 560px) and (min-width: 900px)", function () {
                /* Pin length in viewport heights. Shorter on narrow screens:
                   the same 0.85 that reads as a considered hold at 1440
                   reads as a page that will not move on a phone. */
                var narrow = function () { return window.innerWidth < 820 ? 0.62 : 1; };
                var span = function () {
                    return Math.round(window.innerHeight * 0.85 * narrow());
                };
                /* Plane travel scales with the pin length, not just with the
                   viewport height. Measured at 390x844: at full desktop
                   amplitude the block drifts 130px up inside a 506px pin,
                   which slides the `.hero-meta` line under the sticky topbar
                   and reads as the page having scrolled when it has not.
                   Same factor for the pin and the planes keeps the ratio of
                   "distance travelled per pixel scrolled" identical at every
                   width, which is what makes the effect feel like one
                   mechanism rather than two tunings. */
                var vh = function (f) {
                    return function () { return Math.round(window.innerHeight * f * narrow()); };
                };

                var tl = gsap.timeline({
                    defaults: { ease: "none" },
                    scrollTrigger: {
                        trigger: heroBand,
                        /* `top top`: the pin engages at the exact scroll
                           position where the hero's top already IS the
                           viewport top, so engaging it cannot cause a jump.
                           scroll.css gives `.band-home` a 100svh min-height
                           under html.gsap-on for the same reason — otherwise
                           a topbar-tall sliver of the next band shows under
                           the pinned hero for the whole hold. */
                        start: "top top",
                        end: function () { return "+=" + span(); },
                        pin: true,
                        pinSpacing: true,
                        anticipatePin: 1,
                        scrub: 1,
                        invalidateOnRefresh: true,
                        /* MUST refresh before every other trigger on the
                           page. ScrollTrigger measures with all pins
                           reverted and re-applies each pin's spacing as it
                           refreshes THAT trigger — so any trigger refreshed
                           before this one measures a document that is ~765px
                           shorter than the real one, and every start/end
                           below the hero lands that much too early.

                           This was not theoretical: with the default
                           priority, `#interests`'s line-art draw was
                           measured at scroll 123 instead of 887 and the
                           strokes drew themselves while the section was
                           still 1134px below the fold. Verified in-browser
                           before and after. */
                        refreshPriority: 1
                    }
                });

                // Back to front. Ordered by how much each plane travels,
                // which IS the depth cue: the canvas moves least (and the
                // wrong way, so it reads as further off), the injected
                // foreground moves ~4x the block itself.
                /* THE CANVAS PLANE DOES NOT MOVE. It used to be scrubbed
                   y: 0 -> 6vh and scale: 1 -> 1.12 across the pin, which was
                   wrong for two independent reasons.

                   1. It is not decoration. The canvas is the putting green —
                      an interactive game with a pointer-driven aim. Reviewed:
                      "we should also make it so that when we scroll down, the
                      golf game actually stays stationary". Parallaxing a
                      playfield moves the target while the player is aiming at
                      it.
                   2. The scale actively fought the input layer. Scaling the
                      wrapper means the canvas's CSS box no longer matches its
                      backing store, so every pointer coordinate has to be
                      divided by the live scale before it means anything —
                      which is exactly why HeroCanvas.tsx's `toCanvas()` reads
                      `rect.width / cssW` on every event. Measured over a
                      0 -> 700px scroll: scale ran 1.0000 -> 1.0991, i.e. a 10%
                      coordinate error that the component was paying to undo
                      every frame.

                   `heroCanvas` deliberately STAYS in `planes` below: it is a
                   clearProps target, so any inline transform left over from a
                   build that did scrub it gets cleaned up rather than stranded.
                   The other four planes still parallax — the depth effect is
                   unchanged for everything that is not the game. */
                tl.fromTo(heroInner, { y: 0 }, { y: vh(-0.1) }, 0);
                if (heroName) tl.fromTo(heroName, { y: 0 }, { y: vh(-0.055) }, 0);
                if (heroLower) tl.fromTo(heroLower, { y: 0 }, { y: vh(0.045) }, 0);
                if (fgPlx) tl.fromTo(fgPlx, { y: 0 }, { y: vh(-0.26) }, 0);

                return function () {
                    // Belt: matchMedia reverts its own tweens, but the planes
                    // must provably end with no inline transform at all.
                    gsap.set(planes, { clearProps: "all" });
                };
            });
        })();
    }

    /* ============================================================
       5. Progress rails — scrubbed, not tweened
       The experience timeline fills as you read it; each case study
       gets a hairline that tracks how far through it you are. Both
       rest at full scale in CSS, so with motion off they simply read
       as design elements rather than disappearing.
       ============================================================ */
    if (hasST) {
        toArray(".timeline-rail").forEach(function (rail) {
            var tl = rail.closest(".timeline") || rail;
            gsap.fromTo(rail,
                { scaleY: 0 },
                {
                    scaleY: 1,
                    ease: "none",
                    scrollTrigger: {
                        trigger: tl,
                        start: "top 72%",
                        end: "bottom 62%",
                        scrub: 0.5,
                        // Re-measure on refresh: the rail's length depends on the
                        // timeline's height, which webfonts change after load.
                        invalidateOnRefresh: true
                    }
                }
            );
        });
    }

    /* ============================================================
       5b. Work timeline — the entry you are level with lights up
       Scroll-driven storytelling on the career narrative: as each
       .exp-item crosses the reading line its marker takes the "current"
       treatment, so the rail's fill has something to point AT instead of
       just being a bar that grows.

       Deliberately class-only (colour + shadow, see styles.css). No
       transform, no opacity: an element can never be left mid-flight or
       invisible, and the class simply being absent is a valid resting
       look. This is why it needs no reduced-motion unwind beyond killing
       the CSS transition.
       ============================================================ */
    if (hasST) {
        toArray(".timeline").forEach(function (timeline) {
            var items = toArray(timeline.querySelectorAll(".exp-item"));
            if (items.length < 2) return;

            var clear = function () {
                items.forEach(function (it) { it.classList.remove("is-current"); });
            };

            items.forEach(function (item) {
                ScrollTrigger.create({
                    trigger: item,
                    // A band just under the sticky bar acts as the reading line.
                    start: "top 42%",
                    end: "bottom 42%",
                    onToggle: function (self) {
                        if (!self.isActive) return;
                        clear();
                        item.classList.add("is-current");
                    }
                });
            });
        });
    }

    /* ============================================================
       5c. Case-study marginalia rail — "pinned" read progress
       Each case study on projects.html gets a hairline in the left
       gutter that stays put beside the prose and scrubs as you read.

       Why NOT ScrollTrigger's pin:true — a real pin injects a
       pin-spacer into the document flow. On a page whose whole point is
       a calm editorial column, that is a needless overflow and
       layout-shift risk at every breakpoint. `position: sticky` on the
       track (styles.css) gives the identical "pinned marginalia" read
       for free, natively, with zero effect on layout; ScrollTrigger is
       then only responsible for the scrub. Same story, none of the risk.

       Wrapped in gsap.matchMedia so it exists only at the widths where
       the gutter does. matchMedia's revert() kills the tweens AND clears
       the inline props when the query stops matching, so a resize down
       cannot leave a scaleY(0) fill stranded behind a display:none rail.
       ============================================================ */
    if (hasST) {
        var mm = gsap.matchMedia();
        mm.add("(min-width: 1280px)", function () {
            toArray(".case-rail").forEach(function (rail) {
                var caseSection = rail.closest(".case-study");
                var track = rail.querySelector(".case-rail-track");
                var fill = rail.querySelector(".case-rail-fill");
                var head = rail.querySelector(".case-rail-head");
                if (!caseSection || !track || !fill) return;

                // Measured, not hard-coded: the track height is a clamp() on
                // vh, so it differs per window. invalidateOnRefresh below
                // re-runs these functions after fonts/images settle.
                var travel = function () {
                    return Math.max(0, track.getBoundingClientRect().height - 9);
                };

                var st = {
                    trigger: caseSection,
                    start: "top 55%",
                    end: "bottom 75%",
                    scrub: 0.55,
                    invalidateOnRefresh: true
                };

                gsap.fromTo(fill,
                    { scaleY: 0 },
                    { scaleY: 1, ease: "none", scrollTrigger: st }
                );
                if (head) {
                    gsap.fromTo(head,
                        { y: 0 },
                        { y: travel, ease: "none", scrollTrigger: st }
                    );
                }
            });
        });
    }

    /* ============================================================
       6. Chip / pill staggers
       The parent .reveal is faded by anime.js; these children are
       otherwise unanimated, so GSAP can pop them without overlap.
       clearProps is essential: these elements have CSS :hover
       transforms that an inline transform would otherwise beat.
       ============================================================ */
    if (hasST) {
        var chipGroups = toArray(".bubble-list, .skills-list, .feature-chips");
        chipGroups.forEach(function (group) {
            var chips = toArray(group.children);
            if (!chips.length) return;
            /* These lists are flex-wrapped, so they occupy real rows —
               `grid:'auto'` makes the pop travel along each wrapped row
               instead of jumping between them in DOM order. The 11-item
               skills list is the one where the difference is obvious. */
            gsap.from(chips, {
                y: 12,
                scale: 0.92,
                opacity: 0,
                duration: 0.55,
                ease: "back.out(1.6)",
                stagger: {
                    each: 0.05,
                    grid: "auto",
                    from: "start"
                },
                transformOrigin: "50% 50%",
                scrollTrigger: { trigger: group, start: "top 92%", once: true },
                onStart: function () { chips.forEach(function (c) { c.classList.add("gsap-busy"); }); },
                onComplete: function () {
                    chips.forEach(function (c) { c.classList.remove("gsap-busy"); });
                    gsap.set(chips, { clearProps: "all" });
                }
            });
        });
    }

    /* ============================================================
       6b. REMOVED — the pinned horizontal boarding-pass filmstrip
       The 11 passes used to be re-laid-out as a single row wider than the
       viewport, with the section pinned and vertical scroll remapped to
       horizontal travel along the strip.

       Removed on review, for two reasons given together:
         - tying the sideways motion to the page scroll meant you could not
           look through the trips without also moving the page, and the two
           gestures fought each other;
         - a filmstrip shows one or two passes at a time. The point of this
           section is the SET -- eleven real trips -- and a carousel hides
           most of it behind a gesture.

       What replaces it is what was already underneath: layout.css's 12-column
       bento (two wide featured passes, then three rows of three), which was
       only ever overridden above 1024px by the track. Every pass is on screen
       at once and nothing is scroll-driven.

       The entrance stagger in section 7 stays -- it is triggered on enter, not
       scrubbed, so it plays once and does not follow the scrollbar.

       scroll.css section 3 held the matching CSS and is gone too. Nothing
       injects `.hstage` / `.hviewport` / `.pass-depth` any more.
       ============================================================ */


    /* ============================================================
       6c. Trip cadence — bars that grow under the gesture
       The cadence strip's marks scrub up as the figure enters, staggered
       across the real laid-out grid so the growth travels along the month
       axis instead of arriving all at once.

       The from-state is scaleY 0.18, NOT 0. A scrubbed tween's resting
       value is wherever the scroll stopped, so its from-state has to be a
       legitimate look on its own — 0.18 is a visible tick, 0 is a stranded
       invisible element. Same reasoning as everywhere else in this file:
       never author a zero-area start.
       ============================================================ */
    if (hasST) {
        (function tripCadence() {
            var plot = document.querySelector(".trip-plot");
            if (!plot) return;
            var marks = toArray(plot.querySelectorAll(".trip-mark"));
            if (!marks.length) return;
            gsap.fromTo(marks,
                { scaleY: 0.18, transformOrigin: "50% 100%" },
                {
                    scaleY: 1,
                    ease: "none",
                    stagger: { each: 0.05, grid: "auto", from: "start" },
                    scrollTrigger: {
                        trigger: plot.closest(".trip-summary") || plot,
                        /* Measured, not guessed: at 1440x900 this figure
                           already sits at 58% of the viewport on first paint,
                           so the usual `top 90%` start is behind the scroll
                           position before the user has touched anything and
                           the bars are done growing within 113px. Starting at
                           `top 62%` puts nearly the whole growth in front of
                           the reader instead — it becomes the first thing on
                           the travel page that answers a scroll. */
                        start: "top 62%",
                        end: "bottom 24%",
                        scrub: 0.5,
                        invalidateOnRefresh: true
                    }
                }
            );
        })();
    }

    /* ============================================================
       7. .gsap-reveal — elements handed over from script.js
       Two flavours: boarding passes get a slight card-flip depth;
       everything else (case-study prose) gets a clean rise. Both add
       .is-visible and clearProps on finish so the element ends up in
       exactly the state the CSS expects, hover transforms included.
       ============================================================ */
    // `.gsap-busy` mutes the element's own CSS transitions for the
    // duration of the tween (see styles.css) so a .3s CSS transition
    // isn't chasing our per-frame inline transform.
    /* `__gsapEntered` EXISTS BECAUSE begin() CAN OUTLIVE ITS OWN TWEEN.
       §7b's straggler watchdog can rescue a pass BEFORE the wall's ScrollTrigger
       fires. When it does it kills that pass's entrance tween — and then begin()
       stamps `.gsap-busy` on all eleven, while the killed tween no longer has an
       onComplete to take it off again. Those passes stayed busy for the whole
       visit, which meant motion-ux's `ready()` refused to write their hover
       spring (hover-deaf) and, once stubs became draggable, they were also
       refused as swap targets because a busy stub is skipped.
       Measured on the served build BEFORE this fix: stubs 0, 1 and 2 were still
       `.gsap-busy` five seconds after the wall had finished revealing, and a drag
       of 0 onto 1 correctly refused to trade. After: 0 of 11 busy.
       The flag is one-way, like `is-visible`: once a pass has entered, nothing
       may mark it busy again. */
    function begin(els) {
        els.forEach(function (el) {
            if (el.__gsapEntered) return;
            el.classList.add("gsap-busy", "is-visible");
        });
    }
    function finish(els) {
        els.forEach(function (el) {
            el.__gsapEntered = true;
            el.classList.add("is-visible");
            el.classList.remove("gsap-busy");
        });
        gsap.set(els, { clearProps: "all" });
        /* §7b: a stub becomes throwable at the same instant it becomes
           hoverable. This function is shared with the case-study prose batch,
           so it is filtered here rather than relying on armStub's own
           `.pass-wall` guard to no-op on a `.case-block`. */
        els.forEach(function (el) {
            if (el.classList.contains("pass")) armStub(el);
        });
    }

    /* Release ONE element the moment its own entrance ends.
       `.gsap-busy` is not decoration: motion-ux.js's `ready()` refuses to
       write a hover transform while it is present, because a gesture and an
       entrance tween would otherwise both be writing y/scale. Clearing it
       for the whole SET at the set's end means the first element to settle
       stays hover-deaf until the last one finishes — measured at 2560 as
       ~530ms of a visibly settled pass ignoring the pointer. Per-element
       release keeps the interlock (nothing is freed early) and drops the
       cross-element share of the wait to zero.

       It is also the one place that knows an individual pass is finally at
       rest with no other writer on its transform, which is exactly the
       precondition §7b's Draggable needs — so the drag is armed from here
       (`armStub` is a hoisted declaration in §7b below; it is a no-op until
       the plugins and the pointer gate say otherwise). Arming at init instead
       would let a reader grab a pass whose entrance tween is still running and
       put two writers back on `transform`. */
    function finishOne(el) {
        el.__gsapEntered = true;   // see the note at begin()
        el.classList.add("is-visible");
        el.classList.remove("gsap-busy");
        gsap.set(el, { clearProps: "all" });
        armStub(el);
    }

    var passes = toArray(".pass.gsap-reveal");
    var prose = toArray(".gsap-reveal:not(.pass)");

    /* ---- Boarding-pass wall: grid-aware stagger ----
       The wall is an 11-card CSS grid (3 / 2 / 1 columns by breakpoint).
       The old code batched by scroll proximity with a flat `stagger: 0.09`,
       which reads as an arbitrary queue: DOM order, not the order your eye
       actually travels the wall.

       `stagger: { each, grid: 'auto', from: 'start' }` makes GSAP measure
       the laid-out positions and stagger diagonally from the top-left — so
       the cards arrive as a wave across the grid, matching how the wall is
       read. `grid:'auto'` reads real geometry, so it adapts to 3/2/1
       columns on its own with no breakpoint bookkeeping.

       One whole-wall trigger rather than ScrollTrigger.batch: a grid
       stagger is only meaningful over the full set. Batching hands GSAP
       an arbitrary subset, so the measured grid would be a fragment of
       the real one and the diagonal would break at every batch boundary.
       start:"top 78%" keeps the first row from firing before it's in view. */
    if (hasST && passes.length) {
        /* The wall is a real grid again (the filmstrip is gone, see 6b), so it
           is the right box to measure the start line against and `grid:'auto'`
           reads its actual rows — the wave runs diagonally across the bento. */
        var wall = passes[0].closest(".pass-wall") || passes[0].parentElement;
        gsap.set(passes, { opacity: 0, y: 34, scale: 0.97, rotateX: -6, transformPerspective: 800 });

        /* ONE TWEEN PER PASS, not one staggered tween over all of them.
           The visual result is identical — `gsap.utils.distribute` is the
           very function a `stagger: {}` object uses internally, so feeding
           it the same {each, grid, from, ease} reproduces the same diagonal
           wave (measured: 11 passes, delays 0 -> 0.275s, 7 distinct steps).
           What changes is that each pass now owns an `onComplete`, so it can
           be released from `.gsap-busy` when ITS entrance ends instead of
           when the slowest one does. See finishOne(). */
        var delayOf = gsap.utils.distribute({
            each: 0.075,
            grid: "auto",
            from: "start",
            ease: "power1.inOut"
        });

        var wallIn = gsap.timeline({
            scrollTrigger: {
                trigger: wall,
                start: "top 78%",
                once: true,
                // The airline logos are images; a late decode changes the
                // grid's measured geometry the stagger depends on.
                invalidateOnRefresh: true
            },
            onStart: function () { begin(passes); }
        });

        passes.forEach(function (el, i) {
            wallIn.to(el, {
                opacity: 1, y: 0, scale: 1, rotateX: 0,
                duration: 0.9,
                // Gentle overshoot: a boarding pass settling onto the wall.
                // Kept under 1.2 so it reads as a settle, not a bounce.
                ease: "back.out(1.1)",
                onComplete: function () { finishOne(el); }
            }, delayOf(i, el, passes));
        });
    } else if (passes.length) {
        // No ScrollTrigger for some reason — show them, don't hide them.
        finish(passes);
    }

    /* ============================================================
       7b. THE STUB BOARD IS PICK-UP-AND-THROWABLE
           (Draggable + InertiaPlugin, 3.13.0)

       You can lift a boarding pass off the wall, move it around the board,
       and throw it: it leaves the cursor at the velocity you released it with,
       decelerates, and curves back into its own slot. Nothing is achieved by
       it. It is a toy, and it must leave the board exactly as it found it.

       ======== READ THIS BEFORE CHANGING ANYTHING BELOW ========
       THE OBVIOUS IMPLEMENTATION IS WRONG, AND IT WAS MEASURED WRONG, NOT
       GUESSED WRONG.

       The obvious implementation is `Draggable.create(pass, {type: "x,y"})`.
       Do not do that. GSAP folds the INDEPENDENT `rotate` / `translate` /
       `scale` CSS properties into `transform` the first time it renders a
       transform on an element — it reads them, writes `rotate: none` /
       `translate: none` inline, and carries the values in its own cache
       instead. That fold is visually lossless (same matrix, same rect), and
       `clearProps: "all"` undoes it, which is why §7's entrance can absorb
       and restore the tilt on every pass without anyone noticing.

       A Draggable with `inertia: true` makes it PERMANENT. InertiaPlugin's
       velocity tracker samples the target's x/y every single frame for as
       long as the Draggable exists, so the cache never goes cold and the
       fold is re-applied immediately after any attempt to clear it.

       Measured, on this fixture, with the wall's real CSS: arming eleven
       Draggables directly on the passes left all eleven with
       `rotate: none; translate: none` and a permanent inline `transform`,
       against the committed build's `rotate: -1.5deg; translate: -3px` and
       no inline transform at all. The board still LOOKED identical (rects
       byte-for-byte: left 31.29 / 498.46 / 954.65, top 194.33 / 208.83 /
       677.18 in both), but `.pass-wall > .pass:hover { rotate: 0deg }` —
       "the stub you are looking at is the one lying flat", layout.css §13 —
       went dead on all eleven, together with its .28s transition, because an
       inline `rotate: none` cannot be beaten by a stylesheet. That is the
       fourth instalment of this project's `transform`-on-`.pass` problem, and
       it arrives from a direction the first three did not: not from a
       runtime write, but from GSAP initialising its cache at create time.

       ---- SO: DRAGGABLE NEVER TOUCHES A `.pass` ----
       Each pass gets a zero-size, aria-hidden PROXY div (parked in one
       container on <body>, NOT in `.pass-wall` — the tilt ladder is
       `:nth-child(1..11)` and an extra child in there would scramble it).
       Draggable's TARGET is the proxy; its `trigger` is the pass. So the
       velocity tracker samples the proxy, the throw physics happen on the
       proxy, `zIndexBoost` writes the proxy's z-index, and the pass's
       transform cache is never touched by any of it. `onDrag` and
       `onThrowUpdate` mirror the proxy's x/y onto the pass.

       ---- AND IT MIRRORS ONTO `translate`, NOT `transform` ----
       `transform` on `.pass` is the most contested property in this project.
       At rest it has three writers, deliberately partitioned:

         layout.css §13  the resting tilt and nudge, via the independent
                         `rotate` / `translate` properties
         motion-ux.js    the magnet channel — x, rotate, rotateX, rotateY
         motion-ux.js    the lift channel   — y, scale

       A drag needs two translation axes and there is no free pair left in
       `transform`: it would collide with the magnet on x and with the lift on
       y at once, so the axis partition cannot be extended into it. `translate`
       is the free lane. Nothing animates it — layout.css sets it statically,
       per index, and that is all. So the ownership for a drag is:

         FROM the first 5px of movement (onDragStart) UNTIL the throw has
         landed (land()), THIS SECTION IS THE SOLE WRITER OF `translate` ON
         THAT ONE PASS, and it writes nothing else. `transform` stays exactly
         where motion-ux left it. Every other pass is untouched.

       ---- WHY motion-ux STILL HAS TO BE MUTED ----
       Two reasons, and the second is the one that would bite.
         1. `clearTransform()` in motion-ux's settle() does
            `style.removeProperty("translate")`. That is our lane; 760ms after
            the stub leaves the cursor it would wipe the drag.
         2. THE FOLD AGAIN. Any `gsap.set` on the pass folds whatever is in
            `translate` into `transform` and writes `translate: none`. The
            hover and press springs write transform continuously while a stub
            is in hand, so each one would absorb the current drag offset and
            the next mirrored frame would add it on top — runaway
            accumulation, not a fight.

       The mute is `.gsap-busy`, the interlock this file already owns and §7
       already uses: motion-ux's `ready()` refuses to write while it is
       present, and every write path for a pass goes through it — applyLift
       (checked at entry), applyMagnet (both callers check), settle's
       clearTransform (checked in the callback). Audited path by path; there
       is no fourth. `html.gsap-on .gsap-busy { transition: none !important }`
       comes with it, so no CSS transition is chasing the mirrored frames.

       `.gsap-busy` stops motion-ux STARTING a write; it cannot stop one
       already in flight, because motion-shim.js's springs are not gsap tweens
       — they are integrated on a `gsap.ticker` callback that writes through
       `gsap.set` (which is exactly what makes the axis partition compose).
       `gsap.killTweensOf()` does not touch them. At the moment a drag begins
       there are always two running: the press dip on y/scale and the magnet
       on x/tilt. motion-shim's public escape hatch is `duration: 0`, which
       calls its own `cancelSprings()` per property, writes synchronously, and
       marks the spring inactive. seize() uses it, and it is also why seize
       zeroes GSAP's x/y: they hold the folded resting nudge, and leaving it
       there would apply that nudge twice once we start writing `translate`.

       seize() DELIBERATELY DOES NOT TOUCH `rotate`. GSAP's cache holds the
       folded resting tilt as `rotation`, and zeroing it would flatten the stub
       permanently — that was the first version of this code and it lost the
       tilt on every pass that had been dragged.

       ---- WHY THE PRESS DIP SURVIVES ----
       Seizing at `onPressInit` (Draggable's documented "kill tweens here"
       hook) would be tidier, but it fires on every press, so every plain
       click on a pass would lose motion-ux's press dip and release overshoot.
       Seizing at `onDragStart` costs one frame of normalisation instead, and a
       click that never becomes a drag never touches any of this.

       SIZE PARITY, a hard requirement of this layout: nothing here writes
       `scale` except to pin it at 1, and `translate` is a paint-time offset
       that does not participate in layout. A held stub is the exact size of
       the ten it left behind, measured at every sample of a drag.

       ============================================================
       ---- SWAP ON FLING: THROW ONE STUB AT ANOTHER AND THEY TRADE SLOTS ----

       Fling a stub onto another stub and the two change places. The thrown one
       flies into the target's slot; the target slides into the slot the thrown
       one came from. Same toy, one more verb.

       THE RULE, AND WHY IT IS THIS ONE
       The target is decided from the PROJECTED LANDING, not from where the
       cursor let go. It is a fling: the reader aims at where the card will end
       up. InertiaPlugin already computes that projection from the release
       velocity, so using it costs nothing and it degrades exactly right — a
       slow drag-and-drop projects ~0px past the release point, so the same rule
       covers "place it on that one" and "hurl it at that one" with no second
       code path. (Measured from the plugin's own model: displacement is
       3.5e-4 * v * |v| px at `throwResistance` 1000, so 500px/s carries ~88px
       and 1000px/s carries ~350px — about one column pitch at 1440.)

       Among the candidates the winner is the one the landing BOX covers most,
       and it must cover at least a THIRD of a stub's area (SWAP_COVER). Not
       "nearest slot centre": nearest-centre always finds a winner, so a card
       dropped into the gutter between rows would swap with a neighbour it is
       barely touching. Coverage means the gesture has to actually land the card
       on another card. The three cases, computed against the real 1440 geometry
       (stub ~299x197, gap ~24px, column pitch 323, row pitch 221):

         aimed at a stub            ~100% coverage   -> swap
         dropped in the gutter
           between two stubs        ~46% each        -> swap, with the larger
         dropped on the crossroads
           of four stubs            ~20% each        -> NO swap, returns home
         dropped in the empty 12th
           cell of the last row     ~0%              -> NO swap, returns home

       The crossroads case is deliberately a no-swap: an ambiguous gesture gets
       the answer it had before this feature existed. A third is also nowhere
       near any of those numbers, so the threshold is not a knife edge.

       Boxes are built from `offsetWidth`/`offsetHeight` around each stub's rect
       CENTRE, not from the rects themselves: a rect is grown by the resting
       tilt, but `rotate` turns about the centre, so the centre is exact and the
       layout box is the true slot footprint. Size parity means every box is
       identical, which is why one `w*h` covers both sides of the comparison.

       CANDIDATES MUST BE ARMED AND IDLE — `__stubDrag && !.gsap-busy`. Armed
       means its entrance tween finished (armStub is only ever called from
       finishOne), so a swap can never reach into §7's staggered entrance and
       strand it. `.gsap-busy` means somebody is writing to that pass right now:
       a held stub, the other half of a trade already in flight, or one still
       entering. Both halves of that predicate are interlocks this file already
       owns; no new state was invented for it.

       ONE TRADE AT A TIME (`stubSwapLock`). You cannot drag two stubs with one
       mouse, but you can fling one and immediately fling another while the
       first is still in the air — and two overlapping reorders of the same
       parent is a race with no correct answer. While a trade is pending the
       decision function returns "home" for everybody, so the second fling is
       simply an ordinary throw. Pressing either participant ABORTS the pending
       trade and sends the other half back to its own slot: catching a card
       cancels the deal, which is the only reading a reader could expect.

       ---- THE `translate` ARITHMETIC, WRITTEN OUT ----
       `translate` is shared: it carries the slot's authored nudge AND the live
       drag offset, and a swap moves a stub to a slot with a DIFFERENT nudge.
       That sounds like it needs bookkeeping. It needs none, and here is why.

       The mirror writes `translate = base + offset`, where `base` is the
       stub's authored nudge for the slot it is IN. So for a stub in slot i:

         painted centre  =  centre(slotBox i) + T_i + offset
         rest centre     =  centre(slotBox i) + T_i          (offset 0)

       Both halves measure their own REST CENTRE the same way — seize, paint
       offset 0, read the rect centre — so `restCentre` is a single measured
       number that already contains the slot box, the nudge, and nothing else.
       (It has to be measured after seize(): seize's quiesce() folds the
       independent `translate` into `transform` and then zeroes GSAP's x/y, so
       the element is momentarily sitting on its bare slot box. paint(0,0) puts
       the nudge back in OUR lane, which is where the arithmetic wants it.)

       Let A be thrown, B the target. The throw is redirected to land on

         offset = restCentre(B) - restCentre(A)

       and B is slid to `restCentre(A) - restCentre(B)`, i.e. exactly minus
       that. A difference of two measured centres — no slot boxes, no nudges,
       no grid maths, and it is correct at every breakpoint because it never
       assumes what the grid is doing.

       Then, once BOTH have arrived, the DOM swap and the two land()s happen in
       ONE synchronous block, and that block is a VISUAL NO-OP. Proof, for A:

         before the swap   A's grid box is slotBox(i),
                           inline translate = T_i + (rc(B) - rc(A))
                           centre = centre(slotBox i) + T_i + rc(B) - rc(A)
                                  = rc(A) + rc(B) - rc(A)
                                  = rc(B)
         after the swap    A's grid box is slotBox(j), and land() REMOVES the
                           inline translate, so the stylesheet's value for the
                           new `:nth-child` is live again:
                           centre = centre(slotBox j) + T_j = rc(B)

       Identical. Same argument for B with i and j exchanged. So the reorder
       moves nothing on screen — the movement was the flight and the slide, and
       the reorder only makes the DOM agree with what the reader already sees.
       Nothing is animated across the reorder, so nothing can be stranded
       half-way through it.

       land() is still the guarantee, exactly as before: removing one inline
       property puts the stub on the stylesheet's value for whatever slot it is
       now in. The snap only decides which slot the FLIGHT ends at. That is why
       a landing that InertiaPlugin has to clamp by a few px costs a few px of
       snap at land and nothing worse — and why the bounds check below only has
       to catch the gross case.

       THE SNAP IS `snap.points`, NOT `snap.x`/`snap.y`. A 2D decision cannot be
       made one axis at a time. Draggable's `snap.points`-as-a-function form
       sets InertiaPlugin's `linkedProps: "x,y"`, which gathers the natural
       landing for both axes into ONE point object and calls the function ONCE
       with it (verified in the vendored 3.13.0: InertiaPlugin's `$()` caches
       the result on the point via `calculated`, and the resolved end is written
       back over the `end` key so the second axis cannot re-enter it). `this` is
       the Draggable, so the gesture's own bounds are readable from inside.

       The function's return set is exactly TWO values: {0,0} — this stub's own
       slot, i.e. byte-for-byte the old behaviour — or the target's offset. Both
       are legal slots, so "a thrown stub always ends up in a slot" survives as
       a property of the physics rather than of cleanup code, which is the whole
       reason the original used `snap` instead of a second return-home tween.

       THE BOUNDS CHECK IS NOT OPTIONAL. InertiaPlugin clamps whatever the
       function returns to the gesture's own min/max (Draggable passes them in
       as the per-axis `max`/`min`). Those limits are the visible board, so a
       target that is scrolled mostly off screen is not reachable and a clamped
       landing would stop the card BETWEEN slots. Rejecting an out-of-bounds
       offset turns that into "no swap", and the practical rule it produces is
       the honest one: you can only trade with a stub you can see.

       THE PROXY ORIGIN HAS TO BE RESET. This is the one place the swap reaches
       into the drag machinery. The throw now ends somewhere other than 0,0, and
       the proxy's x/y is the coordinate origin every subsequent gesture on that
       pass is measured from — so land() zeroes the proxy AND writes Draggable's
       own cached `x`/`y`/`endX`/`endY` back to zero with it. The cache write is
       needed because Draggable dispatches `onPressInit` BEFORE it re-reads the
       target's position (verified in the vendored source: `Mh` fires pressInit,
       then records positions, then kills tweens), and onPressInit is where this
       file computes its bounds off `this.x`. Without it the next press on a
       swapped stub derives its limits from the last landing offset. The same
       reasoning is why every proxy tween here mirrors back onto `drag.x`/`.y`.

       THE ARMED BASE HAS TO BE REBASED. `armedBase` is the fallback origin,
       cached at arm time, used only once a hover spring has folded the live
       `translate` away. A swap changes the stub's `:nth-child`, so that cache
       becomes the OLD slot's nudge — a stale one would surface as a =<20px jump
       on some later grab, long after the swap, which is exactly the class of
       bug that never gets found. rebase() re-reads it inside the commit block,
       one line after land() handed `translate` back to the stylesheet.

       ---- THE TILT LADDER MOVES WITH THE SLOT, AND THAT IS THE INTENT ----
       Reordering the DOM re-evaluates `:nth-child`, so a swapped stub wears its
       NEW slot's tilt and nudge. layout.css §13 is explicit that the ladder
       describes the BOARD — "what varies is only how each one LIES on the
       plate" — and the values are hand-picked so no two neighbours lean the
       same way. Carrying a tilt along with its card would break that
       neighbour-alternation at both ends of every trade.

       It is also the only option the ownership map allows. Keeping the tilt
       with the card means writing `rotate` inline, and motion.css §7 records
       the measurement that kills that idea: a drag forces GSAP to render a
       transform, which folds `rotate` away and writes `rotate: none` inline, so
       an inline tilt would also permanently kill
       `.pass-wall > .pass:hover { rotate: 0deg }` on every stub that had ever
       been dragged. The tilt belongs to the slot.

       The change is therefore visible: two stubs each pick up a new lean, by at
       most ~3.5deg, at the instant of the commit. It is INSTANTANEOUS, not
       eased, because `.gsap-busy` (`transition: none !important`) is still on
       when land() removes the inline `rotate` and only comes off afterwards.
       Deliberate: the alternative is dropping `.gsap-busy` first so layout.css's
       `transition: rotate .28s` can run, which would unmute motion-ux for a
       frame while this section still had the pass mid-restore. A 3-degree step
       on a card that has just flown across the board is not worth reopening
       land()'s ordering, which four separate incidents produced.

       ---- WHY A DOM REORDER AND NOT CSS `order` ----
       `order` on the grid items would move the cards without touching the DOM,
       which sounds tidier and keeps the tilts with their cards. It is the wrong
       trade. Visual order would then disagree with DOM order permanently, which
       is precisely what WCAG 1.3.2 Meaningful Sequence is about; a low-vision
       reader driving a screen reader with a mouse would hear the wall in an
       order that no longer matches what is on screen. A DOM swap keeps the two
       in step by construction. `order` would also be a new inline property on
       eleven elements for this file to own, on a page that has paid four times
       for exactly that.

       A pairwise swap is also the MINIMAL reorder: exactly two `:nth-child`
       indices change and the other nine are untouched. "Insert A where B was
       and shift the rest" would re-tilt every stub between them. The owner
       asked for a swap; a swap is also the only reorder that is nearly free.

       ---- WHAT A REORDER COSTS, HONESTLY ----
       DOM order is reading order, so after a trade a screen reader reads the
       two swapped stubs in their new positions. That matches the screen, which
       is the right direction, and it is the reason for the choice above. Tab
       order is unaffected: nothing inside a `.pass` is focusable (no link, no
       button, no tabindex — and §7b will not add one; a previous library put
       eleven articles in the tab order and that is not being repeated).

       NO LIVE REGION, and that is a decision, not an omission. A swap can only
       be performed with a fine pointer on a device with no touch input at all,
       by a reader who is looking at the card they just threw. The only person
       an announcement could reach is the person who caused it and watched it
       happen. The cost is a permanent ARIA live node whose sole consumer cannot
       trigger it, plus a live region that must be proved never to fire during
       the drag itself. WCAG 2.5.7 Dragging Movements is NOT satisfied here —
       the swap inherits the drag's lack of any single-pointer or keyboard
       equivalent, and the judgement in the section header applies unchanged: a
       toy that rearranges eleven decorative stubs conveys nothing and gates
       nothing.

       ---- THE ORDER IS NOT PERSISTED ----
       No localStorage, no sessionStorage, no URL state. Four reasons, and the
       first is sufficient: `.pass-wall`'s authored order is the designed board,
       and this file's rule everywhere else is that the resting state is the one
       the CSS painted. A shuffled board surviving a reload would turn an
       ornament into state — the exact opposite of "it must leave the board
       exactly as it found it". Beyond that: the eleven `trips` entries are NOT
       in chronological order in travel.astro (2025-09, 2025-09, 2026-04,
       2026-05, 2025-10, ...) and the summary strip above the wall sorts its own
       month axis independently, so there is no sequence for a reorder to
       destroy and nothing derived from the wall's order to keep in sync; the
       `.pass-idx` serial travels inside its own card, so each stub keeps its
       own number wherever it lands. And `localStorage` THROWS outright in
       Safari private mode, so persisting would mean wrapping every read and
       every write to protect a feature nobody asked to be durable.

       ---- REDUCED MOTION ----
       Nothing extra to say: the swap lives entirely inside the drag, which
       lives entirely inside this file, which returns before its first
       `gsap.set()` when the preference is set. For a mid-session flip, the
       unwind hook drops any pending trade WITHOUT committing it (no reorder, no
       fly-home tweens — the reader has just asked for less motion) and then
       lands every pass where it stands.
       ============================================================

       ---- COARSE POINTERS: OFF, DELIBERATELY, AND NOT BY MEDIA QUERY ALONE
       Draggable with `type: "x,y"` writes `touch-action: none` as an inline
       style on its TRIGGERS in `enable()`, i.e. at create time. The timing is
       fine — the trap is setting touch-action inside a pointerdown handler,
       which is already too late because the browser resolved it from the
       hit-test element and its ancestors at touchstart. The problem is the
       target: on a phone the wall is one column of eleven big cards, and
       eleven `touch-action: none` cards would take vertical pan away from most
       of the travel page. A stub is far too big a target to steal a scroll.

       So the gate is not "is this a fine pointer" but "is there NO touch input
       on this device at all" — `(any-pointer: coarse)` and
       `navigator.maxTouchPoints` both have to come up empty, which also rules
       out the touchscreen laptop that satisfies `(pointer: fine)`. A mouse
       user on a Surface loses a toy; nobody loses a scroll. motion.css carries
       a static, unflagged `@media (any-pointer: coarse)` belt that puts
       `touch-action` back with `!important` regardless, so even a wrong answer
       here cannot cost a coarse pointer its pan.

       WCAG 2.5.7 Dragging Movements is NOT satisfied by an equivalent
       single-pointer path, and this comment is not going to pretend
       otherwise. There is no keyboard or click alternative: `.pass` is a plain
       `<article>`, and the only way to give it one would be to put eleven
       non-interactive articles into the tab order — a regression this project
       has already had once, from Motion's `press()` setting tabIndex. The
       judgement is that an ornament which moves a card and puts it straight
       back conveys nothing and gates nothing, so there is no function for an
       alternative to provide. Nothing on this page depends on it and a reader
       who never finds it has missed no content. Draggable does cost the
       armed passes their text selection (its `enable()` writes
       `user-select: none`, its `disable()` puts it back) — accepted, and
       recorded here rather than discovered later.

       ---- ONE MEASURED, SELF-HEALING RESIDUE ----
       After a throw the stub is back in its slot to the pixel (asserted), but
       it can still be carrying a folded `transform` and an inline
       `rotate: none` for a moment. It is not ours: motion-ux writes its own
       REST transform when hover ends, and its settle() — the thing that would
       normally strip it 760ms later — had already fired and given up while we
       still held `.gsap-busy`, and settle() is only ever rescheduled from a
       hover or press ending. So the fold survives until the next hover cycle,
       whose settle() clears it. Measured: immediately after landing,
       `transform: translate3d(1px, 6px, 0px) rotate(-1.8deg)` with
       `rotate: none`; after one hover in/out, `transform: ""`,
       `rotate: -1.8deg`, `translate: 1px 6px`, position unchanged throughout.

       The only thing at stake in that window is whether
       `.pass-wall > .pass:hover { rotate: 0deg }` can apply to that one stub,
       and it heals the first time the reader hovers it. It is deliberately NOT
       chased with a deferred second sweep: that would mean timing a write
       against motion-ux's private retry interval, which is precisely the kind
       of cross-file coupling the first four incidents came out of.

       ---- REDUCED MOTION ----
       Nothing here exists: this file returns before its first `gsap.set()`
       when the preference is set, so no plugin is registered, no proxy is
       built, no Draggable is created, and `html.stub-throw` — which every
       rule in motion.css §7 hangs off — is never added. For a mid-session
       flip, §10's unwind lands anything held, kills each Draggable
       (`disable()` is what removes the inline `touch-action`, `cursor` and
       `user-select` and unbinds every listener), removes the proxies and drops
       the flag.
       ============================================================ */
    var stubDrags = [];          // every Draggable instance created here
    var stubProxyHost = null;    // the one container the proxies live in

    /* "none" | "3px" | "2px 13px" -> [x, y], or null when the property has
       already been folded away into `transform` by a gsap write. */
    function parseTranslate(value) {
        if (!value || value === "none") return null;
        var parts = value.trim().split(/\s+/);
        var x = parseFloat(parts[0]);
        var y = parts.length > 1 ? parseFloat(parts[1]) : 0;
        if (isNaN(x) || isNaN(y)) return null;
        return [x, y];
    }

    /* ---- SWAP-ON-FLING state. See the header for the rule and the maths. ----

       ONE trade at a time, for the whole board. `stubSwapLock` is either null
       or `{ a, b, aIn, bIn, dx, dy }`: `a` is the stub that was thrown, `b` the
       one it landed on, the two `In` flags are the join — the commit runs when
       both halves have stopped moving — and `dx`/`dy` is the answer swapSnap
       gave, kept only so it can answer the same way twice. */
    var stubSwapLock = null;

    /* How much of a stub the landing box has to cover to count as "thrown onto
       it". A third: aiming at a card gives ~100%, the gutter between two gives
       ~46% each, the crossroads of four gives ~20%, empty board gives 0. */
    var SWAP_COVER = 1 / 3;

    function clampNum(v, lo, hi) {
        if (typeof lo === "number" && v < lo) return lo;
        if (typeof hi === "number" && v > hi) return hi;
        return v;
    }

    /* Area shared by two identical w*h boxes centred on c1 and c2. Boxes, not
       rects: the resting tilt inflates a rect, but it turns about the centre,
       so a box rebuilt around the measured centre is the true slot footprint. */
    function boxOverlap(c1, c2, w, h) {
        var ox = w - Math.abs(c1.x - c2.x);
        var oy = h - Math.abs(c1.y - c2.y);
        return ox > 0 && oy > 0 ? ox * oy : 0;
    }

    function stubCentre(el) {
        var r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    /* Forget a pending trade without moving anything. Used by the commit (which
       is about to do the reorder itself) and by the reduced-motion unwind. */
    function stubSwapDrop() {
        var lock = stubSwapLock;
        stubSwapLock = null;
        return lock;
    }

    /* Call the deal off. Everything except `keep` flies back to its OWN slot —
       no reorder happened yet, so 0,0 is still each stub's own slot and the
       existing home-and-land path is exactly right. `keep` is the pass the
       reader has just put their hand on; its own gesture takes it from here. */
    function stubSwapAbort(keep) {
        var lock = stubSwapDrop();
        if (!lock) return;
        [lock.a, lock.b].forEach(function (el) {
            if (el !== keep && el.__stubHome) el.__stubHome();
        });
    }

    function stubSwapInvolves(el) {
        return !!stubSwapLock && (stubSwapLock.a === el || stubSwapLock.b === el);
    }

    /* Half of a trade has stopped moving. Commit once both have. */
    function stubSwapArrive(el) {
        var lock = stubSwapLock;
        if (!lock) return;
        if (el === lock.a) lock.aIn = true;
        if (el === lock.b) lock.bIn = true;
        if (lock.aIn && lock.bIn) stubSwapCommit(lock);
    }

    /* THE COMMIT. One synchronous block, and a visual no-op — both stubs are
       already painted on their destinations, so all this does is make the DOM
       agree with the screen. See the header for the proof that no centre moves.

       Swapping exactly two nodes changes exactly two `:nth-child` indices, so
       nine of the eleven tilts are untouched. The three branches are the
       adjacency cases: `insertBefore(a, bn)` with `bn === a` would be a no-op
       and would silently leave the board unswapped. */
    function stubSwapCommit(lock) {
        stubSwapDrop();
        var a = lock.a, b = lock.b;
        var wall = a.parentNode;
        if (wall && b.parentNode === wall) {
            var an = a.nextSibling, bn = b.nextSibling;
            if (an === b) {
                wall.insertBefore(b, a);
            } else if (bn === a) {
                wall.insertBefore(a, b);
            } else {
                wall.insertBefore(a, bn);
                wall.insertBefore(b, an);
            }
        }
        /* land() first — it is what hands `translate` (and the folded `rotate`)
           back to the stylesheet, i.e. what makes each stub take its NEW slot's
           nudge and tilt. rebase() second, because it reads the value land()
           just uncovered. */
        if (a.__stubLand) a.__stubLand();
        if (b.__stubLand) b.__stubLand();
        if (a.__stubRebase) a.__stubRebase();
        if (b.__stubRebase) b.__stubRebase();
    }

    function stubProxy() {
        if (!stubProxyHost) {
            stubProxyHost = document.createElement("div");
            stubProxyHost.className = "stub-proxies";
            stubProxyHost.setAttribute("aria-hidden", "true");
            /* Inline, not in motion.css: this node only exists because this
               script ran, so its own styles travel with it and a stale
               stylesheet can never leave a stray box on the page. Zero-size
               and pointer-transparent, so it is not a tap target, not a
               reachable element and not part of any layout. */
            stubProxyHost.style.cssText =
                "position:fixed;top:0;left:0;width:0;height:0;" +
                "overflow:hidden;pointer-events:none;visibility:hidden";
            document.body.appendChild(stubProxyHost);
        }
        var p = document.createElement("div");
        p.style.cssText = "position:absolute;top:0;left:0;width:0;height:0";
        stubProxyHost.appendChild(p);
        return p;
    }

    function armStub(el) {
        if (!stubThrowReady() || el.__stubDrag) return;

        var wall = el.closest(".pass-wall");
        if (!wall) return;

        /* The resting nudge, read while it is still readable. armStub is called
           from finishOne(), one line after its `clearProps: "all"`, which is
           the moment the independent properties are guaranteed to be back on
           the element. It is re-read at each press when it is still there, so a
           breakpoint change is picked up; the cache only matters once a hover
           spring has folded it away. */
        var armedBase = parseTranslate(window.getComputedStyle(el).translate) || [0, 0];

        /* Nothing to do about the airline wordmark <img> starting a native
           HTML5 image drag, or about a drag selecting the card's text:
           Draggable's `enable()` nulls `ondragstart` / `onselectstart` and
           writes `user-select: none` on each trigger, and its `disable()` puts
           all three back. A copy here would be a second owner, and the CSS half
           of it is the half the unwind could not undo. */

        var proxy = stubProxy();
        var drag = null;         // the Draggable, once created (see below)
        var held = false;        // we own `translate` on this pass right now
        var moved = false;       // this pointer cycle produced a real drag
        var guard = null;        // backstop so `.gsap-busy` can never stick
        var base = armedBase;    // origin the mirrored offset is added to
        /* Where this pass's centre sits when its offset is zero, measured once
           per drag. The whole FLIP arithmetic is a difference of two of these —
           see the header. Null between gestures so a stale one can never be
           used: only a cycle that actually dragged sets it. */
        var restCentre = null;

        function clearGuard() {
            if (guard) { clearTimeout(guard); guard = null; }
        }

        /* The mirror. One property, one owner, no reads — so it cannot drift
           and there is nothing here for another writer to interleave with. */
        function paint(dx, dy) {
            el.style.translate = (base[0] + dx) + "px " + (base[1] + dy) + "px";
        }

        /* Paint zero offset and report the resulting centre. Must be called
           with the pass already seized: quiesce() has by then folded the
           independent `translate` away and zeroed GSAP's x/y, so the element is
           momentarily on its bare slot box and paint(0,0) puts the authored
           nudge back in OUR lane. That makes the reading exactly
           `centre(slotBox) + nudge` with no other contribution in it. */
        function centreAtZero() {
            paint(0, 0);
            return stubCentre(el);
        }

        /* Mirror the proxy onto the pass — and back onto the Draggable's own
           cached position. Draggable dispatches `onPressInit` BEFORE it re-reads
           the target (verified in the vendored source), and onPressInit is where
           the bounds below are computed off `this.x`, so any proxy movement this
           file drives itself has to keep that number honest. */
        function mirrorProxy() {
            var px = +gsap.getProperty(proxy, "x") || 0;
            var py = +gsap.getProperty(proxy, "y") || 0;
            if (drag) { drag.x = drag.endX = px; drag.y = drag.endY = py; }
            paint(px, py);
        }

        /* Take `translate`, and take motion-ux's hands off it. */
        function seize() {
            clearGuard();
            /* Read the origin ONLY on a fresh seize. Re-reading while we are
               already holding the pass would read our OWN mirrored value —
               `base + offset` — and fold the current offset into the origin,
               which doubles it on the next paint. Reachable two ways: catching a
               stub in mid-throw and dragging it on, and grabbing the passive
               half of a swap while it is sliding.
               If the sheet's value has already been folded into `transform` by a
               hover spring, the armed-time reading is the only correct one left. */
            if (!held) {
                base = parseTranslate(window.getComputedStyle(el).translate) || armedBase;
            }
            held = true;
            el.classList.add("gsap-busy", "is-stub-held");
            // Belt for motion-shim's non-spring path, which IS a gsap tween.
            gsap.killTweensOf(el);
            quiesce(el);
        }

        /* Take this pass over as the PASSIVE half of a trade: same seize, but it
           wears `is-stub-swapping` rather than `is-stub-held` (motion.css §7
           gives it a lower z-index and a lighter shadow — it is being moved, not
           carried). Returns its rest centre, which is the other half of the FLIP
           arithmetic, or null if it turns out not to be free after all. */
        function seizeForSwap() {
            if (held) return null;
            seize();
            el.classList.remove("is-stub-held");
            el.classList.add("is-stub-swapping");
            return centreAtZero();
        }

        /* Slide to a destination offset and hold there until the commit. One
           tween, on the proxy, mirrored — so this pass still has exactly one
           writer on `translate`. `onInterrupt` is the belt for Draggable killing
           this tween out from under us when the reader presses this pass
           (`onPressInit` has already aborted by then, so it is a no-op in the
           expected case and the only cover in an unexpected one). */
        function slideTo(dx, dy, dur) {
            gsap.to(proxy, {
                x: dx, y: dy,
                duration: dur,
                ease: "power3.inOut",
                overwrite: "auto",
                onUpdate: mirrorProxy,
                onComplete: function () { arrive(); },
                onInterrupt: function () { stubSwapAbort(el); }
            });
        }

        /* Re-read the slot's authored nudge into the armed-time cache. A swap
           moved this pass to a different `:nth-child`, so the cached value is
           the old slot's — and it is only ever consulted once a hover spring has
           folded the live one away, which is why a stale one would surface as a
           jump on some unrelated later grab. Safe to read here: the commit calls
           it one line after land() handed `translate` back to the stylesheet. */
        function rebase() {
            armedBase = parseTranslate(window.getComputedStyle(el).translate) || armedBase;
            base = armedBase;
        }
        el.__stubRebase = rebase;

        /* Give it back, in the one order that cannot strand anything: resync
           motion-shim's store, drop our inline `translate` so the stylesheet's
           value is the live one again, clear the inline transform GSAP left
           (which is also what restores the independent properties it folded
           away), drop the visual state, and only then unmute motion-ux. */
        function land() {
            clearGuard();
            if (!held) return;
            /* PUT THE PROXY BACK AT THE ORIGIN. Since the throw can now land on
               a slot other than this stub's own, the proxy no longer ends every
               gesture at 0,0 — and its x/y IS the coordinate origin the mirror
               and the bounds are both measured from. Zero it, and zero
               Draggable's own cached copy with it (onPressInit reads `this.x`
               before Draggable re-reads the target), or the next press on a
               swapped stub derives its limits from the last landing offset.
               A no-op on every path that already ended at 0,0. */
            gsap.killTweensOf(proxy);
            gsap.set(proxy, { x: 0, y: 0 });
            if (drag) { drag.x = drag.endX = 0; drag.y = drag.endY = 0; }
            quiesce(el);
            gsap.set(el, { clearProps: "all" });
            /* MEASURED NECESSARY, not belt and braces. Folding the independent
               properties into `transform` means GSAP also writes
               `rotate: none` / `translate: none` inline, and `clearProps: "all"`
               does NOT reliably take those back off — landed with
               `style.rotate === "none"` still set, which leaves
               `.pass-wall > .pass:hover { rotate: 0deg }` unable to apply
               because a stylesheet cannot beat an inline declaration. Removing
               the three by hand is what hands the tilt and the nudge back to
               layout.css, and it is exactly what motion-ux's own
               clearTransform() does for the same reason. Our drag `translate`
               goes out with them, which is the whole restoration: one property
               removed, stylesheet value live again. */
            el.style.removeProperty("translate");
            el.style.removeProperty("rotate");
            el.style.removeProperty("scale");
            el.classList.remove("is-stub-held", "is-stub-swapping");
            held = false;
            moved = false;
            restCentre = null;
            el.classList.remove("gsap-busy");
        }
        el.__stubLand = land;

        /* Catching a stub in mid-flight: a press kills the proxy's throw tween,
           so `onThrowComplete` never fires for it. Rather than snapping the
           stub home from wherever it froze, fly it the rest of the way — on the
           proxy, so the mirror stays the only writer on the pass.
           0,0 is still this stub's own slot on every path that reaches here: a
           trade is only ever committed with both halves already parked, so
           nothing that has been reordered can be in flight. */
        function homeAndLand() {
            gsap.to(proxy, {
                x: 0, y: 0, duration: 0.42, ease: "power3.out",
                overwrite: "auto",
                onUpdate: mirrorProxy,
                onComplete: land
            });
        }
        el.__stubHome = homeAndLand;

        /* This pass has stopped moving and is sitting where it is meant to end
           up. Half of a trade reports in and waits for the other half; anything
           else lands immediately, which is what every path did before. */
        function arrive() {
            if (stubSwapInvolves(el)) { stubSwapArrive(el); return; }
            land();
        }

        /* ---- THE SWAP DECISION ----
           InertiaPlugin calls this exactly once per throw while it builds the
           tween, with `point` = the UNCLAMPED natural landing offset the release
           velocity projects to, and `this` = the Draggable. It returns the offset
           the throw will actually land on, and it can only return two things:
           {0,0} (this stub's own slot — byte-for-byte the old behaviour) or the
           offset that parks this stub on the target's slot. Everything the trade
           needs is set up here, synchronously, so the decision and its
           consequences cannot come apart. See the header. */
        function swapSnap(point) {
            var home = { x: 0, y: 0 };
            /* `moved` excludes the catch-and-release case: Draggable also rebuilds
               a throw when a press interrupts one and is released without
               dragging, and re-deciding a trade off a near-zero velocity there
               would swap a stub the reader was only trying to stop. */
            if (!held || !moved || !restCentre) return home;
            if (stubSwapLock) {
                /* One trade at a time — with one exception, which is a belt
                   against InertiaPlugin evaluating this function twice for the
                   same throw. It does not (3.13.0 caches the resolved point via
                   `calculated` and writes the answer back over the `end` key, so
                   the second axis cannot re-enter), but if a future version did,
                   answering "home" the second time would send this stub back to
                   its own slot while the trade it had just set up carried on.
                   Re-answer identically instead. */
                if (stubSwapLock.a === el) {
                    return { x: stubSwapLock.dx, y: stubSwapLock.dy };
                }
                return home;
            }

            var w = el.offsetWidth, h = el.offsetHeight;
            var wall = el.parentNode;
            if (!w || !h || !wall) return home;

            /* Where the fling is AIMED. Clamped to this gesture's own limits
               because that is as far as the stub can physically travel. */
            var landing = {
                x: restCentre.x + clampNum(point.x, this.minX, this.maxX),
                y: restCentre.y + clampNum(point.y, this.minY, this.maxY)
            };

            /* Most-covered wins, and it has to clear SWAP_COVER. Seeding `best`
               with the threshold makes the two tests one comparison. */
            var target = null;
            var best = w * h * SWAP_COVER;
            var kids = wall.children;
            for (var i = 0; i < kids.length; i++) {
                var c = kids[i];
                if (c === el || !c.classList || !c.classList.contains("pass")) continue;
                /* Armed AND idle. `__stubDrag` means its own entrance tween has
                   finished (armStub is only reached from finishOne), `.gsap-busy`
                   means somebody is writing to it right now. Either way it is not
                   ours to move. */
                if (!c.__stubDrag || c.classList.contains("gsap-busy")) continue;
                var cover = boxOverlap(landing, stubCentre(c), w, h);
                if (cover > best) { best = cover; target = c; }
            }
            if (!target) return home;
            if (!target.__stubSeizeSwap) return home;

            var tc = target.__stubSeizeSwap();
            if (!tc) return home;
            var dx = tc.x - restCentre.x;
            var dy = tc.y - restCentre.y;

            /* Reachability. InertiaPlugin clamps whatever comes back here to this
               gesture's own max/min, so an offset outside them would stop the
               card BETWEEN slots. That is the one thing this must never do, and
               the case it catches is a target scrolled mostly off screen. Give
               the stub straight back and throw normally. */
            if (dx < this.minX || dx > this.maxX || dy < this.minY || dy > this.maxY) {
                if (target.__stubHome) target.__stubHome();
                return home;
            }

            stubSwapLock = { a: el, b: target, aIn: false, bIn: false,
                             dx: dx, dy: dy };
            /* The target vacates while the thrown stub is still in the air. Its
               own tween, its own proxy, its own paint — the two halves never
               share a writer, and the commit waits for whichever finishes last.

               Duration from the DISTANCE, deliberately not from the throw's.
               `this.tween` is NOT usable here: this function runs from inside
               InertiaPlugin's init, i.e. during the `gsap.to()` call that creates
               the throw, so Draggable has not assigned it yet (it does so on the
               line after) and the property still holds null from the press. A
               distance ramp also reads better than copying the throw: the target
               is not being thrown, it is getting out of the way, and one slot
               over should not take as long as the length of the board. */
            var dist = Math.sqrt(dx * dx + dy * dy);
            target.__stubSlide(-dx, -dy, clampNum(0.30 + dist / 1600, 0.42, 0.78));
            return { x: dx, y: dy };
        }
        el.__stubSeizeSwap = seizeForSwap;
        el.__stubSlide = slideTo;

        var d = window.Draggable.create(proxy, {
            /* The pass is what you press; the proxy is what moves. */
            trigger: el,
            type: "x,y",
            inertia: true,
            /* THE THROW. `snap` is applied to the LANDING value, so
               InertiaPlugin still builds its tween from the real release
               velocity and merely redirects the destination — the stub flies
               out, decelerates and curves into a slot as ONE tween. One tween is
               also one owner: there is no second "and now go there" stage for an
               interruption to strand half-done, and swapSnap can only return a
               SLOT (its own, or the target's), which is what makes "a thrown
               stub always ends up in a slot" a property of the physics rather
               than of cleanup code.

               `points`, not `x`/`y`: the swap decision is two-dimensional and
               cannot be made one axis at a time. Draggable's function form of
               `snap.points` sets InertiaPlugin's `linkedProps`, which hands the
               function BOTH natural landing values in one point object and calls
               it exactly once. Verified in the vendored 3.13.0 — see the header.
               With no target found it returns {0,0}, which is the old
               `zeroSnap` behaviour unchanged. */
            snap: { points: swapSnap },
            minDuration: 0.45,
            maxDuration: 1.05,
            /* NO `bounds` HERE ON PURPOSE — see onPressInit. Anything static
               would be wrong by the next resize, and a placeholder of zeros
               would be actively harmful: Draggable clamps against the bounds it
               already has while it records the press. */
            /* 1 = a hard stop at the bound, no rubber-band. Measured at the
               default-ish 0.72: edge resistance lets the stub travel PAST the
               bound in proportion to how hard you push, which put +20px of
               scrollable overflow on the document — the bound stops being a
               guarantee. The bound is already 40px outside the wall, so a hard
               stop reads as "the board has edges" rather than as a snag. */
            edgeResistance: 1,
            minimumMovement: 5,
            cursor: "grab",
            activeCursor: "grabbing",
            allowContextMenu: true,

            /* Bounds, measured fresh, in the one hook that runs BEFORE
               Draggable records the starting position and clamps against it.
               Passing `wall` as an element would be wrong twice over: the
               proxy is not in the wall, and the resting `translate` already
               carries some stubs up to 16px past the wall's own box, which
               Draggable would read as "already at the limit". Working in
               minX/maxX/minY/maxY — limits on the proxy's own x/y, which IS the
               offset we mirror — off the pass's real rendered rect sidesteps
               both: `s` already contains the tilt, the nudge and any offset
               currently applied, so the arithmetic needs to know about none of
               them. */
            onPressInit: function () {
                moved = false;
                restCentre = null;
                clearGuard();
                /* A hand on either half of a pending trade calls it off, and it
                   has to happen BEFORE applyBounds: new bounds can re-clamp an
                   in-flight throw, which makes Draggable rebuild it and run
                   swapSnap again. With the lock already dropped that rebuild
                   returns "home", which is what an abort wants anyway. */
                if (stubSwapInvolves(el)) stubSwapAbort(el);
                var w = wall.getBoundingClientRect();
                var s = el.getBoundingClientRect();
                var pad = 40;
                /* Intersected with the visible viewport, inset a little. The
                   wall alone is not a safe bound: `translate` still counts
                   toward scrollable overflow, so a stub allowed past the
                   viewport edge grows scrollWidth and pops a horizontal
                   scrollbar mid-drag — measured at +20px with a bare wall
                   bound — and past the bottom it grows scrollHeight, which
                   moves the scrollbar under the reader's hand. Clamping to
                   what is on screen makes both impossible, and "the visible
                   part of the board" is the area a mouse can reach anyway. */
                var doc = document.documentElement;
                var inset = 10;
                var lo = Math.max(w.left - pad, inset);
                var hi = Math.min(w.right + pad, doc.clientWidth - inset);
                var to = Math.max(w.top - pad, inset);
                var bo = Math.min(w.bottom + pad, doc.clientHeight - inset);
                this.applyBounds({
                    minX: this.x - Math.max(s.left - lo, 0),
                    maxX: this.x + Math.max(hi - s.right, 0),
                    minY: this.y - Math.max(s.top - to, 0),
                    maxY: this.y + Math.max(bo - s.bottom, 0)
                });
            },

            onDragStart: function () {
                moved = true;
                seize();
                /* Measure the rest centre once, here, while this pass is
                   provably at zero offset with no other writer on it. Every
                   swap's arithmetic is a difference of two of these. */
                restCentre = centreAtZero();
                paint(this.x, this.y);
            },
            onDrag: function () { paint(this.x, this.y); },
            onThrowUpdate: function () { paint(this.x, this.y); },

            onRelease: function () {
                if (!held) return;
                if (!moved) {
                    // Caught it mid-flight: catching a card cancels its trade.
                    stubSwapAbort(el);
                    homeAndLand();
                    return;
                }
                /* The throw tween is created around now. Check on the next
                   frame rather than trusting callback order: a drag that ends
                   exactly on the landing value has nothing to snap to and makes
                   no tween, and waiting on an onThrowComplete that never comes
                   would leave this pass hover-deaf for good.
                   arrive(), not land(): if swapSnap set up a trade this pass has
                   to report to the join instead of landing on its own. */
                var self = this;
                /* Hard backstop. It also has to call the trade off — landing one
                   half without the reorder would leave the other half holding an
                   inline `translate` for the rest of the visit. */
                guard = setTimeout(function () {
                    stubSwapAbort(el);
                    land();
                }, 2200);
                window.requestAnimationFrame(function () {
                    if (!self.isThrowing) arrive();
                });
            },

            onThrowComplete: function () { arrive(); }
        })[0];

        drag = d;
        el.__stubDrag = d;
        stubDrags.push(d);
    }

    /* Stop motion-shim's in-flight springs on the pass and put GSAP's own x/y
       at zero, in one synchronous call. `duration: 0` is the shim's documented
       "be there now" path — it cancels the spring for each property before
       writing, which a gsap kill cannot do because these springs are ticker
       callbacks rather than tweens. x/y have to be zeroed because GSAP folded
       the resting `translate` into them and the mirror is about to apply that
       same nudge itself. `rotate` is NOT in the list: GSAP folded the resting
       TILT into it, and zeroing that flattens the stub for good. The gsap.set
       fallback is for the build where motion-shim never loaded — then no spring
       exists and the write is all that is needed. */
    function quiesce(el) {
        var M = window.Motion;
        var vals = { x: 0, y: 0, scale: 1, rotateX: 0, rotateY: 0 };
        if (M && typeof M.animate === "function") {
            M.animate(el, vals, { duration: 0 });
        } else {
            gsap.set(el, { x: 0, y: 0, scale: 1, rotationX: 0, rotationY: 0 });
        }
    }

    /* One gate, answered once, eagerly. Registering the plugins at init rather
       than on the first entrance means a version mismatch surfaces as a console
       error at load, where tools/gate_dir.py is looking. */
    var stubGate = null;
    function stubThrowReady() {
        if (stubGate !== null) return stubGate;
        stubGate = false;

        var Drag = window.Draggable;
        var Inertia = window.InertiaPlugin;
        if (typeof Drag !== "function" || !Inertia) return stubGate;

        /* No touch input AT ALL. `(pointer: fine)` is not sufficient: a
           touchscreen laptop satisfies it and would still hand eleven big cards
           an inline `touch-action: none`. See the section header. */
        var mm = window.matchMedia;
        if (typeof mm !== "function") return stubGate;
        if (!mm("(hover: hover) and (pointer: fine)").matches) return stubGate;
        if (mm("(any-pointer: coarse)").matches) return stubGate;
        if ((navigator.maxTouchPoints | 0) > 0) return stubGate;

        gsap.registerPlugin(Inertia, Drag);
        document.documentElement.classList.add("stub-throw");
        stubGate = true;
        return stubGate;
    }
    if (passes.length) stubThrowReady();

    /* §10 unwind. `disable()` (inside kill()) is the part a stylesheet cannot
       do: it removes the inline `touch-action`, `cursor` and `user-select`
       Draggable wrote on each trigger and unbinds every listener. Landing first
       means §10's own `clearProps` on `.pass.gsap-reveal` lands on a pass whose
       shim store already reads zero and whose `translate` is the stylesheet's
       again. */
    unwindHooks.push(function () {
        /* Drop any pending trade WITHOUT committing it and without flying
           anything home. stubSwapAbort() would start two tweens, and the reader
           has just asked for less motion; the land() sweep below puts both
           halves back on their own slots in one frame instead. No reorder means
           the board is left in its authored order, which is the correct resting
           state for a preference flip. */
        stubSwapDrop();
        toArray(".pass").forEach(function (el) {
            if (el.__stubLand) el.__stubLand();
        });
        stubDrags.forEach(function (d) {
            try { d.kill(); } catch (err) { /* already dead */ }
        });
        stubDrags.length = 0;
        if (stubProxyHost && stubProxyHost.parentNode) {
            stubProxyHost.parentNode.removeChild(stubProxyHost);
        }
        stubProxyHost = null;
        document.documentElement.classList.remove("stub-throw");
    });
    /* ---- Case-study prose: staggered within its own block ----
       These are the 2x2 .case-block grid on projects.html. Batching by
       proximity is right here (they genuinely enter in clusters), but the
       easing was a flat power2.out on both axes. Splitting the tween so
       opacity uses a linear-ish fade while `y` carries the expressive
       ease is what makes a rise read as "settling" rather than "sliding":
       the element is fully opaque before it stops moving, so the eye
       tracks the type, not the fade. */
    if (hasST && prose.length) {
        gsap.set(prose, { opacity: 0, y: 26 });
        ScrollTrigger.batch(prose, {
            interval: 0.1,
            batchMax: 3,
            start: "top 86%",
            once: true,
            onEnter: function (batch) {
                gsap.timeline({
                    onStart: function () { begin(batch); },
                    onComplete: function () { finish(batch); }
                })
                    .to(batch, {
                        y: 0,
                        duration: 0.95,
                        ease: "expo.out",
                        stagger: 0.1
                    }, 0)
                    .to(batch, {
                        opacity: 1,
                        duration: 0.45,
                        ease: "power1.out",
                        stagger: 0.1
                    }, 0);
            }
        });
    } else if (prose.length) {
        finish(prose);
    }

    /* ============================================================
       7b. Anti-stranding watchdog
       Sections 7 hides elements with gsap.set() and relies on a
       ScrollTrigger to bring them back. That is a from-an-invisible-start
       pattern, i.e. exactly the shape of the old bug where content was
       left stranded at opacity 0. The trigger firing is an assumption,
       and assumptions about layout are what broke it before: a mis-measured
       start (fonts, a zero-height image, a container that was display:none
       at measure time) means the tween never runs and the copy is simply
       gone.

       So we verify instead of assuming. Any element that GSAP hid and that
       the reader has already reached — on screen, or ALREADY SCROLLED PAST —
       gets snapped to its final state. A no-op in the normal case; the
       difference between "a subtle bug" and "unreadable content" in the
       abnormal one.

       TWO CHANGES THIS PASS, both because the page now pins:

       1. `r.bottom <= 0` (scrolled past) is rescued as well as on-screen.
          Previously an element that was hidden and then jumped over — a
          fragment link, a restored scroll position, a fast flick through a
          pin — stayed hidden forever, because it was never "on screen"
          during a sweep. Something behind the reader is unambiguously
          overdue: there is no legitimate reason for it to still be at
          opacity 0. Only what is still BELOW the fold is left alone,
          because that is genuinely awaiting its trigger.
       2. The scroll listener is no longer `once`. A single sweep on the
          first scroll event cannot cover a pinned page, where the interesting
          failures happen hundreds of pixels later. It self-removes instead
          as soon as the guarded set is clean, so the steady state is still
          zero listeners and zero work.
       ============================================================ */
    if (hasST) {
        var guarded = passes.concat(prose);
        if (guarded.length) {
            /* NOT named `pending`: section 9 declares a `pending` of its own
               and every `var` in this file shares one function scope, so the
               image counter there would silently overwrite this array (and
               `overdue.splice` would throw on a number). */
            var overdue = guarded.slice();
            var scrollBound = false;
            var scheduled = false;

            var sweep = function () {
                for (var i = overdue.length - 1; i >= 0; i--) {
                    var el = overdue[i];
                    if (parseFloat(gsap.getProperty(el, "opacity")) >= 0.99) {
                        overdue.splice(i, 1);
                        continue;
                    }
                    var r = el.getBoundingClientRect();
                    var reached = r.top < window.innerHeight;   // on screen or above it
                    if (!reached) continue;                     // still below the fold: not due yet
                    gsap.killTweensOf(el);
                    finish([el]);
                    overdue.splice(i, 1);
                }
                if (!overdue.length && scrollBound) {
                    window.removeEventListener("scroll", onScroll);
                    scrollBound = false;
                }
            };

            // rAF-coalesced: a sweep is a handful of rect reads, but it must
            // not run twice in one frame during a thrash-scroll.
            var onScroll = function () {
                if (scheduled) return;
                scheduled = true;
                requestAnimationFrame(function () { scheduled = false; sweep(); });
            };

            // After load, after fonts, and once more late for slow decodes.
            window.addEventListener("load", function () { setTimeout(sweep, 600); });
            setTimeout(sweep, 2500);
            window.addEventListener("scroll", onScroll, { passive: true });
            scrollBound = true;
        }
    }

    /* ============================================================
       9. Measurement hygiene  —  NOW LOAD-BEARING, NOT HOUSEKEEPING
       Every scrubbed/sticky trigger above was measured against the page
       as it existed at parse time. Three things then change it:
         - webfonts swap (Space Grotesk/Inter/DM Mono + the travel page's
           airline display faces) and every text block re-measures;
         - the 11 airline logos decode and the pass wall's real geometry
           (which the grid stagger AND the strip's travel distance read)
           finally exists;
         - the hero canvas sizes itself.

       This section was already needed for the rails. Now that two sections
       PIN, it is the thing that makes their height deterministic. A pin's
       `end` is resolved to a pixel scroll position, and both pins here
       derive theirs from a measurement: the hero from `innerHeight`, the
       filmstrip from `.pass-wall`'s laid-out width. Measure the strip
       before the airline logos decode and the pin is too short — the strip
       stops with cards still off-screen and the last third of the wall is
       simply unreachable. Both triggers carry `invalidateOnRefresh`, so
       every refresh below re-runs the functions that compute those ends.

       This is why the refresh set is fonts + per-image + load + orientation
       rather than a single `load` handler.
       ============================================================ */
    if (hasST) {
        var refresh = function () { ScrollTrigger.refresh(); };

        window.addEventListener("load", refresh);
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(refresh);
        }

        /* Images specifically: `load` fires once for the document, but a
           lazily-decoded logo can land after it. Refresh per image, but
           coalesce — 11 passes would otherwise mean 11 full recalcs. */
        var imgs = toArray(document.images).filter(function (img) { return !img.complete; });
        if (imgs.length) {
            var pending = imgs.length;
            var coalesced = null;
            var onImg = function () {
                pending--;
                if (coalesced) clearTimeout(coalesced);
                // Refresh once the burst settles, and once more at the end.
                coalesced = setTimeout(refresh, pending > 0 ? 120 : 0);
            };
            imgs.forEach(function (img) {
                img.addEventListener("load", onImg, { once: true });
                img.addEventListener("error", onImg, { once: true });
            });
        }

        /* Orientation/soft-keyboard resizes change the sticky offsets the
           case rails depend on. ScrollTrigger handles width resizes itself;
           this covers the late-settling case. */
        window.addEventListener("orientationchange", function () {
            setTimeout(refresh, 250);
        });
    }

    /* ============================================================
       8. Masked line-rise on the display type  (SplitText)
       .section-title / .case-title / .subhead / .case-tagline rise
       line-by-line out of an overflow-clipped mask. Line-rise rather
       than a per-character cascade on purpose: at 90px, characters
       read as confetti, whereas whole lines climbing out of the
       measure reads like a masthead settling. No opacity is tweened —
       the mask does all the work, so a line can never be left
       stranded at opacity 0.

       OWNERSHIP. Every .section-title and .subhead in the markup ships
       with `.reveal .reveal-clip`, and .case-title/.case-tagline live
       inside a `.case-head.reveal`. Two systems on one node is the bug
       we are avoiding, so this block STRIPS the conflicting classes at
       init — synchronously, before script.js runs and queries
       `.reveal`. anime.js therefore never sees these nodes and the CSS
       clip-wipe never arms. Stripping (rather than excluding) is the
       safe direction: losing `.reveal` means losing `opacity: 0`, so a
       claimed element's resting state is *visible*. The classes are
       only stripped once we know SplitText is actually here, so a 404
       on the plugin leaves the markup untouched and anime.js reveals
       everything exactly as before.

       The split is created at trigger time and REVERTED on complete,
       so: no wrappers exist before the reveal, none after it, the
       original innerHTML (and `text-wrap: balance`) comes back, and
       text selection is only unusual for the ~1s the line is moving.
       SplitText's default `aria: "auto"` puts an aria-label on the
       element and aria-hidden on the wrappers for that window, so the
       accessible name never fragments; revert() restores both.
       ============================================================ */
    var SplitText = window.SplitText;
    if (hasST && SplitText) {
        gsap.registerPlugin(SplitText);

        // yPercent overshoot must clear the mask's overflow-clip-margin
        // (see .sr-line-mask in styles.css) or the line peeks below the
        // clip edge in its from-state. The tightest case is
        // .section-title at line-height 1.0: 135% of a 1em line box vs a
        // clip edge 0.18em past it, so ~0.17em of headroom.
        var RISE = 135;

        var recipes = [
            { sel: ".section-title", dur: 1.00, stag: 0.12, ease: "power3.out", start: "top 86%", delay: 0 },
            { sel: ".case-title",    dur: 0.90, stag: 0.10, ease: "power3.out", start: "top 88%", delay: 0 },
            { sel: ".subhead",       dur: 0.75, stag: 0.08, ease: "power3.out", start: "top 90%", delay: 0 },
            { sel: ".case-tagline",  dur: 0.70, stag: 0.06, ease: "power2.out", start: "top 90%", delay: 0.12 }
        ];

        var claims = [];
        recipes.forEach(function (r) {
            toArray(r.sel).forEach(function (el) {
                if (el.__srClaimed) return;          // one owner per node
                el.__srClaimed = true;
                el.classList.remove("reveal", "reveal-clip", "is-visible");
                claims.push({ el: el, r: r });
            });
        });

        /* The case-study head is a single .reveal wrapping the index,
           the title and the tagline. Now that we own two of its three
           children, hand the whole block over: anime.js fading the
           parent to opacity 0 would swallow our line rise, and its
           translateY would drag the lines mid-tween. */
        claims.forEach(function (c) {
            var head = c.el.closest(".case-head");
            if (!head || head.__srHead) return;
            head.__srHead = true;
            head.classList.remove("reveal", "reveal-clip", "is-visible");
        });

        /* Hold the claimed headings at opacity 0 until their split is
           built. Without this, stripping `.reveal` leaves them painted
           in plain text from first paint, and the reveal then reads as a
           flash followed by the lines dropping to their from-state and
           climbing back — worse than no animation.

           This is the one dangerous moment in the file: these nodes are
           now invisible and only JS can bring them back. Three
           independent belts guarantee it, in order of preference:
             1. play() clears opacity on the way in — including its
                catch path, so a SplitText throw still reveals.
             2. `once`/`arm()` is capped by a timer, so a font request
                that never settles cannot prevent arming.
             3. reveal() below force-clears anything still hidden after
                4s regardless of scroll position or trigger state.
           Belt 3 is what makes stranding impossible: worst case the
           text appears with no animation, which is the correct failure
           direction. */
        var hidden = [];
        var liveSplits = [];
        claims.forEach(function (c) {
            hidden.push(c.el);
            var head = c.el.closest(".case-head");
            var idx = head && c.el.classList.contains("case-title")
                ? head.querySelector(".case-index")
                : null;
            if (idx) { c.idx = idx; hidden.push(idx); }
        });
        gsap.set(hidden, { opacity: 0 });

        function reveal(el) {
            gsap.set(el, { clearProps: "opacity" });
            var i = hidden.indexOf(el);
            if (i > -1) hidden.splice(i, 1);
        }

        function play(claim) {
            var el = claim.el, r = claim.r;
            var split;
            try {
                split = new SplitText(el, {
                    type: "lines",
                    mask: "lines",         // wraps each line in an overflow-clipped div
                    // SINGLE TOKEN, no hyphen, on purpose. SplitText derives
                    // the mask's class by suffixing every \b\w+\b of this
                    // string with "-mask", so a hyphenated "sr-line" would
                    // yield "sr-mask-line-mask" — which silently matched no
                    // CSS rule and left the clip margin at 0, shaving the
                    // descenders off every line mid-tween. "srline" yields
                    // exactly "srline-mask".
                    linesClass: "srline",
                    tag: "div"
                });
            } catch (err) {
                reveal(el);                 // belt 1: never leave it hidden
                if (claim.idx) reveal(claim.idx);
                return;
            }

            var lines = split.lines;
            if (!lines.length) {
                split.revert();
                reveal(el);
                if (claim.idx) reveal(claim.idx);
                return;
            }

            /* Track the split for as long as its wrappers are in the DOM, so
               the §10 unwind can revert() them. Without this, a preference flip
               landing mid-tween leaves the mask divs behind permanently: the
               text still READS correctly (styles.css forces `.srline-mask` to
               `overflow: visible`, and SplitText's aria-label survives), but
               `text-wrap: balance` and text selection stay broken for the rest
               of the visit. */
            liveSplits.push(split);
            var untrack = function () {
                var i = liveSplits.indexOf(split);
                if (i > -1) liveSplits.splice(i, 1);
            };

            // Lines start below the mask, so the element itself is safe
            // to show the instant the wrappers exist.
            reveal(el);

            var tl = gsap.timeline({
                onComplete: function () {
                    // Put the DOM back the way we found it. clearProps
                    // first so no inline transform survives the revert.
                    gsap.set(lines, { clearProps: "all" });
                    split.revert();
                    untrack();
                }
            });
            tl.from(lines, {
                yPercent: RISE,
                duration: r.dur,
                ease: r.ease,
                stagger: r.stag
            }, r.delay);

            // The case index rides along with its title.
            if (claim.idx) {
                reveal(claim.idx);
                tl.from(claim.idx, {
                    opacity: 0, y: 14, duration: 0.6, ease: "power2.out",
                    onComplete: function () { gsap.set(claim.idx, { clearProps: "all" }); }
                }, 0);
            }
        }

        function arm() {
            claims.forEach(function (claim) {
                ScrollTrigger.create({
                    trigger: claim.el,
                    start: claim.r.start,
                    once: true,
                    onEnter: function () { play(claim); }
                });
            });
            ScrollTrigger.refresh();
        }

        /* Line breaks must be measured against the real webfont. Split
           before Space Grotesk swaps in and the masks are cut to the
           fallback's metrics. Wait for fonts, but never longer than
           1.2s — a stalled font request must not mean no reveal. */
        var armed = false;
        var once = function () { if (!armed) { armed = true; arm(); } };
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(once);
            setTimeout(once, 1200);
        } else {
            once();
        }

        // Belt 3 — the unconditional safety net described above.
        setTimeout(function () {
            hidden.slice().forEach(reveal);
        }, 4000);

        /* Belt 4 — the reduced-motion unwind (§10). `hidden` is the ONE set on
           the page held invisible by an inline opacity with no CSS belt behind
           it: §8 strips `.reveal` off these headings, so
           `.reveal { opacity: 1 !important }` no longer matches them and there
           is no `.section-title { opacity: 1 }` rule to fall back on. Belt 3
           would still get there, but making a reader who has just asked for
           less motion wait up to four seconds for the headings is the wrong
           answer. */
        unwindHooks.push(function () {
            hidden.slice().forEach(reveal);
            liveSplits.slice().forEach(function (s) {
                try { s.revert(); } catch (err) { /* already reverted */ }
            });
            liveSplits.length = 0;
        });
    }

    /* ============================================================
       10. Runtime reduced-motion unwind

       Everything above is gated on the ONE read of the media query at the top
       of this file, which is correct for a reader who arrives with the
       preference set — nothing is ever built. It is not enough for a reader who
       turns it on while looking at the page, and three of the states here
       cannot be undone from a stylesheet at all:

         THE PIN. `#home` is held still with `position: fixed` plus an injected
           pin-spacer. No `transform: none !important` unpins it. A section that
           refuses to scroll is the single most disorienting thing on the page
           and it would have survived the flip untouched.
         `repeat: -1` TWEENS. The `.shape-drift` ambient drift (§2) and the
           `.flight-dot` arc (§3) run forever. scroll.css can neutralise the
           first (it writes `transform`), but the second animates the `cx`/`cy`
           ATTRIBUTES of an SVG circle — there is no property for CSS to
           override, so only stopping the tween stops the motion.
         INLINE `opacity: 0`. §8's claimed headings — see belt 4 above.

       ORDER, and why each step is where it is:
         1. Kill every ScrollTrigger with revert=true. `kill(true)` is what
            removes the pin-spacer and puts the section back in the flow;
            `kill()` alone leaves the spacer behind and the document 765px too
            tall.
         2. Kill the tweens, including the endless ones. `globalTimeline.clear()`
            catches every tween this file created without needing a registry.
         3. Run the hooks, so anything held invisible is shown.
         4. Clear the inline props GSAP wrote on the nodes it owns. Deliberately
            an explicit list rather than `killTweensOf("*")` + a blanket
            clearProps: this file is not the only writer on the page, and
            wiping inline styles it does not own is how one system's cleanup
            becomes another's stranding bug.
         5. Drop `html.gsap-on` LAST. It is the flag every gated layout rule in
            scroll.css hangs off, so dropping it first would re-lay-out the
            hero while the pin was still in place.

       scroll.css's `@media (prefers-reduced-motion: reduce)` block stays as the
       belt behind this: if this handler never runs (an old engine with no
       `addEventListener` on MediaQueryList) the CSS still lands every plane in
       its static position. Neither is a substitute for the other — the CSS
       cannot unpin, and JS that throws leaves nothing.
       ============================================================ */
    function unwindGsap() {
        if (hasST) {
            ScrollTrigger.getAll().forEach(function (t) {
                try { t.kill(true); } catch (err) { /* already dead */ }
            });
        }
        try { gsap.globalTimeline.clear(); } catch (err) { /* nothing running */ }

        unwindHooks.forEach(function (fn) {
            try { fn(); } catch (err) { /* a hook must not block the rest */ }
        });

        /* The nodes this file writes inline transforms to, and nothing else.
           `.brand-ltr` is included because the wordmark spring (§1) is the one
           hover effect here that is not scroll-linked, so a flip mid-hover
           would otherwise leave the letters lifted. */
        var owned = ".shape-plx, .shape-drift, .hero-fg-plx, .motif-parallax," +
                    " .glow-sage, .glow-olive, .section-head, .home-inner," +
                    " .hero-name, .hero-lower, .hero-canvas-wrap, .trip-mark," +
                    " .timeline-rail, .case-rail-fill, .case-rail-head," +
                    " .brand-ltr, .brand-rule, .brand-dot," +
                    " .shape-line, .shape-ring, .shape-tick, .shape-dot," +
                    " .pass.gsap-reveal, .gsap-reveal, .srline";
        try {
            gsap.set(toArray(owned), { clearProps: "all" });
        } catch (err) { /* selector matched nothing on this page */ }

        // The injected foreground plane only ever existed to be parallaxed.
        toArray(".hero-fg").forEach(function (el) {
            if (el.parentNode) el.parentNode.removeChild(el);
        });

        document.documentElement.style.removeProperty("--contour");
        document.documentElement.classList.remove("gsap-on");
    }

    if (typeof reduceQuery.addEventListener === "function") {
        reduceQuery.addEventListener("change", function (e) {
            if (e.matches) unwindGsap();
        });
    }

    /* Late webfont/image loads shift layout; recalc so triggers that
       were measured against the pre-layout page still fire correctly. */

})();
