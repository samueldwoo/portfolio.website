"""Verify the hero canvas fade keeps ink off the copy -- and that it now SELF-CORRECTS.

The fade used to be hand-calibrated to a copy column assumed to end at x/W~0.52.
It is now derived from a runtime glyph measurement. Two things to prove:
  1. at the CURRENT type scale, ink coverage over the copy is still ~nil
     (i.e. the refactor is behaviour-preserving, not a re-tune)
  2. after inflating body type -- the exact change that broke it before -- the
     ink still stays off the copy, which the hardcoded version could not do
"""
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

# BASE URL: directory-format, and overridable. These harnesses used to request
# "/index.html", which works on `python -m http.server` but 301s in production and
# is exactly the trap tools/README.md warns about — a test that asks for a URL the
# real site does not serve. Pass a base as argv[1] to point at a different port.
import os as _os, sys as _sys
BASE = (_sys.argv[1] if len(_sys.argv) > 1 and _sys.argv[1].startswith("http")
        else _os.environ.get("SITE_BASE", "http://localhost:8020")).rstrip("/")


URL = BASE + "/"

# Sample the canvas's own pixels underneath the real glyph rects of the copy.
PROBE = r"""
const canvas = document.querySelector('canvas.hero-canvas');
if (!canvas) return {error: 'no canvas'};
const ctx = canvas.getContext('2d');
const cRect = canvas.getBoundingClientRect();
const dpr = canvas.width / cRect.width;

const rects = [];
document.querySelectorAll(
  '.home-inner .hero-meta, .home-inner .hero-name, .home-inner .hero-subtitle, ' +
  '.home-inner .hero-intro'
).forEach(el => {
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    if (!n.nodeValue.trim()) continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    for (const g of r.getClientRects()) if (g.width > 1 && g.height > 1) rects.push(g);
  }
});
if (!rects.length) return {error: 'no glyph rects'};

let maxAlpha = 0, inked = 0, total = 0;
for (const g of rects) {
  const x = Math.max(0, Math.round((g.left - cRect.left) * dpr));
  const y = Math.max(0, Math.round((g.top  - cRect.top ) * dpr));
  const w = Math.min(canvas.width  - x, Math.round(g.width  * dpr));
  const h = Math.min(canvas.height - y, Math.round(g.height * dpr));
  if (w <= 0 || h <= 0) continue;
  const data = ctx.getImageData(x, y, w, h).data;
  for (let i = 3; i < data.length; i += 4) {
    total++;
    if (data[i] > maxAlpha) maxAlpha = data[i];
    if (data[i] > 8) inked++;
  }
}
return {
  maxAlpha,
  coveragePct: total ? Math.round((inked / total) * 10000) / 100 : null,
  glyphRects: rects.length,
  copyRightFrac: Math.round(
    ((Math.max(...rects.map(r => r.right)) - cRect.left) / cRect.width) * 1000) / 1000,
  bodyFontSize: getComputedStyle(document.body).fontSize,
};
"""


def run(width, inflate_body_px=None):
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--force-device-scale-factor=1")
    d = webdriver.Chrome(options=opts)
    try:
        d.execute_cdp_cmd(
            "Emulation.setDeviceMetricsOverride",
            {"width": width, "height": 900, "deviceScaleFactor": 1, "mobile": False},
        )
        d.get(URL)
        try:
            d.execute_script("return document.fonts.ready")
        except Exception:
            pass
        time.sleep(2.5)
        if inflate_body_px:
            # Reproduce the regression that bit this before: raise body text, which
            # widens the `ch`-sized hero column. Then nudge the viewport so the
            # ResizeObserver re-runs layout(), as a real CSS change + reload would.
            d.execute_script(
                "document.body.style.fontSize = arguments[0] + 'px';"
                "document.querySelectorAll('.hero-intro,.hero-subtitle,.hero-meta')"
                "  .forEach(e => e.style.fontSize = arguments[0] + 'px');",
                inflate_body_px,
            )
            d.execute_cdp_cmd(
                "Emulation.setDeviceMetricsOverride",
                {"width": width - 1, "height": 900, "deviceScaleFactor": 1, "mobile": False},
            )
            time.sleep(1.5)
        return d.execute_script(PROBE)
    finally:
        d.quit()


print("\n=== hero canvas ink over copy glyphs ===")
cases = [
    ("wide 3840", 3840, None),("wide 2560", 2560, None),("wide 1920", 1920, None),("wide 1600", 1600, None),("wide 1599", 1599, None),("wide 1440", 1440, None),("wide 1280", 1280, None),("wide 1024", 1024, None),("wide 900", 900, None),
    ("wide 1440, body inflated to 28px", 1440, 28),
    ("narrow 390, current type", 390, None),
    ("narrow 390, body inflated to 28px", 390, 28),
]
fail = 0
for label, wdt, inflate in cases:
    r = run(wdt, inflate)
    if r.get("error"):
        print(f"  {label:<36} ERROR {r['error']}")
        fail += 1
        continue
    ok = (r["coveragePct"] or 0) <= 1.0
    if not ok:
        fail += 1
    print(
        f"  {label:<36} maxAlpha={r['maxAlpha']:>3}  coverage={r['coveragePct']:>5}%  "
        f"copyRight={r['copyRightFrac']}  body={r['bodyFontSize']:<8} {'OK' if ok else 'FAIL'}"
    )

print(f"\nRESULT: {'PASS' if fail == 0 else f'{fail} case(s) over budget'}")
print("Budget: coverage <= 1.0% of true glyph pixels (historical reference: 0.24%).")
sys.exit(1 if fail else 0)
