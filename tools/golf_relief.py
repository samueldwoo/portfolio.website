"""How much RELIEF does the green actually have, per undulation setting?

Answers the design question directly: at a given undulation multiplier, what
fraction of the height variation across the play box comes from the undulation
rather than the plane, and how many local peaks/valleys does that produce? A
plane has none by construction, which is why the fall-line arrows never diverge.

Usage: golf_relief.py probe.json [--rounds 60] [--undul 1,1.5,2,3,4,6] [--tilt 1]
"""
import argparse
import json
import math
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import golf_sim as S  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("probe")
ap.add_argument("--rounds", type=int, default=60)
ap.add_argument("--undul", default="1,1.5,2,3,4,6")
ap.add_argument("--tilt", default="1")
ap.add_argument("--grid", type=int, default=56)
a = ap.parse_args()

probe = json.load(open(a.probe))
w = max(1, round(probe["wrap"]["w"]))
h = max(1, round(probe["wrap"]["h"]))
cb, nr = probe["copyBottom"], probe["narrow"]
N = a.grid

print(f"# {probe['viewport'][0]}x{probe['viewport'][1]}  "
      f"{a.rounds} rounds, {N}x{N} samples over the play box")
print(f"{'undul':>6} {'tilt':>5} {'planeShare':>10} {'peaks':>6} {'valleys':>7} "
      f"{'saddleFree':>10} {'meanSlopeAcc':>12} {'holdFrac':>8}")

for us in [float(v) for v in a.undul.split(",")]:
    for ts in [float(v) for v in a.tilt.split(",")]:
        shares, pk, vl, slopes, holds = [], [], [], [], []
        for rnd in range(1, a.rounds + 1):
            g = S.Green(w, h, cb, nr, rnd, reach_safety=0.9,
                        undul_scale=us, tilt_scale=ts,
                        copy_edge=probe["copyEdge"])
            b = g.box
            H = [[0.0] * N for _ in range(N)]
            P = [[0.0] * N for _ in range(N)]
            for i in range(N):
                y = b["y"] + b["h"] * (i / (N - 1))
                for j in range(N):
                    x = b["x"] + b["w"] * (j / (N - 1))
                    H[i][j] = g.height_at(x, y)
                    nx = (x - g.hmx) / g.span
                    ny = (y - g.hmy) / g.span
                    P[i][j] = (nx * math.cos(g.tilt_ang)
                               + ny * math.sin(g.tilt_ang)) * g.tilt_mag
            flat = [H[i][j] for i in range(N) for j in range(N)]
            pl = [P[i][j] for i in range(N) for j in range(N)]
            un = [flat[k] - pl[k] for k in range(len(flat))]
            rp = max(pl) - min(pl)
            ru = max(un) - min(un)
            shares.append(rp / (rp + ru) if rp + ru else 1.0)
            # local extrema on the 8-neighbourhood, interior only
            npk = nvl = 0
            for i in range(1, N - 1):
                for j in range(1, N - 1):
                    c = H[i][j]
                    nb = [H[i + di][j + dj] for di in (-1, 0, 1)
                          for dj in (-1, 0, 1) if di or dj]
                    if all(c > v for v in nb):
                        npk += 1
                    elif all(c < v for v in nb):
                        nvl += 1
            pk.append(npk)
            vl.append(nvl)
            # slope magnitudes on a coarser grid (this is the expensive bit)
            step = max(1, N // 14)
            mags = []
            for i in range(0, N, step):
                y = b["y"] + b["h"] * (i / (N - 1))
                for j in range(0, N, step):
                    x = b["x"] + b["w"] * (j / (N - 1))
                    gx, gy = g.slope_at(x, y)
                    mags.append(math.hypot(gx, gy))
            slopes.append(sum(mags) / len(mags))
            holds.append(sum(1 for m in mags if m < S.SLOPE_ACCEL * 0.014)
                         / len(mags))
        n = a.rounds
        print(f"{us:>6.2f} {ts:>5.2f} {100 * sum(shares) / n:>9.0f}% "
              f"{sum(pk) / n:>6.1f} {sum(vl) / n:>7.1f} "
              f"{sum(1 for x in pk if x == 0) / n * 100:>9.0f}% "
              f"{sum(slopes) / n:>12.0f} {100 * sum(holds) / n:>7.0f}%")
