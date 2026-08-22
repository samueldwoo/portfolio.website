#!/usr/bin/env python3
"""
a11y_pixel.py — contrast measured from the RENDERED PIXELS, not from the DOM.

WHY THIS EXISTS
    tools/a11y_chrome.py computes an element's effective background by
    compositing its own and its ANCESTORS' background-colors. That is right for
    almost everything in this chrome and wrong for exactly one thing: the
    active nav link. `.nav-marker` is the filled sage pill and it is a SIBLING
    of `.nav-link`, absolutely positioned behind it at z-index 0. No ancestor
    walk can see it, so the DOM-side scan measured white-on-near-white and
    reported 1.03:1 — a fabricated failure on a link that is genuinely 6.4:1.

    Rather than special-case the selector (which would just move the lie), this
    screenshots the element and reads the two colours off the bitmap. Whatever
    stacking, alpha, backdrop-filter or sibling overlay produced them is
    already baked in, so this is what the user's eye receives.

METHOD
    Screenshot the element's rect at DPR 3, drop the outer 1px, then:
      background = the modal (most frequent) colour of the crop
      foreground = the colour furthest from the background in luminance that
                   still covers >= MIN_SHARE of the crop, which skips the
                   antialiased rim and lands on the glyph core
    Report the WCAG ratio between them.

USAGE
    PY=~/personal/finance/finance/.venv/bin/python
    $PY tools/a11y_pixel.py --base http://127.0.0.1:8231
"""
import argparse
import base64
import io
import json
import sys
from collections import Counter

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from PIL import Image
from a11y_chrome import make_driver, set_viewport, load, cdp, DESKTOP, PHONE, PHONE_UA

DPR = 3
MIN_SHARE = 0.02          # a colour must cover 2% of the crop to count as ink


def lin(v):
    v /= 255.0
    return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4


def lum(c):
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def shoot(d, rect):
    png = cdp(d, "Page.captureScreenshot", {
        "format": "png", "fromSurface": True, "captureBeyondViewport": False,
        "clip": {"x": rect["x"], "y": rect["y"], "width": rect["w"],
                 "height": rect["h"], "scale": DPR}})["data"]
    return Image.open(io.BytesIO(base64.b64decode(png))).convert("RGB")


def measure(d, rect):
    im = shoot(d, rect)
    w, h = im.size
    if w < 6 or h < 6:
        return None
    im = im.crop((2, 2, w - 2, h - 2))            # drop the border/AA rim
    px = list(im.convert("RGB").tobytes())
    px = [tuple(px[i:i + 3]) for i in range(0, len(px), 3)]
    if not px:
        return None
    counts = Counter(px)
    total = len(px)
    bg, bgn = counts.most_common(1)[0]
    floor = total * MIN_SHARE
    ink, best = None, -1.0
    for col, n in counts.items():
        if n < floor:
            continue
        dl = abs(lum(col) - lum(bg))
        if dl > best:
            best, ink = dl, col
    if ink is None or ink == bg:
        return {"bg": bg, "ink": None, "ratio": None,
                "bgShare": round(bgn / total, 3)}
    return {"bg": bg, "ink": ink, "ratio": round(ratio(ink, bg), 2),
            "bgShare": round(bgn / total, 3), "inkShare": round(counts[ink] / total, 3)}


# (label, selector, css px size, is-large-text?) — the chrome's small text, plus
# the active nav link that the DOM-side scan cannot resolve.
TARGETS = [
    ("nav-link (inactive)", "#nav-links a.nav-link:not(.is-active)", False),
    ("nav-link (ACTIVE, on the sage pill)", "#nav-links a.nav-link.is-active", False),
    ("nav-cta Connect", "#nav-links .nav-cta", False),
    ("nav-cmd 'Jump to'", "#nav-cmd .nav-cmd-text", False),
    ("nav-cmd kbd", "#nav-cmd kbd", False),
    ("brand wordmark", ".brand .brand-name", True),
]
DIALOG_TARGETS = [
    ("cmdk group label", "#cmdk-list .cmdk-group-label", False),
    ("cmdk item label", "#cmdk-list .cmdk-item:not([aria-selected='true']) .cmdk-item-label",
     False),
    ("cmdk item meta", "#cmdk-list .cmdk-item:not([aria-selected='true']) .cmdk-item-meta",
     False),
    ("cmdk SELECTED label (on sage)", "#cmdk-list .cmdk-item[aria-selected='true'] "
     ".cmdk-item-label", False),
    ("cmdk SELECTED meta (on sage)", "#cmdk-list .cmdk-item[aria-selected='true'] "
     ".cmdk-item-meta", False),
    ("cmdk esc button", "#cmdk-close", False),
    ("cmdk foot hint", ".cmdk-foot span", False),
]
DRAWER_TARGETS = [
    ("drawer eyebrow", "#nav-drawer .drawer-eyebrow", False),
    ("drawer link", "#nav-drawer .drawer-link:not([aria-current]):not(.is-active)", False),
    ("drawer link aria-current=page chip", "#nav-drawer .drawer-link[aria-current='page']",
     False),
    ("drawer num", "#nav-drawer .drawer-num", False),
    ("drawer search", "#nav-drawer .drawer-search", False),
    ("drawer foot link", "#nav-drawer .drawer-foot a", False),
]
RAIL_TARGETS = [
    ("rail label (active)", ".rail-tick.is-active .rail-label", False),
]


def run(d, rows, label, targets):
    for name, sel, large in targets:
        rect = d.execute_script(r"""
          const el = document.querySelector(arguments[0]);
          if (!el) return null;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return null;
          // A Range over the TEXT, not the element box. `.drawer-link` is
          // 298x46 with ~12px of type in it, so the glyph pixels were under the
          // 2%-of-crop floor and the whole row came back "no ink found" — a
          // silent skip that looked like a pass. The Range rect hugs the
          // glyphs, so ink share is high and the modal colour is still the
          // local background.
          let box = null;
          const rng = document.createRange();
          for (const n of el.childNodes) {
            if (n.nodeType !== 3 || !n.textContent.trim()) continue;
            rng.selectNodeContents(n);
            const r = rng.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            box = box ? {left: Math.min(box.left, r.left), top: Math.min(box.top, r.top),
                         right: Math.max(box.right, r.right),
                         bottom: Math.max(box.bottom, r.bottom)}
                      : {left: r.left, top: r.top, right: r.right, bottom: r.bottom};
          }
          const r = box
            ? {x: box.left - 3, y: box.top - 3,
               width: box.right - box.left + 6, height: box.bottom - box.top + 6}
            : el.getBoundingClientRect();
          if (r.width < 6 || r.height < 6) return null;
          if (r.y < 0 || r.y + r.height > innerHeight) return null;
          return {x: r.x, y: r.y, w: r.width, h: r.height,
                  tight: !!box,
                  px: parseFloat(cs.fontSize),
                  bold: parseInt(cs.fontWeight, 10) >= 700,
                  color: cs.color};
        """, sel)
        if not rect:
            rows.append({"ctx": label, "name": name, "skipped": "not rendered"})
            continue
        m = measure(d, rect)
        if not m or m["ratio"] is None:
            rows.append({"ctx": label, "name": name, "skipped": "no ink found",
                         "bg": m["bg"] if m else None})
            continue
        big = large or rect["px"] >= 24 or (rect["bold"] and rect["px"] >= 18.66)
        need = 3.0 if big else 4.5
        rows.append({"ctx": label, "name": name, "px": round(rect["px"], 1),
                     "cssColor": rect["color"], "bg": m["bg"], "ink": m["ink"],
                     "ratio": m["ratio"], "need": need, "pass": m["ratio"] >= need,
                     "inkShare": m.get("inkShare")})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8231")
    ap.add_argument("--json")
    a = ap.parse_args()
    d = make_driver()
    rows = []
    try:
        # ---- desktop bar, on the home page and on a sub-page (where the marker
        #      parks on the page link, so `.is-active` is guaranteed present).
        for page in ("", "projects/"):
            set_viewport(d, DESKTOP)
            load(d, a.base, page)
            run(d, rows, "bar @1440 /%s" % page, TARGETS)
            run(d, rows, "rail @1440 /%s" % page, RAIL_TARGETS)
            d.execute_script("document.getElementById('nav-cmd').click();")
            d.implicitly_wait(0)
            import time
            time.sleep(0.8)
            run(d, rows, "palette @1440 /%s" % page, DIALOG_TARGETS)

        # ---- drawer, at the width it actually appears at
        set_viewport(d, PHONE, touch=True, ua=PHONE_UA)
        load(d, a.base, "")
        d.execute_script("document.getElementById('nav-toggle').click();")
        import time
        time.sleep(0.9)
        run(d, rows, "drawer @390 /", DRAWER_TARGETS)
    finally:
        d.quit()

    print("%-26s %-40s %6s %8s %-18s %-18s %s"
          % ("CONTEXT", "TARGET", "px", "ratio", "background(px)", "ink(px)", ""))
    fails = 0
    for r in rows:
        if "skipped" in r:
            print("%-26s %-40s   -- skipped: %s" % (r["ctx"], r["name"], r["skipped"]))
            continue
        ok = "PASS" if r["pass"] else "FAIL"
        if not r["pass"]:
            fails += 1
        print("%-26s %-40s %6s %8s %-18s %-18s %s (need %.1f)"
              % (r["ctx"], r["name"], r["px"], r["ratio"],
                 str(r["bg"]), str(r["ink"]), ok, r["need"]))
    print("\n%d measured, %d FAIL" % (len([x for x in rows if "skipped" not in x]), fails))
    if a.json:
        json.dump(rows, open(a.json, "w"), indent=1)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
