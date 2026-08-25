"""Replay the simulator's predicted putts in a REAL browser and score agreement.

An unvalidated simulator is worthless, so this is the load-bearing step. It walks
the deterministic round sequence in one page load, self-identifying the current
round by cup position (a sunk putt auto-re-tees after 1.5s, so the round counter
cannot be tracked blindly), then drives each trial through __puttTest.aim().

NOTE ON SCOPE: driving __puttTest.aim() deliberately bypasses the pointer path.
This validates PHYSICS ONLY and is not evidence that input works -- that is what
golf_mouse.py / golf_touch.py / golf_scroll.py are for.

Usage: golf_validate.py trials.json [base_url] [width] [height]
"""
import json
import math
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

TRIALS = sys.argv[1]
# BASE URL: directory-format, 8020 like the rest of the harness. See the note in
# golf_probe.py -- this file had the same "/index.html" + port-8123 pair, which
# passes on `python -m http.server` and 301s in production.
BASE = (sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8020").rstrip("/")
W = int(sys.argv[3]) if len(sys.argv) > 3 else 1440
H = int(sys.argv[4]) if len(sys.argv) > 4 else 900

SETTLE = """
const s = window.__puttTest.state();
return {phase: s.phase, ball: s.ball, cup: s.cup, speed: s.speed};
"""


def boot(d):
    d.get(BASE + "/")
    for _ in range(60):
        time.sleep(0.15)
        if d.execute_script("return !!window.__puttTest"):
            break
    time.sleep(1.5)


def settle(d, timeout=14.0):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        s = d.execute_script(SETTLE)
        last = s
        if s["phase"] != "rolling":
            return s
        time.sleep(0.06)
    return last


def main():
    spec = json.load(open(TRIALS))
    trials = [t for t in spec["trials"] if t.get("predict")]
    by_round = {}
    for t in trials:
        by_round.setdefault(t["round"], []).append(t)

    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--force-device-scale-factor=1")
    d = webdriver.Chrome(options=opts)
    rows = []
    try:
        d.set_window_size(W, H)
        d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                          {"width": W, "height": H, "deviceScaleFactor": 1,
                           "mobile": False})
        d.set_script_timeout(30)

        for rnd in sorted(by_round):
            for ti, t in enumerate(by_round[rnd]):
                # Fresh load per trial: the only way to land on round `rnd` with
                # the ball on its real tee and no history.
                boot(d)
                for _ in range(rnd):
                    d.execute_script("window.__puttTest.reset();")
                s = d.execute_script(SETTLE)
                cup_err = math.hypot(s["cup"][0] - t["cup"][0],
                                     s["cup"][1] - t["cup"][1])
                ball_err = math.hypot(s["ball"][0] - t["ball"][0],
                                      s["ball"][1] - t["ball"][1])
                if cup_err > 0.5 or ball_err > 0.5:
                    rows.append({**t, "status": "DESYNC",
                                 "cupErr": cup_err, "ballErr": ball_err})
                    print(f"round {rnd} {t['kind']:<12} DESYNC "
                          f"cupErr={cup_err:.2f} ballErr={ball_err:.2f}")
                    continue
                a = math.radians(t["angle"])
                d.execute_script(
                    "window.__puttTest.aim(arguments[0],arguments[1],"
                    "arguments[2]);",
                    math.cos(a), math.sin(a), t["power"])
                out = settle(d)
                got = "sunk" if out["phase"] == "sunk" else "not-sunk"
                pred = "sunk" if t["predict"] == "sunk" else "not-sunk"
                pos_err = (0.0 if got == "sunk" else
                           math.hypot(out["ball"][0] - t["predictFinal"][0],
                                      out["ball"][1] - t["predictFinal"][1]))
                agree = got == pred
                rows.append({**t, "status": "ok", "browser": got,
                             "browserFinal": out["ball"], "posErr": pos_err,
                             "agree": agree})
                print(f"round {rnd} {t['kind']:<12} sim={t['predict']:<8} "
                      f"browser={out['phase']:<8} "
                      f"{'AGREE' if agree else 'DISAGREE':<8} "
                      f"posErr={pos_err:6.1f}px")
    finally:
        d.quit()

    ok = [r for r in rows if r["status"] == "ok"]
    ag = [r for r in ok if r["agree"]]
    print(f"\nAGREEMENT {len(ag)}/{len(ok)} = "
          f"{100.0 * len(ag) / max(1, len(ok)):.1f}%  "
          f"(desyncs: {sum(1 for r in rows if r['status'] == 'DESYNC')})")
    for kind in ("sink-centre", "sink-edge", "miss-edge", "miss-far"):
        sub = [r for r in ok if r["kind"] == kind]
        if sub:
            print(f"  {kind:<12} {sum(r['agree'] for r in sub)}/{len(sub)}")
    misses = [r["posErr"] for r in ok if r["browser"] == "not-sunk"
              and r["agree"]]
    if misses:
        misses.sort()
        print(f"  resting-position error on agreeing misses: median "
              f"{misses[len(misses) // 2]:.1f}px  max {max(misses):.1f}px")
    json.dump(rows, open(TRIALS.replace(".json", "") + "_browser.json", "w"),
              indent=1)
    return 0 if len(ag) == len(ok) else 1


if __name__ == "__main__":
    sys.exit(main())
