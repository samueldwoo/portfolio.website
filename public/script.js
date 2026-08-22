/* ============================================================
   Samuel Woo — portfolio interactions (light sage, top-bar nav)
   Vanilla JS + one local dependency (anime.min.js).
   - Section model harvested from the page's own `.band` elements,
     shared by the scroll-spy, the rail, the drawer and the palette
   - Scroll-spy top-bar links + a travelling FILLED active marker
   - Right-edge section rail (>=1024px) with progress spine
   - Command palette on Cmd/Ctrl-K (and `/`)
   - Mobile drawer: native <dialog>, so focus trap + Escape are the
     platform's, not ours
   - Scroll-direction-aware chrome: the bar condenses, never hides
   - Segmented scroll-progress on the bar's edge
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

    /* "I am running." The inline head script sets html.js-anim before paint and
       withdraws it after 3s unless it sees this class, so that a script.js which
       never loads cannot strand every .reveal at opacity 0. Set unconditionally,
       BEFORE the animate branch: reaching this line means the reveal logic below
       will run, either as the IntersectionObserver path or as showAll(). */
    document.documentElement.classList.add("anim-live");
    if (!animate) document.documentElement.classList.remove("js-anim");

    /* ---------- Footer year ---------- */
    var yearEl = document.getElementById("year");
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    /* ============================================================
       NAVIGATION
       ------------------------------------------------------------
       One section model, four affordances. Everything below reads
       from `sections`, which is harvested from the page's own
       `.band` elements — so a page that gains a section gains a
       scroll-spy entry, a rail tick, a drawer row, a progress tick
       and a palette result with no edit anywhere else.

       Ordering note: the id backfill has to happen HERE, above the
       cross-page anchor-landing block further down, because that
       block does `document.querySelector(location.hash)` at parse
       time and would miss a section whose id we had not written yet.

       Why native <dialog> for the drawer and the palette: showModal()
       is what gives us a real focus trap, Escape-to-close, top-layer
       stacking above the fixed bar, and focus restoration on close.
       Hand-rolling those four is where DIY modals go wrong.
       ============================================================ */
    var root = document.documentElement;
    function slice(nl) { return Array.prototype.slice.call(nl); }
    function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

    var navTrack   = document.getElementById("nav-links");
    var marker     = document.getElementById("nav-marker");
    var navToggle  = document.getElementById("nav-toggle");
    var navCmd     = document.getElementById("nav-cmd");
    var railEl     = document.getElementById("section-rail");
    var drawer     = document.getElementById("nav-drawer");
    var palette    = document.getElementById("cmdk");
    var progressEl = document.getElementById("scroll-progress");
    var barProgress = progressEl ? progressEl.parentNode : null;

    var navLinks = navTrack ? slice(navTrack.querySelectorAll(".nav-link, .nav-cta")) : [];
    var canDialog = typeof window.HTMLDialogElement === "function" &&
        !!(drawer && typeof drawer.showModal === "function");

    /* ---------- 1. Section model ----------
       Label priority: the nav link that already points at this section (so
       the rail says "Work", not "Work — 2021 → now"), then the heading named
       by aria-labelledby, then aria-label, then the first heading inside.
       Sub-page bands carry no id, so we mint a slug from the label; those
       slugs are deterministic, which makes case studies deep-linkable. */
    function textOf(el) {
        return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
    }
    function labelFor(sec) {
        if (sec.id === "home") return "Home";
        for (var i = 0; i < navLinks.length; i++) {
            if (sec.id && navLinks[i].getAttribute("data-nav") === sec.id) {
                return textOf(navLinks[i]);
            }
        }
        var t = textOf(document.getElementById(sec.getAttribute("aria-labelledby") || ""));
        if (!t) t = String(sec.getAttribute("aria-label") || "").trim();
        if (!t) t = textOf(sec.querySelector("h1, h2"));
        /* "Ka-ching — Personal Finance Dashboard" is a title, not a label.
           Keep the part before the em dash; it is what people would type. */
        var head = t.split(/\s+[—–-]{1,2}\s+/)[0];
        if (head && head.length >= 3) t = head;
        return t || "Section";
    }
    function slugify(s) {
        return String(s).toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 32) || "section";
    }

    var sections = slice(document.querySelectorAll(".band")).map(function (el, i) {
        var label = labelFor(el);
        if (!el.id) {
            var base = slugify(label), id = base, n = 2;
            while (document.getElementById(id)) { id = base + "-" + (n++); }
            el.id = id;
        }
        return {
            el: el,
            id: el.id,
            label: label,
            short: label.length > 22 ? label.slice(0, 21).replace(/\s+$/, "") + "…" : label,
            index: i
        };
    });
    var sectionIds = sections.map(function (s) { return s.id; });

    /* ---------- 2. URL hash ----------
       We preventDefault() in-page clicks to run our own scroll, which also
       cancels the browser's URL update — so the hash has to be written by
       hand or it goes stale (sitting on #work, clicking Interests left #work
       in the URL, and a refresh then pulled the reader back to Work).

       The spy must not touch the URL until the reader has actually scrolled.
       Its first run happens at load while scrollY is still 0, so it concluded
       "home" and cleared an incoming #work — destroying the anchor target
       before the cross-page landing code could use it (measured: hash gone at
       t=0.2s, page never scrolled). */
    var lastSpyId = null;
    var spyMayWriteHash = false;
    /* Write the hash without a history entry or a re-jump. */
    function setHash(hash) {
        if (!window.history || !window.history.replaceState) return;
        var base = window.location.pathname + window.location.search;
        try {
            window.history.replaceState(null, "", hash ? base + hash : base);
        } catch (err) { /* file:// or blocked — cosmetic only */ }
    }

    /* The hero is the page's default state, so it clears the hash entirely
       rather than showing #home. Every other band has an id now (authored or
       minted above), and those ids are stable, so a case study is linkable. */
    function syncHashToSection(id) {
        if (!id || id === "home") { setHash(""); return; }
        if (sectionIds.indexOf(id) < 0) return;
        setHash("#" + id);
    }

    /* ---------- 3. One scroll to a section, used by every affordance ----------

       WHY NOT scrollIntoView: a ScrollTrigger-PINNED section is `position:
       fixed` for as long as its pin holds, so the browser resolves it against
       where it is right now rather than where it sits in the document. Clicking
       "sam." on the home page landed at scrollY 765 -- exactly the hero's pin
       span (900 x 0.85) -- which pushed `.hero-meta` to y=36 underneath a 69px
       bar and cut the summary line off. Measured; and it only reproduced at
       >=900px, because the hero pin does not run on narrow.

       ScrollTrigger keeps a `.pin-spacer` in the flow at the section's real
       position, so that is the element to measure. This also covers travel's
       pinned boarding-pass track, which had the same latent bug.

       `scroll-margin-top` lives on `.band` (calibrated against --topbar-h), and
       a manual scrollTo does not honour it, so read it off the target and
       subtract it by hand. */
    function sectionScrollTop(target) {
        var flow = (target.closest && target.closest(".pin-spacer")) || target;
        var margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
        var y = flow.getBoundingClientRect().top +
                (window.pageYOffset || document.documentElement.scrollTop || 0) -
                margin;
        return Math.max(0, Math.round(y));
    }

    function goToSection(id) {
        var target = document.getElementById(id);
        if (!target) return;
        window.scrollTo({
            top: sectionScrollTop(target),
            behavior: reduceMotion ? "auto" : "smooth"
        });
        /* Move focus with the viewport or a keyboard reader is left behind at
           the top of the document. -1 keeps the band out of the tab order. */
        target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
        if (id === "home") setHash(""); else setHash("#" + id);
    }

    /* ---------- 4. Active state ----------
       ONE filled marker on screen at a time. Priority: the nav link that
       points at the current section; failing that, the link for the page you
       are on (`data-nav-page`). That fallback is why projects.html no longer
       drops its own highlight the moment you scroll past its first band.
       `aria-current="page"` is authored in the markup for the page link and is
       never touched here; section links get aria-current="true". */
    var railTicks = [];
    var drawerSecRows = [];

    function setActive(id) {
        var claimed = navLinks.some(function (l) { return l.getAttribute("data-nav") === id; });
        navLinks.forEach(function (link) {
            var isSection = link.getAttribute("data-nav") === id;
            var isPageLink = link.hasAttribute("data-nav-page");
            link.classList.toggle("is-active", isSection || (isPageLink && !claimed));
            if (isPageLink) return;                 // keeps aria-current="page"
            if (isSection) link.setAttribute("aria-current", "true");
            else link.removeAttribute("aria-current");
        });
        [railTicks, drawerSecRows].forEach(function (group) {
            group.forEach(function (el) {
                var on = el.getAttribute("data-sec") === id;
                el.classList.toggle("is-active", on);
                if (on) el.setAttribute("aria-current", "true");
                else el.removeAttribute("aria-current");
            });
        });
        placeMarker(false);
    }

    /* ---------- 5. The travelling filled marker ----------
       script.js owns `transform` and `width` on `.nav-marker` and nothing
       else writes them — the one-owner-per-property rule this repo has been
       bitten by three times. anime.js drives it when it is allowed to
       animate (it loads before this file, unlike Motion); otherwise the CSS
       transition in nav.css does, and under reduced motion neither does. */
    var markerAnimated = animate && !!marker;
    if (markerAnimated) root.classList.add("nav-marker-js");

    var markerTween = null;
    function placeMarker(instant) {
        if (!marker || !navTrack) return;
        // The track is display:none at mobile widths; nothing to point at.
        if (!navTrack.offsetWidth) { marker.classList.remove("is-shown"); return; }
        var active = navTrack.querySelector(".nav-link.is-active, .nav-cta.is-active");
        if (!active) { marker.classList.remove("is-shown"); return; }

        var host = navTrack.getBoundingClientRect();
        var r = active.getBoundingClientRect();
        /* An absolutely positioned child resolves `left: 0` against its
           containing block's PADDING box, so the 1px track border has to come
           out of the offset or the pill sits a pixel right of its link. */
        var border = parseFloat(getComputedStyle(navTrack).borderLeftWidth) || 0;
        var x = r.left - host.left - border;
        var w = r.width;
        var first = !marker.classList.contains("is-shown");
        marker.classList.add("is-shown");

        if (markerTween) { markerTween.pause(); markerTween = null; }
        if (instant || first || !markerAnimated) {
            // No slide in from a meaningless origin on first appearance.
            marker.style.transform = "translateX(" + x + "px)";
            marker.style.width = w + "px";
            return;
        }
        markerTween = window.anime({
            targets: marker,
            translateX: x,
            width: w,
            duration: 620,
            easing: "spring(1, 92, 13, 0)"
        });
    }

    /* ---------- 6. Scroll-spy ----------
       By PROXIMITY, not intersection ratio: a tall section yields a smaller
       self-relative ratio than a short one at the same scroll position, which
       mislabeled adjacent sections. Pick the section whose top edge is
       closest to a reading line just under the bar. */
    function readingLine() {
        return (parseFloat(getComputedStyle(root).getPropertyValue("--topbar-h")) || 68) + 24;
    }
    function currentSectionId() {
        if (!sections.length) return null;
        var line = readingLine();
        var best = sections[0].id, bestDist = Infinity;
        sections.forEach(function (s) {
            var top = s.el.getBoundingClientRect().top;
            // prefer the last section whose top has passed the reading line
            var dist = top <= line ? line - top : (top - line) * 4;
            if (dist < bestDist) { bestDist = dist; best = s.id; }
        });
        // bottom-of-page guard: at the very bottom, force the last section
        if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2) {
            best = sections[sections.length - 1].id;
        }
        return best;
    }

    /* ---------- 7. Progress: bar fill + rail spine ----------
       Deliberately NOT gated on reduced motion. This is a position readout,
       not decoration; a reader who suppresses animation still wants to know
       how far down the page they are. There is no transition on either, so
       it simply tracks the scrollbar. */
    function updateProgress() {
        var max = root.scrollHeight - root.clientHeight;
        var pct = max > 0 ? clamp01((root.scrollTop || window.pageYOffset) / max) : 0;
        if (progressEl) progressEl.style.width = (pct * 100) + "%";
        root.style.setProperty("--rail-progress", pct.toFixed(4));
    }

    /* Section-boundary ticks on the bar's progress edge — the narrow-viewport
       stand-in for the rail. Positions are scroll fractions, so they have to
       be recomputed whenever the document height changes. */
    var barTicks = [];
    function buildBarTicks() {
        if (!barProgress) return;
        barTicks.forEach(function (t) { t.remove(); });
        barTicks = [];
        var max = root.scrollHeight - root.clientHeight;
        if (max <= 0 || sections.length < 2) return;
        var line = readingLine();
        var y = root.scrollTop || window.pageYOffset;
        sections.forEach(function (s, i) {
            if (!i) return;
            var at = clamp01((s.el.getBoundingClientRect().top + y - line) / max);
            if (at <= 0.005 || at >= 0.995) return;
            var tick = document.createElement("span");
            tick.className = "bar-tick";
            tick.style.left = (at * 100) + "%";
            barProgress.appendChild(tick);
            barTicks.push(tick);
        });
    }

    /* ---------- 8. Section rail (>=1024px) ----------
       Built from the model, not hand-written, so it cannot drift out of sync
       with the page. Labels are aria-hidden decoration; the tick's accessible
       name is its aria-label, which is why parking an inactive label at
       opacity 0 hides nothing. */
    function buildRail() {
        if (!railEl || sections.length < 2) return;
        var spine = document.createElement("span");
        spine.className = "rail-spine";
        spine.setAttribute("aria-hidden", "true");
        var fill = document.createElement("span");
        fill.className = "rail-spine-fill";
        spine.appendChild(fill);

        var list = document.createElement("ol");
        list.className = "rail-list";
        sections.forEach(function (s, i) {
            var li = document.createElement("li");
            var a = document.createElement("a");
            a.className = "rail-tick";
            a.href = "#" + s.id;
            a.setAttribute("data-sec", s.id);
            a.setAttribute("aria-label", (i + 1) + " of " + sections.length + ": " + s.label);
            var lab = document.createElement("span");
            lab.className = "rail-label";
            lab.setAttribute("aria-hidden", "true");
            lab.textContent = s.short;
            var dot = document.createElement("span");
            dot.className = "rail-dot";
            dot.setAttribute("aria-hidden", "true");
            a.appendChild(lab);
            a.appendChild(dot);
            a.addEventListener("click", function (e) { e.preventDefault(); goToSection(s.id); });
            li.appendChild(a);
            list.appendChild(li);
            railTicks.push(a);
        });
        railEl.appendChild(spine);
        railEl.appendChild(list);
    }

    /* ---------- 9. Drawer section rows ---------- */
    function buildDrawerSections() {
        var host = document.getElementById("drawer-sections");
        var group = document.getElementById("drawer-sections-group");
        if (!host || !group || sections.length < 2) return;
        sections.forEach(function (s, i) {
            var a = document.createElement("a");
            a.className = "drawer-link drawer-stagger";
            a.href = "#" + s.id;
            a.setAttribute("data-sec", s.id);
            var num = document.createElement("span");
            num.className = "drawer-num";
            num.setAttribute("aria-hidden", "true");
            num.textContent = (i < 9 ? "0" : "") + (i + 1);
            a.appendChild(num);
            a.appendChild(document.createTextNode(s.label));
            host.appendChild(a);
            drawerSecRows.push(a);
        });
        group.hidden = false;
    }

    /* ---------- 10. Scroll lock ----------
       showModal() blocks interaction but not scrolling. Locking `html` is the
       only reliable stop; the scrollbar it removes is paid back as padding so
       nothing reflows, and the fixed bar is compensated separately because its
       containing block is the viewport, not <html>. */
    function anyOverlayOpen() {
        return !!((drawer && drawer.open) || (palette && palette.open));
    }
    function lockScroll() {
        var sb = window.innerWidth - root.clientWidth;
        root.style.setProperty("--nav-sb", (sb > 0 ? sb : 0) + "px");
        root.classList.add("nav-locked");
    }
    function unlockScroll() {
        if (anyOverlayOpen()) return;
        root.classList.remove("nav-locked");
        root.style.setProperty("--nav-sb", "0px");
    }

    /* showModal() already prevents focus reaching the page behind a dialog,
       but Chrome's own wrap point routes through <body> for one keypress —
       measured on both dialogs — which reads as "the focus ring vanished".
       Wrapping the ends ourselves keeps the ring inside the panel. */
    var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]),' +
        'select, textarea, [tabindex]:not([tabindex="-1"])';
    function trapTab(dialogEl) {
        dialogEl.addEventListener("keydown", function (e) {
            if (e.key !== "Tab") return;
            var f = slice(dialogEl.querySelectorAll(FOCUSABLE)).filter(function (el) {
                return el.offsetWidth || el.offsetHeight;
            });
            if (!f.length) return;
            var here = document.activeElement;
            if (e.shiftKey) {
                if (here === f[0] || !dialogEl.contains(here)) {
                    e.preventDefault();
                    f[f.length - 1].focus();
                }
            } else if (here === f[f.length - 1]) {
                e.preventDefault();
                f[0].focus();
            }
        });
    }

    /* ---------- 11. Mobile drawer ---------- */
    var drawerClosing = false;
    function openDrawer() {
        if (!canDialog || !drawer || drawer.open) return;
        lockScroll();
        drawer.classList.remove("is-closing");
        drawerClosing = false;
        drawer.showModal();
        if (navToggle) {
            navToggle.setAttribute("aria-expanded", "true");
            navToggle.setAttribute("aria-label", "Close menu");
        }
    }
    function finishDrawerClose() {
        drawerClosing = false;
        drawer.classList.remove("is-closing");
        if (drawer.open) drawer.close();
    }
    function closeDrawer(immediate) {
        if (!drawer || !drawer.open) return;
        if (immediate || reduceMotion) { finishDrawerClose(); return; }
        if (drawerClosing) return;
        drawerClosing = true;
        drawer.classList.add("is-closing");
        // Timer, not animationend: under reduced motion there is no animation
        // to end, and a drawer that cannot close is worse than one that
        // closes without a flourish.
        setTimeout(finishDrawerClose, 210);
    }
    if (canDialog && drawer && navToggle) {
        trapTab(drawer);
        navToggle.addEventListener("click", function () {
            if (drawer.open) closeDrawer(); else openDrawer();
        });
        // Escape: intercept `cancel` so it exits with the same animation as
        // every other close path, then let our own close run.
        drawer.addEventListener("cancel", function (e) { e.preventDefault(); closeDrawer(); });
        drawer.addEventListener("close", function () {
            if (navToggle) {
                navToggle.setAttribute("aria-expanded", "false");
                navToggle.setAttribute("aria-label", "Open menu");
            }
            drawer.classList.remove("is-closing");
            unlockScroll();
            // The platform restores focus to the opener, but only if focus was
            // still inside the dialog when it closed.
            if (document.activeElement === document.body && navToggle) navToggle.focus();
        });
        // Clicks that land on the backdrop are dispatched at the dialog itself.
        drawer.addEventListener("click", function (e) {
            if (e.target === drawer) closeDrawer();
        });
        var drawerClose = document.getElementById("drawer-close");
        if (drawerClose) drawerClose.addEventListener("click", function () { closeDrawer(); });

        /* In-drawer links: the page is scroll-locked while the drawer is open,
           so a same-page jump has to close first or the scroll is swallowed. */
        drawer.addEventListener("click", function (e) {
            var a = e.target.closest && e.target.closest("a[href]");
            if (!a || !drawer.contains(a)) return;
            var href = a.getAttribute("href") || "";
            if (href.charAt(0) !== "#" || href.length < 2) return;   // cross-page: just go
            var id = href.slice(1);
            if (!document.getElementById(id)) return;
            e.preventDefault();
            closeDrawer(true);
            goToSection(id);
        });
        var drawerSearch = document.getElementById("drawer-search");
        if (drawerSearch) {
            drawerSearch.addEventListener("click", function () {
                closeDrawer(true);
                openPalette();
            });
        }
        // Back at desktop width the drawer is redundant and its scroll lock
        // would strand the reader.
        window.matchMedia("(min-width: 761px)").addEventListener("change", function (ev) {
            if (ev.matches) closeDrawer(true);
        });
    }

    /* ---------- 12. Command palette ----------
       Items are harvested from markup that already exists — the drawer's page
       list, the bar's cross-page links, the drawer's contact chips — so there
       is exactly one place to edit a destination.

       The input is a combobox with aria-activedescendant, which is the
       pattern that lets arrow keys move a highlight through the listbox while
       DOM focus stays in the text field. */
    var cmdkInput = document.getElementById("cmdk-input");
    var cmdkList  = document.getElementById("cmdk-list");
    var cmdkEmpty = document.getElementById("cmdk-empty");
    var hasPalette = canDialog && palette && cmdkInput && cmdkList;

    var paletteItems = [];
    var shown = [];        // flat list of currently rendered items
    var selected = 0;

    function collectItems() {
        var out = [];
        sections.forEach(function (s, i) {
            out.push({
                group: "This page", label: s.label, meta: "Section",
                glyph: (i < 9 ? "0" : "") + (i + 1), sec: s.id
            });
        });
        var pageRows = slice(document.querySelectorAll(
            '#nav-drawer nav[aria-labelledby="drawer-pages-label"] .drawer-link'));
        pageRows.forEach(function (a) {
            var here = a.hasAttribute("aria-current");
            out.push({
                group: "Site", label: textOf(a), meta: here ? "Current page" : "Page",
                glyph: "→", href: a.getAttribute("href"), current: here
            });
        });
        // Cross-page section links that live in the bar (sub-pages only).
        navLinks.forEach(function (a) {
            var href = a.getAttribute("href") || "";
            // "/#" and not "index.html#": these cross-page hrefs became
            // root-absolute when build.format switched to 'directory' (see the
            // note in Base.astro). A relative "index.html#work" resolved to
            // /projects/index.html#work once pages moved into directories, i.e.
            // the page you were already on. On the home page these links are
            // bare "#hash" and correctly do not match — this block is
            // sub-pages only.
            if (href.indexOf("/#") !== 0) return;
            out.push({ group: "Site", label: textOf(a), meta: "Home page", glyph: "→", href: href });
        });
        slice(document.querySelectorAll("#nav-drawer .drawer-foot a")).forEach(function (a) {
            var href = a.getAttribute("href") || "";
            var mail = href.indexOf("mailto:") === 0;
            out.push({
                group: "Reach out", label: textOf(a), meta: mail ? "Email" : "External",
                glyph: mail ? "@" : "↗", href: href, external: !mail
            });
        });
        return out;
    }

    var GROUP_ORDER = ["This page", "Site", "Reach out"];

    function matchScore(q, text) {
        if (!q) return { score: 0, ranges: [] };
        var lt = text.toLowerCase();
        var at = lt.indexOf(q);
        if (at >= 0) return { score: 1000 - at * 4 - text.length, ranges: [[at, at + q.length]] };
        // Fall back to a subsequence match, so "kach" finds "Ka-ching".
        var ranges = [], qi = 0, ti = 0, first = -1, last = -1;
        while (ti < lt.length && qi < q.length) {
            if (lt.charAt(ti) === q.charAt(qi)) {
                if (first < 0) first = ti;
                last = ti;
                var prev = ranges[ranges.length - 1];
                if (prev && prev[1] === ti) prev[1] = ti + 1; else ranges.push([ti, ti + 1]);
                qi++;
            }
            ti++;
        }
        if (qi < q.length) return null;
        return { score: 400 - (last - first), ranges: ranges };
    }

    function paintLabel(node, text, ranges) {
        var i = 0;
        ranges.forEach(function (r) {
            if (r[0] > i) node.appendChild(document.createTextNode(text.slice(i, r[0])));
            var b = document.createElement("b");
            b.textContent = text.slice(r[0], r[1]);
            node.appendChild(b);
            i = r[1];
        });
        if (i < text.length) node.appendChild(document.createTextNode(text.slice(i)));
    }

    function renderPalette(query) {
        var q = String(query || "").trim().toLowerCase();
        cmdkList.textContent = "";
        shown = [];
        var hits = [];
        paletteItems.forEach(function (item, i) {
            var m = matchScore(q, item.label);
            if (!m) return;
            hits.push({ item: item, ranges: m.ranges, score: m.score, order: i });
        });
        GROUP_ORDER.forEach(function (group) {
            var inGroup = hits.filter(function (h) { return h.item.group === group; });
            if (!inGroup.length) return;
            inGroup.sort(function (a, b) { return (b.score - a.score) || (a.order - b.order); });
            var head = document.createElement("li");
            head.className = "cmdk-group";
            head.setAttribute("role", "presentation");
            head.textContent = group;
            cmdkList.appendChild(head);
            inGroup.forEach(function (h) {
                var li = document.createElement("li");
                li.className = "cmdk-item" + (h.item.current ? " is-current" : "");
                li.id = "cmdk-opt-" + shown.length;
                li.setAttribute("role", "option");
                li.setAttribute("aria-selected", "false");
                var g = document.createElement("span");
                g.className = "cmdk-item-glyph";
                g.setAttribute("aria-hidden", "true");
                g.textContent = h.item.glyph;
                var lab = document.createElement("span");
                lab.className = "cmdk-item-label";
                paintLabel(lab, h.item.label, h.ranges);
                var meta = document.createElement("span");
                meta.className = "cmdk-item-meta";
                meta.textContent = h.item.meta;
                li.appendChild(g);
                li.appendChild(lab);
                li.appendChild(meta);
                cmdkList.appendChild(li);
                shown.push({ el: li, item: h.item });
            });
        });
        if (cmdkEmpty) cmdkEmpty.hidden = shown.length > 0;
        select(0);
    }

    /* Wraps at both ends. The highlight is announced through
       aria-activedescendant on the input rather than by moving DOM focus,
       which is what keeps typing and arrowing in the same place. */
    function select(i) {
        if (!shown.length) {
            selected = 0;
            cmdkInput.removeAttribute("aria-activedescendant");
            return;
        }
        selected = (i + shown.length) % shown.length;
        shown.forEach(function (s, n) {
            s.el.setAttribute("aria-selected", n === selected ? "true" : "false");
        });
        var el = shown[selected].el;
        cmdkInput.setAttribute("aria-activedescendant", el.id);
        // "nearest" so arrowing down a long list scrolls it by one row, and
        // never with smooth behaviour — key repeat would fight the animation.
        if (el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }

    function activate(item) {
        if (!item) return;
        closePalette(true);              // unlock scroll BEFORE we try to scroll
        if (item.sec) { goToSection(item.sec); return; }
        if (!item.href) return;
        if (item.external) {
            var w = window.open(item.href, "_blank", "noopener");
            if (!w) window.location.href = item.href;
            return;
        }
        window.location.href = item.href;
    }

    var paletteClosing = false;
    function openPalette() {
        if (!hasPalette || palette.open) return;
        if (drawer && drawer.open) closeDrawer(true);
        paletteItems = collectItems();
        cmdkInput.value = "";
        renderPalette("");
        lockScroll();
        palette.classList.remove("is-closing");
        paletteClosing = false;
        palette.showModal();
        cmdkInput.focus();
        cmdkInput.select();
    }
    function finishPaletteClose() {
        paletteClosing = false;
        palette.classList.remove("is-closing");
        if (palette.open) palette.close();
    }
    function closePalette(immediate) {
        if (!palette || !palette.open) return;
        if (immediate || reduceMotion) { finishPaletteClose(); return; }
        if (paletteClosing) return;
        paletteClosing = true;
        palette.classList.add("is-closing");
        setTimeout(finishPaletteClose, 170);
    }
    if (hasPalette) {
        trapTab(palette);
        palette.addEventListener("cancel", function (e) { e.preventDefault(); closePalette(); });
        palette.addEventListener("close", function () {
            palette.classList.remove("is-closing");
            unlockScroll();
        });
        palette.addEventListener("click", function (e) {
            if (e.target === palette) { closePalette(); return; }
            var li = e.target.closest && e.target.closest(".cmdk-item");
            if (!li) return;
            for (var i = 0; i < shown.length; i++) {
                if (shown[i].el === li) { activate(shown[i].item); return; }
            }
        });
        cmdkList.addEventListener("mousemove", function (e) {
            var li = e.target.closest && e.target.closest(".cmdk-item");
            if (!li) return;
            for (var i = 0; i < shown.length; i++) {
                if (shown[i].el === li && i !== selected) { select(i); return; }
            }
        });
        cmdkInput.addEventListener("input", function () { renderPalette(cmdkInput.value); });
        cmdkInput.addEventListener("keydown", function (e) {
            if (e.key === "ArrowDown") { e.preventDefault(); select(selected + 1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); select(selected - 1); }
            else if (e.key === "Enter") {
                e.preventDefault();
                if (shown.length) activate(shown[selected].item);
            }
        });
        if (navCmd) navCmd.addEventListener("click", openPalette);
        var cmdkClose = document.getElementById("cmdk-close");
        if (cmdkClose) cmdkClose.addEventListener("click", function () { closePalette(); });
        // Arrows keep working after Tab has moved focus to the close button.
        palette.addEventListener("keydown", function (e) {
            if (document.activeElement === cmdkInput) return;
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            cmdkInput.focus();
            select(selected + (e.key === "ArrowDown" ? 1 : -1));
        });

        /* ⌘K / Ctrl-K anywhere, plus `/` as the second-nature alternative —
           suppressed while the reader is in a form field so the contact form
           can still contain a slash. */
        document.addEventListener("keydown", function (e) {
            var k = e.key ? e.key.toLowerCase() : "";
            if ((e.metaKey || e.ctrlKey) && k === "k") {
                e.preventDefault();
                if (palette.open) closePalette(); else openPalette();
                return;
            }
            if (k !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
            var t = e.target;
            var tag = t && t.tagName ? t.tagName.toLowerCase() : "";
            if (tag === "input" || tag === "textarea" || tag === "select" ||
                (t && t.isContentEditable) || palette.open || (drawer && drawer.open)) return;
            e.preventDefault();
            openPalette();
        });

        // Windows/Linux readers do not have a ⌘ key to press.
        var keyHint = document.getElementById("nav-cmd-key");
        if (keyHint && !/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)) {
            keyHint.textContent = "Ctrl K";
        }
    } else if (navCmd) {
        // No <dialog> support: do not advertise a palette that cannot open.
        navCmd.hidden = true;
    }

    /* ---------- 13. Scroll-direction-aware chrome ----------
       Condenses on the way down, expands on the way up, and NEVER leaves the
       viewport or drops opacity — a nav you have to go looking for was built
       and rejected here once already. Skipped entirely under reduced motion,
       where the height change has no transition and would read as a 14px jolt
       on every scroll reversal. */
    var lastY = window.scrollY || 0;
    var condensed = false;
    function updateChrome() {
        if (reduceMotion) return;
        var y = Math.max(0, window.scrollY || window.pageYOffset || 0);
        var dy = y - lastY;
        var next = condensed;
        if (y <= 90) next = false;
        else if (dy > 3) next = true;
        else if (dy < -6) next = false;
        lastY = y;
        if (next === condensed) return;
        condensed = next;
        root.classList.toggle("nav-condensed", condensed);
        // The bar's height changed, so the pill has to re-measure.
        placeMarker(true);
    }

    /* ---------- 14. Wire it up ---------- */
    buildRail();
    buildDrawerSections();
    // Stagger order follows DOM order across the static and generated rows.
    slice(document.querySelectorAll("#nav-drawer .drawer-stagger")).forEach(function (el, i) {
        el.style.setProperty("--i", String(i));
    });

    var navFrame = false;
    function onNavScroll() {
        if (navFrame) return;
        navFrame = true;
        requestAnimationFrame(function () {
            navFrame = false;
            updateProgress();
            updateChrome();
            var id = currentSectionId();
            if (id && id !== lastSpyId) {
                lastSpyId = id;
                setActive(id);
                /* Keep the URL honest while the reader scrolls by hand, so a
                   refresh or a copied link reflects where they actually are
                   instead of whatever hash they arrived with. */
                if (spyMayWriteHash) syncHashToSection(id);
            }
        });
    }
    function onNavResize() {
        updateProgress();
        buildBarTicks();
        placeMarker(true);
        lastSpyId = null;
        onNavScroll();
    }
    window.addEventListener("scroll", onNavScroll, { passive: true });
    window.addEventListener("resize", onNavResize, { passive: true });

    updateProgress();
    if (sections.length) {
        lastSpyId = currentSectionId();
        setActive(lastSpyId);
    }
    placeMarker(true);
    buildBarTicks();
    /* Webfonts swap after first paint and change every link width, so the
       pill has to be re-measured once the real metrics are in. */
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { placeMarker(true); buildBarTicks(); });
    }
    window.addEventListener("load", function () {
        updateProgress(); buildBarTicks(); placeMarker(true);
    });

    /* Arm hash-writing only once the reader drives the page themselves. Real
       user input (wheel / touch / keyboard) is the signal — a programmatic
       scroll from the anchor-landing code must not count. */
    var armSpyHash = function () {
        spyMayWriteHash = true;
        window.removeEventListener("wheel", armSpyHash);
        window.removeEventListener("touchstart", armSpyHash);
        window.removeEventListener("keydown", armSpyHash);
    };
    window.addEventListener("wheel", armSpyHash, { passive: true });
    window.addEventListener("touchstart", armSpyHash, { passive: true });
    window.addEventListener("keydown", armSpyHash);

    /* ---------- 15. Smooth-scroll for the remaining in-page links ----------
       Anchors inside the overlays and the rail are handled above (they have
       to close their overlay first, or the scroll lock swallows the scroll),
       so they are excluded here rather than double-bound. */
    slice(document.querySelectorAll('a[href^="#"]')).forEach(function (link) {
        if (link.closest("#nav-drawer, #cmdk, #section-rail")) return;
        link.addEventListener("click", function (e) {
            var href = link.getAttribute("href");
            if (!href || href.length < 2) return;
            var target = document.getElementById(href.slice(1));
            if (!target) return;
            e.preventDefault();
            goToSection(href.slice(1));
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
            /* Same pin-aware resolution as goToSection: scrollIntoView on a
               pinned section resolves against its fixed position and lands at
               the pin end. sectionScrollTop() measures the in-flow .pin-spacer
               and applies .band's scroll-margin-top by hand. */
            window.scrollTo({ top: sectionScrollTop(target), behavior: "auto" });
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
