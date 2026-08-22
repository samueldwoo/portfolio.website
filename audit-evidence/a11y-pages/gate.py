"""Merge gate: runs this project's stated verification bar against a served build.

Usage: gate.py <base_url> [label]

The bar (from HANDOFF.md):
  0 severe console errors on all 3 pages
  no horizontal overflow at 1440 / 820 / 390 (CDP-forced -- headless Chrome
    clamps small windows to ~500px, so a plain 390px window is FAKE)
  nothing stranded under normal AND forced-reduced-motion, checked AFTER a
    full scroll (below-fold elements at opacity 0 are awaiting their observer,
    not stranded)
"""
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8477"
LABEL = sys.argv[2] if len(sys.argv) > 2 else BASE
PAGES = ["", "projects/", "travel/"]   # directory-format build (Vercel adapter)
WIDTHS = [1440, 820, 390]
STRAND_SEL = ".reveal, .reveal-clip, .pass, .case-block, h1, h2"

SCROLL_THEN_PROBE = r"""
const done = arguments[0];
const H = document.documentElement.scrollHeight;
let y = 0;
(function step(){
  y += window.innerHeight * 0.8;
  window.scrollTo(0, Math.min(y, H));
  if (y < H) { setTimeout(step, 90); }
  else {
    // Poll until opacities STOP changing, rather than guessing a settle time.
    // A short fixed wait catches reveals mid-tween (opacity 0.92-0.99 with
    // .is-visible already set) and reports them as stranded -- a false positive
    // that makes the whole gate useless as a regression signal.
    const probe = () => {
      const bad = [];
      document.querySelectorAll(arguments_sel).forEach(el => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;      // genuinely not laid out
        if (cs.display === 'none' || cs.visibility === 'hidden') return;  // deliberate
        if (parseFloat(cs.opacity) < 0.99) {
          bad.push((el.className || el.tagName) + ' op=' + cs.opacity);
        }
      });
      return bad;
    };
    let last = null, stable = 0, waited = 0;
    (function settle(){
      const bad = probe();
      const sig = bad.join('|');
      stable = (sig === last) ? stable + 1 : 0;
      last = sig;
      waited += 250;
      // stable for 3 consecutive polls, or 12s ceiling
      if ((stable >= 3 && waited > 1500) || waited > 12000) {
        done({
          stranded: bad.slice(0, 12),
          strandedCount: bad.length,
          settleMs: waited,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        });
      } else {
        setTimeout(settle, 250);
      }
    })();
  }
})();
""".replace("arguments_sel", repr(STRAND_SEL))


def run(reduced_motion):
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--force-device-scale-factor=1")
    if reduced_motion:
        opts.add_argument("--force-prefers-reduced-motion")
    d = webdriver.Chrome(options=opts)
    d.set_script_timeout(60)
    findings = []
    try:
        for page in PAGES:
            for w in WIDTHS:
                d.execute_cdp_cmd(
                    "Emulation.setDeviceMetricsOverride",
                    {"width": w, "height": 900, "deviceScaleFactor": 1, "mobile": False},
                )
                d.get(f"{BASE}/{page}")
                try:
                    d.execute_script("return document.fonts.ready")
                except Exception:
                    pass
                time.sleep(1.0)
                res = d.execute_async_script(SCROLL_THEN_PROBE)
                sev = [
                    e["message"][:180]
                    for e in d.get_log("browser")
                    if e["level"] == "SEVERE"
                ]
                overflow = res["scrollWidth"] > res["clientWidth"]
                tag = f"{page:<14} @{w:<5}"
                if sev:
                    findings.append(f"  ERROR   {tag} {len(sev)} severe: {sev[0]}")
                if overflow:
                    findings.append(
                        f"  OVERFLOW{tag} scrollWidth={res['scrollWidth']} > {res['clientWidth']}"
                    )
                if res["strandedCount"]:
                    findings.append(
                        f"  STRAND  {tag} {res['strandedCount']}: {res['stranded'][:3]}"
                    )
                if not (sev or overflow or res["strandedCount"]):
                    findings.append(f"  ok      {tag}")
    finally:
        d.quit()
    return findings


print(f"\n=== GATE: {LABEL} ===")
fail = 0
for rm in (False, True):
    mode = "reduced-motion" if rm else "normal"
    print(f"\n-- {mode} --")
    for line in run(rm):
        print(line)
        if not line.strip().startswith("ok"):
            fail += 1
print(f"\nRESULT: {'PASS' if fail == 0 else f'{fail} FINDING(S)'}")
sys.exit(1 if fail else 0)
