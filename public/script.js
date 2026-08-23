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
   - Rotating hero subtitle (DORMANT: one entry, so it does not run —
     see the WCAG 2.2.2 note at the subtitle block before adding a second)
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

    /* ---------- Reduced motion flipped MID-SESSION ----------
       `reduceMotion` above is a SNAPSHOT taken at parse time. Every gate in
       this file reads it, so a reader who turns the preference on after the
       page has loaded — the macOS "Reduce motion" switch, or a browser devtools
       emulation — keeps every indefinite animation this file started. The CSS
       side is covered (each sheet has a `prefers-reduced-motion` block, and
       scroll.css §4 exists specifically for the mid-session case), but a CSS
       media query cannot stop a JS timer or an anime.js `loop: true`.

       Two things here run FOREVER rather than merely resting somewhere wrong,
       which is what makes it worth a live listener: the hero subtitle's
       setInterval. (An ambient `.bg-shape` drift used to be the second, but its
       markup never existed and the tween has been removed.)

       Reassigning `reduceMotion` is deliberate and does useful work beyond the
       two callbacks: `goToSection` stops smooth-scrolling, `closeDrawer` and
       `closePalette` take their immediate path, and `updateChrome` stops
       condensing the bar — all of them read the flag at CALL time. */
    var reduceStops = [];
    function onReduceMotion(fn) { reduceStops.push(fn); }
    (function () {
        var q = window.matchMedia("(prefers-reduced-motion: reduce)");
        var handler = function (ev) {
            if (!ev.matches) return;
            reduceMotion = true;
            /* Copy first: a callback is free to register nothing, but iterating
               the live array while clearing it is how this kind of thing skips
               half its work. */
            var stops = reduceStops.slice();
            reduceStops.length = 0;
            stops.forEach(function (fn) {
                try { fn(); } catch (err) { /* one bad stop must not block the rest */ }
            });
        };
        /* addListener is the pre-2021 Safari spelling; still worth the branch
           because matchMedia here is otherwise unguarded. */
        if (q.addEventListener) q.addEventListener("change", handler);
        else if (q.addListener) q.addListener(handler);
    })();

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

    /* ---------- Focus restoration that VERIFIES it landed ----------
       `el.focus()` on an element the layout has removed is a silent no-op:
       nothing throws, and `document.activeElement` is left on <body>. Both
       dialogs restore focus to their opener by calling focus() and trusting it,
       and for the drawer that opener is `.nav-toggle`, which nav.css sets to
       `display: none` above 760px.

       Measured on the built site at 1440px: with the drawer open, Escape closed
       it and left `document.activeElement` on BODY — `returned: false`. At
       390px the same sequence returned focus to `#nav-toggle` correctly.

       The path a real reader takes to that state is a RESIZE, not a click: the
       drawer is opened at a narrow width, then the window is widened or the
       phone rotated past 761px, and the matchMedia handler further down calls
       `closeDrawer(true)` — closing the drawer while its opener is being
       display:none'd in the same frame. Focus lands on <body>, so the next Tab
       starts again from the skip link and the reader's place in the document is
       gone. That is WCAG 2.4.3 Focus Order, and 2.4.7 for the moment in
       between where there is no focus indicator anywhere.

       So: try each candidate in turn and CHECK, rather than assuming.
       `getClientRects().length` screens out display:none cheaply; the
       activeElement comparison afterwards is what actually catches everything
       else (visibility:hidden, inert, a disabled control). */
    function restoreFocus(candidates) {
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (!el || !el.getClientRects || !el.getClientRects().length) continue;
            try { el.focus(); } catch (err) { continue; }
            if (document.activeElement === el) return el;
        }
        return null;
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
        // aria-expanded carries the state; the label stays "Menu" (see Base.astro).
        if (navToggle) navToggle.setAttribute("aria-expanded", "true");
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
            if (navToggle) navToggle.setAttribute("aria-expanded", "false");
            drawer.classList.remove("is-closing");
            unlockScroll();
            // The platform restores focus to the opener, but only if focus was
            // still inside the dialog when it closed. And the opener itself is
            // display:none above 760px, so it is tried FIRST and verified rather
            // than trusted — see restoreFocus(). `.nav-cmd` is the fallback
            // because it is the one control present at every width; the bar's
            // first link and the wordmark cover the no-palette build after it.
            if (document.activeElement === document.body) {
                restoreFocus([
                    navToggle,
                    navCmd,
                    navTrack ? navTrack.querySelector(".nav-link, .nav-cta") : null,
                    document.querySelector(".brand")
                ]);
            }
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
    var cmdkStatus = document.getElementById("cmdk-status");
    var hasPalette = canDialog && palette && cmdkInput && cmdkList;

    /* Both controls that open the palette advertise it with aria-haspopup, but
       neither said whether it was OPEN — measured: #nav-cmd had no
       aria-expanded attribute at all, on every page. One place to keep the two
       triggers honest. */
    var paletteTriggers = ["nav-cmd", "drawer-search"];
    function setPaletteExpanded(open) {
        paletteTriggers.forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.setAttribute("aria-expanded", open ? "true" : "false");
        });
    }

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
            /* role="group" wrapper rather than a bare heading row. A listbox may
               only own `option` and `group`; the old `li[role="presentation"]`
               heading left "This page" / "Site" / "Reach out" sitting loose
               inside the listbox as exposed text. The heading itself is
               aria-hidden now — the group's aria-label carries the same words
               once, in the place ARIA expects them. */
            var wrap = document.createElement("div");
            wrap.className = "cmdk-group";
            wrap.setAttribute("role", "group");
            wrap.setAttribute("aria-label", group);
            var head = document.createElement("div");
            head.className = "cmdk-group-label";
            head.setAttribute("aria-hidden", "true");
            head.textContent = group;
            wrap.appendChild(head);
            cmdkList.appendChild(wrap);
            inGroup.forEach(function (h) {
                var li = document.createElement("div");
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
                wrap.appendChild(li);
                shown.push({ el: li, item: h.item });
            });
        });
        if (cmdkEmpty) cmdkEmpty.hidden = shown.length > 0;
        /* A combobox whose popup is empty is NOT expanded. This was hard-coded
           "true" in the markup and never changed, so "zzzqqq" left the screen
           reader believing a listbox of results was on screen. */
        cmdkInput.setAttribute("aria-expanded", shown.length ? "true" : "false");
        announceCount(shown.length, q);
        select(0);
    }

    /* Debounced, because renderPalette() runs on every keystroke and a
       role="status" region rewritten per character is unusable — the reader
       never finishes a phrase. One announcement per typing pause is the
       APG-recommended behaviour for a combobox result count. */
    var announceTimer = null;
    function announceCount(n, query) {
        if (!cmdkStatus) return;
        if (announceTimer) clearTimeout(announceTimer);
        announceTimer = setTimeout(function () {
            if (!query) { cmdkStatus.textContent = ""; return; }   // full list; options speak
            cmdkStatus.textContent = n === 0
                ? "No results. Nothing matches that."
                : (n === 1 ? "1 result." : n + " results.");
        }, 420);
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
        setPaletteExpanded(true);
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
            setPaletteExpanded(false);
            /* Stop the status region holding a stale "No results." that a
               reader would hit again the next time the palette opens. */
            if (announceTimer) clearTimeout(announceTimer);
            if (cmdkStatus) cmdkStatus.textContent = "";
            unlockScroll();
            /* The platform restores focus to the opener, but only when focus was
               still inside the dialog at close time — the same gap the drawer
               already covers. Without this, closing the palette from a row that
               had been removed by a re-render dropped the ring to <body>. */
            /* Same verify-don't-trust rule as the drawer. `#nav-cmd` is visible
               at every width so this is belt-and-braces here, but it is hidden
               outright when <dialog> is unsupported, and a restore that silently
               did nothing is exactly the bug the drawer had. */
            if (document.activeElement === document.body) {
                restoreFocus([
                    document.getElementById("nav-cmd"),
                    document.getElementById("drawer-search"),
                    navTrack ? navTrack.querySelector(".nav-link, .nav-cta") : null,
                    document.querySelector(".brand")
                ]);
            }
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
                /* UNOBSERVE, or this rescue becomes a double entrance.
                   Rescuing only added `is-visible` and cleared the inline
                   from-state; the IntersectionObserver below was still
                   watching. So the next time the element intersected — a
                   scroll back up, or simply the first IO callback after the
                   rescue — the observer ran its `anime()` on an element that
                   was already fully visible, writing the from-state
                   (`translateY(22px)`, `opacity: 0`) back onto it and playing
                   the entrance a SECOND time.
                   That is the reported "the pop and appear animation happens
                   again after first hover": the entrance re-firing, not a
                   hover effect. Traced by watching one `.favorite-item` —
                   opacity reached 1, then a redundant `is-visible` write was
                   followed by inline `transform: translateY(22px); opacity:
                   1.11e-16` and a fresh 820ms ramp. Measured on `/`: 9
                   elements re-entered, and 3 on `/projects/`.
                   `revObserver` is `var`-scoped in the sibling branch below
                   and assigned before any listener that can call this, but it
                   is guarded anyway because this function also runs from a
                   `setTimeout` and from `load`. */
                if (typeof revObserver !== "undefined" && revObserver) {
                    revObserver.unobserve(el);
                }
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
                /* ALREADY REVEALED => NEVER RE-ANIMATE. Second line of defence
                   behind rescueStragglers' unobserve: an entrance is one-shot
                   by definition, so re-running it on an element already at its
                   resting state can only be a bug. Anything reaching here with
                   `is-visible` was revealed by another path (the rescue sweep,
                   showAll(), or an earlier callback), and the `anime()` calls
                   below would write the from-state back onto it. */
                if (el.classList.contains("is-visible")) return;
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

    /* ---------- Hero name + signature motif entrance (on load) ----------

       THE PER-LETTER SPLIT DESTROYED THE <h1>'s ACCESSIBLE NAME.
       Chrome's name computation inserts a boundary between inline elements, so
       once "Samuel" / "Woo" became nine separate `<span class="hero-char">`
       nodes the <h1> was exposed as the string "S a m u e l W o o" — read out
       letter by letter. It does not stop at the heading either: the hero band
       is `<section id="home" aria-labelledby="home-title">` and `home-title`
       IS this <h1>, so the landmark inherited the same name. Measured in
       Chrome's OWN accessibility tree (CDP Accessibility.getFullAXTree, not
       recomputed from attributes): on `/` the landmark inventory came back
       `region("S a m u e l W o o")` alongside the correctly-named
       region("Interests") / region("Projects") / region("Work") /
       region("Connect"). A screen-reader reader arriving at the home page
       therefore heard the site's owner spelled out, twice.

       Base.astro already solved exactly this for the brand wordmark in the top
       bar — "Letters are wrapped in aria-hidden and the accessible name comes
       from aria-label, so screen readers hear 'Samuel Woo — home', not
       's a m'" — and this is the same treatment applied to the runtime split:
       the glyphs become aria-hidden decoration and the real string is restated
       once, for AT only, using styles.css's existing `.visually-hidden`
       utility (which is clip-path + 1x1, deliberately NOT display:none, so the
       text stays in the a11y tree and stays available for name computation).

       Only the animated path is touched. With reduced motion on, or anime.js
       absent, `animate` is false, the split never happens and the <h1> keeps
       its authored text node — that path was always correct and stays so.
       aria-label is NOT used on the wrapper: these are plain <span>s with no
       role, and aria-label on a generic element is not required to be honoured.
       A real text node is. */
    if (animate) {
        var heroLines = document.querySelectorAll(".hero-name .hero-line");
        heroLines.forEach(function (line) {
            var accent = line.querySelector(".hero-accent");
            var host = accent || line;
            var text = host.textContent;
            host.textContent = "";

            /* The name, once, for AT. First child so it reads in source order. */
            var sr = document.createElement("span");
            sr.className = "visually-hidden";
            sr.textContent = text;
            host.appendChild(sr);

            /* The glyphs, as decoration. anime.js targets
               `.hero-name .hero-char` — a DESCENDANT selector, so it still
               matches through this wrapper. */
            var glyphs = document.createElement("span");
            glyphs.setAttribute("aria-hidden", "true");
            for (var i = 0; i < text.length; i++) {
                var ch = document.createElement("span");
                ch.className = "hero-char";
                ch.style.display = "inline-block";
                ch.style.willChange = "transform, opacity";
                ch.textContent = text[i];
                glyphs.appendChild(ch);
            }
            host.appendChild(glyphs);
        });
        window.anime({
            targets: ".hero-name .hero-char",
            translateY: [{ value: ["1.05em", "0em"] }],
            opacity: [0, 1],
            duration: 900,
            delay: window.anime.stagger(45, { start: 220 }),
            easing: "easeOutExpo"
        });

        var motif = document.querySelectorAll(".projects-motif .motif-draw");
        motif.forEach(function (el) {
            var len = 0;
            try { len = el.getTotalLength(); } catch (e) { len = 400; }
            el.style.strokeDasharray = len;
            el.style.strokeDashoffset = len;
        });
        window.anime({
            targets: ".projects-motif .motif-draw",
            strokeDashoffset: [window.anime.setDashoffset, 0],
            duration: 2200,
            delay: window.anime.stagger(260, { start: 400 }),
            easing: "easeInOutSine"
        });
    }

    /* Count-up kicker numerals: REMOVED. It observed `.kicker-num`, which
       appears in no markup on any page (verified: 0 hits in src/ and 0 in all
       four built pages), so it constructed an IntersectionObserver and then
       observed an empty list. The matching `.kicker-num` colour rule in
       styles.css went with it. If numeric count-ups are wanted again, the
       numerals that exist today are `.project-index`, `.interest-index`,
       `.case-index` and `.bento-plate-n`. */

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

    /* Ambient background-shape drift: REMOVED. It animated
       `.bg-shapes .bg-shape`, which exists in no markup on any page (0 hits in
       src/ and 0 in every built page) — so it started an endless `loop: true`
       tween over an empty target list and registered a reduced-motion stop for
       it. Same dead-selector class as the count-up numerals above. */

    /* ---------- Rotating hero subtitle ----------
       WCAG 2.2.2 Pause, Stop, Hide (Level A): moving or blinking information
       that starts automatically, runs for more than five seconds and sits
       alongside other content needs a mechanism to pause, stop or hide it.

       What this actually did, measured on the built site with reduced motion
       OFF (the default almost everyone gets): `setInterval` registered at
       4000ms, and `.fade-out` toggled onto `#rotating-subtitle` at t=2763ms,
       6779ms and 10796ms — a 4016ms period — held ~502ms each time. Combined
       with styles.css's `.hero-subtitle { transition: opacity .3s ease }` and
       `.hero-subtitle.fade-out { opacity: 0 }`, the hero's one-line summary
       faded out and back in every four seconds, indefinitely, and there was no
       pause control anywhere in the band (measured: zero buttons or inputs in
       the hero band, no aria-live on the element).

       And it was blinking for NOTHING. `subtitles` has exactly one entry, so
       `idx2 = (idx2 + 1) % 1` is always 0 and the line it re-assigns is the
       line already there. The text never changed. The animation carried no
       information at all — it was a four-second flicker on the first sentence a
       reader tries to read.

       So the fix is to not run it: with one entry there is nothing to rotate,
       and removing the motion removes the 2.2.2 obligation outright rather than
       satisfying it with a control nobody needs.

       IF `subtitles` EVER GROWS PAST ONE ENTRY, THIS NEEDS A VISIBLE PAUSE
       CONTROL BEFORE IT SHIPS. The `length > 1` guard is what keeps that
       decision from being made by accident: adding a second string turns the
       rotation back on, and a rotation without a pause button is a Level A
       failure. The control belongs next to the subtitle in the hero, which is
       styles.css / layout.css territory, not this file's.

       Reduced motion, for the record: the load-time gate below was already
       correct, and `.reveal { opacity: 1 !important }` in styles.css's
       reduced-motion block outranks `.hero-subtitle.fade-out { opacity: 0 }`
       (the element carries `class="hero-subtitle reveal"`), so even a
       mid-session flip never showed a visible fade. The timer kept running
       though — invisible work on a page that had just been asked to calm down —
       so it registers a stop as well. */
    var subtitles = [
        "software engineer, part-time robot wrangler"
    ];
    var subtitleEl = document.getElementById("rotating-subtitle");
    if (subtitleEl && subtitles.length > 1 && !reduceMotion) {
        var idx2 = 0;
        var subFade = null;
        var subTimer = setInterval(function () {
            subtitleEl.classList.add("fade-out");
            subFade = setTimeout(function () {
                subFade = null;
                idx2 = (idx2 + 1) % subtitles.length;
                subtitleEl.textContent = subtitles[idx2];
                subtitleEl.classList.remove("fade-out");
            }, 300);
        }, 4000);
        onReduceMotion(function () {
            clearInterval(subTimer);
            if (subFade) { clearTimeout(subFade); subFade = null; }
            /* Never leave the line parked mid-fade. */
            subtitleEl.classList.remove("fade-out");
        });
    }
})();
