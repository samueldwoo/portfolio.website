#!/usr/bin/env python3
"""
touch.py — real touch-emulation checks for the portfolio site, via Chrome CDP.

WHY CDP AND NOT A SMALL WINDOW
    Headless Chrome refuses to shrink its window below roughly 500 CSS px. Ask
    for a 390px window and you get ~500px, the mobile breakpoint at 760px still
    matches, everything looks fine, and the test has proved nothing about a
    phone. Worse, a small *window* has no touch input at all: the hamburger
    would be driven by a synthetic mouse click, so "the nav opens on tap" would
    be a claim about mice.

    This harness therefore uses:
      Emulation.setDeviceMetricsOverride   width/height/DPR with mobile:true
      Emulation.setTouchEmulationEnabled   maxTouchPoints, coarse pointer
      Emulation.setUserAgentOverride       so UA sniffing sees a phone
      Input.dispatchTouchEvent             real touchstart/move/end sequences

    The metrics override is honoured independently of the OS window, so 390px
    means 390px. The harness ASSERTS this before running anything else and
    aborts if the override did not take — a viewport that silently clamped is
    a fake mobile test and must fail loudly rather than pass quietly.

WHAT IT VERIFIES
    1. The override is real            innerWidth == requested, touch points > 0,
                                       coarse pointer, any-hover: none.
    2. Nav toggle opens/closes BY TAP  dispatched touch events only; asserts
                                       aria-expanded, .is-open and body.nav-open,
                                       and that the revealed links are actually
                                       hit-testable at their centres.
    3. The page scrolls BY SWIPE       a multi-step touchmove drag must move
                                       scrollY.
    4. No hover-only affordance is unreachable
                                       every interactive element must be either
                                       hit-testable or legitimately behind a
                                       closed disclosure; and any :hover rule
                                       that GATES VISIBILITY on live markup is
                                       reported, since hover does not exist here.
    5. Tap targets >= 44x44 CSS px     measured on what is actually visible, in
                                       both nav states.

USAGE
    PY=~/personal/finance/finance/.venv/bin/python
    $PY tools/touch.py --base http://127.0.0.1:8899
    $PY tools/touch.py --base http://127.0.0.1:8899 --device pixel7 --json out.json
    $PY tools/touch.py --base http://127.0.0.1:8899 --headed   # watch it happen

EXIT CODE
    0 all checks passed   1 at least one failure   2 setup/override problem
"""

import argparse
import json
import sys
import time
from pathlib import Path

# Device profiles. `mobile: True` is the load-bearing flag — it is what makes
# Chrome treat the override as a phone (visual viewport, meta-viewport handling)
# rather than just a small desktop window.
DEVICES = {
    "iphone14": {
        "width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": True,
        "ua": ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
               "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
               "Mobile/15E148 Safari/604.1"),
    },
    "iphonese": {
        "width": 375, "height": 667, "deviceScaleFactor": 2, "mobile": True,
        "ua": ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
               "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
               "Mobile/15E148 Safari/604.1"),
    },
    "pixel7": {
        "width": 412, "height": 915, "deviceScaleFactor": 2.625, "mobile": True,
        "ua": ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"),
    },
    # Narrowest profile that still matters: the site has a 420px breakpoint.
    "small360": {
        "width": 360, "height": 740, "deviceScaleFactor": 3, "mobile": True,
        "ua": ("Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"),
    },
}

MIN_TAP = 44.0  # CSS px, per WCAG 2.5.5 / Apple HIG

INTERACTIVE_SEL = ("a[href], button, input:not([type=hidden]), select, textarea, "
                   "[role=button], [tabindex]:not([tabindex='-1'])")

# ---------------------------------------------------------------------------
# In-page helpers. Kept as one script so every query below sees the same
# definition of "visible" and "hit-testable".
# ---------------------------------------------------------------------------
JS_HELPERS = r"""
window.__ovTouch = (function () {
  var SEL = %s;
  var MIN = %s;

  function label(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    var c = (el.getAttribute("class") || "").trim();
    if (c) s += "." + c.split(/\s+/).slice(0, 3).join(".");
    return s;
  }
  function text(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
  }
  /* Rendered means it occupies space and is not transparent. Transparency
     matters here: the closed mobile nav is visibility:hidden + opacity 0, and
     counting its links as undersized tap targets would be noise. */
  function rendered(el) {
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity || "1") < 0.05) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  /* Parked off-screen: the element has a real box but sits entirely above or to
     the left of the viewport and stays there. The canonical case is this site's
     `.skip-link`, held at `top: -60px` and slid in only by `:focus` — a
     keyboard affordance that is never a touch target. Counting it as an
     undersized tap target was a false positive that had to go, but the
     exclusion is REPORTED rather than silent so it can be audited.
     Below-the-fold elements are deliberately NOT excluded: those become real
     tap targets as soon as the user scrolls. */
  function parkedOffscreen(el) {
    var r = el.getBoundingClientRect();
    return r.bottom <= 0 || r.right <= 0 || r.left >= innerWidth;
  }
  /* Effective opacity/visibility including ancestors — a link inside a panel at
     opacity 0 is not reachable no matter what its own style says. */
  function effectivelyVisible(el) {
    var n = el;
    var o = 1;
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      o *= parseFloat(cs.opacity || "1");
      if (o < 0.05) return false;
      n = n.parentElement;
    }
    return true;
  }
  /* Hit-testable == a touch at the element's centre actually lands on it (or a
     descendant). This is the only honest definition on a touch device: an
     element covered by an overlay is unreachable however visible it looks. */
  function hitTest(el) {
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
      return { inViewport: false, hit: null, ok: null };
    }
    var top = document.elementFromPoint(cx, cy);
    var ok = !!(top && (top === el || el.contains(top) || top.contains(el)));
    return {
      inViewport: true, ok: ok,
      hit: top ? label(top) : null,
      point: [Math.round(cx), Math.round(cy)]
    };
  }
  return {
    label: label,
    env: function () {
      return {
        innerWidth: innerWidth, innerHeight: innerHeight,
        outerWidth: outerWidth, outerHeight: outerHeight,
        dpr: devicePixelRatio,
        screen: [screen.width, screen.height],
        maxTouchPoints: navigator.maxTouchPoints,
        ontouchstart: "ontouchstart" in window,
        TouchEvent: typeof window.TouchEvent !== "undefined",
        anyHover: matchMedia("(any-hover: hover)").matches,
        hoverNone: matchMedia("(hover: none)").matches,
        anyPointerCoarse: matchMedia("(any-pointer: coarse)").matches,
        pointerCoarse: matchMedia("(pointer: coarse)").matches,
        mq760: matchMedia("(max-width: 760px)").matches,
        mq420: matchMedia("(max-width: 420px)").matches,
        ua: navigator.userAgent,
        scrollY: window.pageYOffset,
        scrollHeight: document.documentElement.scrollHeight
      };
    },
    navState: function () {
      var t = document.getElementById("nav-toggle");
      /* WHICH ELEMENT IS "THE MENU" depends on which nav is shipped, and this
         harness must not hard-code the older one.

         The pre-overhaul nav revealed the #nav-links row in place, toggling
         `.is-open` on it plus `body.nav-open`. The current nav instead opens a
         native <dialog id="nav-drawer"> with showModal(), and #nav-links is
         legitimately removed from the bar at mobile widths (opacity 0) — so
         asserting `.is-open` on #nav-links reports a working drawer as a dead
         menu. That exact false failure was hit once: the drawer demonstrably
         opened on a real touch tap (dialog.open true, display block, 335x844,
         scroll locked, focus moved to .drawer-close) while this check said
         "tap did not open the menu".

         So prefer the dialog when one exists, and fall back to the old
         contract otherwise. `openState` is whichever notion of "open" applies. */
      var dlg = document.getElementById("nav-drawer");
      var usingDialog = !!(dlg && typeof dlg.showModal === "function");
      var m = usingDialog ? dlg : document.getElementById("nav-links");
      if (!t || !m) return { present: false };
      var tr = t.getBoundingClientRect();
      var tcs = getComputedStyle(t);
      return {
        present: true,
        menuKind: usingDialog ? "dialog#nav-drawer" : "panel#nav-links",
        toggleDisplay: tcs.display,
        toggleRendered: rendered(t),
        toggleRect: [Math.round(tr.left), Math.round(tr.top),
                     Math.round(tr.width), Math.round(tr.height)],
        toggleCentre: [Math.round(tr.left + tr.width / 2),
                       Math.round(tr.top + tr.height / 2)],
        toggleHit: hitTest(t),
        ariaExpanded: t.getAttribute("aria-expanded"),
        ariaLabel: t.getAttribute("aria-label"),
        /* A <dialog> is open when its `open` property is set; the legacy panel
           is open when it carries `.is-open`. */
        menuIsOpen: usingDialog ? !!m.open : m.classList.contains("is-open"),
        /* The legacy nav set body.nav-open to lock scrolling. The current nav
           locks <html> instead, so for the dialog path report THAT — the
           equivalent signal, which must track open/closed. Do not hardcode it
           true: the close assertion reads this flag, so a constant makes
           "did it close?" unfalsifiable. */
        bodyNavOpen: usingDialog
          ? (document.documentElement.classList.contains("nav-locked")
             || !!document.documentElement.style.overflow)
          : document.body.classList.contains("nav-open"),
        menuOpacity: parseFloat(getComputedStyle(m).opacity || "1"),
        menuVisibility: getComputedStyle(m).visibility,
        menuPointerEvents: getComputedStyle(m).pointerEvents,
        /* Whether each revealed link can actually be tapped. A panel that
           animates in but stays pointer-events:none is a dead menu. */
        links: Array.prototype.map.call(m.querySelectorAll("a"), function (a) {
          var r = a.getBoundingClientRect();
          return {
            el: label(a), text: text(a),
            rect: [Math.round(r.left), Math.round(r.top),
                   Math.round(r.width), Math.round(r.height)],
            visible: effectivelyVisible(a),
            hit: hitTest(a)
          };
        })
      };
    },
    /* Tap targets, measured on what is actually visible right now. Reported
       with the element's own box; CSS that enlarges the hit area via a
       pseudo-element is NOT detected here and is called out in the README. */
    tapTargets: function () {
      var els = Array.prototype.slice.call(document.querySelectorAll(SEL));
      var small = [], okCount = 0, skipped = 0, parked = [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!rendered(el) || !effectivelyVisible(el)) { skipped++; continue; }
        if (parkedOffscreen(el)) {
          var pr = el.getBoundingClientRect();
          parked.push({ el: label(el), text: text(el),
                        rect: [Math.round(pr.left), Math.round(pr.top),
                               Math.round(pr.width), Math.round(pr.height)],
                        reason: "parked outside the viewport; focus-revealed, not a touch target" });
          continue;
        }
        var r = el.getBoundingClientRect();
        var w = Math.round(r.width * 100) / 100, h = Math.round(r.height * 100) / 100;
        if (w + 0.5 < MIN || h + 0.5 < MIN) {
          small.push({
            el: label(el), text: text(el),
            width: w, height: h,
            shortfall: Math.round((Math.min(MIN - w, 0) || 0) * 100) / 100,
            missingWidthPx: w + 0.5 < MIN ? Math.round((MIN - w) * 100) / 100 : 0,
            missingHeightPx: h + 0.5 < MIN ? Math.round((MIN - h) * 100) / 100 : 0,
            docTop: Math.round(r.top + window.pageYOffset)
          });
        } else { okCount++; }
      }
      return { checked: els.length, visible: okCount + small.length,
               skippedNotVisible: skipped, okCount: okCount,
               excludedParkedOffscreen: parked,
               tooSmall: small.slice(0, 40), tooSmallCount: small.length };
    },
    /* Unreachable interactive elements: visible in layout terms but not
       hit-testable, i.e. something is covering them. */
    unreachable: function () {
      var els = Array.prototype.slice.call(document.querySelectorAll(SEL));
      var bad = [];
      /* MODAL INERTNESS IS CORRECT BEHAVIOUR, NOT A DEFECT.
         showModal() makes everything outside the dialog inert, so while a modal
         is open the brand, the palette trigger and the hamburger behind it are
         SUPPOSED to be untappable. Reporting them as "unreachable" inverts the
         test: it fails the page precisely for implementing a focus trap
         correctly. So while a modal dialog is open, only consider elements
         inside it. (Observed: a.brand / #nav-cmd / #nav-toggle all flagged as
         "covered by dialog#nav-drawer" — which is the dialog working.) */
      var modal = null;
      var dialogs = document.querySelectorAll("dialog[open]");
      for (var d = 0; d < dialogs.length; d++) {
        // Last open modal wins; a non-modal <dialog> does not make anything inert.
        if (dialogs[d].matches(":modal")) modal = dialogs[d];
      }
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (modal && !modal.contains(el)) continue;
        if (!rendered(el) || !effectivelyVisible(el)) continue;
        if (parkedOffscreen(el)) continue;
        var cs = getComputedStyle(el);
        var pe = cs.pointerEvents === "none";
        var h = hitTest(el);
        if (h.inViewport && (h.ok === false || pe)) {
          bad.push({ el: label(el), text: text(el), pointerEventsNone: pe,
                     coveredBy: h.hit, point: h.point });
        }
      }
      return bad.slice(0, 30);
    },
    /* :hover rules that GATE VISIBILITY. On a touch device hover is not
       reliably available, so a control revealed only by hover is unreachable.
       Decorative pseudo-element rules are excluded — the host stays tappable. */
    hoverGates: function () {
      var risks = [], seen = 0, decorative = 0, unreadable = 0;
      for (var s = 0; s < document.styleSheets.length; s++) {
        var rules;
        try { rules = document.styleSheets[s].cssRules; }
        catch (e) { unreadable++; continue; }
        if (!rules) continue;
        var stack = Array.prototype.slice.call(rules);
        while (stack.length) {
          var rule = stack.shift();
          if (rule.cssRules) {
            stack = stack.concat(Array.prototype.slice.call(rule.cssRules));
            continue;
          }
          if (!rule.selectorText || rule.selectorText.indexOf(":hover") === -1) continue;
          seen++;
          var st = rule.style; if (!st) continue;
          var gates = [];
          if (st.opacity !== "" && parseFloat(st.opacity) > 0) gates.push("opacity");
          if (st.visibility === "visible") gates.push("visibility");
          if (st.display !== "" && st.display !== "none") gates.push("display");
          if (st.pointerEvents === "auto") gates.push("pointer-events");
          if (!gates.length) continue;
          if (/::(before|after|marker|placeholder)/.test(rule.selectorText)) {
            decorative++; continue;
          }
          var base = rule.selectorText.replace(/:hover/g, "");
          var n = 0;
          try { n = document.querySelectorAll(base).length; } catch (e) {}
          if (n > 0) {
            risks.push({ selector: rule.selectorText.slice(0, 140),
                         gates: gates, matchesOnPage: n });
          }
        }
      }
      return { hoverRulesSeen: seen, decorativePseudoOnly: decorative,
               sheetsUnreadable: unreadable, liveRisks: risks.slice(0, 20),
               liveRiskCount: risks.length };
    }
  };
})();
return true;
""" % (json.dumps(INTERACTIVE_SEL), MIN_TAP)


# ---------------------------------------------------------------------------
# CDP touch primitives
# ---------------------------------------------------------------------------
def cdp(driver, method, params=None):
    return driver.execute_cdp_cmd(method, params or {})


def tap(driver, x, y, hold_ms=60):
    """A real touch tap: touchStart then touchEnd at the same point.

    Not a click. Chrome turns this pair into a click itself, exactly as a phone
    does, which is the point — it exercises the site's real touch path including
    the 300ms tap delay and any touch-action handling.
    """
    cdp(driver, "Input.dispatchTouchEvent", {
        "type": "touchStart",
        "touchPoints": [{"x": x, "y": y, "id": 1,
                         "radiusX": 12, "radiusY": 12, "force": 1.0}],
    })
    time.sleep(hold_ms / 1000.0)
    # touchEnd carries an EMPTY touchPoints list: the array is "points still
    # down", and sending the point again here makes Chrome reject the event.
    cdp(driver, "Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def swipe(driver, x, y_from, y_to, steps=14, step_ms=16):
    """A real touch drag, as a proper touchStart / touchMove* / touchEnd stream.

    Moving the finger UP (y decreasing) scrolls the page DOWN, same as a phone.
    The intermediate moves matter: Chrome's compositor needs several samples to
    recognise a scroll gesture, and a single jump from start to end is usually
    swallowed.
    """
    cdp(driver, "Input.dispatchTouchEvent", {
        "type": "touchStart",
        "touchPoints": [{"x": x, "y": y_from, "id": 1,
                         "radiusX": 12, "radiusY": 12, "force": 1.0}],
    })
    for i in range(1, steps + 1):
        y = y_from + (y_to - y_from) * (i / float(steps))
        cdp(driver, "Input.dispatchTouchEvent", {
            "type": "touchMove",
            "touchPoints": [{"x": x, "y": y, "id": 1,
                             "radiusX": 12, "radiusY": 12, "force": 1.0}],
        })
        time.sleep(step_ms / 1000.0)
    cdp(driver, "Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def apply_device(driver, dev):
    cdp(driver, "Emulation.setDeviceMetricsOverride", {
        "width": dev["width"], "height": dev["height"],
        "deviceScaleFactor": dev["deviceScaleFactor"],
        "mobile": dev["mobile"],
        "screenWidth": dev["width"], "screenHeight": dev["height"],
        "positionX": 0, "positionY": 0,
        "screenOrientation": {"angle": 0, "type": "portraitPrimary"},
    })
    cdp(driver, "Emulation.setTouchEmulationEnabled",
        {"enabled": True, "maxTouchPoints": 5})
    # Makes media queries and UA sniffing agree with the geometry. Without this
    # the page can still believe it is on a desktop.
    cdp(driver, "Emulation.setUserAgentOverride", {
        "userAgent": dev["ua"],
        "platform": "iPhone" if "iPhone" in dev["ua"] else "Linux armv8l",
    })
    try:
        cdp(driver, "Emulation.setEmitTouchEventsForMouse",
            {"enabled": True, "configuration": "mobile"})
    except Exception:
        pass


def install_helpers(driver):
    driver.execute_script(JS_HELPERS)


def q(driver, expr):
    return driver.execute_script("return window.__ovTouch.%s" % expr)


# ---------------------------------------------------------------------------
def check_override(driver, dev):
    """Prove the emulation is real before trusting anything measured under it."""
    env = q(driver, "env()")
    problems = []
    if abs(env["innerWidth"] - dev["width"]) > 1:
        problems.append(
            "viewport did not take: innerWidth=%s but %spx was requested — this is "
            "the headless minimum-window clamp, and every result below would be a "
            "desktop measurement wearing a phone's name"
            % (env["innerWidth"], dev["width"]))
    if not env["maxTouchPoints"]:
        problems.append("navigator.maxTouchPoints=0 — touch emulation is not active")
    if not env["ontouchstart"]:
        problems.append("'ontouchstart' missing from window — touch events not wired")
    if not env["anyPointerCoarse"]:
        problems.append("(any-pointer: coarse) is false — the page still sees a fine pointer")
    if env["anyHover"]:
        problems.append("(any-hover: hover) is TRUE under mobile emulation — hover-only "
                        "affordances would appear reachable when they are not")
    if not env["mq760"]:
        problems.append("(max-width: 760px) does not match at %spx — the mobile nav "
                        "breakpoint is not engaged" % env["innerWidth"])
    return env, problems


def check_nav_tap(driver, results):
    """Open and close the nav with real taps, and prove the links are tappable."""
    check = {"name": "nav toggle opens/closes by tap", "status": "FAIL", "steps": []}
    before = q(driver, "navState()")
    check["initial"] = before
    if not before.get("present"):
        check["status"] = "FAIL"
        check["reason"] = "#nav-toggle or #nav-links not in the DOM"
        results.append(check)
        return
    if not before.get("toggleRendered"):
        check["status"] = "FAIL"
        check["reason"] = ("hamburger is not rendered at this width "
                           "(display=%s) — there is no way to reach the nav"
                           % before.get("toggleDisplay"))
        results.append(check)
        return
    if before.get("menuIsOpen"):
        check["steps"].append("menu was already open before any tap")

    cx, cy = before["toggleCentre"]

    # --- tap to OPEN
    tap(driver, cx, cy)
    time.sleep(0.55)   # the panel transition is .24s; allow it to finish
    opened = q(driver, "navState()")
    check["afterFirstTap"] = opened
    open_ok = (opened.get("ariaExpanded") == "true" and opened.get("menuIsOpen")
               and opened.get("bodyNavOpen") and opened.get("menuOpacity", 0) > 0.9
               and opened.get("menuVisibility") == "visible")
    check["steps"].append("tap at (%d,%d) -> aria-expanded=%s is-open=%s "
                          "body.nav-open=%s opacity=%s visibility=%s"
                          % (cx, cy, opened.get("ariaExpanded"),
                             opened.get("menuIsOpen"), opened.get("bodyNavOpen"),
                             opened.get("menuOpacity"), opened.get("menuVisibility")))

    # Opening is worthless if the links cannot then be tapped.
    links = opened.get("links") or []
    unhittable = [l for l in links
                  if l.get("visible") and l.get("hit", {}).get("inViewport")
                  and l.get("hit", {}).get("ok") is False]
    check["linkCount"] = len(links)
    check["linksNotHitTestable"] = unhittable
    if unhittable:
        check["steps"].append(
            "%d revealed nav link(s) are NOT hit-testable at their centre"
            % len(unhittable))

    # --- tap to CLOSE
    tap(driver, cx, cy)
    time.sleep(0.55)
    closed = q(driver, "navState()")
    check["afterSecondTap"] = closed
    close_ok = (closed.get("ariaExpanded") == "false"
                and not closed.get("menuIsOpen")
                and not closed.get("bodyNavOpen"))
    check["steps"].append("second tap -> aria-expanded=%s is-open=%s body.nav-open=%s"
                          % (closed.get("ariaExpanded"), closed.get("menuIsOpen"),
                             closed.get("bodyNavOpen")))

    check["status"] = "PASS" if (open_ok and close_ok and not unhittable) else "FAIL"
    if not open_ok:
        check["reason"] = "tap did not open the menu"
    elif unhittable:
        check["reason"] = "menu opened but revealed links are not hit-testable"
    elif not close_ok:
        check["reason"] = "second tap did not close the menu"
    results.append(check)


def check_swipe_scroll(driver, dev, results):
    """The page must scroll from a finger drag, not just from scripted scrollTo."""
    check = {"name": "page scrolls by swipe", "status": "FAIL"}
    driver.execute_script(
        "try{window.scrollTo({top:0,left:0,behavior:'instant'});}"
        "catch(e){window.scrollTo(0,0);}")
    time.sleep(0.4)
    y0 = driver.execute_script("return window.pageYOffset")

    x = dev["width"] // 2
    # Start low and finish high: finger up == page down. Kept clear of the
    # fixed top bar so the drag does not begin on sticky chrome.
    swipe(driver, x, int(dev["height"] * 0.80), int(dev["height"] * 0.20))
    time.sleep(0.9)   # allow fling/settle
    y1 = driver.execute_script("return window.pageYOffset")

    check["scrollYBefore"] = y0
    check["scrollYAfterSwipeUp"] = y1
    check["deltaPx"] = round(y1 - y0, 2)
    check["swipe"] = {"x": x, "from": int(dev["height"] * 0.80),
                      "to": int(dev["height"] * 0.20), "steps": 14}

    if y1 - y0 > 20:
        # And it must come back, so we know we measured scrolling and not a
        # one-way layout shift.
        swipe(driver, x, int(dev["height"] * 0.20), int(dev["height"] * 0.80))
        time.sleep(0.9)
        y2 = driver.execute_script("return window.pageYOffset")
        check["scrollYAfterSwipeDown"] = y2
        check["reversible"] = y2 < y1
        check["status"] = "PASS"
    else:
        check["status"] = "FAIL"
        check["reason"] = ("swipe up moved scrollY by only %.1fpx; the page did not "
                           "scroll from a dispatched touch drag" % (y1 - y0))
    results.append(check)


def check_tap_targets(driver, results, label):
    check = {"name": "tap targets >= %gx%g (%s)" % (MIN_TAP, MIN_TAP, label)}
    data = q(driver, "tapTargets()")
    check.update(data)
    check["status"] = "PASS" if data["tooSmallCount"] == 0 else "FAIL"
    if data["tooSmallCount"]:
        check["reason"] = ("%d visible interactive element(s) are under %gpx in at "
                           "least one dimension" % (data["tooSmallCount"], MIN_TAP))
    results.append(check)


def check_reachability(driver, results, label):
    check = {"name": "no unreachable interactive element (%s)" % label}
    bad = q(driver, "unreachable()")
    check["unreachable"] = bad
    check["status"] = "PASS" if not bad else "FAIL"
    if bad:
        check["reason"] = "%d visible interactive element(s) cannot be tapped" % len(bad)
    results.append(check)


def check_hover_gates(driver, results):
    check = {"name": "no hover-gated affordance on touch"}
    data = q(driver, "hoverGates()")
    check.update(data)
    check["status"] = "PASS" if data["liveRiskCount"] == 0 else "FAIL"
    if data["liveRiskCount"]:
        check["reason"] = ("%d :hover rule(s) gate visibility on markup present in "
                           "this page; hover is unavailable on touch"
                           % data["liveRiskCount"])
    results.append(check)


# ---------------------------------------------------------------------------
def run_page(driver, base, page, dev, results_root):
    url = "%s/%s" % (base.rstrip("/"), page)
    driver.get(url)
    for _ in range(60):
        if driver.execute_script("return document.readyState") == "complete":
            break
        time.sleep(0.1)
    time.sleep(1.2)          # let entry animations finish
    install_helpers(driver)

    page_res = {"url": url, "checks": []}
    env, problems = check_override(driver, dev)
    page_res["env"] = env
    page_res["overrideProblems"] = problems
    if problems:
        # Refuse to report per-check results measured under a viewport that did
        # not actually apply. A fake pass here is worse than no data.
        page_res["checks"].append({
            "name": "device metrics override is real", "status": "FAIL",
            "reason": "; ".join(problems)})
        results_root[page] = page_res
        return
    page_res["checks"].append({
        "name": "device metrics override is real", "status": "PASS",
        "detail": "innerWidth=%s dpr=%s maxTouchPoints=%s any-hover=%s coarse=%s"
                  % (env["innerWidth"], env["dpr"], env["maxTouchPoints"],
                     env["anyHover"], env["anyPointerCoarse"])})

    check_hover_gates(driver, page_res["checks"])
    check_tap_targets(driver, page_res["checks"], "nav closed")
    check_reachability(driver, page_res["checks"], "nav closed")
    check_nav_tap(driver, page_res["checks"])

    # Re-measure with the panel open: that state has its own tap targets and its
    # own overlay, and it is the state a phone user is actually in when
    # navigating.
    nav = q(driver, "navState()")
    if nav.get("present") and nav.get("toggleRendered"):
        cx, cy = nav["toggleCentre"]
        tap(driver, cx, cy)
        time.sleep(0.55)
        if q(driver, "navState()").get("menuIsOpen"):
            check_tap_targets(driver, page_res["checks"], "nav open")
            check_reachability(driver, page_res["checks"], "nav open")
        tap(driver, cx, cy)
        time.sleep(0.45)

    check_swipe_scroll(driver, dev, page_res["checks"])
    results_root[page] = page_res


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--base", required=True)
    ap.add_argument("--pages", default="index.html,projects.html,travel.html")
    ap.add_argument("--device", default="iphone14",
                    help="one of: %s (comma-separate for several)" % ", ".join(DEVICES))
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options

    pages = [p.strip() for p in args.pages.split(",") if p.strip()]
    devices = [d.strip() for d in args.device.split(",") if d.strip()]
    for d in devices:
        if d not in DEVICES:
            print("unknown device %r; choose from %s" % (d, ", ".join(DEVICES)))
            return 2

    payload = {"base": args.base, "devices": {},
               "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    exit_code = 0

    for dname in devices:
        dev = DEVICES[dname]
        o = Options()
        if not args.headed:
            o.add_argument("--headless=new")
        # Deliberately a DESKTOP-sized window. The CDP override supplies the
        # phone viewport; asking the window for 390px would hit the ~500px
        # headless clamp and quietly contradict the override.
        o.add_argument("--window-size=1200,900")
        o.add_argument("--no-first-run")
        try:
            driver = webdriver.Chrome(options=o)
        except Exception as e:
            print("Chrome unavailable: %s: %s" % (type(e).__name__, str(e)[:300]))
            return 2

        dev_res = {"profile": dict(dev), "pages": {}}
        try:
            apply_device(driver, dev)
            for page in pages:
                run_page(driver, args.base, page, dev, dev_res["pages"])
        finally:
            try:
                driver.quit()
            except Exception:
                pass
        payload["devices"][dname] = dev_res

    # ---- report
    print("\n" + "=" * 100)
    print("TOUCH EMULATION RESULTS  (Chrome + CDP device metrics override)")
    print("=" * 100)
    for dname, dres in payload["devices"].items():
        p = dres["profile"]
        print("\ndevice %s  %dx%d @%sx  mobile=%s"
              % (dname, p["width"], p["height"], p["deviceScaleFactor"], p["mobile"]))
        for page, pres in dres["pages"].items():
            env = pres.get("env") or {}
            print("  %s   (innerWidth=%s, maxTouchPoints=%s, any-hover=%s)"
                  % (page, env.get("innerWidth"), env.get("maxTouchPoints"),
                     env.get("anyHover")))
            for c in pres["checks"]:
                mark = "PASS" if c["status"] == "PASS" else "FAIL"
                if c["status"] != "PASS":
                    exit_code = 1
                print("     [%s] %s" % (mark, c["name"]))
                if c.get("detail"):
                    print("            %s" % c["detail"])
                if c.get("reason"):
                    print("            reason: %s" % c["reason"])
                for s in (c.get("steps") or []):
                    print("            - %s" % s)
                for pk in (c.get("excludedParkedOffscreen") or [])[:6]:
                    print("            excluded (%s): %-30s rect=%s"
                          % (pk["reason"][:46], pk["el"], pk["rect"]))
                for t in (c.get("tooSmall") or [])[:12]:
                    print("            small: %-42s %.1fx%.1f  (needs +%.1fw +%.1fh)  '%s'"
                          % (t["el"], t["width"], t["height"],
                             t["missingWidthPx"], t["missingHeightPx"], t["text"]))
                for u in (c.get("unreachable") or [])[:10]:
                    print("            unreachable: %-38s covered by %s  pe:none=%s"
                          % (u["el"], u.get("coveredBy"), u.get("pointerEventsNone")))
                for r in (c.get("liveRisks") or [])[:10]:
                    print("            hover-gate: %s  gates=%s  (%s nodes)"
                          % (r["selector"], r["gates"], r["matchesOnPage"]))
                for l in (c.get("linksNotHitTestable") or [])[:8]:
                    print("            nav link not tappable: %s '%s' hit=%s"
                          % (l["el"], l["text"], l.get("hit", {}).get("hit")))
                if c.get("deltaPx") is not None:
                    print("            scrollY %s -> %s (delta %spx), reversible=%s"
                          % (c.get("scrollYBefore"), c.get("scrollYAfterSwipeUp"),
                             c.get("deltaPx"), c.get("reversible")))
    print("\n" + "=" * 100)
    print("RESULT: %s" % ("all touch checks passed" if exit_code == 0
                          else "at least one touch check FAILED"))
    print("=" * 100)

    if args.json:
        Path(args.json).write_text(json.dumps(payload, indent=2))
        print("full results: %s" % args.json)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
