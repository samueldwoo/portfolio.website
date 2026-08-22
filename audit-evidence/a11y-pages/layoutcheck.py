"""Responsive + zoom + measure audit.

Viewports are forced through CDP Emulation.setDeviceMetricsOverride, NOT by
sizing the window: headless Chrome clamps a window below ~500px, so a plain
390px window test measures ~500px and passes while 390px is broken.

200% zoom (WCAG 1.4.4) is emulated the way a browser actually does it -- the
CSS viewport halves while the device pixels stay put -- via deviceScaleFactor,
so `vw`-based clamps see the real reduced viewport.

Character counts are counted from per-glyph Range rects on the LONGEST realized
line, not inferred from `ch` (which is the advance of "0" and over-flatters
Inter by ~1.34x).
"""
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8231"
PAGES = ["", "projects/", "travel/"]
WIDTHS = [390, 820, 1024, 1440, 1920, 2560]

PROBE = r"""
const done = arguments[0];
const H = () => document.documentElement.scrollHeight;
let y = 0;
(function step(){
  y += window.innerHeight * 0.85;
  window.scrollTo(0, Math.min(y, H()));
  if (y < H()) return setTimeout(step, 70);
  setTimeout(() => {
    const de = document.documentElement;
    // every element wider than the viewport, ignoring the deliberately
    // clipped/fixed decoration layers
    const wide = [];
    document.querySelectorAll('main *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 2) return;
      const right = r.right + window.scrollX;
      const left = r.left + window.scrollX;
      if (right > de.clientWidth + 1 || left < -1) {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed') return;
        wide.push({
          sel: el.tagName.toLowerCase() + '.' + (el.className||'').toString().split(' ')[0],
          left: Math.round(left), right: Math.round(right),
        });
      }
    });

    // real characters on the longest realized line, per selector
    const measure = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const t = [...el.childNodes].find(n => n.nodeType === 3 && n.textContent.trim().length > 40);
      if (!t) return null;
      const rows = new Map();
      for (let i = 0; i < t.textContent.length; i++) {
        const rg = document.createRange();
        rg.setStart(t, i); rg.setEnd(t, i + 1);
        const b = rg.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        const key = Math.round(b.top);
        rows.set(key, (rows.get(key) || 0) + 1);
      }
      return rows.size ? Math.max(...rows.values()) : null;
    };

    done({
      scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
      wide: wide.slice(0, 8), wideCount: wide.length,
      chars: {
        '.exp-item p:not(.exp-company)': measure('.exp-item p:not(.exp-company)'),
        '.case-block p': measure('.case-block p'),
        '.card p:not([class])': measure('.card p:not([class])'),
        '.prose p': measure('.prose p'),
        '.interest-copy': measure('.interest-copy'),
        '.section-intro': measure('.section-intro'),
        '.hero-intro': measure('.hero-intro'),
        '.bento-plate-note': measure('.bento-plate-note'),
      },
    });
  }, 700);
})();
"""


def run(width, dsf=1, reduced=False, label=""):
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--force-device-scale-factor=1")
    if reduced:
        opts.add_argument("--force-prefers-reduced-motion")
    d = webdriver.Chrome(options=opts)
    d.set_script_timeout(60)
    try:
        for page in PAGES:
            d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                              {"width": width, "height": 900,
                               "deviceScaleFactor": dsf, "mobile": False})
            d.get(f"{BASE}/{page}")
            try:
                d.execute_script("return document.fonts.ready")
            except Exception:
                pass
            time.sleep(0.9)
            r = d.execute_async_script(PROBE)
            ov = r["scrollWidth"] - r["clientWidth"]
            tag = f"{label}{width:>5} /{page:<10}"
            status = "ok      " if ov <= 0 and r["wideCount"] == 0 else "OVERFLOW"
            print(f"  {status} {tag} doc {r['scrollWidth']}>{r['clientWidth']} (+{ov})"
                  f" wide-elements={r['wideCount']}")
            for w in r["wide"]:
                print(f"           {w['sel']:<40} left={w['left']} right={w['right']}")
            ch = {k: v for k, v in r["chars"].items() if v}
            if ch:
                bad = {k: v for k, v in ch.items() if v > 85 or v < 45}
                print("           chars/line: " + "  ".join(f"{k.split(':')[0]}={v}" for k, v in ch.items())
                      + ("   <<< OUT OF 45-85 BAND: " + str(bad) if bad else ""))
    finally:
        d.quit()


print("=" * 100)
print("RESPONSIVE (CDP-forced viewports)")
print("=" * 100)
for w in WIDTHS:
    run(w)

print()
print("=" * 100)
print("200% ZOOM (WCAG 1.4.4) -- CSS viewport halved at deviceScaleFactor 2")
print("=" * 100)
for w in (1440, 1280, 820):
    run(w // 2, dsf=2, label="z200 ")

print()
print("=" * 100)
print("prefers-reduced-motion")
print("=" * 100)
for w in (390, 1440):
    run(w, reduced=True, label="rm   ")
