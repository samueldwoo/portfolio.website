/* ============================================================
   Samuel Woo — GSAP motion layer  (gsap-motion.js)

   This file is ADDITIVE to script.js / anime.js. The two libraries
   are kept strictly separated so they can never fight over a node:

     anime.js  owns : hero letter stagger, .hero-motif/.projects-motif
                      line-draw (the .motif-draw paths), .kicker-num
                      count-ups, and every .reveal EXCEPT .gsap-reveal.
     CSS       owns : .reveal-clip clip-wipe, all :hover states.
     GSAP (here) owns: the brand springy wordmark, the decorative
                      .shape-field line-art layer, hero/glow parallax,
                      the timeline progress rail, chip staggers, every
                      element tagged .gsap-reveal, and — via SplitText
                      (section 8) — the masked line-rise on
                      .section-title / .case-title / .case-tagline /
                      .subhead / .case-head. Section 8 STRIPS .reveal
                      and .reveal-clip off those nodes at init so
                      anime.js and the CSS clip-wipe never see them.

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

       So we verify instead of assuming. Once the page has settled, any
       element that GSAP hid, is inside the viewport, and is still
       transparent gets snapped to its final state. A no-op in the normal
       case; the difference between "a subtle bug" and "unreadable content"
       in the abnormal one.
       ============================================================ */
    if (hasST) {
        var guarded = passes.concat(prose);
        if (guarded.length) {
            var sweep = function () {
                guarded.forEach(function (el) {
                    if (parseFloat(gsap.getProperty(el, "opacity")) >= 0.99) return;
                    var r = el.getBoundingClientRect();
                    // Only rescue what should already be on screen; anything
                    // still below the fold has a legitimate reason to be hidden.
                    var onScreen = r.top < window.innerHeight && r.bottom > 0;
                    if (!onScreen) return;
                    gsap.killTweensOf(el);
                    finish([el]);
                });
            };
            // After load, after fonts, and once more late for slow decodes.
            window.addEventListener("load", function () { setTimeout(sweep, 600); });
            setTimeout(sweep, 2500);
            window.addEventListener("scroll", sweep, { passive: true, once: true });
        }
    }

    /* ============================================================
       8. Measurement hygiene
       Every scrubbed/sticky trigger above was measured against the page
       as it existed at parse time. Three things then change it:
         - webfonts swap (Space Grotesk/Inter/DM Mono + the travel page's
           airline display faces) and every text block re-measures;
         - the 11 airline logos decode and the pass wall's real geometry
           (which the grid stagger reads) finally exists;
         - the hero canvas sizes itself.
       Without a refresh the case-study rails scrub against stale
       start/end pixels and the grid stagger measures a collapsed grid.
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

            // Lines start below the mask, so the element itself is safe
            // to show the instant the wrappers exist.
            reveal(el);

            var tl = gsap.timeline({
                onComplete: function () {
                    // Put the DOM back the way we found it. clearProps
                    // first so no inline transform survives the revert.
                    gsap.set(lines, { clearProps: "all" });
                    split.revert();
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
    }

    /* Late webfont/image loads shift layout; recalc so triggers that
       were measured against the pre-layout page still fire correctly. */

})();
