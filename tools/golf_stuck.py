"""Can the ball become permanently unplayable?

Aiming requires phase === 'idle'. If a putt ends with the ball pinned against a
wall and phase stuck at 'rolling', the game is soft-locked — that is the reported
"ball goes to the bottom and can't be played anymore".

Drives real putts through the component's own __puttTest hook: place the ball,
aim at full power into an edge, then poll until it settles. Any run still
'rolling' after the timeout is a soft-lock.
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


# (label, start fx, start fy, aim dx, aim dy) — aims that end at a wall/corner
CASES = [
    ("straight down     ", 0.5, 0.2, 0.0, 1.0),
    ("down-left corner  ", 0.6, 0.2, -0.8, 1.0),
    ("down-right corner ", 0.4, 0.2, 0.8, 1.0),
    ("straight up       ", 0.5, 0.8, 0.0, -1.0),
    ("hard left         ", 0.8, 0.5, -1.0, 0.05),
    ("hard right        ", 0.2, 0.5, 1.0, -0.05),
    ("down from bottom  ", 0.5, 0.9, 0.1, 1.0),
    ("shallow along base", 0.15, 0.92, 1.0, 0.25),
]

POLL = """
const s = window.__puttTest.state();
return {phase: s.phase, speed: s.speed, ball: s.ball, box: s.box};
"""


def run(width, height, mobile, label):
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--force-device-scale-factor=1")
    d = webdriver.Chrome(options=opts)
    stuck = 0
    try:
        d.execute_cdp_cmd(
            "Emulation.setDeviceMetricsOverride",
            {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": mobile},
        )
        d.get(BASE + "/")
        try:
            d.execute_script("return document.fonts.ready")
        except Exception:
            pass
        time.sleep(2.6)
        if not d.execute_script("return !!window.__puttTest"):
            print(f"  {label}: NO TEST HOOK (reduced motion or short viewport?)")
            return 1

        print(f"\n  --- {label} ---")
        for name, fx, fy, dx, dy in CASES:
            d.execute_script("window.__puttTest.place(arguments[0], arguments[1])", fx, fy)
            d.execute_script(
                "window.__puttTest.aim(arguments[0], arguments[1], 1.0)", dx, dy
            )
            # poll up to 12s for it to settle
            phase = "rolling"
            waited = 0.0
            last = None
            while waited < 12.0:
                time.sleep(0.25)
                waited += 0.25
                last = d.execute_script(POLL)
                phase = last["phase"]
                if phase in ("idle", "sunk"):
                    break
            b = last["box"]
            bx, by = last["ball"]
            at_edge = (
                abs(bx - b["x"]) < 1.5
                or abs(bx - (b["x"] + b["w"])) < 1.5
                or abs(by - b["y"]) < 1.5
                or abs(by - (b["y"] + b["h"])) < 1.5
            )
            ok = phase in ("idle", "sunk")
            if not ok:
                stuck += 1
            print(
                f"    {'ok ' if ok else 'STUCK'} {name} -> phase={phase:<8} "
                f"settled in {waited:>4.1f}s  speed={last['speed']:.1f}  "
                f"atEdge={at_edge}"
            )
        return stuck
    finally:
        d.quit()


total = 0
total += run(1440, 900, False, "desktop 1440x900")
total += run(390, 844, True, "mobile 390x844")
print(f"\nRESULT: {total} soft-lock(s)")
sys.exit(1 if total else 0)
