"""Emit the BEST-POSSIBLE attempts on a round, as browser-replayable trials.

For a round the simulator calls unsolvable, these are the lines that come
closest to the cup over the whole (angle x power) grid. Replaying them in the
browser is the direct corroboration that the hole really cannot be holed --
independent of trusting the sweep's completeness.

Usage: golf_pick_fails.py probe.json out.json 7,12 [--top 15]
                         [--dt-source probe|fps]
"""
import argparse
import json
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import golf_sim as S  # noqa: E402
from golf_sweep import sweep  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("probe")
ap.add_argument("out")
ap.add_argument("rounds")
ap.add_argument("--top", type=int, default=15)
# SAME TIMESTEP AS golf_sweep AND golf_pick, from the same resolver.
ap.add_argument("--fps", type=float, default=S.DEFAULT_FPS)
ap.add_argument("--dt-source", choices=("probe", "fps"), default="probe")
ap.add_argument("--astep", type=float, default=0.5)
ap.add_argument("--pstep", type=float, default=0.01)
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
for rnd in [int(v) for v in a.rounds.split(",")]:
    # copy_edge is REQUIRED: without it the play box reverts to the
    # pre-derivation 0.44 left edge and the wall sits 271px too far out at 1440.
    g = S.Green(w, h, cb, nr, rnd, copy_edge=probe["copyEdge"])
    if rnd in measured:
        m = measured[rnd]
        g.ball0 = (m["ball"][0], m["ball"][1])
        g.cup_x, g.cup_y = m["cup"][0], m["cup"][1]
    r = sweep(g, angles, powers, dt)
    cl = r["closest"]
    print(f"round {rnd}: sunk={int((r['outcome'] == 1).sum())} "
          f"closest={cl.min():.2f}px over {cl.size} putts")
    flat = np.argsort(cl, axis=None)[: a.top]
    for f in flat:
        ai, pi = np.unravel_index(f, cl.shape)
        oc = int(r["outcome"][ai, pi])
        # Relief at the point of consumption — see the note in golf_pick.py.
        fx = float(r["final"][0][ai, pi])
        fy = float(r["final"][1][ai, pi])
        if oc != 1:
            fx, fy = g.relief_in(fx, fy)
        trials.append({
            "round": rnd, "kind": f"best-try-{cl[ai, pi]:.0f}px",
            "angle": float(angles[ai]), "power": float(powers[pi]),
            "expect": "not-sunk",
            "predict": {1: "sunk", 2: "stopped", 3: "timeout"}[oc],
            "predictFinal": [fx, fy],
            "predictClosest": float(cl[ai, pi]),
            "cup": [g.cup_x, g.cup_y], "ball": list(g.ball0),
        })

json.dump({"probe": a.probe, "dt": dt_label, "dtSource": a.dt_source,
           "fps": a.fps, "trials": trials},
          open(a.out, "w"), indent=1)
print(f"{len(trials)} trials -> {a.out}")
