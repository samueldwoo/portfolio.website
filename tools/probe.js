/* ============================================================================
 * probe.js — the shared in-page audit, evaluated identically in every engine.
 *
 * This file is ONE JavaScript expression: a function literal. Both drivers read
 * it as text and evaluate it, so there is exactly one copy of the measurement
 * logic and no chance of Chrome and WebKit being asked different questions.
 *
 *   Selenium   : driver.execute_script("return (" + SRC + ")(arguments[0])", opts)
 *   Playwright : page.evaluate("(" + SRC + ")(" + JSON.stringify(opts) + ")")
 *
 * Contract:
 *   - MUST stay synchronous. Selenium's execute_script does not await promises,
 *     so anything async here would silently return null in Chrome/Firefox while
 *     working in WebKit — exactly the cross-engine asymmetry this harness exists
 *     to prevent. Scroll choreography and waiting belong in the drivers.
 *   - MUST be side-effect-free on the page under test, with one exception: the
 *     descender probe appends a detached measurement node and removes it again
 *     before returning. Nothing else is created, and no site style or class is
 *     ever mutated.
 *   - MUST return only JSON-serialisable values (WebDriver serialises the
 *     return value; DOM nodes, functions and NaN would be lost or throw).
 * ==========================================================================*/
(function (opts) {
  opts = opts || {};

  var STRANDED = opts.strandedSelectors ||
    [".reveal", ".pass", ".case-block", "h1", "h2"];
  var OPACITY_MIN = typeof opts.opacityMin === "number" ? opts.opacityMin : 0.99;
  var MAX_REPORTED = opts.maxReported || 25;

  /* Layout landmarks. Deliberately a fixed, page-agnostic list: selectors that
     match nothing are reported as `present:false` rather than dropped, so the
     per-engine JSON always has the same shape and can be diffed key-by-key. */
  var KEY_SELECTORS = opts.keySelectors || [
    "header.topbar", ".topbar-inner", ".brand", "#nav-toggle", "#nav-links",
    "h1", ".hero-name", ".section-title", ".band-inner", ".site-foot",
    ".hero-canvas-wrap", ".pass", ".case-block", ".reveal"
  ];

  var out = {};

  /* ---------------------------------------------------------------- helpers */
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }

  function r2(n) {
    if (n === null || n === undefined || typeof n !== "number" || !isFinite(n)) return null;
    return Math.round(n * 100) / 100;
  }

  function label(el) {
    if (!el || el.nodeType !== 1) return String(el);
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    var cls = (el.getAttribute("class") || "").trim();
    if (cls) s += "." + cls.split(/\s+/).slice(0, 3).join(".");
    return s;
  }

  function snippet(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
  }

  function qsa(sel) {
    try { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
    catch (e) { return []; }
  }

  /* An element is "not rendered" when it has no box at all. Such elements are
     neither visible nor stranded — a mobile-only nav toggle at a desktop width
     is display:none by design and must not be counted as a failure. */
  function notRendered(el) {
    var cs = getComputedStyle(el);
    if (cs.display === "none") return "display:none";
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return "zero-box";
    if (!el.getClientRects().length) return "no-client-rects";
    return null;
  }

  /* Own opacity is what the deliverable asks about. Effective opacity (the
     product of the element's own and every ancestor's) is carried alongside it
     because an ancestor stuck at 0 strands a child that reports 1 — without
     this, such a bug reads as a pass. */
  function effectiveOpacity(el) {
    var o = 1, n = el;
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return 0;
      var v = num(cs.opacity);
      if (v !== null) o *= v;
      n = n.parentElement;
    }
    return o;
  }

  /* ------------------------------------------------------------ environment */
  var de = document.documentElement;
  out.env = {
    url: location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    innerWidth: innerWidth,
    innerHeight: innerHeight,
    devicePixelRatio: r2(devicePixelRatio),
    maxTouchPoints: navigator.maxTouchPoints,
    hasOntouchstart: "ontouchstart" in window,
    htmlClasses: (de.getAttribute("class") || "").trim(),
    bodyClasses: (document.body.getAttribute("class") || "").trim(),
    scrollY: r2(window.pageYOffset || de.scrollTop || 0),
    docScrollHeight: de.scrollHeight,
    readyState: document.readyState,
    prefersReducedMotion: !!(window.matchMedia &&
      matchMedia("(prefers-reduced-motion: reduce)").matches),
    hoverAny: !!(window.matchMedia && matchMedia("(any-hover: hover)").matches),
    pointerCoarse: !!(window.matchMedia && matchMedia("(any-pointer: coarse)").matches)
  };

  /* ----------------------------------------------------- animation libraries
     Presence of the global is the load signal. `version` is pulled where the
     library exposes one so a silently-swapped vendored file is visible in the
     diff, and ScrollTrigger is checked both as a bare global and as a GSAP
     plugin because GSAP registers it in both places depending on build. */
  function libInfo(getter) {
    try {
      var v = getter();
      if (v === undefined || v === null) return { loaded: false };
      return {
        loaded: true,
        type: typeof v,
        version: (v && v.version) ? String(v.version) : null
      };
    } catch (e) { return { loaded: false, error: String(e).slice(0, 120) }; }
  }

  out.libs = {
    gsap: libInfo(function () { return window.gsap; }),
    anime: libInfo(function () { return window.anime; }),
    Motion: libInfo(function () { return window.Motion; }),
    ScrollTrigger: libInfo(function () { return window.ScrollTrigger; })
  };
  out.libs.ScrollTrigger.viaGsapPlugin = !!(window.gsap && window.gsap.plugins &&
    window.gsap.plugins.scrollTrigger) ||
    !!(window.gsap && typeof window.gsap.getById === "function" &&
       window.ScrollTrigger !== undefined);
  out.libs.SplitText = libInfo(function () { return window.SplitText; });
  /* Motion's UMD bundle exposes its API surface on window.Motion; record which
     entry points are actually there, since a partial bundle still sets the
     global and would otherwise look like a clean load. */
  out.libs.Motion.api = window.Motion
    ? ["animate", "scroll", "inView", "spring", "hover", "press"]
        .filter(function (k) { return typeof window.Motion[k] === "function"; })
    : [];

  /* ------------------------------------------------------------ CSS support
     Feature queries for the properties this site's motion layer depends on.
     overflow-clip-margin is the one under investigation (deliverable 3): it
     gives the SplitText line masks room for descenders and is unsupported in
     Safari < 16.4, where every g/y/p tail would be shaved off mid-tween. */
  function supports(prop, val) {
    try { return !!(window.CSS && CSS.supports && CSS.supports(prop, val)); }
    catch (e) { return null; }
  }

  out.cssSupport = {
    "overflow-clip-margin:0.2em": supports("overflow-clip-margin", "0.2em"),
    "overflow-clip-margin:1px": supports("overflow-clip-margin", "1px"),
    "overflow:clip": supports("overflow", "clip"),
    "backdrop-filter:blur(2px)": supports("backdrop-filter", "blur(2px)"),
    "text-wrap:balance": supports("text-wrap", "balance"),
    "aspect-ratio:1": supports("aspect-ratio", "1"),
    "scroll-behavior:smooth": supports("scroll-behavior", "smooth"),
    "clip-path:inset(0)": supports("clip-path", "inset(0)")
  };

  /* CSS.supports can lie by omission: a browser may parse a property and then
     ignore it. Round-tripping through a real element and reading the computed
     value back is the stronger signal, so both are reported. */
  (function () {
    var probe = document.createElement("div");
    probe.style.cssText = "position:absolute;left:-9999px;top:0;font-size:16px;" +
      "overflow:clip;overflow-clip-margin:0.2em;";
    document.body.appendChild(probe);
    var cs = getComputedStyle(probe);
    var raw = cs.overflowClipMargin || cs.getPropertyValue("overflow-clip-margin") || "";
    /* 0.2em at font-size 16px is 3.2px, but engines report resolved lengths at
       their own sub-pixel precision — Chrome says "3.1875px" (3.2 snapped to
       1/16px). A string prefix match on "3.2" therefore reports a WORKING
       browser as broken, so the value is parsed and range-checked instead. An
       empty string or 0px means the declaration was dropped. */
    var clipPx = parseFloat(raw);
    out.cssSupport.computed = {
      overflowClipMargin: raw || null,
      overflowClipMarginPx: isNaN(clipPx) ? null : Math.round(clipPx * 1000) / 1000,
      overflow: cs.overflow,
      honoured: !isNaN(clipPx) && clipPx > 0.05,
      matchesExpected0_2em: !isNaN(clipPx) && Math.abs(clipPx - 3.2) < 0.25
    };
    probe.parentNode.removeChild(probe);
  })();

  /* ------------------------------------------------------ horizontal overflow
     `body { overflow-x: hidden }` is set by this site's stylesheet, which
     CLAMPS scrollWidth on the scrolling box and so suppresses the documented
     scrollWidth > clientWidth signal. The requested comparison is still
     reported verbatim, but a geometric sweep runs alongside it: any rendered
     element whose right edge lands past the viewport's right edge is real
     overflow whether or not a scrollbar was allowed to appear. Without that
     second measure this check would report a clean pass on a clipped page. */
  var docOverflowPx = de.scrollWidth - de.clientWidth;
  var bodyOverflowPx = document.body.scrollWidth - document.body.clientWidth;

  var overflow = {
    documentElement: {
      scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
      overflowPx: docOverflowPx
    },
    body: {
      scrollWidth: document.body.scrollWidth, clientWidth: document.body.clientWidth,
      overflowPx: bodyOverflowPx,
      computedOverflowX: getComputedStyle(document.body).overflowX
    },
    scrollWidthExceedsClientWidth: docOverflowPx > 1 || bodyOverflowPx > 1,
    clampedByOverflowXHidden: getComputedStyle(document.body).overflowX === "hidden"
  };

  /* Geometric sweep. Runs at scrollX 0 so viewport coordinates are absolute. */
  var limit = de.clientWidth;
  var offenders = [];
  var selfScrollers = [];
  var all = qsa("body *");
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (notRendered(el)) continue;
    var cs = getComputedStyle(el);

    /* An element that scrolls its own content horizontally is a deliberate
       carousel/strip, not a layout break — recorded separately, never failed. */
    var ox = cs.overflowX;
    if (el.scrollWidth - el.clientWidth > 1) {
      if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") {
        if (selfScrollers.length < MAX_REPORTED) {
          selfScrollers.push({
            el: label(el), overflowX: ox,
            innerOverflowPx: el.scrollWidth - el.clientWidth, intentional: true
          });
        }
        continue;
      }
    }

    var rect = el.getBoundingClientRect();
    /* Fixed-position chrome is measured against the viewport by definition and
       is excluded from the page-width verdict. */
    if (cs.position === "fixed") continue;
    var overhang = rect.right - limit;
    if (overhang > 1) {
      /* Not every overhang is a defect. This site paints deliberately oversized
         ambient art (.glow, .atmosphere, the shape-field SVGs) that is meant to
         bleed past the edge and be clipped by `body { overflow-x: hidden }`.
         Failing on those would bury a genuine content break under a dozen
         by-design entries. Decorative overhang is still reported — its size is
         worth diffing across engines — but only overhanging CONTENT counts
         toward the verdict. */
      var interactive = !!el.closest("a,button,input,select,textarea,[tabindex],[role=button]");
      var ownText = (el.textContent || "").trim().length > 0;
      var ariaHidden = !!el.closest('[aria-hidden="true"]');
      var svgArt = typeof SVGElement !== "undefined" && el instanceof SVGElement;
      var noHitTarget = cs.pointerEvents === "none";
      var decorative = (ariaHidden || svgArt || (noHitTarget && !ownText)) && !interactive;

      var rec = {
        el: label(el), text: snippet(el),
        right: r2(rect.right), left: r2(rect.left),
        width: r2(rect.width), overhangPx: r2(overhang),
        position: cs.position, overflowX: ox,
        decorative: decorative,
        why: decorative
          ? (ariaHidden ? "aria-hidden subtree" : svgArt ? "svg art" : "pointer-events:none, no text")
          : (interactive ? "interactive" : ownText ? "text content" : "box with no text"),
        transform: cs.transform === "none" ? "none" : cs.transform.slice(0, 60)
      };
      offenders.push(rec);
    }
  }
  offenders.sort(function (a, b) { return b.overhangPx - a.overhangPx; });
  var contentOffenders = offenders.filter(function (o) { return !o.decorative; });
  var decorOffenders = offenders.filter(function (o) { return o.decorative; });

  overflow.viewportRightEdge = limit;
  overflow.offenderCount = offenders.length;
  overflow.worstOverhangPx = offenders.length ? offenders[0].overhangPx : 0;
  overflow.contentOffenderCount = contentOffenders.length;
  overflow.worstContentOverhangPx = contentOffenders.length ? contentOffenders[0].overhangPx : 0;
  overflow.offenders = contentOffenders.slice(0, MAX_REPORTED);
  overflow.decorativeOffenders = decorOffenders.slice(0, MAX_REPORTED);
  overflow.intentionalScrollers = selfScrollers;
  /* Verdict: overflow exists if the scrollWidth signal fires, or if real
     content hangs past the right edge by more than a rounding pixel. */
  overflow.hasHorizontalOverflow =
    overflow.scrollWidthExceedsClientWidth || overflow.worstContentOverhangPx > 1;
  out.horizontalOverflow = overflow;

  /* ------------------------------------------------------ stranded elements
     Valid only after the driver has scrolled to the bottom: an element at
     opacity 0 below the fold is waiting for its scroll observer, not broken.
     Once the page has been scrolled through, anything still transparent has
     had its trigger pass and failed to fire. */
  var stranded = { opacityMin: OPACITY_MIN, scrollY: out.env.scrollY, bySelector: {} };
  var strandedTotal = 0, checkedTotal = 0;
  var strandedList = [];

  for (var s = 0; s < STRANDED.length; s++) {
    var sel = STRANDED[s];
    var nodes = qsa(sel);
    var bucket = {
      matched: nodes.length, rendered: 0, notRendered: 0,
      ok: 0, stranded: 0, hiddenByAncestor: 0, worstOpacity: null
    };
    for (var n = 0; n < nodes.length; n++) {
      var node = nodes[n];
      var why = notRendered(node);
      if (why) { bucket.notRendered++; continue; }
      bucket.rendered++;
      var ownOp = num(getComputedStyle(node).opacity);
      if (ownOp === null) ownOp = 1;
      var effOp = effectiveOpacity(node);
      if (bucket.worstOpacity === null || ownOp < bucket.worstOpacity) {
        bucket.worstOpacity = r2(ownOp);
      }
      if (ownOp < OPACITY_MIN) {
        bucket.stranded++;
        if (strandedList.length < MAX_REPORTED) {
          var rct = node.getBoundingClientRect();
          strandedList.push({
            selector: sel, el: label(node), text: snippet(node),
            ownOpacity: r2(ownOp), effectiveOpacity: r2(effOp),
            visibility: getComputedStyle(node).visibility,
            transform: getComputedStyle(node).transform === "none"
              ? "none" : getComputedStyle(node).transform.slice(0, 60),
            /* Absolute document offset, so a reader can find the element
               without reproducing the exact scroll position. */
            docTop: r2(rct.top + (window.pageYOffset || 0)),
            inViewport: rct.bottom > 0 && rct.top < innerHeight
          });
        }
      } else if (effOp < OPACITY_MIN) {
        bucket.hiddenByAncestor++;
      } else {
        bucket.ok++;
      }
    }
    strandedTotal += bucket.stranded;
    checkedTotal += bucket.rendered;
    stranded.bySelector[sel] = bucket;
  }
  stranded.totalRendered = checkedTotal;
  stranded.totalStranded = strandedTotal;
  stranded.examples = strandedList;
  stranded.hasStranded = strandedTotal > 0;
  out.stranded = stranded;

  /* ----------------------------------------------------------- key metrics
     Numeric layout snapshot for engine-to-engine diffing. Font metrics are
     included because text measurement is the usual source of cross-engine
     layout divergence, and a raw px diff on a heading is the fastest way to
     see it. */
  var metrics = {};
  for (var k = 0; k < KEY_SELECTORS.length; k++) {
    var ksel = KEY_SELECTORS[k];
    var kel = document.querySelector(ksel);
    if (!kel) { metrics[ksel] = { present: false }; continue; }
    var kcs = getComputedStyle(kel);
    var krect = kel.getBoundingClientRect();
    metrics[ksel] = {
      present: true,
      x: r2(krect.left), y: r2(krect.top + (window.pageYOffset || 0)),
      width: r2(krect.width), height: r2(krect.height),
      display: kcs.display, position: kcs.position,
      opacity: r2(num(kcs.opacity)),
      fontSize: kcs.fontSize, lineHeight: kcs.lineHeight,
      fontWeight: kcs.fontWeight,
      fontFamily: (kcs.fontFamily || "").split(",")[0].replace(/["']/g, ""),
      letterSpacing: kcs.letterSpacing,
      /* scrollWidth/clientWidth kept per-landmark so a single overflowing
         section can be attributed without re-running the whole sweep. */
      scrollWidth: kel.scrollWidth, clientWidth: kel.clientWidth,
      transform: kcs.transform === "none" ? "none" : kcs.transform.slice(0, 60)
    };
  }
  out.keyMetrics = metrics;

  /* ------------------------------------------------------ resource failures
     A vendored library that 404s still leaves window.gsap undefined, but the
     Resource Timing entry names the file — which turns "something did not
     load" into "this path is wrong". responseStatus is not universal, so a
     zero-byte non-cached entry is treated as the fallback failure signal. */
  var resources = [];
  try {
    var entries = performance.getEntriesByType("resource");
    for (var e2 = 0; e2 < entries.length; e2++) {
      var en = entries[e2];
      var status = typeof en.responseStatus === "number" ? en.responseStatus : null;
      var emptyBody = en.decodedBodySize === 0 && en.transferSize === 0 &&
        en.duration === 0;
      if ((status !== null && status >= 400) || (status === null && emptyBody)) {
        resources.push({
          name: String(en.name).slice(-90),
          initiatorType: en.initiatorType,
          responseStatus: status,
          transferSize: en.transferSize,
          decodedBodySize: en.decodedBodySize,
          /* Flagged on the weaker signal — worth a human glance, not a hard
             failure, because a cross-origin or cached entry can look identical. */
          inferred: status === null
        });
      }
    }
  } catch (e) { resources.push({ error: String(e).slice(0, 120) }); }
  out.resourceFailures = resources;

  /* -------------------------------------------------- hover-only affordances
     A control that only becomes visible or reachable on :hover is unreachable
     on a touch device. Every rule in the page's own stylesheets whose selector
     contains :hover is walked; a rule is a risk only if it turns visibility on
     (opacity from 0, visibility, display) rather than merely decorating. Rules
     landing on ::before/::after are decorative by construction — the host
     element is still tappable — and are counted separately. */
  var hoverRisks = [];
  var hoverRuleCount = 0, hoverDecorative = 0, sheetsUnreadable = 0;
  try {
    for (var sh = 0; sh < document.styleSheets.length; sh++) {
      var rules;
      try { rules = document.styleSheets[sh].cssRules; }
      catch (e) { sheetsUnreadable++; continue; }
      if (!rules) continue;
      var stack = Array.prototype.slice.call(rules);
      while (stack.length) {
        var rule = stack.shift();
        if (rule.cssRules) {
          stack = stack.concat(Array.prototype.slice.call(rule.cssRules));
          continue;
        }
        if (!rule.selectorText || rule.selectorText.indexOf(":hover") === -1) continue;
        hoverRuleCount++;
        var st = rule.style;
        if (!st) continue;
        var gates = [];
        if (st.opacity !== "" && num(st.opacity) !== null && num(st.opacity) > 0) gates.push("opacity");
        if (st.visibility === "visible") gates.push("visibility");
        if (st.display !== "" && st.display !== "none") gates.push("display");
        if (st.pointerEvents === "auto") gates.push("pointer-events");
        if (!gates.length) continue;
        var pseudo = /::(before|after|marker|placeholder)/.test(rule.selectorText);
        if (pseudo) { hoverDecorative++; continue; }
        hoverRisks.push({
          selector: rule.selectorText.slice(0, 120),
          gates: gates,
          /* Does the selector's non-hover form actually exist on this page? A
             risky-looking rule for markup that is not here is not a live bug. */
          matchesOnPage: qsa(rule.selectorText.replace(/:hover/g, "")).length
        });
      }
    }
  } catch (e) { hoverRisks.push({ error: String(e).slice(0, 120) }); }
  out.hoverAffordances = {
    hoverRulesSeen: hoverRuleCount,
    decorativePseudoOnly: hoverDecorative,
    sheetsUnreadable: sheetsUnreadable,
    risks: hoverRisks.slice(0, MAX_REPORTED),
    /* Only rules that gate visibility AND match real markup are live risks. */
    liveRiskCount: hoverRisks.filter(function (r) { return r.matchesOnPage > 0; }).length
  };

  /* ------------------------------------------------------- reveal machinery
     Counts that explain a stranded verdict: how many .reveal nodes the JS path
     marked visible, and whether the GSAP path claimed them instead. */
  out.revealState = {
    reveal: qsa(".reveal").length,
    revealIsVisible: qsa(".reveal.is-visible").length,
    gsapReveal: qsa(".gsap-reveal").length,
    motionSpring: qsa(".motion-spring").length,
    srlineMasks: qsa(".srline-mask").length,
    srlines: qsa(".srline").length,
    htmlJsAnim: de.classList.contains("js-anim"),
    htmlGsapOn: de.classList.contains("gsap-on"),
    htmlMotionOn: de.classList.contains("motion-on")
  };

  /* --------------------------------------------------- descender clip probe
     Deliverable 3, measured rather than assumed. Three synthetic line boxes
     replicate the real mask: `.section-title` sets line-height 1.0, so the
     line box is exactly 1em and Space Grotesk's descenders fall outside it.
     SplitText sets `overflow: clip` inline on each `.srline-mask`, and the
     stylesheet's `overflow-clip-margin: 0.2em` is what keeps the tails.

       control : overflow visible          — the unclipped truth
       masked  : clip + 0.2em clip margin  — what the site actually ships
       nomargin: clip, no clip margin      — what a Safari < 16.4 renders,
                                             since it drops the unknown
                                             property and keeps the clip

     The nodes are returned with their geometry so the driver can screenshot
     each one and compare where ink actually stops. `nomargin` doubles as a
     positive control: if its painted extent does not come up short, the
     screenshot comparison is not sensitive enough to trust either verdict. */
  var descender = { built: false };
  try {
    var host = document.createElement("div");
    host.id = "__ov_descender_probe";
    host.setAttribute("data-ov-harness", "1");
    /* Parked at a known, isolated spot at the top of the document so the
       driver can screenshot each cell without page content bleeding in. */
    host.style.cssText = "position:absolute;left:0;top:0;z-index:2147483647;" +
      "background:#ffffff;padding:0;margin:0;width:760px;";

    var titleEl = document.querySelector(".section-title") || document.querySelector("h2");
    var tcs = titleEl ? getComputedStyle(titleEl) : null;
    var fontFamily = tcs ? tcs.fontFamily : "system-ui";
    /* Fixed size rather than the live heading size: the probe must mean the same
       thing at every viewport. 160px rather than something heading-sized because
       descender overspill scales with the font — at 64px the whole effect was
       only ~3px, barely above antialiasing noise, and a test whose signal sits
       on the tolerance boundary is a coin flip. Clipping is proportional, so
       amplifying the glyph does not change the verdict, only its confidence. */
    var fontSize = 160;

    /* The display face is fetched from Google Fonts at runtime. If it has not
       loaded, this probe is measuring the fallback's descenders, not Space
       Grotesk's — which does not invalidate the clip-margin verdict but does
       change the pixel numbers, so it has to be on the record.

       document.fonts.check() alone is a trap here: called without a weight it
       defaults to 400, and this site only ever loads the weights it uses, so
       the 400 face is legitimately "unloaded" while the 700 face the headings
       render in is present. That mismatch reported a perfectly working webfont
       as missing. The weight is therefore specified, and a width comparison
       against a deliberately non-existent family is used as the real proof —
       if the family renders wider or narrower than the fallback, it is active. */
    function measureFamily(family, weight) {
      var span = document.createElement("span");
      span.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;" +
        "white-space:nowrap;font-size:100px;font-weight:" + (weight || 700) +
        ";font-family:" + family;
      span.textContent = "gypqj WWW";
      document.body.appendChild(span);
      var w = span.getBoundingClientRect().width;
      span.parentNode.removeChild(span);
      return Math.round(w * 100) / 100;
    }
    try {
      var wReal = measureFamily('"Space Grotesk"', 700);
      var wBogus = measureFamily('"__ov_no_such_font__"', 700);
      descender.displayFont = {
        checkAt700: !!(document.fonts && document.fonts.check('700 160px "Space Grotesk"')),
        checkAt400: !!(document.fonts && document.fonts.check('400 160px "Space Grotesk"')),
        widthWithFamily: wReal,
        widthFallback: wBogus,
        /* A real difference in advance width is direct evidence the face is
           being used to shape text, independent of any API's opinion. */
        renderingWithFace: Math.abs(wReal - wBogus) > 1,
        fontsStatus: document.fonts ? document.fonts.status : null
      };
      descender.displayFontLoaded = descender.displayFont.renderingWithFace;
    } catch (e) { descender.displayFontLoaded = null; }

    var variants = [
      { key: "control", css: "overflow:visible;" },
      { key: "masked", css: "overflow:clip;overflow-clip-margin:0.2em;" },
      { key: "nomargin", css: "overflow:clip;" }
    ];
    var cellHtml = "";
    for (var v = 0; v < variants.length; v++) {
      cellHtml +=
        /* The cell is the screenshot target and must be TALLER than the line
           box it wraps. With line-height 1 the inner content box is exactly
           1em, so descenders paint outside it; if the cell were the same
           height, the screenshot crop would cut those tails off and every
           variant would look clipped — the crop, not the CSS, would be doing
           the clipping and the whole comparison would be void. The 48px of
           bottom padding is the headroom that makes the difference visible. */
        '<div id="__ov_cell_' + variants[v].key + '" ' +
        'style="background:#ffffff;padding:0 0 120px 0;margin:0 0 8px 0;width:760px;">' +
          '<div style="' + variants[v].css +
          'font-family:' + fontFamily.replace(/"/g, "'") + ';' +
          'font-size:' + fontSize + 'px;line-height:1;font-weight:700;' +
          'color:#000000;background:#ffffff;width:760px;">' +
            /* Descender-heavy and ascender-free on the right so any vertical
               shave shows up as missing ink at a predictable place. */
            'gypqj' +
          '</div>' +
        '</div>';
    }
    host.innerHTML = cellHtml;
    document.body.appendChild(host);

    descender.built = true;
    descender.fontFamily = fontFamily;
    descender.fontSize = fontSize;
    descender.cells = {};
    for (var v2 = 0; v2 < variants.length; v2++) {
      var key = variants[v2].key;
      var cell = document.getElementById("__ov_cell_" + key);
      var inner = cell.firstChild;
      var cr = cell.getBoundingClientRect();
      var ir = inner.getBoundingClientRect();
      descender.cells[key] = {
        cellId: "__ov_cell_" + key,
        /* Document-absolute, since the driver screenshots by element handle
           but may also want to crop a full-page shot. */
        x: r2(cr.left + (window.pageXOffset || 0)),
        y: r2(cr.top + (window.pageYOffset || 0)),
        width: r2(cr.width), height: r2(cr.height),
        innerHeight: r2(ir.height),
        computedOverflow: getComputedStyle(inner).overflow,
        computedClipMargin: getComputedStyle(inner).overflowClipMargin ||
          getComputedStyle(inner).getPropertyValue("overflow-clip-margin") || null
      };
    }
    /* Left in the DOM on purpose: the driver screenshots these cells straight
       after this call and tears the node down itself via removeDescenderProbe.
       Returning geometry for nodes that no longer exist would be useless. */
  } catch (e) {
    descender.error = String(e).slice(0, 200);
  }
  out.descenderProbe = descender;

  /* ------------------------------------------------------------ page errors
     Populated by an init-script hook where the driver can install one
     (Chrome CDP, Playwright). Absent in Firefox, which is covered by BiDi
     log handlers on the driver side instead. */
  out.inPageErrors = (window.__ovErrors && window.__ovErrors.slice(0, MAX_REPORTED)) || [];

  return out;
});
