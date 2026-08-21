"""Is the mobile putting gesture robust?

Three things this checks that a mouse test cannot:
  1. a real touch drag on the ball actually launches a putt
  2. the PAGE DOES NOT SCROLL during that drag (the passive-listener bug)
  3. usable power from the worst lie -- ball pinned against the play box edge,
     where the drag runway is whatever screen lies behind it
"""
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options


def cdp(d, m, p):
    return d.execute_cdp_cmd(m, p)


def touch_drag(d, x0, y0, x1, y1, steps=8):
    cdp(d, "Input.dispatchTouchEvent",
        {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
    for i in range(1, steps + 1):
        t = i / steps
        cdp(d, "Input.dispatchTouchEvent",
            {"type": "touchMove",
             "touchPoints": [{"x": x0 + (x1 - x0) * t, "y": y0 + (y1 - y0) * t}]})
        time.sleep(0.02)
    cdp(d, "Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


# (label, start fx, start fy, drag direction) — drag AWAY from intended target
LIES = [
    ("centre        ", 0.5, 0.5, (0, -1)),
    ("left edge     ", 0.0, 0.5, (-1, 0)),
    ("right edge    ", 1.0, 0.5, (1, 0)),
    ("top edge      ", 0.5, 0.0, (0, -1)),
    ("bottom edge   ", 0.5, 1.0, (0, 1)),
    ("bottom-left   ", 0.0, 1.0, (-1, 1)),
    ("top-right     ", 1.0, 0.0, (1, -1)),
]

opts = Options()
opts.add_argument("--headless=new")
opts.add_argument("--hide-scrollbars")
opts.add_argument("--force-device-scale-factor=1")
d = webdriver.Chrome(options=opts)
fails = 0
try:
    cdp(d, "Emulation.setDeviceMetricsOverride",
        {"width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": True})
    cdp(d, "Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
    d.get("http://localhost:8123/index.html")
    try:
        d.execute_script("return document.fonts.ready")
    except Exception:
        pass
    time.sleep(2.8)

    # bring the green band into view
    d.execute_script("""
      const b=document.querySelector('.hero-canvas-wrap').getBoundingClientRect();
      const s=window.__puttTest.state();
      window.scrollTo({top: window.pageYOffset + b.top + s.box.y - 120, behavior:'instant'});
    """)
    time.sleep(1.0)

    print(f"\n  coarse grab radius / narrow maxPull in effect at 390x844")
    print(f"  {'lie':<15} {'launched':<9} {'power(px/s)':<12} {'scrolled':<9} verdict")
    for name, fx, fy, (dx, dy) in LIES:
        d.execute_script("window.__puttTest.place(arguments[0], arguments[1])", fx, fy)
        time.sleep(0.25)
        geo = d.execute_script("""
          const r=document.querySelector('.hero-canvas-wrap').getBoundingClientRect();
          const s=window.__puttTest.state();
          return {bx:r.left+s.ball[0], by:r.top+s.ball[1], sy:window.pageYOffset,
                  vw:innerWidth, vh:innerHeight};
        """)
        bx, by = geo["bx"], geo["by"]
        # drag 100px in the given direction, clamped to stay on screen
        tx = max(4, min(geo["vw"] - 4, bx + dx * 100))
        ty = max(4, min(geo["vh"] - 4, by + dy * 100))
        # drag WITHOUT releasing, so we can read the pull the game actually saw
        cdp(d, "Input.dispatchTouchEvent",
            {"type": "touchStart", "touchPoints": [{"x": bx, "y": by}]})
        for i in range(1, 9):
            t = i / 8
            cdp(d, "Input.dispatchTouchEvent",
                {"type": "touchMove",
                 "touchPoints": [{"x": bx + (tx - bx) * t, "y": by + (ty - by) * t}]})
            time.sleep(0.02)
        mid = d.execute_script(
            "const s=window.__puttTest.state();"
            "return {phase:s.phase, sy:window.pageYOffset};")
        cdp(d, "Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        time.sleep(0.06)
        st = d.execute_script(
            "const s=window.__puttTest.state();"
            "return {phase:s.phase, speed:s.speed, sy:window.pageYOffset};")
        st["aiming"] = mid["phase"]
        st["dragpx"] = round(((tx-bx)**2 + (ty-by)**2) ** 0.5)
        launched = st["phase"] in ("rolling", "sunk") or st["speed"] > 5
        scrolled = abs(st["sy"] - geo["sy"]) > 4
        ok = launched and not scrolled
        if not ok:
            fails += 1
        print(f"  {name:<15} {str(launched):<9} {st['speed']:>11.0f} "
              f"{str(scrolled):<9} {'ok' if ok else 'FAIL'}   "
              f"drag={st['dragpx']}px midPhase={st['aiming']}")
        # let it settle before the next lie
        for _ in range(40):
            time.sleep(0.2)
            if d.execute_script("return window.__puttTest.state().phase") in ("idle", "sunk"):
                break

    print(f"\nRESULT: {fails} failure(s) of {len(LIES)} lies")
finally:
    d.quit()
sys.exit(1 if fails else 0)
