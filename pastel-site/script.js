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

    /* ---------- Smooth-scroll for nav + in-page links ---------- */
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
        });
    });

    /* ---------- Reveals ---------- */
    var reveals = Array.prototype.slice.call(document.querySelectorAll(".reveal"));

    function showAll() {
        reveals.forEach(function (el) { el.classList.add("is-visible"); });
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
                    window.anime({
                        targets: blocks,
                        translateY: [22, 0],
                        opacity: [0, 1],
                        duration: 720,
                        delay: window.anime.stagger(80, { start: 40 }),
                        easing: "easeOutElastic(1, .85)"
                    });
                }
            });
        }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
        reveals.forEach(function (el) { revObserver.observe(el); });
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
