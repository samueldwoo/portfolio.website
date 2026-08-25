"""Pick validation trials: predicted SINKS and predicted MISSES, per round.

The point of the trial set is to be falsifiable in both directions. A validation
that only replays sinks proves nothing — a simulator that returned "sunk" for
everything would pass it. So each round contributes:

  sink-centre   the middle of the widest angular solution run   -> expect sunk
  sink-edge     one grid step inside that run's edge             -> expect sunk
  miss-edge     three steps OUTSIDE the run                      -> expect NOT sunk
  miss-far      the solution line rotated 90 deg, full power     -> expect NOT sunk

Usage: golf_pick.py probe.json out.json [--rounds 20] [--dt-source probe|fps]
"""
import argparse
import json
import math
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import golf_sim as S  # noqa: E402
from golf_sweep import sweep  # noqa: E402


def runs_of(mask):
    """Circular runs of True as (start, length) on the index ring."""
    n = mask.size
    if not mask.any():
        return []
    out = []
    i = 0
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            out.append((i, j - i))
            i = j
        else:
            i += 1
    # merge wrap-around
    if len(out) > 1 and out[0][0] == 0 and out[-1][0] + out[-1][1] == n:
        s, ln = out[-1]
        out = out[1:-1] + [(s, ln + out[0][1])]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("probe")
    ap.add_argument("out")
    ap.add_argument("--rounds", type=int, default=20)
    # SAME TIMESTEP AS golf_sweep, from the same resolver. This defaulted to
    # --fps 120 while golf_sweep defaulted to 60, so the tool that picks the
    # trials and the tool that certifies solvability disagreed about the physics
    # by a factor of two — and neither matched the page.
    ap.add_argument("--fps", type=float, default=S.DEFAULT_FPS)
    ap.add_argument("--dt-source", choices=("probe", "fps"), default="probe")
    ap.add_argument("--astep", type=float, default=1.0)
    ap.add_argument("--pstep", type=float, default=0.025)
    a = ap.parse_args()

    probe = json.load(open(a.probe))
    w = max(1, round(probe["wrap"]["w"]))
    h = max(1, round(probe["wrap"]["h"]))
    cb, nr = probe["copyBottom"], probe["narrow"]
    dt, dt_label = S.resolve_dt(probe, a.dt_source, a.fps)
    print(f"# dt={dt_label}")
    measured = {r["round"]: r for r in probe["rounds"]}

    angles = np.arange(0.0, 360.0, a.astep)
    powers = np.round(np.arange(0.1, 1.0 + 1e-9, a.pstep), 6)

    trials = []
    for rnd in range(1, a.rounds + 1):
        # copy_edge IS REQUIRED. Without it Green falls back to the
        # pre-derivation 0.44 left edge, so the play box ran 633..1354 while the
        # real one runs 905..1354 at 1440 — the trials were picked with the left
        # wall 271px too far out, and a putt that the page stops against that
        # wall kept rolling here. Overriding ball0/cup from the probe fixed the
        # tee and the hole and hid the box.
        g = S.Green(w, h, cb, nr, rnd, copy_edge=probe["copyEdge"])
        if rnd in measured:
            m = measured[rnd]
            g.ball0 = (m["ball"][0], m["ball"][1])
            g.cup_x, g.cup_y = m["cup"][0], m["cup"][1]
        r = sweep(g, angles, powers, dt)
        sunk = r["outcome"] == 1
        best = None
        for pi in range(powers.size):
            for st, ln in runs_of(sunk[:, pi]):
                if best is None or ln > best[1]:
                    best = (st, ln, pi)
        if best is None:
            trials.append({"round": rnd, "kind": "unsolvable",
                           "cup": [g.cup_x, g.cup_y], "ball": list(g.ball0)})
            print(f"round {rnd}: NO SOLUTION at dt={dt_label}")
            continue
        st, ln, pi = best
        n = angles.size
        pw = float(powers[pi])
        centre = angles[(st + ln // 2) % n]
        edge = angles[(st + ln - 1) % n]
        out_ang = (angles[(st + ln - 1) % n] + 3 * a.astep) % 360.0
        perp = (centre + 90.0) % 360.0

        def one(kind, adeg, power, expect):
            rr = sweep(g, [adeg], [power], dt)
            oc = int(rr["outcome"][0, 0])
            got = "sunk" if oc == 1 else ("timeout" if oc == 3 else "stopped")
            return {
                "round": rnd, "kind": kind, "angle": float(adeg),
                "power": float(power), "expect": expect, "predict": got,
                "predictFinal": [float(rr["final"][0][0, 0]),
                                 float(rr["final"][1][0, 0])],
                "predictClosest": float(rr["closest"][0, 0]),
                "cup": [g.cup_x, g.cup_y], "ball": list(g.ball0),
                "runDeg": ln * a.astep,
            }

        trials.append(one("sink-centre", centre, pw, "sunk"))
        trials.append(one("sink-edge", edge, pw, "sunk"))
        trials.append(one("miss-edge", out_ang, pw, "not-sunk"))
        trials.append(one("miss-far", perp, 1.0, "not-sunk"))
        print(f"round {rnd}: run {ln * a.astep:.1f}deg @ power {pw:.3f}, "
              f"centre {centre:.1f}deg")

    json.dump({"probe": a.probe, "dt": dt_label, "dtSource": a.dt_source,
               "fps": a.fps, "trials": trials}, open(a.out, "w"), indent=1)
    bad = [t for t in trials if t.get("predict") and
           ((t["expect"] == "sunk") != (t["predict"] == "sunk"))]
    print(f"\n{len(trials)} trials -> {a.out}"
          f"  (self-consistent: {len(trials) - len(bad)}/{len(trials)})")


if __name__ == "__main__":
    main()
