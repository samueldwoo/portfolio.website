#!/usr/bin/env python3
"""Repro: tab to the large project card on `/` and watch where focus lands.

The general focus sweep flagged exactly one settled problem:

    a.card.project-card: offscreen-y top=928 bottom=1633;
                         faded eff=0.0 by=... project-feature reveal ...

i.e. after 2.5s of polling the focused link was still entirely below the fold
AND at opacity 0. Two candidate causes, and they need separating:

  A. `html { scroll-behavior: smooth }` + the pinned hero. The browser's
     scroll-into-view for focus competes with ScrollTrigger's pin, which
     changes layout as it engages/releases.
  B. `.reveal`'s IntersectionObserver simply has not fired because the element
     never actually entered the viewport.

So: tab one stop at a time, and at the stop where the feature card takes focus,
poll for 8 SECONDS recording the trail. If it converges into view, this is a
slow-but-correct scroll. If it parks, it is a real focus-visibility failure.

Usage: repro_focus_card.py <base> [width] [height]
"""
import json
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8130"
W = int(sys.argv[2]) if len(sys.argv) > 2 else 1440
H = int(sys.argv[3]) if len(sys.argv) > 3 else 900

READ = r"""
const el = document.activeElement;
if (!el || el === document.body) return null;
const r = el.getBoundingClientRect();
let a = el, eff = 1, by = null;
while (a && a !== document.documentElement) {
  const o = parseFloat(getComputedStyle(a).opacity);
  if (o < eff) { eff = o; by = String(a.className||a.tagName).slice(0,60); }
  a = a.parentElement;
}
return {
  cls: String(el.className||'').slice(0,60), tag: el.tagName.toLowerCase(),
  top: Math.round(r.top), bottom: Math.round(r.bottom),
  vh: window.innerHeight, scrollY: Math.round(window.scrollY),
  eff: Math.round(eff*1000)/1000, by: by,
  visible: String(el.className||'').includes('is-visible'),
  pinned: document.querySelectorAll('.pin-spacer').length,
};
"""

o = Options()
o.add_argument("--headless=new")
o.add_argument("--hide-scrollbars")
o.add_argument("--force-device-scale-factor=1")
d = webdriver.Chrome(options=o)
d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                  {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False})
try:
    d.get(f"{BASE}/")
    time.sleep(2.0)
    body = d.find_element(By.TAG_NAME, "body")
    body.click()
    print(f"viewport {W}x{H}  pin-spacers at rest: "
          f"{d.execute_script('return document.querySelectorAll(\".pin-spacer\").length')}")
    hits = 0
    for i in range(40):
        (body if i == 0 else d.switch_to.active_element).send_keys(Keys.TAB)
        info = d.execute_script(READ)
        if not info:
            continue
        interesting = "project-card" in info["cls"]
        if not interesting:
            continue
        hits += 1
        print(f"\n--- tab stop #{i+1}: {info['tag']}.{info['cls']} ---")
        trail = []
        for t in range(32):                     # 32 x 250ms = 8s
            time.sleep(0.25)
            cur = d.execute_script(READ)
            if not cur:
                break
            trail.append((t * 250 + 250, cur["top"], cur["bottom"],
                          cur["eff"], cur["scrollY"]))
        for ms, top, bot, eff, sy in trail[:4] + trail[-3:]:
            print(f"   t={ms:>5}ms  top={top:>6} bottom={bot:>6} "
                  f"effOpacity={eff:<6} scrollY={sy}")
        last = trail[-1]
        onscreen = last[2] > 0 and last[1] < info["vh"]
        opaque = last[3] >= 0.99
        print(f"   VERDICT after 8s: onscreen={onscreen} opaque={opaque}"
              f"  => {'OK' if (onscreen and opaque) else 'FOCUS NOT VISIBLE'}")
    if not hits:
        print("no project-card tab stop reached in 40 tabs")
finally:
    d.quit()
