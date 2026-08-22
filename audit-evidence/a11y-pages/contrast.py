"""Composited-pixel contrast audit.

Every ratio here is measured against the REAL ground: the background is the
per-channel MEDIAN of the element's own box taken from a full-page screenshot
of the built output, so the procedural grain layer, the dark plates and the
airline fills are all already composited in. Foreground is the computed colour
composited over that same measured ground through the full ancestor opacity
chain (and through `filter: brightness()` where one is in force).

Run with --force-prefers-reduced-motion so every `.reveal` is at its finished
opacity: sampling a mid-tween element reports a fake ratio.

Usage: contrast.py <base> <width>
"""
import base64
import io
import sys
import time

from PIL import Image
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8231"
WIDTH = int(sys.argv[2]) if len(sys.argv) > 2 else 1440
PAGES = ["", "projects/", "travel/"]


def lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lum(rgb):
    r, g, b = rgb
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


COLLECT = r"""
// Every element that paints its own text. Returns geometry in DOCUMENT
// coordinates plus the composited-alpha and filter chain.
const out = [];
const parse = (s) => {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return {rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1};
};
document.querySelectorAll('body *').forEach((el) => {
  // direct text only -- a wrapper's colour is not what the reader sees
  let txt = '';
  for (const n of el.childNodes) if (n.nodeType === 3) txt += n.textContent;
  txt = txt.trim();
  const cs = getComputedStyle(el);
  const isImg = el.tagName === 'IMG';
  if (!txt && !isImg) return;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  if (cs.visibility === 'hidden' || cs.display === 'none') return;
  // walk the chain for opacity + brightness filters
  let alpha = 1, bright = 1, node = el, hidden = false;
  while (node && node !== document.documentElement) {
    const s = getComputedStyle(node);
    alpha *= parseFloat(s.opacity);
    const f = s.filter;
    if (f && f !== 'none') {
      const b = f.match(/brightness\(([\d.]+)\)/);
      if (b) bright *= parseFloat(b[1]);
    }
    if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') hidden = true;
    node = node.parentElement;
  }
  const col = parse(cs.color) || {rgb: [0, 0, 0], a: 1};
  out.push({
    tag: el.tagName.toLowerCase(),
    cls: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 60),
    txt: (txt || el.getAttribute('alt') || '').slice(0, 34),
    isImg,
    ariaHidden: hidden,
    x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY),
    w: Math.round(r.width), h: Math.round(r.height),
    color: col.rgb, colorA: col.a,
    alpha: alpha, bright: bright,
    fs: parseFloat(cs.fontSize),
    fw: cs.fontWeight,
  });
});
return out;
"""


def median_bg(img, box):
    x, y, w, h = box
    x, y = max(0, x), max(0, y)
    w = min(w, img.width - x)
    h = min(h, img.height - y)
    if w < 1 or h < 1:
        return None
    crop = img.crop((x, y, x + w, y + h)).convert("RGB")
    px = list(crop.getdata())
    if not px:
        return None
    # per-channel median: glyph coverage in a text box is well under 50%,
    # so the median pixel is the ground the glyphs sit on, grain included.
    return tuple(sorted(c[i] for c in px)[len(px) // 2] for i in range(3))


def run(page):
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--force-device-scale-factor=1")
    opts.add_argument("--force-prefers-reduced-motion")
    d = webdriver.Chrome(options=opts)
    try:
        d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                          {"width": WIDTH, "height": 1000,
                           "deviceScaleFactor": 1, "mobile": False})
        d.get(f"{BASE}/{page}")
        try:
            d.execute_script("return document.fonts.ready")
        except Exception:
            pass
        time.sleep(1.6)
        els = d.execute_script(COLLECT)
        shot = d.execute_cdp_cmd("Page.captureScreenshot",
                                 {"captureBeyondViewport": True, "fromSurface": True})
        img = Image.open(io.BytesIO(base64.b64decode(shot["data"])))
    finally:
        d.quit()
    return els, img


def check(els, img):
    rows = []
    for e in els:
        bg = median_bg(img, (e["x"], e["y"], e["w"], e["h"]))
        if bg is None:
            continue
        if e["isImg"]:
            # Image of text (the airline wordmarks). The ground is NOT the
            # median of the image's own box -- that is dominated by the logo's
            # own ink and reported Frontier as a 1.83 failure when the real
            # white-on-green ratio is 5.25. Sample a RING outside the box.
            ring = median_bg(img, (e["x"] - 8, e["y"] - 8, e["w"] + 16, e["h"] + 16))
            x, y = max(0, e["x"]), max(0, e["y"])
            w = min(e["w"], img.width - x)
            h = min(e["h"], img.height - y)
            if w < 1 or h < 1 or ring is None:
                continue
            px = list(img.crop((x, y, x + w, y + h)).convert("RGB").getdata())
            px.sort(key=lum)
            ink_lo, ink_hi = px[len(px) // 40], px[-len(px) // 40 - 1]
            # ink = whichever extreme is FURTHEST from the measured ground
            ink = ink_lo if abs(lum(ink_lo) - lum(ring)) > abs(lum(ink_hi) - lum(ring)) else ink_hi
            rows.append((ratio(ink, ring), 4.5, e, ring, ink, "img-of-text"))
            continue
        if e["alpha"] * e["colorA"] < 0.05:
            continue   # deliberately hidden (hover-only rail labels) -- not text on screen
        a = e["alpha"] * e["colorA"]
        fg = tuple(bg[i] + a * (e["color"][i] - bg[i]) for i in range(3))
        if e["bright"] != 1:
            fg = tuple(min(255, c * e["bright"]) for c in fg)
        large = e["fs"] >= 24 or (e["fs"] >= 18.66 and int(e["fw"]) >= 700)
        need = 3.0 if large else 4.5
        rows.append((ratio(fg, bg), need, e, bg, fg, "large" if large else "small"))
    return rows


print(f"\n{'='*96}\nCONTRAST @ {WIDTH}px  (reduced-motion, finished state, real pixels)\n{'='*96}")
tot_fail = 0
for page in PAGES:
    els, img = run(page)
    rows = check(els, img)
    # SHOWALL=<substr> prints every matching style with its measured ratio,
    # pass or fail, so a fixed style still carries a number in the report.
    import os
    keep = os.environ.get("SHOWALL")
    if keep:
        fails = [r for r in rows
                 if keep in r[2]["cls"] or (r[2]["isImg"] and keep in "img-of-text")]
    else:
        fails = [r for r in rows if r[0] < r[1] - 0.005]
    tot_fail += len(fails)
    print(f"\n--- /{page or ''}  ({len(rows)} text styles, page {img.width}x{img.height}) ---")
    for cr, need, e, bg, fg, kind in sorted(fails, key=lambda r: r[0]):
        ah = " [aria-hidden]" if e["ariaHidden"] else ""
        print(f"  {('FAIL' if cr < need - 0.005 else 'pass')} {cr:5.2f} (need {need:.1f}) {kind:12} {e['fs']:5.1f}px "
              f"{e['tag']}.{e['cls'][:32]:<32} bg=#{bg[0]:02x}{bg[1]:02x}{bg[2]:02x} "
              f"fg=#{int(fg[0]):02x}{int(fg[1]):02x}{int(fg[2]):02x} "
              f"a={e['alpha']:.2f} {e['txt']!r}{ah}")
    if not fails:
        print("  no failures")
print(f"\nTOTAL FAILURES: {tot_fail}")
