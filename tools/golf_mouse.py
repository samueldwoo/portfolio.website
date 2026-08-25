"""Desktop putting via a REAL mouse drag on the ball.

The existing golf tests call window.__puttTest.aim(), which bypasses pointerdown /
pointermove / pointerup entirely — so they cannot catch a broken input path. This
drives CDP Input.dispatchMouseEvent instead.
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



def cdp(d, m, p):
    return d.execute_cdp_cmd(m, p)


def mouse_drag(d, x0, y0, x1, y1, steps=10):
    cdp(d, "Input.dispatchMouseEvent",
        {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "clickCount": 1})
    for i in range(1, steps + 1):
        t = i / steps
        cdp(d, "Input.dispatchMouseEvent",
            {"type": "mouseMoved", "x": x0 + (x1 - x0) * t, "y": y0 + (y1 - y0) * t,
             "button": "left", "buttons": 1})
        time.sleep(0.02)
    return


def mouse_release(d, x, y):
    cdp(d, "Input.dispatchMouseEvent",
        {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})


LIES = [
    ("centre     ", 0.5, 0.5, (-1, 0)),
    ("left edge  ", 0.0, 0.5, (-1, 0)),
    ("right edge ", 1.0, 0.5, (1, 0)),
    ("top        ", 0.5, 0.0, (0, -1)),
    ("bottom     ", 0.5, 1.0, (0, 1)),
]

fails = 0
for w, h in [(1440, 900), (1024, 800)]:
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--force-device-scale-factor=1")
    d = webdriver.Chrome(options=opts)
    try:
        cdp(d, "Emulation.setDeviceMetricsOverride",
            {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False})
        d.get(BASE + "/")
        try:
            d.execute_script("return document.fonts.ready")
        except Exception:
            pass
        time.sleep(2.8)
        print(f"\n  === {w}x{h} (mouse) ===")
        print(f"  {'lie':<12} {'midPhase':<9} {'launched':<9} {'speed':>7}  {'hitEl':<28} verdict")
        for name, fx, fy, (dx, dy) in LIES:
            d.execute_script("window.__puttTest.place(arguments[0], arguments[1])", fx, fy)
            time.sleep(0.3)
            geo = d.execute_script("""
              const r=document.querySelector('.hero-canvas-wrap').getBoundingClientRect();
              const s=window.__puttTest.state();
              const bx=r.left+s.ball[0], by=r.top+s.ball[1];
              const el=document.elementFromPoint(bx,by);
              return {bx, by, vw:innerWidth, vh:innerHeight,
                      hit: el ? (el.tagName+'.'+((el.className&&el.className.baseVal!==undefined
                            ? el.className.baseVal : el.className)||'')).slice(0,28) : 'none'};
            """)
            bx, by = geo["bx"], geo["by"]
            tx = max(4, min(geo["vw"] - 4, bx + dx * 120))
            ty = max(4, min(geo["vh"] - 4, by + dy * 120))
            mouse_drag(d, bx, by, tx, ty)
            mid = d.execute_script("return window.__puttTest.state().phase")
            mouse_release(d, tx, ty)
            time.sleep(0.08)
            st = d.execute_script(
                "const s=window.__puttTest.state();return {phase:s.phase,speed:s.speed};")
            launched = st["phase"] in ("rolling", "sunk") or st["speed"] > 5
            ok = launched and mid == "aiming"
            if not ok:
                fails += 1
            print(f"  {name:<12} {mid:<9} {str(launched):<9} {st['speed']:>7.0f}  "
                  f"{geo['hit']:<28} {'ok' if ok else 'FAIL'}")
            for _ in range(40):
                time.sleep(0.2)
                if d.execute_script("return window.__puttTest.state().phase") in ("idle", "sunk"):
                    break
    finally:
        d.quit()

print(f"\nRESULT: {fails} failure(s)")
sys.exit(1 if fails else 0)
