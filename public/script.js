/* ============================================================
   Samuel Woo — portfolio interactions (light sage, top-bar nav)
   Vanilla JS + one local dependency (anime.min.js).
   - Scroll-spy top-bar links (IntersectionObserver)
   - Mobile hamburger menu (aria-expanded, esc to close)
   - Scroll-progress line under the top bar
   - anime.js staggered reveals on scroll (falls back to CSS)
   - Hero name entrance + signature line-draw motif
   - Ambient drifting background shapes (pause when tab hidden)
   - Pointer-follow spotlight on cards (rAF-throttled)
   - Count-up kicker numerals on enter
   - Rotating hero subtitle
   - Smooth-scroll nav + in-page links
   All motion guarded by prefers-reduced-motion.

   Coexistence with gsap-motion.js: GSAP loads FIRST and, if it is
   both present and allowed to animate, sets `html.gsap-on`. When that
   flag is up we hand every `.gsap-reveal` element over to GSAP and
   leave it strictly alone, so the two libraries never tween the same
   node. If GSAP is missing or reduced motion is on, the flag is
   absent and those elements are revealed here exactly like any other
   `.reveal` — they can never be left stranded invisible.
   ============================================================ */
(function () {
    "use strict";

    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var hasAnime = typeof window.anime === "function";
    var animate = hasAnime && !reduceMotion;

    if (animate) document.documentElement.classList.add("js-anim");

    /* ---------- Footer year ---------- */
    var yearEl = document.getElementById("year");
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    /* ---------- URL hash helpers ----------
       Declared up here because the scroll-spy below uses them and `var`
       initialisation does not hoist (only the `function` declaration does). */
    var lastSpyId = null;
    /* The spy must not touch the URL until the reader has actually scrolled.
       Its first run happens at load while scrollY is still 0, so it concluded
       "home" and cleared an incoming #work — destroying the anchor target
       before the cross-page landing code could use it (measured: hash gone at
       t=0.2s, page never scrolled). */
    var spyMayWriteHash = false;

    /* Write the hash without a history entry or a re-jump. We preventDefault()
       on in-page links to run our own smooth scroll, which also suppresses the
       browser's own URL update — so we have to do it ourselves or the hash goes
       stale (sitting on #work, clicking Interests left #work in the URL, and a
       refresh then pulled the reader back to Work). */
    function setHash(hash) {
        if (!window.history || !window.history.replaceState) return;
        var base = window.location.pathname + window.location.search;
        try {
            window.history.replaceState(null, "", hash ? base + hash : base);
        } catch (err) { /* file:// or blocked — cosmetic only */ }
    }

    /* The hero is the page's default state, so it clears the hash entirely
       rather than showing #home. Only sections that have a nav link are
       written, so scrolling through an unlinked band does not invent a hash. */
    function syncHashToSection(id) {
        if (!id || id === "home") { setHash(""); return; }
        var linked = navLinks.some(function (l) { return l.getAttribute("data-nav") === id; });
        if (linked) setHash("#" + id);
    }

    /* ---------- Scroll-spy: highlight active top-bar link ---------- */
    var navLinks = Array.prototype.slice.call(document.querySelectorAll(".nav-link, .nav-cta"));
    var sections = Array.prototype.slice.call(document.querySelectorAll(".band"));

    function setActive(id) {
        navLinks.forEach(function (link) {
            var isActive = link.getAttribute("data-nav") === id;
            link.classList.toggle("is-active", isActive);
            if (isActive) {
                link.setAttribute("aria-current", "true");
            } else {
                link.removeAttribute("aria-current");
            }
        });
    }

    if (sections.length) {
        // Scroll-spy by PROXIMITY, not intersection ratio: a tall section yields a
        // smaller self-relative ratio than a short one at the same scroll position,
        // which mislabeled adjacent sections. Instead, pick the section whose top
        // edge is closest to a reading line just below the sticky top bar.
        var updateSpy = function () {
            var line = (parseFloat(getComputedStyle(document.documentElement)
                .getPropertyValue("--topbar-h")) || 68) + 24;
            var best = sections[0].id, bestDist = Infinity;
            sections.forEach(function (sec) {
                var top = sec.getBoundingClientRect().top;
                // prefer the last section whose top has passed the reading line
                var dist = top <= line ? line - top : (top - line) * 4; // penalize sections still below
                if (dist < bestDist) { bestDist = dist; best = sec.id; }
            });
            // bottom-of-page guard: if scrolled to the very bottom, force last section
            if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2) {
                best = sections[sections.length - 1].id;
            }
            setActive(best);
            /* Keep the URL honest while the reader scrolls by hand, so a
               refresh or a copied link reflects where they actually are
               instead of whatever hash they originally arrived with. Only
               write on an actual change — replaceState every frame would be
               wasteful. The hero is the default state, so it clears the hash. */
            if (best !== lastSpyId) {
                lastSpyId = best;
                if (spyMayWriteHash) syncHashToSection(best);
            }
        };
        var spyScheduled = false;
        var onScrollSpy = function () {
            if (spyScheduled) return;
            spyScheduled = true;
            requestAnimationFrame(function () { spyScheduled = false; updateSpy(); });
        };
        window.addEventListener("scroll", onScrollSpy, { passive: true });
        window.addEventListener("resize", onScrollSpy, { passive: true });
        updateSpy();

        /* Arm hash-writing only once the reader drives the page themselves.
           Real user input (wheel / touch / keyboard) is the signal — a
           programmatic scroll from the anchor-landing code must not count. */
        var armSpyHash = function () {
            spyMayWriteHash = true;
            window.removeEventListener("wheel", armSpyHash);
            window.removeEventListener("touchstart", armSpyHash);
            window.removeEventListener("keydown", armSpyHash);
        };
        window.addEventListener("wheel", armSpyHash, { passive: true });
        window.addEventListener("touchstart", armSpyHash, { passive: true });
        window.addEventListener("keydown", armSpyHash);
    }

    /* ---------- Mobile hamburger menu ---------- */
    var navToggle = document.getElementById("nav-toggle");
    var navMenu = document.getElementById("nav-links");
    function closeMenu() {
        if (!navToggle || !navMenu) return;
        navMenu.classList.remove("is-open");
        document.body.classList.remove("nav-open");
        navToggle.setAttribute("aria-expanded", "false");
        navToggle.setAttribute("aria-label", "Open menu");
    }
    function openMenu() {
        if (!navToggle || !navMenu) return;
        navMenu.classList.add("is-open");
        document.body.classList.add("nav-open");
        navToggle.setAttribute("aria-expanded", "true");
        navToggle.setAttribute("aria-label", "Close menu");
    }
    if (navToggle && navMenu) {
        navToggle.addEventListener("click", function () {
            if (navMenu.classList.contains("is-open")) closeMenu(); else openMenu();
        });
        navMenu.addEventListener("click", function (e) {
            if (e.target.closest("a")) closeMenu();
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && navMenu.classList.contains("is-open")) {
                closeMenu();
                navToggle.focus();
            }
        });
        // Reset menu state if resized back to desktop.
        window.matchMedia("(min-width: 761px)").addEventListener("change", function (ev) {
            if (ev.matches) closeMenu();
        });
    }

    /* ---------- Scroll-progress line under the top bar ---------- */
    var progressEl = document.getElementById("scroll-progress");
    if (progressEl && !reduceMotion) {
        var ticking = false;
        var updateProgress = function () {
            var h = document.documentElement;
            var max = h.scrollHeight - h.clientHeight;
            var pct = max > 0 ? (h.scrollTop || window.pageYOffset) / max : 0;
            progressEl.style.width = Math.max(0, Math.min(1, pct)) * 100 + "%";
            ticking = false;
        };
        window.addEventListener("scroll", function () {
            if (!ticking) { window.requestAnimationFrame(updateProgress); ticking = true; }
        }, { passive: true });
        window.addEventListener("resize", updateProgress);
        updateProgress();
    }

    /* ---------- Smooth-scroll for nav + in-page links ----------
       We preventDefault() to run our own smooth scroll, which also cancels the
       browser's URL update — so the hash would go stale: sitting on
       index.html#work and clicking Interests scrolled correctly but left #work
       in the address bar, and a refresh then yanked you back to Work.
       We therefore write the hash ourselves with replaceState, which updates
       the URL (so reload/copy-paste are correct) without pushing a history
       entry per click and without triggering another jump. */
    document.querySelectorAll('a[href^="#"]').forEach(function (link) {
        link.addEventListener("click", function (e) {
            var id = link.getAttribute("href");
            if (id.length < 2) return;
            var target = document.querySelector(id);
            if (!target) return;
            e.preventDefault();
            target.scrollIntoView({
                behavior: reduceMotion ? "auto" : "smooth",
                block: "start"
            });
            target.setAttribute("tabindex", "-1");
            target.focus({ preventScroll: true });
            setHash(id);
        });
    });

    /* The brand/home link points at #home (or index.html#home cross-page).
       Landing on the hero is the page's default state, so strip the hash
       entirely rather than leaving #home in the URL. */
    document.querySelectorAll('.brand[href^="#"], a[href="#home"]').forEach(function (link) {
        link.addEventListener("click", function () {
            setHash("");
        });
    });

    /* ---------- Cross-page anchor landing (index.html#work etc.) ----------
       Arriving from another page, the browser jumps to the hash while the
       document is still settling: webfonts have not swapped, images have no
       intrinsic size yet, and the .reveal elements are still at opacity 0 /
       translated. Everything below the anchor then grows and the saved scroll
       position ends up SHORT of the section — measured 207px short landing on
       #interests, which reads as "it only took me to the home page".

       There is no scroll-anchoring fix for this because the shift happens
       above the viewport, so we re-assert the position ourselves once layout
       has actually stabilised: after `load`, then again on a couple of rAF
       ticks, and once more if the document height is still changing. */
    (function () {
        var hash = window.location.hash;
        if (!hash || hash.length < 2) return;

        var target;
        try {
            target = document.querySelector(hash);
        } catch (err) {
            return;                 // malformed selector in the hash
        }
        if (!target) return;

        var settle = function () {
            // scroll-margin-top on .band already accounts for the sticky bar,
            // so scrollIntoView lands the heading in the right place.
            target.scrollIntoView({ behavior: "auto", block: "start" });
        };

        var lastHeight = -1;
        var attempts = 0;
        var recheck = function () {
            var h = document.documentElement.scrollHeight;
            // Re-assert while the page is still growing, up to ~1s.
            if (h !== lastHeight && attempts < 12) {
                lastHeight = h;
                settle();
                attempts++;
                setTimeout(recheck, 80);
            }
        };

        // Run after the browser's own hash jump, then keep correcting.
        if (document.readyState === "complete") {
            requestAnimationFrame(function () { settle(); recheck(); });
        } else {
            window.addEventListener("load", function () {
                requestAnimationFrame(function () { settle(); recheck(); });
            });
        }
        // Fonts can swap after `load` and shift metrics again.
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function () { settle(); });
        }
    })();

    /* ---------- Reveals ---------- */
    // `.gsap-reveal` nodes belong to gsap-motion.js when it signalled
    // that it took ownership; otherwise they fall through to us.
    var gsapOwns = document.documentElement.classList.contains("gsap-on");
    var revealSelector = gsapOwns ? ".reveal:not(.gsap-reveal)" : ".reveal";
    var reveals = Array.prototype.slice.call(document.querySelectorAll(revealSelector));

    function showAll() {
        reveals.forEach(function (el) { el.classList.add("is-visible"); });
    }

    /* ---------- Reveal rescue sweep (anti-stranding) ----------
       IntersectionObserver only reports what it actually sampled. A fast
       scroll — a wheel fling, a hash jump, restored scroll on reload, or a
       programmatic scrollTo — can carry a short element from below the
       viewport to above it inside a single sample interval. The observer
       then never sees `isIntersecting`, never fires, and because
       `html.js-anim .reveal:not(.is-visible)` pins it to opacity 0, that
       copy is invisible for the rest of the session.

       Measured on the pristine baseline: 6 of 6 fast-scroll passes over
       index.html left 1-3 `.reveal` blocks permanently at opacity 0
       (section intros, subheads, a project card). It is scroll-rate
       dependent, which is why it reads as intermittent rather than broken.

       So the observer is treated as the fast path, not the source of
       truth. This sweep is the backstop: anything at or above the fold
       that is still hidden gets snapped to its final state. Elements the
       reader scrolled past do not want an entrance animation anyway — they
       want to be readable, so the rescue is instant and unanimated. */
    function rescueStragglers() {
        if (!reveals.length) return;
        var vh = window.innerHeight;
        var remaining = false;
        reveals.forEach(function (el) {
            if (el.classList.contains("is-visible")) return;
            var r = el.getBoundingClientRect();
            // Its top edge has reached the fold: it has been seen (or passed).
            if (r.top < vh * 0.94) {
                el.classList.add("is-visible");
                // Drop any half-applied inline from-state so the CSS
                // resting rule (.reveal.is-visible) fully governs it.
                el.style.removeProperty("opacity");
                el.style.removeProperty("transform");
            } else {
                remaining = true;
            }
        });
        // Nothing left below the fold — stop paying for the listener.
        if (!remaining) {
            window.removeEventListener("scroll", onSweepScroll);
            window.removeEventListener("resize", onSweepScroll);
        }
    }

    var sweepScheduled = false;
    function onSweepScroll() {
        if (sweepScheduled) return;
        sweepScheduled = true;
        requestAnimationFrame(function () {
            sweepScheduled = false;
            rescueStragglers();
        });
    }

    if (reduceMotion || !("IntersectionObserver" in window)) {
        showAll();
    } else if (animate) {
        var revObserver = new IntersectionObserver(function (entries, obs) {
            var groups = {};
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                var el = entry.target;
                obs.unobserve(el);
                var parent = el.parentElement;
                var key = parent ? (parent.__revId || (parent.__revId = "g" + (++showAll.__n || (showAll.__n = 1)))) : "root";
                (groups[key] = groups[key] || []).push(el);
            });
            Object.keys(groups).forEach(function (k) {
                var els = groups[k];
                var clips = els.filter(function (e) { return e.classList.contains("reveal-clip"); });
                var blocks = els.filter(function (e) { return !e.classList.contains("reveal-clip"); });
                clips.forEach(function (e, i) {
                    e.style.setProperty("--reveal-delay", (i * 90) + "ms");
                    e.classList.add("is-visible");
                });
                if (blocks.length) {
                    blocks.forEach(function (e) { e.classList.add("is-visible"); });
                    /* `easeOutElastic(1, .85)` overshot and wobbled every
                       block back into place — too playful for an editorial
                       page, and on a group of stacked prose it read as the
                       whole column jiggling. `easeOutQuint` covers most of
                       the distance early then decelerates hard, which is
                       the "settles into place" feel with no overshoot.

                       Opacity is deliberately shorter than the move (a
                       separate, faster tween) so the text is legible while
                       it is still travelling the last few pixels — the eye
                       follows the words instead of waiting on the fade. */
                    window.anime({
                        targets: blocks,
                        translateY: [22, 0],
                        duration: 820,
                        delay: window.anime.stagger(70, { start: 30 }),
                        easing: "easeOutQuint"
                    });
                    window.anime({
                        targets: blocks,
                        opacity: [0, 1],
                        duration: 420,
                        delay: window.anime.stagger(70, { start: 30 }),
                        easing: "easeOutSine"
                    });
                }
            });
        }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
        reveals.forEach(function (el) { revObserver.observe(el); });
        /* Backstop the observer (see rescueStragglers above). Debounced on
           scroll so a fling that outruns IO is caught on the next frame,
           plus fixed checks for the load/font/image settling window. */
        window.addEventListener("scroll", onSweepScroll, { passive: true });
        window.addEventListener("resize", onSweepScroll, { passive: true });
        window.addEventListener("load", function () { setTimeout(rescueStragglers, 400); });
        setTimeout(rescueStragglers, 2200);
    } else {
        var cssObs = new IntersectionObserver(function (entries, obs) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                var el = entry.target;
                var parent = el.parentElement;
                var siblings = parent ? Array.prototype.slice.call(parent.querySelectorAll(":scope > .reveal")) : [el];
                var idx = siblings.indexOf(el);
                var delay = idx > 0 ? Math.min(idx, 8) * 80 : 0;
                el.style.setProperty("--reveal-delay", delay + "ms");
                el.classList.add("is-visible");
                obs.unobserve(el);
            });
        }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
        reveals.forEach(function (el) { cssObs.observe(el); });
        // Same backstop for the CSS-transition path (anime.js absent).
        window.addEventListener("scroll", onSweepScroll, { passive: true });
        window.addEventListener("resize", onSweepScroll, { passive: true });
        window.addEventListener("load", function () { setTimeout(rescueStragglers, 400); });
        setTimeout(rescueStragglers, 2200);
    }

    /* ---------- Hero name + signature motif entrance (on load) ---------- */
    if (animate) {
        var heroLines = document.querySelectorAll(".hero-name .hero-line");
        heroLines.forEach(function (line) {
            var accent = line.querySelector(".hero-accent");
            var host = accent || line;
            var text = host.textContent;
            host.textContent = "";
            for (var i = 0; i < text.length; i++) {
                var ch = document.createElement("span");
                ch.className = "hero-char";
                ch.style.display = "inline-block";
                ch.style.willChange = "transform, opacity";
                ch.textContent = text[i];
                host.appendChild(ch);
            }
        });
        window.anime({
            targets: ".hero-name .hero-char",
            translateY: [{ value: ["1.05em", "0em"] }],
            opacity: [0, 1],
            duration: 900,
            delay: window.anime.stagger(45, { start: 220 }),
            easing: "easeOutExpo"
        });

        var motif = document.querySelectorAll(".hero-motif .motif-draw, .projects-motif .motif-draw");
        motif.forEach(function (el) {
            var len = 0;
            try { len = el.getTotalLength(); } catch (e) { len = 400; }
            el.style.strokeDasharray = len;
            el.style.strokeDashoffset = len;
        });
        window.anime({
            targets: ".hero-motif .motif-draw, .projects-motif .motif-draw",
            strokeDashoffset: [window.anime.setDashoffset, 0],
            duration: 2200,
            delay: window.anime.stagger(260, { start: 400 }),
            easing: "easeInOutSine"
        });
    }

    /* ---------- Count-up kicker numerals on enter ---------- */
    if (animate) {
        var kickerNums = Array.prototype.slice.call(document.querySelectorAll(".kicker-num"));
        var numObs = new IntersectionObserver(function (entries, obs) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                var el = entry.target;
                obs.unobserve(el);
                var target = parseInt(el.textContent, 10);
                if (isNaN(target)) return;
                var pad = el.textContent.length;
                var obj = { v: 0 };
                window.anime({
                    targets: obj,
                    v: target,
                    duration: 900,
                    easing: "easeOutCubic",
                    round: 1,
                    update: function () {
                        el.textContent = String(Math.round(obj.v)).padStart(pad, "0");
                    }
                });
            });
        }, { rootMargin: "0px 0px -20% 0px", threshold: 0.4 });
        kickerNums.forEach(function (el) { numObs.observe(el); });
    }

    /* ---------- Pointer-follow spotlight on cards (rAF-throttled) ---------- */
    if (!reduceMotion && window.matchMedia("(hover: hover)").matches) {
        var spotCards = Array.prototype.slice.call(document.querySelectorAll(".card.spotlight"));
        spotCards.forEach(function (card) {
            var frame = null, mx = 0, my = 0;
            card.addEventListener("mousemove", function (e) {
                var rect = card.getBoundingClientRect();
                mx = e.clientX - rect.left;
                my = e.clientY - rect.top;
                if (frame) return;
                frame = window.requestAnimationFrame(function () {
                    card.style.setProperty("--mx", mx + "px");
                    card.style.setProperty("--my", my + "px");
                    frame = null;
                });
            }, { passive: true });
        });
    }

    /* ---------- Ambient drifting background shapes ---------- */
    if (animate) {
        var bgShapes = document.querySelectorAll(".bg-shapes .bg-shape");
        var drift = null;
        if (bgShapes.length) {
            drift = window.anime({
                targets: ".bg-shapes .bg-shape",
                translateX: function () { return [window.anime.random(-16, 16), window.anime.random(-16, 16)]; },
                translateY: function () { return [window.anime.random(-12, 12), window.anime.random(-12, 12)]; },
                opacity: [{ value: [0.04, 0.10] }, { value: 0.06 }],
                duration: function () { return window.anime.random(15000, 24000); },
                direction: "alternate",
                loop: true,
                easing: "easeInOutSine",
                delay: window.anime.stagger(1400)
            });
        }
        document.addEventListener("visibilitychange", function () {
            if (!drift) return;
            if (document.hidden) drift.pause(); else drift.play();
        });
    }

    /* ---------- Rotating hero subtitle ---------- */
    var subtitles = [
        "software engineer, part-time robot wrangler"
    ];
    var subtitleEl = document.getElementById("rotating-subtitle");
    if (subtitleEl && !reduceMotion) {
        var idx2 = 0;
        setInterval(function () {
            subtitleEl.classList.add("fade-out");
            setTimeout(function () {
                idx2 = (idx2 + 1) % subtitles.length;
                subtitleEl.textContent = subtitles[idx2];
                subtitleEl.classList.remove("fade-out");
            }, 300);
        }, 4000);
    }
})();
