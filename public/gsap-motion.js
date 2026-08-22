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
                if (heroCanvas) {
                    tl.fromTo(heroCanvas,
                        { y: 0, scale: 1 },
                        { y: vh(0.06), scale: 1.12, transformOrigin: "50% 42%" }, 0);
                }
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
    function begin(els) {
        els.forEach(function (el) {
            el.classList.add("gsap-busy", "is-visible");
        });
    }
    function finish(els) {
        els.forEach(function (el) {
            el.classList.add("is-visible");
            el.classList.remove("gsap-busy");
        });
        gsap.set(els, { clearProps: "all" });
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
        gsap.to(passes, {
            opacity: 1, y: 0, scale: 1, rotateX: 0,
            duration: 0.9,
            // Gentle overshoot: a boarding pass settling onto the wall.
            // Kept under 1.2 so it reads as a settle, not a bounce.
            ease: "back.out(1.1)",
            stagger: {
                each: 0.075,
                grid: "auto",
                from: "start",
                ease: "power1.inOut"
            },
            scrollTrigger: {
                trigger: wall,
                start: "top 78%",
                once: true,
                // The airline logos are images; a late decode changes the
                // grid's measured geometry the stagger depends on.
                invalidateOnRefresh: true
            },
            onStart: function () { begin(passes); },
            onComplete: function () { finish(passes); }
        });
    } else if (passes.length) {
        // No ScrollTrigger for some reason — show them, don't hide them.
        finish(passes);
    }

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
