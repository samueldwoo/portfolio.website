"""The mash line: how many holes fall to "aim at the cup and use full power".

WHY THIS FILE EXISTS. Until 2026-08-26 this green was won by aiming straight at
the hole and mashing, on 68 of 81 holes including the par 4 and the par 5. Break
is proportional to TIME on the green, so pace suppresses it, and overshooting the
cup cost nothing while `CAPTURE_SPEED` was 520 of a 900 maximum. Full power was
strictly dominant, which makes the contour lines decorative -- the one thing this
hero cannot afford, since the whole subsystem exists so that reading them pays.

AND NO INVARIANT NOTICED FOR THE ENTIRE TIME IT WAS BROKEN. `golf_sweep.py`
reported SOLVABLE 81/81 throughout, because solvability asks whether AT LEAST ONE
(aim, power) pair sinks: a dominant strategy makes MORE pairs sink, so the metric
is a floor on the sinking window and cannot see the window swallow the space.
`golf_par.py` missed it too -- its player model rolls the ball 15% past the hole
by design, so it never played the degenerate line at all. A skill model that plays
WELL will not find an exploit; the exploit has to be tested for on purpose.

Both handoff notes therefore say to "re-measure the mash line by hand" after any
change to the cup test. This is that check, mechanised, so it stops depending on
somebody remembering. It is the cheapest tool in this directory: one putt per hole
at the default settings.

READ THE RESULT AS A CEILING ON EXPLOITABILITY, NOT AS DIFFICULTY. A low number
means the naive strategy does not dominate. It says nothing about whether a
competent read finds the line -- that is what golf_par.py measures, and the two
are different questions.

    $PY tools/golf_mash.py probe80.json                 # the documented check
    $PY tools/golf_mash.py probe80.json --aim-window 2  # allow a sloppy aim
    $PY tools/golf_mash.py probe80.json --json out.json

MEASURED BASELINES (2026-08-26, one probe at 1440x900, --dt-source fps):

    physics                              dead straight   --aim-window 2
    capture 520, no lip-out (the bug)        68/81  84%       --
    capture 175, no lip-out (reviewed)       16/81  20%    21/81  26%
    capture 225, lip-out + gate (shipped)    16/81  20%    29/81  36%
    capture 205, lip-out + gate (proposed)   12/81  15%    21/81  26%

RUN IT WITH --aim-window 2, NOT JUST THE DEFAULT, BECAUSE THE TWO DISAGREE. Dead
straight, capture 225 matches the reviewed baseline exactly (16/81) and looks free.
At +-2deg it costs 8 holes (29/81 against 21/81), which is the number a person
actually experiences, since nobody aims to the degree. 205 was proposed on that
basis; the owner chose 225 for feel, knowing the cost. Whichever value is in the
tree, quote BOTH windows -- a single favourable window is how this nearly shipped
unexamined.

If either number climbs toward 68, the cup test has regressed. Pass --dt-source fps
for a reproducible count: the probe's measured per-frame dt moves it by +-1.
"""
import argparse
import json
import math

import golf_sim as S


def build_green(probe, rnd, capture=None):
    """Green for `rnd`, tee and cup pinned to the probe's real values.

    IDENTICAL to golf_par.build_green, and copy_edge IS REQUIRED -- without it the
    play box reverts to the pre-derivation left edge and the walls move 271px, so
    every result would describe a green nobody plays. See golf_pick.py's long note.

    `capture` overrides the cup's speed test, and it exists to make this check
    FALSIFIABLE. A tool that reports 16/81 and has never been seen to report
    anything else has not been shown to measure exploitability at all; run it at
    --capture 520 and it must reproduce the pre-fix 68/81.
    """
    w = max(1, round(probe["wrap"]["w"]))
    h = max(1, round(probe["wrap"]["h"]))
    kw = {} if capture is None else {"capture_speed": capture}
    g = S.Green(w, h, probe["copyBottom"], probe["narrow"], rnd,
                copy_edge=probe["copyEdge"], reach_safety=0.9, **kw)
    m = {r["round"]: r for r in probe["rounds"]}.get(rnd)
    if m:
        g.ball0 = (m["ball"][0], m["ball"][1])
        g.cup_x, g.cup_y = m["cup"][0], m["cup"][1]
    return g


def mash(g, dt, dts, powers, aims):
    """Sink the hole by aiming AT the cup? Returns the first winning (aim, power).

    Aim is measured as a signed offset in degrees from the straight line to the
    cup, so 0.0 is the pure exploit. Powers are tried high-first because the claim
    under test is specifically that FULL power dominates.
    """
    bx, by = g.ball0
    base = math.atan2(g.cup_y - by, g.cup_x - bx)
    for p in powers:
        for da in aims:
            ang = base + math.radians(da)
            out, _, _, _, _, _, _, _ = g.putt(math.cos(ang), math.sin(ang), p,
                                              dt=dt, dts=dts, start=(bx, by),
                                              trace=True)
            if out == "sunk":
                return da, p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("probe")
    ap.add_argument("--rounds", type=int, default=80)
    ap.add_argument("--power", type=float, default=1.0,
                    help="lowest power to try; every step up to 1.0 is tried")
    ap.add_argument("--power-step", type=float, default=0.05)
    ap.add_argument("--aim-window", type=float, default=0.0,
                    help="degrees either side of straight-at-the-cup")
    ap.add_argument("--aim-step", type=float, default=0.5)
    ap.add_argument("--capture", type=float, default=None,
                    help="override the cup speed test; 520 reproduces the "
                         "pre-fix 68/81 and is this tool's positive control")
    ap.add_argument("--dt-source", choices=("probe", "fps"), default="probe")
    ap.add_argument("--fps", type=float, default=S.DEFAULT_FPS)
    ap.add_argument("--json")
    a = ap.parse_args()

    probe = json.load(open(a.probe))
    dt, dt_label = S.resolve_dt(probe, a.dt_source, a.fps)
    dts = probe.get("dt_roll_ms")
    dts = [v / 1000.0 for v in dts] if dts and a.dt_source == "probe" else None

    # High power first: the hypothesis is that full power dominates, so the first
    # hit found should be the one the exploit would actually use.
    powers, p = [], 1.0
    while p >= a.power - 1e-9:
        powers.append(round(p, 4))
        p -= a.power_step
    aims = [0.0]
    if a.aim_window > 0:
        n = int(a.aim_window / a.aim_step)
        # Smallest offsets first, so a hole that falls to a nearly-straight putt
        # is reported as such rather than as a 2deg read.
        aims = [0.0] + [s * i * a.aim_step
                        for i in range(1, n + 1) for s in (1, -1)]

    cap_label = "shipped" if a.capture is None else f"{a.capture:g} (OVERRIDE)"
    print(f"# dt={dt_label}  holes={a.rounds + 1}  powers={len(powers)} "
          f"({powers[-1]:g}..1)  aim window +-{a.aim_window:g}deg "
          f"({len(aims)} offsets)  capture={cap_label}")

    rows, sunk = [], 0
    for rnd in range(0, a.rounds + 1):
        g = build_green(probe, rnd, a.capture)
        hit = mash(g, dt, dts, powers, aims)
        d = math.hypot(g.cup_x - g.ball0[0], g.cup_y - g.ball0[1])
        rows.append({"round": rnd, "dist": d, "sunk": hit is not None,
                     "aim": None if hit is None else hit[0],
                     "power": None if hit is None else hit[1]})
        if hit is not None:
            sunk += 1
            print(f"round {rnd:>3}  dist {d:6.1f}  MASHED  "
                  f"aim {hit[0]:+.1f}deg  power {hit[1]:g}")
        else:
            print(f"round {rnd:>3}  dist {d:6.1f}  resists")

    n = len(rows)
    print(f"\nMASH LINE: {sunk} of {n} = {100.0 * sunk / n:.1f}%")
    print("baselines at 1440x900, fixed fps: capture 225 + lip-out = 16/81 dead "
          "straight, 29/81 at --aim-window 2; capture 520 with no lip-out = 68/81. "
          "Run BOTH windows — the dead-straight number alone once hid an 8-hole "
          "regression. A number climbing toward 68 means the cup test regressed.")
    if a.aim_window == 0 and a.power == 1.0:
        print("this is the documented check: one putt per hole, dead straight, "
              "full power")
    if a.json:
        json.dump({"config": vars(a), "sunk": sunk, "of": n, "rows": rows},
                  open(a.json, "w"), indent=1)
        print(f"\n-> {a.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
