"""Verifies the two specific claims written into layout.css's new comments.

CLAIM 1 (fix #1): at 390px the pass wall is 11 passes in 11 rows, widest row 1,
                  zero document overflow -- identical before and after.
CLAIM 2 (fix #2): under prefers-reduced-motion, after a full scroll, all four
                  bento tiles sit at opacity 1.000 -- identical before and after.

A comment that states a measurement has to be re-runnable or it is decoration.
"""
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

BASE = sys.argv[1]
LABEL = sys.argv[2] if len(sys.argv) > 2 else ""

WALL = r"""
const done = arguments[0];
window.scrollTo(0, document.documentElement.scrollHeight);
setTimeout(() => {
  const ps = [...document.querySelectorAll('.pass-wall > .pass')];
  const tops = {};
  ps.forEach(p => { const t = Math.round(p.getBoundingClientRect().top / 20) * 20;
                    tops[t] = (tops[t] || 0) + 1; });
  const rows = Object.values(tops);
  const cols = ps.map(p => getComputedStyle(p).gridColumn);
  done({
    n: ps.length, rows: rows.length, widest: Math.max(...rows),
    gridColumn: [...new Set(cols)],
    ov: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    heights: [...new Set(ps.map(p => Math.round(p.getBoundingClientRect().height)))],
  });
}, 1800);
"""

TILES = r"""
const done = arguments[0];
const H = document.documentElement.scrollHeight;
let y = 0;
(function step(){
  y += window.innerHeight * 0.85;
  window.scrollTo(0, Math.min(y, H));
  if (y < H) return setTimeout(step, 70);
  setTimeout(() => {
    const sels = ['.project-feature', '.bento-plate', '.project-card--tall', '.project-card--wide'];
    done(sels.map(s => {
      const el = document.querySelector(s);
      if (!el) return [s, 'MISSING'];
      const cs = getComputedStyle(el);
      return [s, parseFloat(cs.opacity).toFixed(3), cs.transform,
              el.classList.contains('reveal') ? 'is .reveal' : 'NOT .reveal'];
    }));
  }, 1200);
})();
"""


def drive(width, reduced, script, page):
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--force-device-scale-factor=1")
    if reduced:
        opts.add_argument("--force-prefers-reduced-motion")
    d = webdriver.Chrome(options=opts)
    d.set_script_timeout(60)
    try:
        d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                          {"width": width, "height": 900, "deviceScaleFactor": 1, "mobile": False})
        d.get(f"{BASE}/{page}")
        try:
            d.execute_script("return document.fonts.ready")
        except Exception:
            pass
        time.sleep(1.0)
        return d.execute_async_script(script)
    finally:
        d.quit()


print(f"\n===== CLAIM CHECK [{LABEL}] =====")
w = drive(390, False, WALL, "travel/")
print(f"CLAIM 1  @390 pass wall: passes={w['n']} rows={w['rows']} widest-row={w['widest']} "
      f"doc-overflow={w['ov']} grid-column={w['gridColumn']} heights={w['heights']}")

t = drive(1440, True, TILES, "")
print("CLAIM 2  reduced-motion, after full scroll, bento tiles:")
for row in t:
    print(f"           {row[0]:<22} opacity={row[1]}  transform={row[2]}  {row[3]}")
