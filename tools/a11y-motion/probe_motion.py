#!/usr/bin/env python3
"""probe_motion.py — targeted checks for the motion/a11y audit.

Usage: probe_motion.py <base_url> <label> [check ...]

Checks (all by default):
  cssom     every stylesheet parses; report rule counts + whether each file's
            prefers-reduced-motion @media block survived the parser.
  tabindex  the [tabindex] set with motion-ux.js live vs BLOCKED AT THE
            NETWORK LAYER (CDP Network.setBlockedURLs). Motion.press() sets
            tabIndex=0 on non-focusable targets, so any diff is a real
            injection into the tab order.
  rmflip    load NORMAL, scroll through the pinned hero so GSAP has written
            inline transforms, THEN flip prefers-reduced-motion via
            Emulation.setEmulatedMedia. Every parallax plane must end with no
            transform. Both layers are exercised here: scroll.css's `!important`
            belt and gsap-motion.js §10's unwind.
  willchange census of computed will-change != auto after everything settles,
            at 1440 AND 390 -- the hero-plane hints used to apply at every
            width for a pin that only exists at >= 900px.
  frames    longest frame during a scripted scroll, sampled in-page with rAF.
  focus     tab through every focusable, sampling twice per stop: at t0 and
            again POLLED UNTIL STABLE. `scroll-behavior: smooth` plus the .6s
            `.reveal` transition mean a t0 hit is usually legitimate motion;
            only the settled verdict is a finding.
  clipmargin  the SplitText mask geometry workaround still produces a clip
            edge 0.2em outside the content box on both vertical edges.
  rmhover   after a mid-session reduced-motion flip, does a REAL mouse move
            onto a claimed element still produce a live spring? Targets the
            claims that are NOT `.reveal`, because `.reveal`'s own belt masks
            the answer on the cards and the passes.
  rmpin     the three states no stylesheet can undo: the pin (plus its injected
            pin-spacer), a `repeat: -1` tween on SVG cx/cy ATTRIBUTES, and an
            inline opacity:0 on a heading whose `.reveal` class was stripped.
  deeplink  arrive at a #hash PAST a trigger and look for content the reader
            has reached but that never un-hid. Settle floor 6s, because
            gsap-motion.js's last-resort belts fire at 2500ms and 4000ms and a
            faster probe reports both of them as failures.
  widestrand  the ordinary full-scroll journey, but with a selector wide
            enough to include the chip staggers and the SplitText claims --
            neither of which gate_dir.py's selector can see.

TWO RULES THIS FILE ENFORCES ON ITSELF, both learned the hard way here:
  1. Never report a value sampled mid-tween. Poll until it stops changing, and
     give the implementation's own late safety belts time to fire first. A
     1.7s settle produced 57 "stranded" elements on /#interests; every one was
     a false positive.
  2. Never call an element stranded without checking whether the reader has
     REACHED it. Below-fold content at opacity 0 is waiting its turn, not
     broken. Adding that one test took the same run from 57 findings to 0.
"""
import json
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8130"
LABEL = sys.argv[2] if len(sys.argv) > 2 else BASE
ONLY = set(sys.argv[3:])
PAGES = ["", "projects/", "travel/"]

PLANES = (".home-inner, .hero-name, .hero-lower, .hero-canvas-wrap, "
          ".section-head, .shape-plx, .hero-fg-plx, .trip-mark, .hero-fg")


def driver(width=1440, height=900, reduced=False):
    o = Options()
    o.add_argument("--headless=new")
    o.add_argument("--hide-scrollbars")
    o.add_argument("--force-device-scale-factor=1")
    if reduced:
        o.add_argument("--force-prefers-reduced-motion")
    d = webdriver.Chrome(options=o)
    d.set_script_timeout(90)
    d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                      {"width": width, "height": height,
                       "deviceScaleFactor": 1, "mobile": False})
    return d


SCROLL_ALL = r"""
const done = arguments[0];
const H = () => document.documentElement.scrollHeight;
let y = 0;
(function step(){
  y += window.innerHeight * 0.5;
  window.scrollTo(0, Math.min(y, H()));
  if (y < H()) setTimeout(step, 70); else setTimeout(()=>done(true), 1200);
})();
"""


# ---------------------------------------------------------------- cssom
CSSOM_JS = r"""
const out = [];
for (const ss of document.styleSheets) {
  let rules = null, err = null;
  try { rules = ss.cssRules; } catch (e) { err = String(e); }
  if (!rules) { out.push({href: ss.href, error: err}); continue; }
  let rm = 0, rmDecls = 0, bogus = 0;
  for (const r of rules) {
    if (r.type === CSSRule.MEDIA_RULE &&
        /prefers-reduced-motion/.test(r.conditionText || r.media.mediaText)) {
      rm++; rmDecls += r.cssRules.length;
    }
    // A rule whose selector swallowed a comment / an at-rule is the signature
    // of an unterminated comment upstream of it.
    if (r.type === CSSRule.STYLE_RULE && /[*]\/|@media/.test(r.selectorText || "")) bogus++;
  }
  out.push({href: (ss.href||"inline").split('/').pop(), rules: rules.length,
            rmBlocks: rm, rmDecls: rmDecls, bogus: bogus});
}
return out;
"""


def check_cssom(rep):
    d = driver()
    try:
        for p in PAGES:
            d.get(f"{BASE}/{p}")
            time.sleep(0.7)
            for s in d.execute_script(CSSOM_JS):
                rep.append(("cssom", p or "/", json.dumps(s)))
            break   # same <head> on all three pages
    finally:
        d.quit()


# ------------------------------------------------------------- tabindex
TABINDEX_JS = r"""
const m = {};
document.querySelectorAll('[tabindex]').forEach(el => {
  const k = el.tagName.toLowerCase() + '.' + (el.className||'').split(' ')[0]
          + '[tabindex=' + el.getAttribute('tabindex') + ']';
  m[k] = (m[k]||0) + 1;
});
return {map: m, total: document.querySelectorAll('[tabindex]').length,
        motionOn: document.documentElement.classList.contains('motion-on')};
"""


def tabindex_for(page, block):
    d = driver()
    try:
        if block:
            d.execute_cdp_cmd("Network.enable", {})
            d.execute_cdp_cmd("Network.setBlockedURLs",
                              {"urls": ["*motion-ux.js", "*motion.min.js"]})
        d.get(f"{BASE}/{page}")
        time.sleep(1.2)
        d.execute_async_script(SCROLL_ALL)
        # a press() call can happen lazily; give hover/press wiring time
        time.sleep(0.8)
        return d.execute_script(TABINDEX_JS)
    finally:
        d.quit()


def check_tabindex(rep):
    for p in PAGES:
        live = tabindex_for(p, False)
        base = tabindex_for(p, True)
        diff = {}
        for k in set(list(live["map"]) + list(base["map"])):
            a, b = base["map"].get(k, 0), live["map"].get(k, 0)
            if a != b:
                diff[k] = f"baseline={a} live={b}"
        rep.append(("tabindex", p or "/",
                    f"motionOn={live['motionOn']} baselineTotal={base['total']} "
                    f"liveTotal={live['total']} diff={json.dumps(diff)}"))


# --------------------------------------------------------------- rmflip
PLANE_JS = r"""
const sel = arguments[0];
const out = [];
document.querySelectorAll(sel).forEach(el => {
  const cs = getComputedStyle(el);
  out.push({
    cls: (el.className && el.className.baseVal !== undefined
            ? el.className.baseVal : el.className) || el.tagName,
    transform: cs.transform,
    inline: el.getAttribute('style') || '',
    display: cs.display,
    opacity: cs.opacity,
  });
});
return out;
"""


def check_rmflip(rep):
    for p in PAGES:
        d = driver()
        try:
            d.get(f"{BASE}/{p}")
            time.sleep(1.2)
            # Scroll INTO the pin (not past it) so the hero planes hold a
            # live inline transform, then a bit further for .section-head.
            d.execute_script("window.scrollTo(0, Math.round(window.innerHeight*0.55));")
            time.sleep(1.2)
            before = d.execute_script(PLANE_JS, PLANES)
            moved_before = [b for b in before
                            if b["transform"] not in ("none", "matrix(1, 0, 0, 1, 0, 0)")]
            # Flip the preference at runtime, exactly as a reader would.
            d.execute_cdp_cmd("Emulation.setEmulatedMedia", {
                "features": [{"name": "prefers-reduced-motion", "value": "reduce"}]})
            time.sleep(1.0)
            after = d.execute_script(PLANE_JS, PLANES)
            moved_after = [a for a in after
                           if a["transform"] not in ("none", "matrix(1, 0, 0, 1, 0, 0)")
                           and a["display"] != "none"]
            rep.append(("rmflip", p or "/",
                        f"planes={len(before)} transformed_before_flip={len(moved_before)} "
                        f"STILL_transformed_after_flip={len(moved_after)} "
                        + json.dumps([f'{a["cls"]}:{a["transform"]}' for a in moved_after][:8])))
        finally:
            d.quit()


# ----------------------------------------------------------- willchange
WC_JS = r"""
const counts = {};
let total = 0;
document.querySelectorAll('*').forEach(el => {
  const wc = getComputedStyle(el).willChange;
  if (!wc || wc === 'auto') return;
  total++;
  const k = (el.tagName.toLowerCase() + '.' +
    String((el.className && el.className.baseVal !== undefined
       ? el.className.baseVal : el.className) || '').split(' ').filter(Boolean).slice(0,2).join('.'))
    + ' => ' + wc;
  counts[k] = (counts[k]||0)+1;
});
return {total: total, counts: counts};
"""


def check_willchange(rep):
    # Both widths: the hero-plane hints are the ones that used to apply at
    # every width for a pin that only exists at >= 900px, so 390 is where the
    # regression lives and 1440 is the control that must NOT change.
    for w in (1440, 390):
        for p in PAGES:
            d = driver(width=w)
            try:
                d.get(f"{BASE}/{p}")
                time.sleep(1.0)
                d.execute_async_script(SCROLL_ALL)
                time.sleep(2.0)
                r = d.execute_script(WC_JS)
                heroes = {k: v for k, v in r["counts"].items()
                          if any(h in k for h in ("home-inner", "hero-name",
                                                  "hero-lower", "hero-canvas-wrap"))}
                top = sorted(r["counts"].items(), key=lambda kv: -kv[1])[:5]
                rep.append(("willchange", p or "/",
                            f"@{w} total={r['total']} heroPlanes={sum(heroes.values())} "
                            f"top={json.dumps(top)}"))
            finally:
                d.quit()


# --------------------------------------------------------------- frames
FRAMES_JS = r"""
const done = arguments[0];
const gaps = [];
let last = performance.now();
let stop = false;
(function raf(){ const t = performance.now(); gaps.push(t-last); last = t;
  if (!stop) requestAnimationFrame(raf); })();
const H = document.documentElement.scrollHeight;
let y = 0;
(function step(){
  y += 120;
  window.scrollTo(0, Math.min(y, H));
  if (y < H) requestAnimationFrame(step);
  else setTimeout(()=>{ stop = true;
    const s = gaps.slice(5).sort((a,b)=>a-b);
    const q = f => s.length ? s[Math.min(s.length-1, Math.floor(s.length*f))] : 0;
    done({n:s.length, p50:+q(.5).toFixed(1), p95:+q(.95).toFixed(1),
          max:+(s[s.length-1]||0).toFixed(1),
          over50: s.filter(x=>x>50).length, over100: s.filter(x=>x>100).length});
  }, 300);
})();
"""


def check_frames(rep):
    for p in PAGES:
        d = driver()
        try:
            d.get(f"{BASE}/{p}")
            time.sleep(1.5)
            r = d.execute_async_script(FRAMES_JS)
            rep.append(("frames", p or "/", json.dumps(r)))
        finally:
            d.quit()


# ---------------------------------------------------------------- focus
FOCUS_JS = r"""
const el = document.activeElement;
if (!el || el === document.body) return null;
const r = el.getBoundingClientRect();
const cs = getComputedStyle(el);
let anc = el, hiddenBy = null, minOp = 1;
while (anc && anc !== document.documentElement) {
  const acs = getComputedStyle(anc);
  const o = parseFloat(acs.opacity);
  if (o < minOp) { minOp = o; if (o < 0.99) hiddenBy = (anc.className||anc.tagName)+':'+o; }
  anc = anc.parentElement;
}
return {
  tag: el.tagName.toLowerCase(),
  cls: String(el.className||'').split(' ').slice(0,2).join('.'),
  top: Math.round(r.top), bottom: Math.round(r.bottom),
  left: Math.round(r.left), right: Math.round(r.right),
  w: Math.round(r.width), h: Math.round(r.height),
  vh: window.innerHeight, vw: window.innerWidth,
  opacity: cs.opacity, effOpacity: minOp, hiddenBy: hiddenBy,
  outline: cs.outlineWidth + ' ' + cs.outlineStyle,
};
"""


def _focus_probs(info):
    probs = []
    if info["bottom"] < 0 or info["top"] > info["vh"]:
        probs.append(f"offscreen-y top={info['top']} bottom={info['bottom']}")
    if info["right"] < 0 or info["left"] > info["vw"]:
        probs.append(f"offscreen-x left={info['left']} right={info['right']}")
    if float(info["effOpacity"]) < 0.99:
        probs.append(f"faded eff={round(float(info['effOpacity']),3)} by={info['hiddenBy']}")
    if info["w"] == 0 and info["h"] == 0:
        probs.append("zero-area")
    return probs


def check_focus(rep):
    """Two verdicts per stop, because they answer different questions.

    t0        : the frame focus lands. `scroll-behavior: smooth` + a .6s
                .reveal transition mean a lot is legitimately in flight here,
                so a t0 hit alone is NOT a bug.
    settled   : POLLED until the geometry+opacity signature stops changing
                (2.5s ceiling). Anything still wrong here is a real one --
                focus parked off-screen or on invisible content.
    """
    for p in PAGES:
        d = driver()
        try:
            d.get(f"{BASE}/{p}")
            time.sleep(1.5)
            body = d.find_element(By.TAG_NAME, "body")
            body.click()
            t0_bad, settled_bad = [], []
            seen = 0
            for i in range(70):
                (body if i == 0 else d.switch_to.active_element).send_keys(Keys.TAB)
                info = d.execute_script(FOCUS_JS)
                if not info:
                    continue
                seen += 1
                if _focus_probs(info):
                    t0_bad.append(f"{info['tag']}.{info['cls']}")
                # poll until the signature stabilises
                last, stable, waited = None, 0, 0
                while waited < 2500:
                    time.sleep(0.15)
                    waited += 150
                    info = d.execute_script(FOCUS_JS)
                    if not info:
                        break
                    sig = (info["top"], info["bottom"], info["left"],
                           info["right"], round(float(info["effOpacity"]), 3))
                    stable = stable + 1 if sig == last else 0
                    last = sig
                    if stable >= 2:
                        break
                if not info:
                    continue
                probs = _focus_probs(info)
                if probs:
                    settled_bad.append(f"{info['tag']}.{info['cls']}: " + "; ".join(probs))
            rep.append(("focus", p or "/",
                        f"stops={seen} t0_transient={len(t0_bad)} "
                        f"SETTLED_PROBLEMS={len(settled_bad)} "
                        + json.dumps(settled_bad[:6])))
        finally:
            d.quit()


# ------------------------------------------------------- deeplink strand
# Wider than gate_dir.py's selector on purpose: the chip staggers (§6) and the
# SplitText claims (§8) both use a from-an-invisible-start pattern on elements
# that are NOT .reveal / .pass / .case-block / h1 / h2, so the existing gate
# cannot see them at all.
WIDE_SEL = (".reveal, .reveal-clip, .pass, .case-block, h1, h2, h3, "
            ".bubble, .bubble-list > *, .skills-list > *, .feature-chips > *, "
            ".section-title, .subhead, .case-title, .case-tagline, .case-index, "
            ".trip-mark, .timeline-rail, .case-rail-fill, .exp-item")

# Authored (non-animation) opacities that must NOT be reported.
ALLOW = r"""
const AUTHORED = ['pass-date','pass-k','pass-cities'];
"""

DEEP_PROBE = r"""
// execute_async_script appends the callback as the LAST argument, so with one
// real argument the order is (sel, done) -- getting this backwards silently
// turned `sel` into a function and threw inside querySelectorAll.
const sel = arguments[0];
const done = arguments[1];

// Authored opacities, not animation residue: styles.css sets these at
// 0.72-0.85 by design. Matched on the class TOKEN, not a substring.
const AUTHORED = ['pass-date','pass-k','pass-cities'];

// A user-facing definition of "stranded", stated without reference to any
// trigger's maths: content the reader can SEE, or has already SCROLLED PAST,
// must be visible. Only what is still entirely below the fold is legitimately
// waiting for its turn.
function classify(el){
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  if (cs.display === 'none' || cs.visibility === 'hidden') return null;
  const cls = String(el.className && el.className.baseVal !== undefined
      ? el.className.baseVal : el.className || '');
  const tokens = cls.split(/\s+/);
  if (AUTHORED.some(a => tokens.indexOf(a) > -1)) return null;
  if (parseFloat(cs.opacity) >= 0.99) return null;
  const reached = r.top < window.innerHeight;   // on screen, or above it
  return {label: (cls || el.tagName) + ' op=' + cs.opacity +
                 ' top=' + Math.round(r.top), reached: reached};
}
function probe(){
  const hit = [], pend = [];
  document.querySelectorAll(sel).forEach(el => {
    const c = classify(el);
    if (!c) return;
    (c.reached ? hit : pend).push(c.label);
  });
  return {hit: hit, pend: pend};
}
// FLOOR of 6s before any verdict. gsap-motion.js's own last-resort belts are a
// 2500ms watchdog sweep and a 4000ms SplitText force-reveal; a probe that
// settles at 1.7s reports both of those as failures and is useless. Stability
// alone is not enough here -- "stably wrong" and "not rescued yet" look
// identical until the last belt has had its chance.
let last = null, stable = 0, waited = 0;
(function settle(){
  const p = probe();
  const sig = p.hit.join('|') + '#' + p.pend.length;
  stable = (sig === last) ? stable + 1 : 0;
  last = sig; waited += 250;
  if ((stable >= 3 && waited > 6000) || waited > 14000) {
    done({stranded: p.hit.slice(0,14), n: p.hit.length,
          belowFold: p.pend.length, settleMs: waited});
  } else setTimeout(settle, 250);
})();
"""

HASHES = {
    "": ["#connect", "#interests", "#work"],
    "projects/": ["#connect"],
    "travel/": ["#connect"],
}


def check_deeplink(rep):
    """Arrive PAST a trigger, then look for content that never un-hid.

    A reader who follows /#connect (the nav does exactly this on a fresh load)
    jumps the whole document in one frame. Every from-an-invisible-start
    pattern above them has to be rescued by something; §7 has a watchdog,
    §6 and §8 do not.
    """
    for reduced in (False, True):
        for p, hashes in HASHES.items():
            for h in hashes:
                for w in (1440, 390):
                    d = driver(width=w, reduced=reduced)
                    try:
                        d.get(f"{BASE}/{p}{h}")
                        time.sleep(1.2)
                        r = d.execute_async_script(DEEP_PROBE, WIDE_SEL)
                        mode = "reduced" if reduced else "normal"
                        rep.append(("deeplink",
                                    f"{p or '/'}{h}",
                                    f"{mode} @{w} STRANDED(reached)={r['n']} "
                                    f"belowFold={r['belowFold']} "
                                    f"settleMs={r['settleMs']} "
                                    + json.dumps(r["stranded"][:6])))
                    finally:
                        d.quit()


PIN_READ = r"""
const html = document.documentElement;
const dot = document.querySelector('.flight-dot');
const drift = document.querySelector('.shape-drift');
return {
  pinSpacers: document.querySelectorAll('.pin-spacer').length,
  heroFg: document.querySelectorAll('.hero-fg').length,
  gsapOn: html.classList.contains('gsap-on'),
  contour: getComputedStyle(html).getPropertyValue('--contour').trim(),
  scrollHeight: document.documentElement.scrollHeight,
  dotCx: dot ? dot.getAttribute('cx') : null,
  driftTransform: drift ? getComputedStyle(drift).transform : null,
  srlineMasks: document.querySelectorAll('.srline-mask').length,
  hiddenHeads: Array.prototype.filter.call(
      document.querySelectorAll('.section-title, .subhead, .case-title, .case-tagline'),
      el => parseFloat(getComputedStyle(el).opacity) < 0.99).length,
};
"""

# Sample an ATTRIBUTE-driven animation. `.flight-dot` moves via cx/cy, so no
# stylesheet can stop it -- only killing the tween can. Two samples 900ms apart.
MOVE_SAMPLE = r"""
const done = arguments[1];
const sel = arguments[0];
const el = document.querySelector(sel);
if (!el) { done(null); }
else {
  const a = [el.getAttribute('cx'), el.getAttribute('cy')];
  setTimeout(() => {
    const b = [el.getAttribute('cx'), el.getAttribute('cy')];
    done({from: a, to: b, moved: a[0] !== b[0] || a[1] !== b[1]});
  }, 900);
}
"""


def check_rmpin(rep):
    """Does a mid-session flip actually STOP things, or only reposition them?

    Three states no stylesheet can undo: the pin (position:fixed + an injected
    pin-spacer), a `repeat: -1` tween on an SVG ATTRIBUTE, and an inline
    opacity:0 on a heading whose `.reveal` class was stripped.
    """
    for p in PAGES:
        d = driver()
        try:
            d.get(f"{BASE}/{p}")
            time.sleep(1.5)
            d.execute_script("window.scrollTo(0, Math.round(window.innerHeight*0.55));")
            time.sleep(1.5)
            before = d.execute_script(PIN_READ)
            mv_before = d.execute_async_script(MOVE_SAMPLE, ".flight-dot")
            d.execute_cdp_cmd("Emulation.setEmulatedMedia", {
                "features": [{"name": "prefers-reduced-motion", "value": "reduce"}]})
            time.sleep(1.5)
            after = d.execute_script(PIN_READ)
            mv_after = d.execute_async_script(MOVE_SAMPLE, ".flight-dot")
            rep.append(("rmpin", p or "/",
                        f"pinSpacers {before['pinSpacers']}->{after['pinSpacers']} "
                        f"heroFg {before['heroFg']}->{after['heroFg']} "
                        f"gsapOn {before['gsapOn']}->{after['gsapOn']} "
                        f"contour {before['contour']!r}->{after['contour']!r} "
                        f"hiddenHeads {before['hiddenHeads']}->{after['hiddenHeads']} "
                        f"srlineMasks {before['srlineMasks']}->{after['srlineMasks']} "
                        f"flightDotMoving "
                        f"{(mv_before or {}).get('moved')}->{(mv_after or {}).get('moved')}"))
        finally:
            d.quit()


HOVER_READ = r"""
const el = document.querySelector(arguments[0]);
if (!el) return null;
return {
  transform: getComputedStyle(el).transform,
  inline: el.getAttribute('style') || '',
  spring: el.classList.contains('motion-spring'),
  motionOn: document.documentElement.classList.contains('motion-on'),
  cursorFlag: document.documentElement.classList.contains('motion-cursor'),
  followers: document.querySelectorAll('.mx-follow, .mx-focus-halo').length,
};
"""


def check_rmhover(rep):
    """After a MID-SESSION reduced-motion flip, does a hover still spring?

    motion-ux.js unwinds by dropping `html.motion-on` and `.motion-spring` --
    which are exactly the two hooks every reduced-motion CSS belt is keyed on.
    If the gesture handlers survive the unwind they can write an inline
    transform again with nothing left able to override it.

    Driven with a REAL mouse move (ActionChains), not a synthetic event, so
    Motion's own pointerenter path is the one exercised.
    """
    from selenium.webdriver.common.action_chains import ActionChains
    # `.project-card` / `.pass` are ALSO `.reveal`, and styles.css's
    # reduced-motion block forces `transform: none !important` on `.reveal`.
    # That masks the real behaviour, so the targets below are the claimed
    # elements which are NOT `.reveal` and therefore have no other belt:
    #   li.bubble, .skills-list li, .btn-resume, .nav-cta, .nav-toggle,
    #   .contact-form button[type=submit]
    TARGETS = [("", ".skills-list li"), ("", ".btn-resume"),
               ("", "li.bubble"), ("", ".project-card")]
    for p, sel in TARGETS:
        d = driver()
        try:
            d.get(f"{BASE}/{p}")
            time.sleep(1.5)
            d.execute_async_script(SCROLL_ALL)
            time.sleep(1.0)
            el = d.find_element(By.CSS_SELECTOR, sel)
            d.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
            time.sleep(1.5)
            pre = d.execute_script(HOVER_READ, sel)
            # Flip the preference, let the unwind run.
            d.execute_cdp_cmd("Emulation.setEmulatedMedia", {
                "features": [{"name": "prefers-reduced-motion", "value": "reduce"}]})
            time.sleep(0.8)
            post_unwind = d.execute_script(HOVER_READ, sel)
            # Now hover, and POLL until the transform stops changing.
            ActionChains(d).move_to_element(el).perform()
            last, stable, waited, cur = None, 0, 0, None
            while waited < 2500:
                time.sleep(0.15)
                waited += 150
                cur = d.execute_script(HOVER_READ, sel)
                stable = stable + 1 if cur["transform"] == last else 0
                last = cur["transform"]
                if stable >= 3:
                    break
            animated = cur["transform"] not in ("none", "matrix(1, 0, 0, 1, 0, 0)")
            rep.append(("rmhover", p or "/",
                        f"motionOn:{pre['motionOn']}->{post_unwind['motionOn']} "
                        f"spring:{pre['spring']}->{post_unwind['spring']} "
                        f"cursorFlag_after={post_unwind['cursorFlag']} "
                        f"followers_after={post_unwind['followers']} "
                        f"HOVER_AFTER_FLIP_transform={cur['transform']} "
                        f"inline={cur['inline'][:90]!r} "
                        f"=> {'SPRING STILL LIVE' if animated else 'inert'}"))
        finally:
            d.quit()


def check_widestrand(rep):
    """Same wide selector, but the ordinary full-scroll journey."""
    for reduced in (False, True):
        for p in PAGES:
            for w in (1440, 390):
                d = driver(width=w, reduced=reduced)
                try:
                    d.get(f"{BASE}/{p}")
                    time.sleep(1.0)
                    d.execute_async_script(SCROLL_ALL)
                    r = d.execute_async_script(DEEP_PROBE, WIDE_SEL)
                    mode = "reduced" if reduced else "normal"
                    rep.append(("widestrand", p or "/",
                                f"{mode} @{w} STRANDED(reached)={r['n']} "
                                f"belowFold={r['belowFold']} "
                                + json.dumps(r["stranded"][:6])))
                finally:
                    d.quit()


# ----------------------------------------------------------- clipmargin
CLIP_JS = r"""
// Build a .srline-mask by hand and measure the real clip edge geometry the
// workaround is supposed to produce, WITHOUT relying on the implementation's
// own arithmetic: probe with an absolutely-positioned marker inside the mask
// and read whether it is painted (via elementFromPoint on the marker's px).
const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:20px;top:300px;width:300px;font-size:100px;line-height:1;z-index:99999;background:#fff';
const mask = document.createElement('div');
mask.className = 'srline-mask';
mask.style.overflow = 'clip';
const line = document.createElement('div');
line.className = 'srline';
line.textContent = 'gyp';
mask.appendChild(line); host.appendChild(mask); document.body.appendChild(host);
const supported = CSS.supports('overflow-clip-margin', '1px');
const cs = getComputedStyle(mask);
const mr = mask.getBoundingClientRect();
const lr = line.getBoundingClientRect();
const res = {
  supported: supported,
  clipMargin: cs.overflowClipMargin,
  padBlock: cs.paddingTop + '/' + cs.paddingBottom,
  marBlock: cs.marginTop + '/' + cs.marginBottom,
  maskH: +mr.height.toFixed(2), lineH: +lr.height.toFixed(2),
  // layout advance must be unchanged: border-box height minus the negative
  // margins must equal the line box height.
  advance: +(mr.height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)).toFixed(2),
  // the clip edge (padding box) relative to the CONTENT box, per vertical edge
  clipEdgeTop: +(parseFloat(cs.paddingTop) + (supported ? parseFloat(cs.overflowClipMargin)||0 : 0)).toFixed(2),
  clipEdgeBottom: +(parseFloat(cs.paddingBottom) + (supported ? parseFloat(cs.overflowClipMargin)||0 : 0)).toFixed(2),
  em: 100,
};
document.body.removeChild(host);
return res;
"""


def check_clipmargin(rep):
    d = driver()
    try:
        d.get(f"{BASE}/")
        time.sleep(1.0)
        rep.append(("clipmargin", "/", json.dumps(d.execute_script(CLIP_JS))))
    finally:
        d.quit()


CHECKS = {
    "cssom": check_cssom, "tabindex": check_tabindex, "rmflip": check_rmflip,
    "willchange": check_willchange, "frames": check_frames,
    "focus": check_focus, "clipmargin": check_clipmargin,
    "deeplink": check_deeplink, "widestrand": check_widestrand,
    "rmhover": check_rmhover, "rmpin": check_rmpin,
}

if __name__ == "__main__":
    rep = []
    for name, fn in CHECKS.items():
        if ONLY and name not in ONLY:
            continue
        try:
            fn(rep)
        except Exception as e:
            rep.append((name, "-", f"HARNESS ERROR: {type(e).__name__}: {e}"))
    print(f"\n===== PROBE: {LABEL} =====")
    for k, p, v in rep:
        print(f"[{k:<11}] {p:<11} {v}")
