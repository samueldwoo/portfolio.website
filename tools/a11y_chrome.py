#!/usr/bin/env python3
"""
a11y_chrome.py — WCAG 2.1 AA audit of the GLOBAL CHROME (nav bar, command
palette, mobile drawer, section rail, skip link, landmarks, focus management).

WHY IT IS BUILT THE WAY IT IS — the failure modes this repo has already paid for
-------------------------------------------------------------------------------
1. WRONG URL. @astrojs/vercel hard-forces `build.format: "directory"`, so the
   built pages are `/`, `/projects/`, `/travel/`. `projects.html` is a 301 in
   production and a flat 404 on a static server. Tests that requested
   `projects.html` passed while the page was blank. PAGES below are directory
   URLs and every one is asserted to return real markup before anything is
   measured.

2. FAKE VIEWPORT. Headless Chrome will not shrink its window below ~500 CSS px.
   A 390px *window* still matches the 760px breakpoint, so "the drawer works on
   a phone" was a claim about a desktop. Every mobile measurement here goes
   through Emulation.setDeviceMetricsOverride + setTouchEmulationEnabled, and
   `assert_viewport()` aborts if innerWidth != requested.

3. MIRRORING THE IMPLEMENTATION'S OWN MATHS. Accessible names are read from
   Chrome's OWN accessibility tree (CDP Accessibility.getFullAXTree), not
   recomputed in JS from aria-label attributes. If Chrome does not expose the
   name, the screen reader does not get it, whatever the markup says.

4. SAMPLING TOO EARLY. Webfonts swap after first paint and script.js
   re-measures the nav marker on `document.fonts.ready`; reveals finish on a
   tween. Geometry is only read after fonts.ready + a settle poll that waits
   for values to STOP changing.

5. SYNTHETIC EVENTS THAT DO NOT SET :focus-visible. Focus rings are provoked
   with real CDP Input.dispatchKeyEvent Tab presses and then confirmed with
   el.matches(':focus-visible') — the UA heuristic itself — before the ring's
   computed style is read.

USAGE
    PY=~/personal/finance/finance/.venv/bin/python
    $PY tools/a11y_chrome.py --base http://127.0.0.1:8231 --json out.json
    $PY tools/a11y_chrome.py --base http://127.0.0.1:8231 --only palette

EXIT 0 = no failures, 1 = failures, 2 = setup problem.
"""

import argparse
import json
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

PAGES = ["", "projects/", "travel/"]          # directory format — see note 1
SAGE_FAIL = "rgb(95, 122, 79)"                # --sage  #5f7a4f, 4.41:1 on --bg
SAGE_DEEP = "rgb(78, 102, 64)"                # --sage-deep #4e6640, 5.86:1

DESKTOP = {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False}
PHONE = {"width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": True}
PHONE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
            "Mobile/15E148 Safari/604.1")


# --------------------------------------------------------------------------
# driver plumbing
# --------------------------------------------------------------------------
def make_driver(headed=False):
    o = Options()
    if not headed:
        o.add_argument("--headless=new")
    o.add_argument("--window-size=1500,1000")
    o.add_argument("--force-device-scale-factor=1")
    o.add_argument("--hide-scrollbars")
    d = webdriver.Chrome(options=o)
    d.set_page_load_timeout(40)
    return d


def cdp(d, method, params=None):
    return d.execute_cdp_cmd(method, params or {})


def set_viewport(d, metrics, touch=False, ua=None):
    cdp(d, "Emulation.setDeviceMetricsOverride", metrics)
    # maxTouchPoints must be 1..16 even when disabling, or chromedriver rejects it.
    cdp(d, "Emulation.setTouchEmulationEnabled",
        {"enabled": touch, "maxTouchPoints": 5 if touch else 1})
    if touch:
        cdp(d, "Emulation.setEmitTouchEventsForMouse",
            {"enabled": True, "configuration": "mobile"})
    if ua:
        cdp(d, "Emulation.setUserAgentOverride", {"userAgent": ua})


def assert_viewport(d, want_w, want_touch):
    got = d.execute_script(
        "return {w: window.innerWidth,"
        " tp: navigator.maxTouchPoints,"
        " coarse: matchMedia('(pointer: coarse)').matches,"
        " mobileBp: matchMedia('(max-width: 760px)').matches};")
    if got["w"] != want_w:
        raise SystemExit(
            "SETUP FAILURE: viewport override did not take — asked %d, got %d. "
            "Every mobile result below would be a lie." % (want_w, got["w"]))
    if want_touch and got["tp"] < 1:
        raise SystemExit("SETUP FAILURE: touch emulation not active (maxTouchPoints=%s)"
                         % got["tp"])
    return got


def set_reduced_motion(d, on):
    cdp(d, "Emulation.setEmulatedMedia", {"features": [
        {"name": "prefers-reduced-motion", "value": "reduce" if on else "no-preference"}]})


SETTLE = r"""
const done = arguments[0];
// Wait for the webfont swap (script.js re-measures the nav marker on it) and
// then poll until laid-out geometry STOPS changing. A fixed sleep here is what
// previously sampled reveals mid-tween.
const ready = document.fonts && document.fonts.ready
      ? document.fonts.ready : Promise.resolve();
ready.then(() => {
  let last = null, stable = 0, waited = 0;
  const sig = () => {
    const m = document.getElementById('nav-marker');
    const parts = [document.documentElement.scrollHeight,
                   m ? m.style.transform + '/' + m.style.width : '-'];
    document.querySelectorAll('.topbar, .section-rail, .nav-links')
      .forEach(el => { const r = el.getBoundingClientRect();
                       parts.push(Math.round(r.width) + 'x' + Math.round(r.height)); });
    return parts.join('|');
  };
  (function tick() {
    const s = sig();
    stable = (s === last) ? stable + 1 : 0;
    last = s; waited += 120;
    if ((stable >= 3 && waited >= 480) || waited > 6000) done(waited);
    else setTimeout(tick, 120);
  })();
});
"""


def load(d, base, page, reduced=False):
    url = base.rstrip("/") + "/" + page
    d.get(url)
    set_reduced_motion(d, reduced)
    if reduced:
        d.get(url)          # re-load so the media query is live at parse time
    d.set_script_timeout(30)
    d.execute_async_script(SETTLE)
    return url


# --------------------------------------------------------------------------
# accessibility tree — Chrome's own names, not ours
# --------------------------------------------------------------------------
def ax_tree(d):
    return cdp(d, "Accessibility.getFullAXTree").get("nodes", [])


def ax_index(nodes):
    """backendDOMNodeId -> {role, name, level, ignored}"""
    out = {}
    for n in nodes:
        bid = n.get("backendDOMNodeId")
        if bid is None:
            continue
        role = (n.get("role") or {}).get("value")
        name = (n.get("name") or {}).get("value")
        level = None
        for p in n.get("properties", []) or []:
            if p.get("name") == "level":
                level = (p.get("value") or {}).get("value")
        out[bid] = {"role": role, "name": name, "level": level,
                    "ignored": bool(n.get("ignored"))}
    return out


LANDMARK_ROLES = {"banner", "navigation", "main", "contentinfo", "complementary",
                  "region", "search", "form"}


HEADINGS_IN_DOM_ORDER = r"""
// Accessibility.getFullAXTree returns a FLAT node list that is NOT document
// order — reading headings off it reported the hero h1 in the middle of the
// page and invented a phantom "h1 -> h3" skip while missing the real h2 -> h4
// one. Heading ORDER is a document-order property, so it is read from the DOM,
// and only elements a screen reader can actually reach are counted.
const out = [];
document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]').forEach(el => {
  if (el.closest('[aria-hidden="true"]')) return;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return;
  if (el.closest('dialog') && !el.closest('dialog').open) return;
  const lvl = el.getAttribute('aria-level')
      ? parseInt(el.getAttribute('aria-level'), 10)
      : (/^H[1-6]$/.test(el.tagName) ? +el.tagName[1] : null);
  out.push({level: lvl,
            name: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            tag: el.tagName.toLowerCase()});
});
return out;
"""


def landmarks_and_headings(d):
    nodes = ax_tree(d)
    lands = []
    for n in nodes:
        if n.get("ignored"):
            continue
        role = (n.get("role") or {}).get("value")
        name = ((n.get("name") or {}).get("value") or "").strip()
        if role in LANDMARK_ROLES:
            lands.append({"role": role, "name": name})
    heads = d.execute_script("return (function(){%s})();" % HEADINGS_IN_DOM_ORDER)
    return lands, heads


def heading_problems(heads):
    probs = []
    h1 = [h for h in heads if h["level"] == 1]
    if len(h1) != 1:
        probs.append("h1 count = %d (want exactly 1): %s"
                     % (len(h1), [h["name"][:40] for h in h1]))
    prev = None
    for h in heads:
        lvl = h["level"]
        if prev is not None and lvl is not None and lvl > prev + 1:
            probs.append("skipped level: h%s -> h%s at %r" % (prev, lvl, h["name"][:50]))
        if lvl is not None:
            prev = lvl
    return probs


# --------------------------------------------------------------------------
# real keyboard
# --------------------------------------------------------------------------
KEYS = {
    "Tab":       dict(key="Tab", code="Tab", windowsVirtualKeyCode=9, text="\t"),
    "Escape":    dict(key="Escape", code="Escape", windowsVirtualKeyCode=27),
    "Enter":     dict(key="Enter", code="Enter", windowsVirtualKeyCode=13, text="\r"),
    "Space":     dict(key=" ", code="Space", windowsVirtualKeyCode=32, text=" "),
    "ArrowDown": dict(key="ArrowDown", code="ArrowDown", windowsVirtualKeyCode=40),
    "ArrowUp":   dict(key="ArrowUp", code="ArrowUp", windowsVirtualKeyCode=38),
}


def press(d, name, modifiers=0, settle=0.05):
    """A real, trusted key event. Synthetic .focus() does NOT arm :focus-visible."""
    k = dict(KEYS[name])
    txt = k.pop("text", None)
    cdp(d, "Input.dispatchKeyEvent",
        dict(type="rawKeyDown", modifiers=modifiers, **k))
    if txt and not modifiers:
        cdp(d, "Input.dispatchKeyEvent",
            dict(type="char", modifiers=modifiers, text=txt, key=k["key"]))
    cdp(d, "Input.dispatchKeyEvent",
        dict(type="keyUp", modifiers=modifiers, **k))
    time.sleep(settle)


SETTLE_RECT = r"""
// Poll the focused element's rect until it STOPS moving. Two things move it
// after a Tab and both burned an earlier version of this file:
//   * .skip-link animates `top: -60px -> 12px` over 200ms, so an immediate read
//     reported top=-2/-19/-24 and "the skip link never reaches the screen" —
//     a fabricated failure. Settled, it is top=12 on all three pages.
//   * focusing a control below the fold scrolls the document, so an immediate
//     read reported half a dozen content links as "off-screen".
const done = arguments[0];
let last = null, stable = 0, waited = 0;
(function tick() {
  const el = document.activeElement;
  const r = el ? el.getBoundingClientRect() : null;
  const sig = r ? [Math.round(r.top), Math.round(r.left),
                   Math.round(r.width), Math.round(r.height),
                   Math.round(window.scrollY)].join(',') : 'none';
  stable = (sig === last) ? stable + 1 : 0;
  last = sig; waited += 60;
  if ((stable >= 3 && waited >= 240) || waited > 2500) done(waited);
  else setTimeout(tick, 60);
})();
"""


def press_settled(d, name, modifiers=0):
    """Press a key, then wait for the focused element's geometry to stop moving."""
    press(d, name, modifiers, settle=0.02)
    d.set_script_timeout(15)
    d.execute_async_script(SETTLE_RECT)


def type_text(d, s):
    for ch in s:
        cdp(d, "Input.dispatchKeyEvent", {"type": "keyDown", "text": ch, "key": ch})
        cdp(d, "Input.dispatchKeyEvent", {"type": "keyUp", "key": ch})
    time.sleep(0.15)


DESCRIBE_ACTIVE = r"""
const el = document.activeElement;
if (!el || el === document.body) return {tag: el ? el.tagName : 'null', body: true};
const cs = getComputedStyle(el);
const r = el.getBoundingClientRect();
// Ask the UA whether IT considers this a focus-visible moment. Reading the
// outline without this would report the ring on a mouse click too.
let fv = false; try { fv = el.matches(':focus-visible'); } catch (e) {}
const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0)
          || (cs.boxShadow && cs.boxShadow !== 'none');
return {
  tag: el.tagName.toLowerCase(),
  id: el.id || null,
  cls: (el.className && el.className.toString().slice(0, 60)) || null,
  text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
  ariaLabel: el.getAttribute('aria-label'),
  href: el.getAttribute('href'),
  focusVisible: fv,
  ring: ring,
  outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
  boxShadow: cs.boxShadow === 'none' ? null : cs.boxShadow.slice(0, 60),
  rect: {x: Math.round(r.x), y: Math.round(r.y),
         w: Math.round(r.width), h: Math.round(r.height)},
  inViewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
  inDialog: !!el.closest('dialog'),
  dialogId: el.closest('dialog') ? el.closest('dialog').id : null,
  path: (function(n){const p=[];while(n&&n.nodeType===1&&p.length<6){
        p.unshift(n.tagName.toLowerCase()+(n.id?'#'+n.id:''));n=n.parentElement;}
        return p.join('>')})(el)
};
"""


def active(d):
    return d.execute_script("return (function(){%s})();" % DESCRIBE_ACTIVE)


def tab_walk(d, limit=40, start_from_top=True):
    """Tab from the very start of the document and record every stop."""
    if start_from_top:
        d.execute_script("window.scrollTo(0,0);"
                         "if(document.activeElement&&document.activeElement.blur)"
                         "document.activeElement.blur();")
        # Click the very top-left of the document body so the sequential focus
        # navigation starting point is the document start, not wherever a
        # previous test left it.
        d.execute_script("document.body.setAttribute('tabindex','-1');"
                         "document.body.focus();"
                         "document.body.removeAttribute('tabindex');")
    stops = []
    seen = {}
    for i in range(limit):
        press_settled(d, "Tab")
        a = active(d)
        key = a.get("path", "") + "|" + (a.get("text") or "")
        stops.append(a)
        seen[key] = seen.get(key, 0) + 1
        if seen[key] > 2:
            stops.append({"LOOP": key})
            break
    return stops


# --------------------------------------------------------------------------
# contrast — composite the real ancestor stack
# --------------------------------------------------------------------------
CONTRAST_JS = r"""
function parse(c) {
  const m = String(c).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map(s => parseFloat(s.trim()));
  return {r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1};
}
function over(fg, bg) {           // fg composited onto opaque bg
  const a = fg.a;
  return {r: fg.r * a + bg.r * (1 - a),
          g: fg.g * a + bg.g * (1 - a),
          b: fg.b * a + bg.b * (1 - a), a: 1};
}
function lin(v) { v /= 255; return v <= 0.03928 ? v / 12.92
                            : Math.pow((v + 0.055) / 1.055, 2.4); }
function lum(c) { return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); }
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
// Effective background = every semi-transparent layer from the element upward
// composited down onto the first fully opaque one. Ends at the documented page
// canvas rather than assuming white.
function effBg(el) {
  const stack = [];
  let n = el;
  while (n && n.nodeType === 1) {
    const c = parse(getComputedStyle(n).backgroundColor);
    if (c && c.a > 0) { stack.push(c); if (c.a >= 0.999) break; }
    n = n.parentElement;
  }
  let base = {r: 245, g: 246, b: 242, a: 1};       // --bg #f5f6f2
  if (stack.length && stack[stack.length - 1].a >= 0.999) base = stack.pop();
  for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
  return base;
}
const out = [];
// SELECTOR is interpolated in by the caller. It used to read `arguments[0]`,
// but this body runs inside an IIFE whose own `arguments` are empty, so the
// selector was the string "undefined", nothing matched, and the contrast check
// reported "0 text nodes checked" as a PASS on every page for every build.
document.querySelectorAll(SELECTOR).forEach(el => {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden'
      || parseFloat(cs.opacity) < 0.05) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  // only elements that actually paint text of their own
  const own = Array.from(el.childNodes)
    .filter(n => n.nodeType === 3 && n.textContent.trim().length)
    .map(n => n.textContent.trim()).join(' ');
  if (!own) return;
  const fg = parse(cs.color);
  if (!fg) return;
  const bg = effBg(el);
  // effBg() walks ANCESTORS. It therefore cannot see `.nav-marker` — the filled
  // sage pill is a SIBLING of `.nav-link`, absolutely positioned behind it — so
  // the active link measured as white-on-near-white, 1.03:1, a fabricated
  // failure on text that is really 6.37:1 (verified from the rendered bitmap by
  // tools/a11y_pixel.py). elementsFromPoint() cannot rescue it either: the
  // marker is pointer-events:none and so is absent from the hit-test stack.
  // Any element with an opaque sibling covering its text is handed off to the
  // pixel tool instead of being guessed at here.
  let overlaid = null;
  const mine = el.getBoundingClientRect();
  const cx = mine.left + mine.width / 2, cy = mine.top + mine.height / 2;
  if (el.parentElement) {
    for (const sib of el.parentElement.children) {
      if (sib === el || sib.contains(el)) continue;
      const sc = parse(getComputedStyle(sib).backgroundColor);
      if (!sc || sc.a < 0.5) continue;
      const sr = sib.getBoundingClientRect();
      if (cx >= sr.left && cx <= sr.right && cy >= sr.top && cy <= sr.bottom) {
        overlaid = sib.tagName.toLowerCase()
                 + (sib.id ? '#' + sib.id : '.' + (sib.className || '').toString().trim());
        break;
      }
    }
  }
  const px = parseFloat(cs.fontSize);
  const bold = parseInt(cs.fontWeight, 10) >= 700;
  const large = px >= 24 || (bold && px >= 18.66);
  const cr = ratio(over(fg, bg), bg);
  out.push({
    sel: el.tagName.toLowerCase()
         + (el.id ? '#' + el.id : '')
         + (el.className ? '.' + el.className.toString().trim().split(/\s+/).join('.') : ''),
    text: own.slice(0, 34), px: +px.toFixed(1), bold: bold, large: large,
    color: cs.color, bg: 'rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(', ') + ')',
    ratio: +cr.toFixed(2), need: large ? 3.0 : 4.5,
    pass: cr >= (large ? 3.0 : 4.5),
    overlaid: overlaid
  });
});
return out;
"""

CHROME_TEXT_SEL = (".topbar *, .skip-link, .section-rail *, "
                   "#nav-drawer *, #cmdk *")


def contrast_scan(d, selector=CHROME_TEXT_SEL):
    body = CONTRAST_JS.replace("SELECTOR", json.dumps(selector))
    rows = d.execute_script("return (function(){%s})();" % body)
    if not rows:
        raise SystemExit("SETUP FAILURE: contrast scan matched 0 text nodes for %r. "
                         "A vacuous pass is worse than a failure." % selector)
    return rows


# --------------------------------------------------------------------------
# tap targets
# --------------------------------------------------------------------------
TAP_JS = r"""
const MIN = 44;
const out = [];
const sel = 'a[href], button, input, select, textarea, summary,'
          + '[role="button"], [role="option"], [tabindex]:not([tabindex="-1"])';
document.querySelectorAll(sel).forEach(el => {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return;
  if (cs.pointerEvents === 'none') return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  if (r.bottom < 0 || r.top > innerHeight * 6) return;      // far off-page
  if (el.closest('dialog') && !el.closest('dialog').open) return;
  // The skip link parks itself off-screen until focused; measure it where the
  // user meets it, not at top:-60px.
  const w = r.width, h = r.height;
  if (w >= MIN && h >= MIN) return;
  out.push({
    sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
         + (el.className ? '.' + el.className.toString().trim().split(/\s+/).join('.') : ''),
    text: (el.getAttribute('aria-label') || el.textContent || '')
            .replace(/\s+/g, ' ').trim().slice(0, 30),
    w: +w.toFixed(1), h: +h.toFixed(1),
    inDialog: el.closest('dialog') ? el.closest('dialog').id : null
  });
});
return out;
"""


def tap_scan(d):
    return d.execute_script("return (function(){%s})();" % TAP_JS)


# --------------------------------------------------------------------------
# checks
# --------------------------------------------------------------------------
class Report:
    def __init__(self):
        self.rows = []

    def add(self, area, page, name, ok, detail=""):
        self.rows.append({"area": area, "page": page or "/", "check": name,
                          "ok": bool(ok), "detail": detail})
        flag = "PASS" if ok else "FAIL"
        print("  [%s] %-11s %-46s %s" % (flag, area, name, detail))

    @property
    def failures(self):
        return [r for r in self.rows if not r["ok"]]


def check_structure(d, rep, page):
    lands, heads = landmarks_and_headings(d)
    rep.add("structure", page, "landmark inventory", True,
            "; ".join("%s(%s)" % (l["role"], l["name"] or "-") for l in lands))
    mains = [l for l in lands if l["role"] == "main"]
    rep.add("structure", page, "exactly one main landmark", len(mains) == 1,
            "found %d" % len(mains))
    navs = [l for l in lands if l["role"] == "navigation"]
    unnamed = [n for n in navs if not n["name"]]
    rep.add("structure", page, "every nav landmark is named", not unnamed,
            "unnamed: %d of %d" % (len(unnamed), len(navs)))
    names = [n["name"] for n in navs]
    rep.add("structure", page, "nav landmark names are unique",
            len(names) == len(set(names)), "names=%s" % names)
    probs = heading_problems(heads)
    rep.add("structure", page, "heading order (one h1, no skipped levels)",
            not probs, " | ".join(probs) or "outline=%s"
            % "".join("h%s" % h["level"] for h in heads))
    return {"landmarks": lands, "headings": heads, "headingProblems": probs}


def check_aria_current(d, rep, page):
    got = d.execute_script(r"""
      const bar = [...document.querySelectorAll('#nav-links a')].map(a => ({
        text: a.textContent.trim(), href: a.getAttribute('href'),
        cur: a.getAttribute('aria-current'), active: a.classList.contains('is-active')}));
      return bar;
    """)
    page_cur = [a for a in got if a["cur"] == "page"]
    want = {"": 0, "projects/": 1, "travel/": 1}[page]
    rep.add("aria-current", page, "bar has expected aria-current=page count",
            len(page_cur) == want,
            "want %d got %d %s" % (want, len(page_cur),
                                   [a["text"] for a in page_cur]))
    return got


def check_skip_link(d, rep, page):
    d.execute_script("window.scrollTo(0,0);"
                     "document.body.setAttribute('tabindex','-1');"
                     "document.body.focus();document.body.removeAttribute('tabindex');")
    press_settled(d, "Tab")
    a = active(d)
    is_skip = "skip-link" in (a.get("cls") or "")
    rep.add("skip-link", page, "skip link is the first tab stop", is_skip,
            "got %s %r" % (a.get("tag"), a.get("text")))
    if not is_skip:
        return
    vis = d.execute_script(
        "const e=document.querySelector('.skip-link');const r=e.getBoundingClientRect();"
        "return {top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width),"
        " onscreen: r.top >= 0 && r.bottom <= innerHeight};")
    rep.add("skip-link", page, "skip link is on screen when focused",
            vis["onscreen"], "top=%s %sx%s" % (vis["top"], vis["w"], vis["h"]))
    rep.add("skip-link", page, "skip link ring visible", a.get("focusVisible") and a.get("ring"),
            "fv=%s outline=%s" % (a.get("focusVisible"), a.get("outline")))
    press(d, "Enter")
    time.sleep(1.2)
    after = d.execute_script(
        "return {y: Math.round(window.scrollY),"
        " af: document.activeElement.id || document.activeElement.tagName,"
        " isTarget: document.activeElement === "
        "  document.querySelector(document.querySelector('.skip-link').hash)};")
    rep.add("skip-link", page, "activating skip link moves focus to its target",
            after["isTarget"], "activeElement=%s scrollY=%s" % (after["af"], after["y"]))


def check_focus_rings(d, rep, page, label, limit=40):
    stops = tab_walk(d, limit=limit)
    loop = [s for s in stops if "LOOP" in s]
    real = [s for s in stops if "LOOP" not in s and not s.get("body")]
    rep.add("keyboard", page, "tab traversal reaches controls [%s]" % label,
            len(real) >= 5, "%d stops%s" % (len(real), " (cycled)" if loop else ""))
    noring = [s for s in real if s.get("focusVisible") and not s.get("ring")]
    rep.add("keyboard", page, "every keyboard stop has a visible ring [%s]" % label,
            not noring,
            "; ".join("%s%s" % (s["tag"], "#" + s["id"] if s.get("id") else
                                "." + (s.get("cls") or "?").split()[0])
                      for s in noring[:6]) or "%d stops checked" % len(real))
    novis = [s for s in real if not s.get("focusVisible")]
    rep.add("keyboard", page, "UA arms :focus-visible on every stop [%s]" % label,
            not novis, "; ".join(s["tag"] + (s.get("id") or "") for s in novis[:6]))
    offscreen = [s for s in real if not s.get("inViewport")]
    rep.add("keyboard", page, "no focused control is off-screen [%s]" % label,
            not offscreen,
            "; ".join("%s%s y=%s" % (s["tag"], "#" + (s.get("id") or ""),
                                     s["rect"]["y"]) for s in offscreen[:6]))
    return stops


def check_palette(d, rep, page, ctrl_key=2):
    """ctrl_key: CDP modifier bitmask. 2=Ctrl, 4=Meta."""
    d.execute_script("window.scrollTo(0,0);"
                     "document.getElementById('nav-cmd').focus();")
    press(d, "Escape")            # clear any prior state
    time.sleep(0.2)
    # Open via the real keyboard shortcut, not .click()
    press(d, "Space")
    time.sleep(0.5)
    st = d.execute_script(r"""
      const p = document.getElementById('cmdk');
      const i = document.getElementById('cmdk-input');
      const l = document.getElementById('cmdk-list');
      if (!p) return {missing: true};
      const opts = [...l.querySelectorAll('[role="option"]')];
      const ad = i.getAttribute('aria-activedescendant');
      const adEl = ad ? document.getElementById(ad) : null;
      return {
        open: p.open,
        focusInInput: document.activeElement === i,
        role: i.getAttribute('role'),
        expanded: i.getAttribute('aria-expanded'),
        controls: i.getAttribute('aria-controls'),
        autocomplete: i.getAttribute('aria-autocomplete'),
        listRole: l.getAttribute('role'),
        nOptions: opts.length,
        activedescendant: ad,
        adExists: !!adEl,
        adSelected: adEl ? adEl.getAttribute('aria-selected') : null,
        adText: adEl ? adEl.textContent.replace(/\s+/g,' ').trim().slice(0,40) : null,
        // A listbox may own `option` and `group` and nothing else. Anything
        // exposed (i.e. not aria-hidden) outside those two is stray content.
        nonOptionChildren: [...l.children]
            .filter(c => ['option', 'group'].indexOf(c.getAttribute('role')) < 0
                      && c.getAttribute('aria-hidden') !== 'true')
            .map(c => c.tagName.toLowerCase() + '[role=' + c.getAttribute('role') + ']'),
        triggerExpanded: document.getElementById('nav-cmd').getAttribute('aria-expanded'),
        liveRegions: [...document.querySelectorAll('#cmdk [role="status"],'
                    + '#cmdk [aria-live]')].map(e => e.id || e.className)
      };
    """)
    rep.add("palette", page, "opens from its trigger by keyboard", st.get("open"),
            "open=%s focusInInput=%s" % (st.get("open"), st.get("focusInInput")))
    rep.add("palette", page, "focus lands in the combobox input", st.get("focusInInput"), "")
    rep.add("palette", page, "combobox wiring (role/controls/autocomplete)",
            st.get("role") == "combobox" and st.get("controls") == "cmdk-list"
            and st.get("listRole") == "listbox" and st.get("autocomplete") == "list",
            "role=%s controls=%s list=%s ac=%s" % (st.get("role"), st.get("controls"),
                                                   st.get("listRole"), st.get("autocomplete")))
    rep.add("palette", page, "aria-activedescendant points at a real selected option",
            st.get("adExists") and st.get("adSelected") == "true",
            "ad=%s exists=%s selected=%s %r" % (st.get("activedescendant"),
                                                st.get("adExists"),
                                                st.get("adSelected"), st.get("adText")))
    rep.add("palette", page, "trigger reports its expanded state",
            st.get("triggerExpanded") == "true",
            "#nav-cmd aria-expanded=%s" % st.get("triggerExpanded"))
    rep.add("palette", page, "listbox contains only role=option children",
            not st.get("nonOptionChildren"),
            "non-option: %s" % (st.get("nonOptionChildren") or [])[:4])

    # arrowing must move the announced option
    before = st.get("activedescendant")
    press(d, "ArrowDown")
    time.sleep(0.2)
    after = d.execute_script(
        "const i=document.getElementById('cmdk-input');"
        "const ad=i.getAttribute('aria-activedescendant');"
        "const e=ad?document.getElementById(ad):null;"
        "return {ad: ad, sel: e?e.getAttribute('aria-selected'):null,"
        " nSel: document.querySelectorAll('#cmdk-list [aria-selected=\"true\"]').length,"
        " text: e?e.textContent.replace(/\\s+/g,' ').trim().slice(0,40):null};")
    rep.add("palette", page, "ArrowDown moves the announced active option",
            after["ad"] and after["ad"] != before and after["sel"] == "true",
            "%s -> %s %r" % (before, after["ad"], after["text"]))
    rep.add("palette", page, "exactly one option is aria-selected", after["nSel"] == 1,
            "count=%d" % after["nSel"])

    # empty result set. The status region is debounced 420ms so the reader is
    # not re-interrupted on every keystroke — wait past that or this samples the
    # region before it has been written.
    type_text(d, "zzzqqq")
    time.sleep(1.0)
    empty = d.execute_script(r"""
      const i = document.getElementById('cmdk-input');
      const e = document.getElementById('cmdk-empty');
      const live = [...document.querySelectorAll('#cmdk [role="status"], #cmdk [aria-live]')];
      return {
        n: document.querySelectorAll('#cmdk-list [role="option"]').length,
        expanded: i.getAttribute('aria-expanded'),
        ad: i.getAttribute('aria-activedescendant'),
        emptyVisible: e ? !e.hidden : null,
        liveText: live.map(x => (x.textContent || '').trim()).join(' / '),
        liveCount: live.length
      };
    """)
    rep.add("palette", page, "no-match: aria-expanded flips to false",
            empty["expanded"] == "false",
            "options=%d aria-expanded=%s" % (empty["n"], empty["expanded"]))
    rep.add("palette", page, "no-match: activedescendant cleared",
            not empty["ad"], "ad=%s" % empty["ad"])
    rep.add("palette", page, "no-match is announced via a live region",
            empty["liveCount"] > 0 and bool(empty["liveText"]),
            "regions=%d text=%r" % (empty["liveCount"], empty["liveText"]))

    # Tab must not escape the palette either. It has only TWO focusable children,
    # which is the case Chrome routes through <body> for one keypress — the
    # reason trapTab() exists at all.
    cycle = []
    for _ in range(8):
        press(d, "Tab")
        ap_ = active(d)
        cycle.append((ap_.get("dialogId"), ap_.get("id")))
    escaped = [c for c in cycle if c[0] != "cmdk"]
    rep.add("palette", page, "Tab never leaves the open palette", not escaped,
            "escapes: %s" % escaped[:4])

    # Escape + focus restoration
    press(d, "Escape")
    time.sleep(0.6)
    closed = d.execute_script(
        "return {open: document.getElementById('cmdk').open,"
        " af: document.activeElement.id || document.activeElement.tagName,"
        " expanded: document.getElementById('nav-cmd').getAttribute('aria-expanded'),"
        " locked: document.documentElement.classList.contains('nav-locked')};")
    rep.add("palette", page, "Escape closes the palette", not closed["open"],
            "open=%s" % closed["open"])
    rep.add("palette", page, "focus restored to the trigger on close",
            closed["af"] == "nav-cmd", "activeElement=%s" % closed["af"])
    rep.add("palette", page, "scroll lock released on close", not closed["locked"], "")
    rep.add("palette", page, "trigger aria-expanded reset to false",
            closed["expanded"] == "false", "=%s" % closed["expanded"])

    # ---- the ADVERTISED shortcuts, driven as real modified key events. The
    # button carries aria-keyshortcuts="Meta+K Control+K"; if the handler did not
    # fire, the bar is promising a key that does nothing. `/` is the documented
    # second-nature alternative and must be suppressed inside form fields.
    d.execute_script("document.body.click();")
    for label, mods in (("Ctrl+K", 2), ("Meta+K", 4)):
        press(d, "Escape", settle=0.3)
        press(d, "Tab")                          # focus something in the page
        cdp(d, "Input.dispatchKeyEvent", {"type": "rawKeyDown", "modifiers": mods,
                                          "key": "k", "code": "KeyK",
                                          "windowsVirtualKeyCode": 75})
        cdp(d, "Input.dispatchKeyEvent", {"type": "keyUp", "modifiers": mods,
                                          "key": "k", "code": "KeyK",
                                          "windowsVirtualKeyCode": 75})
        time.sleep(0.6)
        opened = d.execute_script(
            "return {open: document.getElementById('cmdk').open,"
            " focused: document.activeElement.id};")
        rep.add("palette", page, "%s opens the palette" % label, opened["open"],
                "open=%s focus=%s" % (opened["open"], opened["focused"]))
        rep.add("palette", page, "%s lands focus in the input" % label,
                opened["focused"] == "cmdk-input", "focus=%s" % opened["focused"])
        press(d, "Escape", settle=0.6)

    d.execute_script("window.scrollTo(0,0);"
                     "document.getElementById('nav-cmd').focus();")
    type_text(d, "/")
    time.sleep(0.6)
    rep.add("palette", page, "'/' opens the palette outside a form field",
            d.execute_script("return document.getElementById('cmdk').open;"), "")
    # ...and must NOT hijack a slash typed into the palette's own text field.
    type_text(d, "/x")
    time.sleep(0.3)
    val = d.execute_script("return document.getElementById('cmdk-input').value;")
    rep.add("palette", page, "'/' is not hijacked inside a text field",
            "/" in val, "input value=%r" % val)
    press(d, "Escape", settle=0.6)
    return st


def check_drawer(d, rep, page):
    d.execute_script("window.scrollTo(0,0);document.getElementById('nav-toggle').focus();")
    st0 = d.execute_script(
        "const t=document.getElementById('nav-toggle');"
        "const r=t.getBoundingClientRect();"
        "return {exp: t.getAttribute('aria-expanded'), w: Math.round(r.width),"
        " h: Math.round(r.height), disp: getComputedStyle(t).display};")
    rep.add("drawer", page, "hamburger is displayed at phone width",
            st0["disp"] != "none", "display=%s %sx%s" % (st0["disp"], st0["w"], st0["h"]))
    press(d, "Enter")
    time.sleep(0.6)
    st = d.execute_script(r"""
      const dg = document.getElementById('nav-drawer');
      const t = document.getElementById('nav-toggle');
      const ae = document.activeElement;
      return {
        open: dg.open, exp: t.getAttribute('aria-expanded'),
        toggleLabel: t.getAttribute('aria-label'),
        focusInside: dg.contains(ae),
        focusOn: ae.id || ae.className || ae.tagName,
        locked: document.documentElement.classList.contains('nav-locked'),
        modal: dg.matches(':modal'),
        role: dg.getAttribute('role'),
        name: dg.getAttribute('aria-label'),
        sectionsShown: !document.getElementById('drawer-sections-group').hidden,
        rows: document.querySelectorAll('#nav-drawer .drawer-link').length
      };
    """)
    rep.add("drawer", page, "opens by keyboard", st["open"], "open=%s" % st["open"])
    rep.add("drawer", page, "is a real modal (top layer + platform trap)", st["modal"], "")
    rep.add("drawer", page, "toggle aria-expanded=true while open", st["exp"] == "true",
            "=%s label=%r" % (st["exp"], st["toggleLabel"]))
    rep.add("drawer", page, "focus moves into the drawer", st["focusInside"],
            "focus on %s" % st["focusOn"])
    rep.add("drawer", page, "page scroll is locked", st["locked"], "")

    # tab cycle must not escape
    cycle = []
    for _ in range(14):
        press(d, "Tab")
        a = active(d)
        cycle.append((a.get("dialogId"), a.get("id") or a.get("cls")))
    escaped = [c for c in cycle if c[0] != "nav-drawer"]
    rep.add("drawer", page, "Tab never leaves the open drawer", not escaped,
            "escapes: %s" % escaped[:4])
    rings = d.execute_script(r"""
      const bad = [];
      document.querySelectorAll('#nav-drawer a[href], #nav-drawer button')
        .forEach(el => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none') return;
          const r = el.getBoundingClientRect();
          if (r.width < 44 || r.height < 44) bad.push(
            (el.id || el.className.toString().split(' ')[0]) + ' '
            + Math.round(r.width) + 'x' + Math.round(r.height));
        });
      return bad;
    """)
    rep.add("drawer", page, "every drawer control is >= 44x44", not rings,
            "; ".join(rings[:6]))

    press(d, "Escape")
    time.sleep(0.6)
    cl = d.execute_script(
        "const t=document.getElementById('nav-toggle');"
        "return {open: document.getElementById('nav-drawer').open,"
        " exp: t.getAttribute('aria-expanded'),"
        " af: document.activeElement.id || document.activeElement.tagName,"
        " locked: document.documentElement.classList.contains('nav-locked')};")
    rep.add("drawer", page, "Escape closes the drawer", not cl["open"], "open=%s" % cl["open"])
    rep.add("drawer", page, "toggle aria-expanded=false after close",
            cl["exp"] == "false", "=%s" % cl["exp"])
    rep.add("drawer", page, "focus restored to the hamburger",
            cl["af"] == "nav-toggle", "activeElement=%s" % cl["af"])
    rep.add("drawer", page, "scroll lock released", not cl["locked"], "")


def check_label_in_name(d, rep, page):
    """WCAG 2.5.3 Label in Name (Level A): the accessible name must contain the
    visible label, or a voice-control user cannot address the control."""
    bad = d.execute_script(r"""
      const bad = [];
      document.querySelectorAll('.topbar a, .topbar button, #cmdk button, #cmdk input,'
        + '#nav-drawer a, #nav-drawer button, .rail-tick, .skip-link').forEach(el => {
        const al = el.getAttribute('aria-label');
        if (!al) return;
        let vis = '';
        const walk = n => {
          if (n.nodeType === 3) { vis += n.textContent; return; }
          if (n.nodeType !== 1) return;
          if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return;
          if (getComputedStyle(n).display === 'none') return;
          n.childNodes.forEach(walk);
        };
        el.childNodes.forEach(walk);
        vis = vis.replace(/\s+/g, ' ').trim();
        if (!vis) return;                       // icon-only: nothing to match
        const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
                           .replace(/\s+/g, ' ').trim();
        if (norm(al).indexOf(norm(vis)) < 0)
          bad.push((el.id || el.tagName.toLowerCase()) + ': visible ' + JSON.stringify(vis)
                   + ' not in name ' + JSON.stringify(al));
      });
      return bad;
    """)
    rep.add("2.5.3", page, "accessible name contains the visible label",
            not bad, "; ".join(bad[:4]))


def check_rail_clearance(d, rep, page, base):
    """The rail is a fixed strip in the page gutter. If its hit column ever
    overlaps the content column it silently swallows clicks meant for text —
    which is why widening the tick to 44px had to be paid for out of the
    `right` offset and not out of the gutter. Asserted at the narrowest width
    the rail is enabled at, where the budget is tightest."""
    rows = []
    for w in (1024, 1100, 1280, 1440):
        set_viewport(d, dict(DESKTOP, width=w))
        load(d, base, page)
        r = d.execute_script(r"""
          const rail = document.getElementById('section-rail');
          const tick = rail.querySelector('.rail-tick');
          if (!tick || getComputedStyle(rail).display === 'none') return null;
          const band = document.querySelector('.band .band-inner')
                    || document.querySelector('.band');
          const rr = rail.getBoundingClientRect(), tr = tick.getBoundingClientRect(),
                br = band.getBoundingClientRect();
          return {vw: innerWidth,
                  tick: Math.round(tr.width) + 'x' + Math.round(tr.height),
                  clearance: Math.round(rr.left - br.right),
                  railRightEdgeGap: Math.round(innerWidth - rr.right)};
        """)
        if r:
            rows.append(r)
    ok44 = [r for r in rows if r["tick"] != "44x44"]
    rep.add("rail", page, "tick is 44x44 at every rail width", not ok44,
            "; ".join("%d:%s" % (r["vw"], r["tick"]) for r in rows))
    overlap = [r for r in rows if r["clearance"] < 0]
    rep.add("rail", page, "rail never overlaps the content column", not overlap,
            "; ".join("%d:clear=%d gap=%d" % (r["vw"], r["clearance"],
                                              r["railRightEdgeGap"]) for r in rows))
    return rows


def check_dialog_rings(d, rep, page):
    """Focus rings INSIDE the two modals. tab_walk() can never reach these —
    the dialogs are display:none when closed — so a ring missing in here was
    invisible to the traversal check. This is where #cmdk-input's bare
    `outline: none` was hiding."""
    for dlg, opener in (("cmdk", "nav-cmd"), ("nav-drawer", "nav-toggle")):
        d.execute_script("document.getElementById(%s).click();" % json.dumps(opener))
        time.sleep(0.7)
        if not d.execute_script("return document.getElementById(%s).open;" % json.dumps(dlg)):
            rep.add("keyboard", page, "%s opens for ring check" % dlg, False, "")
            continue
        seen, noring = [], []
        for _ in range(12):
            press(d, "Tab", settle=0.1)
            a = active(d)
            key = a.get("id") or (a.get("cls") or "")[:20]
            seen.append(key)
            if a.get("dialogId") != dlg:
                continue
            if a.get("focusVisible") and not a.get("ring"):
                noring.append("%s (outline=%s shadow=%s)"
                              % (key, a.get("outline"), a.get("boxShadow")))
        uniq = []
        for x in noring:
            if x not in uniq:
                uniq.append(x)
        rep.add("keyboard", page, "every control inside #%s shows a ring" % dlg,
                not uniq, "; ".join(uniq[:3]) or "stops=%s" % sorted(set(seen)))
        press(d, "Escape", settle=0.5)


def check_listbox_ax(d, rep, page):
    """Read the palette's structure out of Chrome's OWN accessibility tree.
    Checking the DOM would only prove the attributes are spelled right; this
    proves the listbox actually exposes group+option and nothing else."""
    d.execute_script("document.getElementById('nav-cmd').click();")
    time.sleep(0.7)
    nodes = ax_tree(d)
    by_id = {n["nodeId"]: n for n in nodes}
    lb = [n for n in nodes
          if (n.get("role") or {}).get("value") == "listbox" and not n.get("ignored")]
    rep.add("palette", page, "listbox is exposed in the AX tree", len(lb) == 1,
            "found %d" % len(lb))
    if len(lb) != 1:
        press(d, "Escape", settle=0.4)
        return
    kids = []
    for cid in lb[0].get("childIds", []):
        n = by_id.get(cid)
        if not n or n.get("ignored"):
            continue
        kids.append(((n.get("role") or {}).get("value"),
                     ((n.get("name") or {}).get("value") or "").strip()))
    stray = [k for k in kids if k[0] not in ("group", "option")]
    rep.add("palette", page, "listbox exposes only group/option children",
            not stray and bool(kids),
            "children=%s" % kids)
    groups = [k for k in kids if k[0] == "group"]
    rep.add("palette", page, "each group carries an accessible name",
            bool(groups) and all(g[1] for g in groups),
            "groups=%s" % [g[1] for g in groups])
    press(d, "Escape", settle=0.4)
    return kids


def check_rail(d, rep, page):
    st = d.execute_script(r"""
      const rail = document.getElementById('section-rail');
      if (!rail) return {missing: true};
      const cs = getComputedStyle(rail);
      const ticks = [...rail.querySelectorAll('.rail-tick')];
      const bands = document.querySelectorAll('.band').length;
      return {
        display: cs.display, bands: bands, ticks: ticks.length,
        ariaHidden: rail.getAttribute('aria-hidden'),
        name: rail.getAttribute('aria-label'),
        role: rail.tagName.toLowerCase(),
        labels: ticks.map(t => t.getAttribute('aria-label')),
        unlabelled: ticks.filter(t => !t.getAttribute('aria-label')).length,
        sizes: ticks.map(t => { const r = t.getBoundingClientRect();
                                return Math.round(r.width) + 'x' + Math.round(r.height); }),
        tabbable: ticks.filter(t => t.tabIndex >= 0).length,
        current: ticks.filter(t => t.getAttribute('aria-current')).length
      };
    """)
    if st.get("missing"):
        rep.add("rail", page, "rail element present", False, "#section-rail missing")
        return
    shown = st["display"] != "none"
    rep.add("rail", page, "rail visible at 1440px", shown,
            "display=%s ticks=%d bands=%d" % (st["display"], st["ticks"], st["bands"]))
    if not shown:
        return
    rep.add("rail", page, "one tick per band", st["ticks"] == st["bands"],
            "%d ticks vs %d bands" % (st["ticks"], st["bands"]))
    rep.add("rail", page, "every tick has an accessible name", st["unlabelled"] == 0,
            "unlabelled=%d e.g. %r" % (st["unlabelled"], (st["labels"] or [None])[0]))
    rep.add("rail", page, "every tick is keyboard reachable",
            st["tabbable"] == st["ticks"], "tabbable %d/%d" % (st["tabbable"], st["ticks"]))
    rep.add("rail", page, "exactly one tick carries aria-current", st["current"] == 1,
            "count=%d" % st["current"])
    small = [s for s in st["sizes"]
             if int(s.split("x")[0]) < 44 or int(s.split("x")[1]) < 44]
    rep.add("rail", page, "every tick is >= 44x44", not small,
            "under: %s" % small[:5])
    # reachable by Tab from the top of the page?
    stops = tab_walk(d, limit=60)
    hit = [s for s in stops if "rail-tick" in (s.get("cls") or "")]
    rep.add("rail", page, "rail ticks are reached by sequential Tab", bool(hit),
            "%d rail stops in first 60" % len(hit))
    return st


def check_reduced_motion(d, rep, base, page):
    load(d, base, page, reduced=True)
    ok = d.execute_script("return matchMedia('(prefers-reduced-motion: reduce)').matches;")
    rep.add("reduced", page, "reduced-motion media query is actually active", ok, "")
    if not ok:
        return
    d.set_script_timeout(40)
    res = d.execute_async_script(r"""
      const done = arguments[0];
      const H = document.documentElement.scrollHeight;
      let y = 0;
      (function step(){
        y += innerHeight * 0.8;
        window.scrollTo(0, Math.min(y, H));
        if (y < H) setTimeout(step, 70);
        else setTimeout(() => {
          const stranded = [];
          document.querySelectorAll('.topbar *, .section-rail *, .reveal, .band, h1, h2')
            .forEach(el => {
              const cs = getComputedStyle(el);
              const r = el.getBoundingClientRect();
              if (!r.width && !r.height) return;
              if (cs.display === 'none' || cs.visibility === 'hidden') return;
              if (el.getAttribute('aria-hidden') === 'true') return;
              if (parseFloat(cs.opacity) < 0.99)
                stranded.push((el.id || el.className || el.tagName) + ' op=' + cs.opacity);
            });
          const running = document.getAnimations()
            .filter(a => a.playState === 'running')
            .map(a => (a.effect && a.effect.target
                        ? (a.effect.target.id || a.effect.target.className
                           || a.effect.target.tagName) : '?')
                     + '::' + ((a.effect && a.effect.pseudoElement) || '')
                     + ' ' + (a.animationName || ''));
          done({stranded: stranded.slice(0, 10), running: running.slice(0, 10),
                condensed: document.documentElement.classList.contains('nav-condensed')});
        }, 900);
      })();
    """)
    rep.add("reduced", page, "nothing stranded invisible after a full scroll",
            not res["stranded"], "; ".join(res["stranded"][:5]))
    rep.add("reduced", page, "bar does not condense under reduced motion",
            not res["condensed"], "nav-condensed=%s" % res["condensed"])

    # dialogs under reduced motion: they must still open, close, and not animate
    d.execute_script("window.scrollTo(0,0);")
    anim = d.execute_script(r"""
      const p = document.getElementById('cmdk');
      document.getElementById('nav-cmd').click();
      const a = document.getAnimations().map(x => ({
        name: x.animationName || '?',
        pseudo: (x.effect && x.effect.pseudoElement) || '',
        state: x.playState,
        target: x.effect && x.effect.target
                ? (x.effect.target.id || x.effect.target.className || x.effect.target.tagName)
                : '?'
      }));
      return {open: p.open, animations: a};
    """)
    running = [a for a in anim["animations"] if a["state"] == "running"]
    rep.add("reduced", page, "palette opens with no running animation",
            anim["open"] and not running,
            "open=%s running=%s" % (anim["open"],
                                    [(a["target"], a["pseudo"], a["name"]) for a in running]))
    press(d, "Escape")
    time.sleep(0.4)
    rep.add("reduced", page, "palette closes immediately under reduced motion",
            not d.execute_script("return document.getElementById('cmdk').open;"), "")

    # The drawer's own animations: drawer-in on the panel, drawer-row on every
    # staggered link, nav-fade-in on the backdrop. Its rows resting at opacity 0
    # would be the worst possible reduced-motion outcome, so this checks both
    # "no motion" and "nothing hidden" in the same open state.
    danim = d.execute_script(r"""
      const dg = document.getElementById('nav-drawer');
      const t = document.getElementById('nav-toggle');
      if (getComputedStyle(t).display === 'none') t.style.display = 'flex';
      t.click();
      const running = document.getAnimations()
        .filter(a => a.playState === 'running')
        .map(a => ((a.effect && a.effect.target)
                    ? (a.effect.target.id || a.effect.target.className
                       || a.effect.target.tagName) : '?')
                 + ((a.effect && a.effect.pseudoElement) || '')
                 + ' ' + (a.animationName || ''));
      const faded = [...dg.querySelectorAll('.drawer-link, .drawer-search, .drawer-close')]
        .filter(e => parseFloat(getComputedStyle(e).opacity) < 0.99)
        .map(e => (e.id || e.className) + ' op=' + getComputedStyle(e).opacity);
      return {open: dg.open, running: running.slice(0, 8), faded: faded.slice(0, 6)};
    """)
    rep.add("reduced", page, "drawer opens with no running animation",
            danim["open"] and not danim["running"],
            "open=%s running=%s" % (danim["open"], danim["running"]))
    rep.add("reduced", page, "no drawer row is left faded under reduced motion",
            not danim["faded"], "; ".join(danim["faded"]))
    press(d, "Escape")
    time.sleep(0.4)
    rep.add("reduced", page, "drawer closes immediately under reduced motion",
            not d.execute_script("return document.getElementById('nav-drawer').open;"), "")
    set_reduced_motion(d, False)


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8231")
    ap.add_argument("--json")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    only = set(x.strip() for x in args.only.split(",") if x.strip())

    def want(name):
        return not only or name in only

    d = make_driver(args.headed)
    rep = Report()
    raw = {}
    try:
        for page in PAGES:
            print("\n=== %s%s  (desktop 1440) ===" % (args.base, page or "/"))
            set_viewport(d, DESKTOP)
            url = load(d, args.base, page)
            html_len = d.execute_script("return document.documentElement.outerHTML.length;")
            css_ok = d.execute_script(
                "return getComputedStyle(document.querySelector('.topbar')).position;")
            rep.add("setup", page, "page served with CSS applied",
                    html_len > 4000 and css_ok == "fixed",
                    "html=%dB .topbar position=%s" % (html_len, css_ok))
            assert_viewport(d, 1440, False)

            if want("structure"):
                raw.setdefault(page, {})["structure"] = check_structure(d, rep, page)
            if want("aria"):
                raw.setdefault(page, {})["bar"] = check_aria_current(d, rep, page)
            if want("skip"):
                check_skip_link(d, rep, page)
                load(d, args.base, page)
            if want("keyboard"):
                check_focus_rings(d, rep, page, "1440")
            if want("rail"):
                raw.setdefault(page, {})["rail"] = check_rail(d, rep, page)
                raw.setdefault(page, {})["railClear"] = \
                    check_rail_clearance(d, rep, page, args.base)
                set_viewport(d, DESKTOP)
                load(d, args.base, page)
            if want("keyboard"):
                check_dialog_rings(d, rep, page)
                load(d, args.base, page)
            if want("palette"):
                check_label_in_name(d, rep, page)
                raw.setdefault(page, {})["listboxAx"] = check_listbox_ax(d, rep, page)
                load(d, args.base, page)
                check_palette(d, rep, page)
            if want("contrast"):
                load(d, args.base, page)
                cs = contrast_scan(d)
                overlaid = [c for c in cs if c.get("overlaid")]
                bad = [c for c in cs if not c["pass"] and not c.get("overlaid")]
                rep.add("contrast", page, "all chrome text meets AA (DOM composite)",
                        not bad, "; ".join("%s %.2f<%.1f (%.1fpx)"
                                           % (c["sel"][:34], c["ratio"], c["need"], c["px"])
                                           for c in bad[:6])
                        or "%d text nodes checked" % len(cs))
                # Never silently drop the handed-off rows: name them, and require
                # that the set is the one tools/a11y_pixel.py actually covers.
                rep.add("contrast", page,
                        "sibling-overlaid text is handed to the pixel tool, not guessed",
                        all("nav-link" in c["sel"] for c in overlaid),
                        "handed off: %s" % [c["sel"][:34] for c in overlaid])
                sage = [c for c in cs if c["color"] == SAGE_FAIL and not c["large"]]
                rep.add("contrast", page, "no small text painted in plain --sage",
                        not sage, "; ".join(c["sel"][:40] for c in sage[:5]))
                raw.setdefault(page, {})["contrast"] = cs

            # ---- phone ----
            print("\n=== %s%s  (phone 390 CDP + touch) ===" % (args.base, page or "/"))
            set_viewport(d, PHONE, touch=True, ua=PHONE_UA)
            load(d, args.base, page)
            vp = assert_viewport(d, 390, True)
            rep.add("setup", page, "390px override is real (not a clamped window)",
                    vp["w"] == 390 and vp["mobileBp"],
                    "innerWidth=%s coarse=%s mobileBp=%s"
                    % (vp["w"], vp["coarse"], vp["mobileBp"]))
            if want("drawer"):
                check_drawer(d, rep, page)
                load(d, args.base, page)
            if want("keyboard"):
                check_focus_rings(d, rep, page, "390", limit=25)
            if want("tap"):
                small = tap_scan(d)
                rep.add("tap", page, "all visible controls >= 44x44 (closed chrome)",
                        not small, "; ".join("%s %sx%s" % (s["sel"][:40], s["w"], s["h"])
                                             for s in small[:8]))
                d.execute_script("document.getElementById('nav-toggle').click();")
                time.sleep(0.6)
                small2 = tap_scan(d)
                rep.add("tap", page, "all visible controls >= 44x44 (drawer open)",
                        not small2, "; ".join("%s %sx%s" % (s["sel"][:40], s["w"], s["h"])
                                              for s in small2[:8]))
                press(d, "Escape")
                time.sleep(0.4)
                d.execute_script("document.getElementById('nav-cmd').click();")
                time.sleep(0.6)
                small3 = tap_scan(d)
                rep.add("tap", page, "all visible controls >= 44x44 (palette open)",
                        not small3, "; ".join("%s %sx%s" % (s["sel"][:40], s["w"], s["h"])
                                              for s in small3[:8]))
                press(d, "Escape")
                raw.setdefault(page, {})["tap"] = {"closed": small, "drawer": small2,
                                                   "palette": small3}
            if want("contrast"):
                load(d, args.base, page)
                d.execute_script("document.getElementById('nav-toggle').click();")
                time.sleep(0.6)
                cs = contrast_scan(d, "#nav-drawer *")
                bad = [c for c in cs if not c["pass"]]
                rep.add("contrast", page, "drawer text meets AA at 390px", not bad,
                        "; ".join("%s %.2f<%.1f" % (c["sel"][:34], c["ratio"], c["need"])
                                  for c in bad[:6]) or "%d nodes" % len(cs))
            if want("reduced"):
                set_viewport(d, DESKTOP)
                check_reduced_motion(d, rep, args.base, page)

    finally:
        try:
            d.quit()
        except Exception:
            pass

    print("\n" + "=" * 78)
    fails = rep.failures
    print("TOTAL %d checks, %d FAILURES" % (len(rep.rows), len(fails)))
    for f in fails:
        print("  FAIL  %-9s %-11s %-44s %s"
              % (f["page"], f["area"], f["check"], f["detail"][:90]))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump({"rows": rep.rows, "raw": raw}, fh, indent=1)
        print("wrote %s" % args.json)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
