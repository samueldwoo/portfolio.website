/* ============================================================
   Samuel Woo — GSAP motion layer  (gsap-motion.js)

   This file is ADDITIVE to script.js / anime.js. The two libraries
   are kept strictly separated so they can never fight over a node:

     anime.js  owns : hero letter stagger, .hero-motif/.projects-motif
                      line-draw (the .motif-draw paths), .kicker-num
                      count-ups, and every .reveal EXCEPT .gsap-reveal.
     CSS       owns : .reveal-clip clip-wipe, all :hover states.
     GSAP (here) owns: the brand waving-hand, the decorative
                      .shape-field line-art layer, hero/glow parallax,
                      the timeline + case-study progress rails, chip
                      staggers, and every element tagged .gsap-reveal.

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

    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var gsap = window.gsap;

    // Hard stop before any gsap.set(): a bail-out here must leave the DOM
    // exactly as the CSS painted it (all content visible).
    if (!gsap || reduceMotion) return;

    var ScrollTrigger = window.ScrollTrigger;
    var hasST = !!ScrollTrigger;
    if (hasST) gsap.registerPlugin(ScrollTrigger);

    // Tell script.js it is safe to hand .gsap-reveal elements over to us.
    document.documentElement.classList.add("gsap-on");

    var toArray = gsap.utils.toArray;
    var rand = gsap.utils.random;

    /* ============================================================
       1. Brand mark — waving hand
       Replaces the old CSS @keyframes hand-wave. The point of doing it
       in GSAP is physicality: the fingers splay open in a stagger with
       an elastic overshoot *before* the wrist starts rocking, so it
       reads as a hand opening into a wave instead of an icon rotating.
       One paused timeline is built per brand and restarted on hover /
       focus, so repeated hovers never stack tweens.
       ============================================================ */
    toArray(".brand").forEach(function (brand) {
        var hand = brand.querySelector(".brand-wave");
        if (!hand) return;
        var fingers = toArray(hand.querySelectorAll("path"));
        var dot = brand.querySelector(".brand-dot");

        // Palm/pinky path is the last one and carries the wrist, so it
        // gets a smaller travel than the three free fingers.
        var travel = fingers.map(function (_, i) { return i === fingers.length - 1 ? -0.5 : -1.5; });

        var tl = gsap.timeline({
            paused: true,
            defaults: { transformOrigin: "50% 100%" },
            onComplete: function () {
                // Drop inline transforms so the icon returns to a pristine
                // CSS resting state (and hover transitions stay CSS-driven).
                gsap.set(fingers, { clearProps: "all" });
                gsap.set(hand, { clearProps: "all" });
                if (dot) gsap.set(dot, { clearProps: "all" });
            }
        });

        tl.to(fingers, {
            y: function (i) { return travel[i]; },
            rotation: function (i) { return (i - 1.5) * 3; },
            duration: 0.42,
            ease: "elastic.out(1, 0.42)",
            stagger: 0.045
        }, 0)
          .to(hand, {
              keyframes: {
                  rotation: [0, 17, -9, 13, -4, 0],
                  easeEach: "sine.inOut"
              },
              duration: 0.62,
              transformOrigin: "70% 85%"
          }, 0.1)
          .to(fingers, {
              y: 0,
              rotation: 0,
              duration: 0.34,
              ease: "power2.inOut",
              stagger: 0.03
          }, 0.5);

        if (dot) {
            tl.to(dot, { scale: 1.7, duration: 0.16, ease: "power2.out", transformOrigin: "50% 85%" }, 0.06)
              .to(dot, { scale: 1, duration: 0.42, ease: "elastic.out(1, 0.4)" }, 0.22);
        }

        var replay = function () { tl.restart(); };
        brand.addEventListener("mouseenter", replay);
        brand.addEventListener("focus", replay);
    });

    /* ============================================================
       2. Decorative line-art shape fields
       Same visual language as the existing .motif-draw signature:
       sage strokes that draw themselves in. Each field draws once on
       enter, then drifts forever on an inner <g> (drifting the <g> in
       SVG user units means we never collide with the CSS transform
       used to position the field itself).
       ============================================================ */
    toArray(".shape-field").forEach(function (field, fi) {
        var strokes = toArray(field.querySelectorAll(".shape-line, .shape-ring"));
        var dots = toArray(field.querySelectorAll(".shape-dot"));
        var ticks = toArray(field.querySelectorAll(".shape-tick"));
        var drifter = field.querySelector(".shape-drift") || field;
        var band = field.closest(".band") || field;

        // Arm the dash-draw. Guard getTotalLength: it throws on some
        // shapes in older engines, and a 0 length would mean an
        // invisible stroke — so we simply skip drawing that one.
        strokes = strokes.filter(function (el) {
            var len = 0;
            try { len = el.getTotalLength(); } catch (e) { len = 0; }
            if (!len) return false;
            gsap.set(el, { strokeDasharray: len, strokeDashoffset: len });
            return true;
        });

        var tl = gsap.timeline({
            scrollTrigger: hasST
                ? { trigger: band, start: "top 88%", once: true }
                : undefined,
            onComplete: function () {
                // Remove the dash props so the strokes are plain again
                // (also avoids any sub-pixel dash seam on the joins).
                if (strokes.length) gsap.set(strokes, { clearProps: "strokeDasharray,strokeDashoffset" });
            }
        });

        if (strokes.length) {
            tl.to(strokes, {
                strokeDashoffset: 0,
                duration: 1.9,
                ease: "sine.inOut",
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
            }, 0.55);
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
                    scrollTrigger: { trigger: tl, start: "top 72%", end: "bottom 62%", scrub: 0.5 }
                }
            );
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
            gsap.from(chips, {
                y: 12,
                scale: 0.92,
                opacity: 0,
                duration: 0.5,
                ease: "back.out(1.7)",
                stagger: 0.055,
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

    if (hasST && passes.length) {
        gsap.set(passes, { opacity: 0, y: 38, scale: 0.965, rotateX: -7, transformPerspective: 700 });
        ScrollTrigger.batch(passes, {
            interval: 0.12,
            batchMax: 4,
            start: "top 90%",
            once: true,
            onEnter: function (batch) {
                gsap.to(batch, {
                    opacity: 1, y: 0, scale: 1, rotateX: 0,
                    duration: 0.85,
                    ease: "power3.out",
                    stagger: 0.09,
                    onStart: function () { begin(batch); },
                    onComplete: function () { finish(batch); }
                });
            }
        });
    } else if (passes.length) {
        // No ScrollTrigger for some reason — show them, don't hide them.
        finish(passes);
    }

    if (hasST && prose.length) {
        gsap.set(prose, { opacity: 0, y: 28 });
        ScrollTrigger.batch(prose, {
            interval: 0.1,
            batchMax: 3,
            start: "top 88%",
            once: true,
            onEnter: function (batch) {
                gsap.to(batch, {
                    opacity: 1, y: 0,
                    duration: 0.8,
                    ease: "power2.out",
                    stagger: 0.11,
                    onStart: function () { begin(batch); },
                    onComplete: function () { finish(batch); }
                });
            }
        });
    } else if (prose.length) {
        finish(prose);
    }

    /* Late webfont/image loads shift layout; recalc so triggers that
       were measured against the pre-layout page still fire correctly. */
    if (hasST) {
        window.addEventListener("load", function () { ScrollTrigger.refresh(); });
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function () { ScrollTrigger.refresh(); });
        }
    }
})();
