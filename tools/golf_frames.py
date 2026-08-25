"""Per-frame browser trace of a rolling putt, diffed against golf_sim.

WHY THIS EXISTS. Every offline number in this directory was integrated at a
uniform timestep while the page integrates at `Math.min(0.05, (now - last) /
1000)` — the real frame delta, clamped. probe.json carried a `dt_ms` sample that
looked like evidence about that, but it was collected on a QUIET page with no
ball rolling and nothing else registered for the frame, so it described an idle
rAF rather than the timestep the game feeds stepBall. This tool measures the
real thing, then replays the captured sequence through `golf_sim.putt(dts=...)`
and names the first frame where the two part.

WHY A PASSENGER rAF LOOP IS ENOUGH, and the alternative that was rejected. The
obvious plan was to wrap `window.requestAnimationFrame` via CDP before
hydration and read `tick()`'s own `now`. That is unnecessary: every callback in
one animation-frame batch is handed the SAME timestamp, so a loop registered
after `tick()` differences exactly the numbers `tick()` differences. It is also
checkable rather than assumed — `__heroFrames` must advance by exactly 1 between
consecutive samples, and a run where it does not is reported as UNRELIABLE
instead of averaged into a distribution. Wrapping rAF would have needed
injection before hydration plus a guess at which callback is `tick`.

Usage: golf_frames.py [base] [--round N] [--angle DEG] [--power P] [--width W]
                      [--height H] [--json OUT]
"""
import argparse
import json
import math
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import golf_sim as S  # noqa: E402

# THE LOOP FIRES THE PUTT ITSELF, and that is the whole shape of this script.
#
# dt for the roll's FIRST step is (that frame's `now` - the PREVIOUS frame's
# `now`), so a sample from BEFORE the launch has to exist or that step's dt is
# simply not knowable. The first version called aim() from outside the loop and
# silently dropped it — and then two real ~8.3ms frames summed to ~16.6ms, which
# is close enough to tick()'s 0.016 first-frame seed that the missing step read
# as "the seed fired" and matched the browser to 0.03px over 841 frames. It had
# not fired: the rAF loop is already running on an idle page (measured, 120fps),
# so start() inside aim() is a no-op and `last` is never reset. A wrong story
# that fits the data to a thirtieth of a pixel is exactly the trap this
# directory keeps falling into, so warm up first and mark the launch frame.
#
# `heavy` adds the unrounded ball position and speed, because __putt.ball is
# rounded to whole pixels and a first-divergence diff needs sub-pixel. It costs a
# state() call per frame, so the dt distribution is taken light and the positional
# diff heavy.
CAPTURE_JS = r"""
const done = arguments[arguments.length - 1];
const dx = arguments[0], dy = arguments[1], pw = arguments[2];
const cap = arguments[3], heavy = arguments[4];
const log = [];
let aimedAt = -1;
let restAt = -1;
const t0 = performance.now();
function f(now) {
  const s = heavy ? window.__puttTest.state() : null;
  const ph = window.__putt ? window.__putt.phase : "?";
  log.push([now, ph, window.__heroFrames,
            s ? s.ball[0] : 0, s ? s.ball[1] : 0, s ? s.speed : 0]);
  if (aimedAt < 0) {
    if (log.length >= 3) { aimedAt = log.length - 1; window.__puttTest.aim(dx, dy, pw); }
  } else if (restAt < 0 && log.length - 1 > aimedAt && ph !== "rolling") {
    restAt = log.length - 1;
  }
  const spent = performance.now() - t0;
  const over = restAt >= 0 && log.length - 1 >= restAt + 2;
  if (log.length < cap && spent < 9500 && !over) requestAnimationFrame(f);
  else done({log: log, aimedAt: aimedAt, restAt: restAt});
}
requestAnimationFrame(f);
"""


def chrome(w, h):
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--force-device-scale-factor=1")
    d = webdriver.Chrome(options=opts)
    d.set_window_size(w, h)
    d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                      {"width": w, "height": h, "deviceScaleFactor": 1,
                       "mobile": False})
    d.set_script_timeout(40)
    return d


def boot(d, base, rnd):
    """Land on round `rnd` with the ball on its real tee. Mirrors golf_validate."""
    d.get(base.rstrip("/") + "/")
    for _ in range(60):
        time.sleep(0.15)
        if d.execute_script("return !!window.__puttTest"):
            break
    time.sleep(1.5)
    for _ in range(rnd):
        d.execute_script("window.__puttTest.reset();")
    return d.execute_script(
        "const s = window.__puttTest.state();"
        "return {phase: s.phase, ball: s.ball, cup: s.cup, box: s.box,"
        " copyEdge: s.copyEdge, copyBottom: s.copyBottom, narrow: s.narrow};")


def capture(d, dx, dy, power, heavy=False, cap=1200):
    """One putt, sampled once per animation frame. Returns the reconstruction."""
    res = d.execute_async_script(CAPTURE_JS, dx, dy, power, cap, bool(heavy))
    raw = res["log"]
    k = res["aimedAt"]
    # LOCKSTEP CHECK, not an assumption: this loop only sees tick()'s timestamps
    # if it runs in the same animation-frame batch, and __heroFrames advancing by
    # exactly 1 between consecutive samples is what proves it. A vacuous pass here
    # would launder an idle-rAF measurement into a "measured during a roll" claim.
    skips = sum(1 for i in range(1, len(raw)) if raw[i][2] - raw[i - 1][2] != 1)
    # aim() ran at the END of frame k (this callback runs after tick, which was
    # registered first), so frame k+1 is the first one stepBall sees. The frame
    # that finishes the roll steps too and only THEN writes 'idle'/'sunk', so it
    # is included.
    rolling = []
    if k >= 1:
        for i in range(k + 1, len(raw)):
            rolling.append(i)
            if raw[i][1] != "rolling":
                break
    return {
        "raw": raw,
        "skips": skips,
        "aimed_at": k,
        # The game's own arithmetic, verbatim from tick(): a real frame delta,
        # clamped at 50ms. No 0.016 seed — see frame_dts in golf_sim.
        "roll_dts": [min(S.DT_CLAMP, (raw[i][0] - raw[i - 1][0]) / 1000.0)
                     for i in rolling],
        "roll_pos": [(raw[i][3], raw[i][4], raw[i][5]) for i in rolling],
        "roll_phase": [raw[i][1] for i in rolling],
        "sunk": any(raw[i][1] == "sunk" for i in rolling),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default="http://localhost:8020")
    ap.add_argument("--round", type=int, default=1)
    ap.add_argument("--angle", type=float, default=0.0)
    ap.add_argument("--power", type=float, default=1.0)
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--json", default=None)
    a = ap.parse_args()

    d = chrome(a.width, a.height)
    try:
        st = boot(d, a.base, a.round)
        ang = math.radians(a.angle)
        c = capture(d, math.cos(ang), math.sin(ang), a.power, heavy=True)
    finally:
        d.quit()

    # cssW/cssH come from the rounded wrap rect, which at these viewports is the
    # window itself — the same assumption golf_validate makes.
    w, h = a.width, a.height
    g = S.Green(w, h, st["copyBottom"], st["narrow"], a.round,
                copy_edge=st["copyEdge"])
    g.ball0 = (st["ball"][0], st["ball"][1])
    g.cup_x, g.cup_y = st["cup"][0], st["cup"][1]

    dts = c["roll_dts"]
    ms = sorted(x * 1000 for x in dts)
    print(f"# round {a.round}  angle {a.angle}  power {a.power}  "
          f"frames sampled {len(c['raw'])}  lockstep skips {c['skips']}")
    if c["skips"]:
        print("UNRELIABLE: this loop missed frames tick() ran, so these "
              "timestamps are not tick()'s. Do not average them.")
    if ms:
        print(f"# roll dt over {len(ms)} stepped frames: min {ms[0]:.3f}ms  "
              f"p50 {ms[len(ms) // 2]:.3f}ms  max {ms[-1]:.3f}ms  "
              f"first {dts[0] * 1000:.3f}ms  "
              f"clamped@50ms {sum(1 for x in dts if x >= S.DT_CLAMP)}")

    out, frames, fx, fy, closest, hot, hotmin, path = g.putt(
        math.cos(ang), math.sin(ang), a.power, dts=dts, trace=True)
    print(f"# sim: {out} in {frames} frames, final ({fx:.2f}, {fy:.2f}); "
          f"browser: {'sunk' if c['sunk'] else 'not-sunk'}, "
          f"final ({c['roll_pos'][-1][0]:.2f}, {c['roll_pos'][-1][1]:.2f})")

    print(f"{'frm':>4} {'dt_ms':>7} {'simX':>9} {'simY':>9} {'brX':>9} "
          f"{'brY':>9} {'dpx':>8} {'simSpd':>8} {'brSpd':>8}")
    first_bad = None
    n = min(len(path), len(c["roll_pos"]))
    for i in range(n):
        sx, sy, ssp = path[i]
        bx, by, bsp = c["roll_pos"][i]
        dp = math.hypot(sx - bx, sy - by)
        if first_bad is None and dp > 0.01:
            first_bad = i
        if i < 6 or (first_bad is not None and first_bad - 2 <= i
                     <= first_bad + 6) or i >= n - 3:
            print(f"{i:>4} {dts[i] * 1000 if i < len(dts) else 0:>7.3f} "
                  f"{sx:>9.3f} {sy:>9.3f} {bx:>9.3f} {by:>9.3f} {dp:>8.3f} "
                  f"{ssp:>8.2f} {bsp:>8.2f}")
    if first_bad is None:
        print(f"\nNO DIVERGENCE above 0.01px over {n} compared frames.")
    else:
        print(f"\nFIRST DIVERGENCE at frame {first_bad} "
              f"({math.hypot(path[first_bad][0] - c['roll_pos'][first_bad][0], path[first_bad][1] - c['roll_pos'][first_bad][1]):.4f}px)")
    if a.json:
        json.dump({"round": a.round, "angle": a.angle, "power": a.power,
                   "skips": c["skips"], "dts": dts, "browser": c["roll_pos"],
                   "sim": path, "simOutcome": out, "browserSunk": c["sunk"],
                   "ball": list(g.ball0), "cup": [g.cup_x, g.cup_y]},
                  open(a.json, "w"), indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
