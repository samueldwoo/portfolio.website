"""Element-geometry snapshot, for proving a semantic swap is visually inert.

The risky edits were structural, not stylistic: div->dl with span->dt/dd,
h4->h3 on .card-title, and width/height attributes on the 10 airline logos.
Each of those changes the UA default box the element starts from, so "the class
carries all the styling" is a claim to check, not to assume.

Usage: geom.py <base> <out.json>
"""
import json
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

BASE, OUT = sys.argv[1], sys.argv[2]

SELS = {
    "": [".favorites-grid", ".favorite-item", ".favorite-label", ".favorite-value",
         ".project-grid", ".project-feature", ".project-card--tall", ".bento-plate",
         ".project-card--wide", ".card-title", ".feature-chips", ".feature-chips li",
         ".skills-list", ".timeline", ".exp-item", ".contact-form form", ".site-foot",
         ".hero-name", ".section-title", ".subhead"],
    "projects/": [".case-study", ".case-head", ".case-meta", ".case-body", ".case-block",
                  ".project-grid--even", ".project-card", ".card-title", ".site-foot"],
    "travel/": [".trip-summary", ".trip-plot", ".trip-col", ".pass-wall", ".pass",
                ".pass-main", ".pass-head", ".pass-logoband", ".pass-logo", ".pass-cities",
                ".pass-route", ".pass-code", ".pass-foot", ".pass-stub", ".site-foot",
                ".band-inner"],
}

JS = """
const out = {};
for (const s of arguments[0]) {
  out[s] = [...document.querySelectorAll(s)].map(el => {
    const r = el.getBoundingClientRect();
    return [Math.round((r.left + window.scrollX) * 10) / 10,
            Math.round((r.top + window.scrollY) * 10) / 10,
            Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10];
  });
}
out.__doc = [document.documentElement.scrollWidth, document.documentElement.scrollHeight];
return out;
"""

snap = {}
for w in (390, 1440):
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--force-device-scale-factor=1")
    opts.add_argument("--force-prefers-reduced-motion")   # finished state, deterministic
    d = webdriver.Chrome(options=opts)
    try:
        for page, sels in SELS.items():
            d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                              {"width": w, "height": 900, "deviceScaleFactor": 1, "mobile": False})
            d.get(f"{BASE}/{page}")
            try:
                d.execute_script("return document.fonts.ready")
            except Exception:
                pass
            time.sleep(1.5)
            snap[f"{w}|{page}"] = d.execute_script(JS, sels)
    finally:
        d.quit()

json.dump(snap, open(OUT, "w"), indent=1)
print(f"wrote {OUT}")
