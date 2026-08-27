"""Exhaustive (aim angle x power) sweep of the putting green, per round.

Vectorised with numpy: every candidate putt for a round is stepped in lockstep,
which is what makes an exhaustive sweep tractable (a single putt can roll 7s =
840 frames, and a fine sweep is ~10^5 putts per round).

The numpy field functions are checked against the scalar port in tools/golf_sim.py
(itself checked against the browser) on every run. That check was opt-in until
2026-08-25 and the drift it exists to catch had been in the tree for days — see
Field.height. Use --no-selfcheck only when you know why.

Usage:
  golf_sweep.py probe.json [--rounds 24] [--dt-source probe|fps] [--fps 120]
                [--capture 225] [--maxspeed 900] [--friction 0.12] [--cupr 13]
"""
import argparse
import json
import math
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import golf_sim as S  # noqa: E402

# ---------------- vectorised field ----------------


def hash2_np(i, j):
    n = i * 374761393 + j * 668265263          # exact in int64
    u = n & 0xFFFFFFFF                          # ToUint32 bits of the |0
    x1 = u ^ (u >> 13)
    x1s = np.where(x1 >= 0x80000000, x1 - 0x100000000, x1)
    # The lossy step: JS does this multiply in float64 and only THEN coerces.
    prod = x1s.astype(np.float64) * 1274126177.0
    u2 = np.trunc(prod).astype(np.int64) & 0xFFFFFFFF
    return ((u2 ^ (u2 >> 16)) & 0xFFFFFFFF) / 4294967295.0


def vnoise_np(x, y):
    xi = np.floor(x).astype(np.int64)
    yi = np.floor(y).astype(np.int64)
    xf = x - xi
    yf = y - yi
    u = xf * xf * (3 - 2 * xf)
    v = yf * yf * (3 - 2 * yf)
    a = hash2_np(xi, yi)
    b = hash2_np(xi + 1, yi)
    c = hash2_np(xi, yi + 1)
    d = hash2_np(xi + 1, yi + 1)
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v


def fbm_np(x, y):
    return (vnoise_np(x, y) - 0.5) * 1.34 + (
        vnoise_np(x * 2.17 + 11.3, y * 2.17 - 4.1) - 0.5) * 0.62


class Field:
    def __init__(self, g: S.Green):
        self.hmx, self.hmy, self.span = g.hmx, g.hmy, g.span
        self.ca = math.cos(g.tilt_ang)
        self.sa = math.sin(g.tilt_ang)
        self.tm = g.tilt_mag
        self.sd = g.g_seed
        self.us = g.undul_scale

    def height(self, x, y):
        nx = (x - self.hmx) / self.span
        ny = (y - self.hmy) / self.span
        plane = (nx * self.ca + ny * self.sa) * self.tm
        # THIRD MIRROR OF heightAt, AND THE ONE THAT WENT STALE. It sat at
        # frequencies 1.25/2.9 and amplitudes 1.05/0.40 long after the component
        # moved to 0.85/2.0 and 1.16/0.26 — up to 1.14 units of height error, mean
        # |grad| 202 against a real 179, and less than half the restable area. So
        # every sweep number, including SOLVABLE 41/41, described a green nobody
        # plays, and every trial golf_pick handed the browser was aimed on it.
        #
        # golf_verify_port.py could not catch it: it only ever checked
        # golf_sim.height_at. golf_sweep's own --selfcheck WOULD have caught it,
        # which is why that now runs by default rather than on request.
        undul = (fbm_np(nx * 0.85 + self.sd, ny * 0.85 - self.sd) * 1.16
                 + fbm_np(nx * 2.0 - self.sd * 1.7,
                          ny * 2.0 + self.sd * 1.3) * 0.26) * self.us
        return plane + undul

    def slope(self, x, y):
        h = 7.0
        hx = self.height(x + h, y) - self.height(x - h, y)
        hy = self.height(x, y + h) - self.height(x, y - h)
        return -hx * S.SLOPE_ACCEL, -hy * S.SLOPE_ACCEL


# ---------------- vectorised stepBall ----------------

def as_dts(dt):
    """A scalar timestep or a measured per-frame sequence, one way in.

    The page's dt is a real frame delta, so the honest input here is a sequence.
    A float is still accepted because a uniform step is the right tool for a
    what-if (halve the friction, widen the cup) where the browser is not the
    reference. Whichever it is, the loop below reads it the same way and the
    sequence's LAST value repeats once a putt outlives the capture.
    """
    if isinstance(dt, (int, float)):
        return [float(dt)]
    out = [float(v) for v in dt]
    if not out:
        raise ValueError("empty dt sequence")
    return out


def sweep(g: S.Green, angles_deg, powers, dt, start=None):
    """Returns dict of per-candidate result arrays, shape (nA, nP).

    `dt` is a float or a measured per-frame sequence (see as_dts).
    """
    f = Field(g)
    b = g.box
    bxl, bxr = b["x"], b["x"] + b["w"]
    byt, byb = b["y"], b["y"] + b["h"]
    sx, sy = start if start else g.ball0

    A = np.deg2rad(np.asarray(angles_deg, dtype=np.float64))
    P = np.asarray(powers, dtype=np.float64)
    nA, nP = A.size, P.size
    N = nA * nP
    ang = np.repeat(A, nP)
    pw = np.tile(P, nA)

    bx = np.full(N, sx)
    by = np.full(N, sy)
    vx = np.cos(ang) * pw * g.max_speed
    vy = np.sin(ang) * pw * g.max_speed
    on_wall = np.zeros(N, dtype=bool)
    in_cup = np.zeros(N, dtype=bool)   # inside the cup radius LAST frame
    stalled = np.zeros(N)
    roll = np.zeros(N)
    closest = np.full(N, math.hypot(g.cup_x - sx, g.cup_y - sy))
    hot = np.zeros(N, dtype=bool)
    hot_min = np.full(N, np.inf)
    outcome = np.zeros(N, dtype=np.int8)     # 0 running, 1 sunk, 2 stop, 3 t/o
    live = np.arange(N)

    hold_thr = S.SLOPE_ACCEL * S.REST_SLOPE   # mirrors HeroCanvas REST_SLOPE
    dts = as_dts(dt)
    # Frame budget from the SMALLEST step, so a fast-frame tail cannot truncate a
    # putt that MAX_ROLL would otherwise still be carrying.
    max_frames = int(math.ceil(S.MAX_ROLL / min(dts))) + 4

    for _fi in range(max_frames):
        if live.size == 0:
            break
        dt = dts[_fi] if _fi < len(dts) else dts[-1]
        keep = math.pow(g.friction, dt)
        x = bx[live]
        y = by[live]
        gx, gy = f.slope(x, y)
        wx = vx[live] + gx * dt
        wy = vy[live] + gy * dt
        wx *= keep
        wy *= keep
        x = x + wx * dt
        y = y + wy * dt

        at_l = x < bxl
        at_r = x > bxr
        at_t = y < byt
        at_b = y > byb
        x = np.where(at_l, bxl, x)
        x = np.where(at_r, bxr, x)
        y = np.where(at_t, byt, y)
        y = np.where(at_b, byb, y)
        wx = np.where(at_l | at_r, 0.0, wx)
        wy = np.where(at_t | at_b, 0.0, wy)
        touching = at_l | at_r | at_t | at_b
        begin = touching & ~on_wall[live]
        wy = np.where(begin & (at_l | at_r), wy * 0.5, wy)
        wx = np.where(begin & (at_t | at_b), wx * 0.5, wx)
        on_wall[live] = touching

        dcx = g.cup_x - x
        dcy = g.cup_y - y
        dist = np.sqrt(dcx * dcx + dcy * dcy)
        speed = np.sqrt(wx * wx + wy * wy)
        closest[live] = np.minimum(closest[live], dist)

        near = dist < g.cup_r
        # THE GATE (mirror of golf_sim / HeroCanvas): a ball already lipped out on
        # this pass cannot be captured, which is what makes LIP_LOSS safe.
        gated = in_cup[live] if g.lip_gate else np.zeros_like(in_cup[live])
        drop = near & ~gated & (speed < g.capture_speed)
        rim = near & ~drop
        if rim.any():
            hot[live] = hot[live] | rim
            hot_min[live] = np.where(rim, np.minimum(hot_min[live], speed),
                                     hot_min[live])
            # MIRROR of HeroCanvas / golf_sim: too fast to be held, so the lip
            # throws it off line -- a ROTATION, never a damping, see
            # golf_sim.LIP_DEFLECT. THIRD MIRROR — the one that went stale on the
            # height field — so the selfcheck guards it.
            #
            # `enter` must be computed BEFORE in_cup is updated, and in_cup is
            # written every frame (not only when `rim`), so leaving the radius
            # re-arms the deflection. Same edge-detect shape as `begin`/`on_wall`
            # above; a per-frame rotation would spiral the ball around the cup.
            enter = rim & ~in_cup[live]
            if enter.any():
                safe = np.where(speed > 0.0, speed, 1.0)
                inv = 1.0 / safe
                ux, uy = wx * inv, wy * inv
                lat = -dcx * uy + dcy * ux
                frac = np.minimum(1.0, np.abs(lat) / g.cup_r)
                ang = np.where(enter, -np.sign(lat) * g.lip_deflect * frac, 0.0)
                ca, sa = np.cos(ang), np.sin(ang)
                # Loss on the EXCESS above capture speed, so the hit itself can
                # never put the ball under the threshold. See golf_sim.LIP_LOSS.
                excess = speed - g.capture_speed
                target = g.capture_speed + excess * (1.0 - g.lip_loss)
                scale = np.where(enter, target / safe, 1.0)
                wx, wy = np.where(enter, (wx * ca - wy * sa) * scale, wx), \
                    np.where(enter, (wx * sa + wy * ca) * scale, wy)
        in_cup[live] = rim

        rgx = np.where((at_l & (gx < 0)) | (at_r & (gx > 0)), 0.0, gx)
        rgy = np.where((at_t & (gy < 0)) | (at_b & (gy > 0)), 0.0, gy)
        holds = np.hypot(rgx, rgy) < hold_thr

        st = np.where(speed < S.STOP_SPEED, stalled[live] + dt, 0.0)
        stalled[live] = st
        rt = roll[live] + dt
        roll[live] = rt

        timeout = rt > S.MAX_ROLL
        rest = (speed < S.STOP_SPEED) & (holds | (st > 0.9))
        creep = (speed < 6) & ~holds & ~timeout & ~rest
        wx = np.where(creep, wx + gx * dt * 0.5, wx)
        wy = np.where(creep, wy + gy * dt * 0.5, wy)

        bx[live] = x
        by[live] = y
        vx[live] = wx
        vy[live] = wy

        done = drop | timeout | rest
        oc = np.where(drop, 1, np.where(timeout, 3, np.where(rest, 2, 0)))
        outcome[live] = np.where(done, oc, outcome[live])
        # sunk balls snap to the cup
        bx[live] = np.where(drop, g.cup_x, bx[live])
        by[live] = np.where(drop, g.cup_y, by[live])
        if done.any():
            live = live[~done]

    return {
        "outcome": outcome.reshape(nA, nP),
        "closest": closest.reshape(nA, nP),
        "hot": hot.reshape(nA, nP),
        "hot_min": hot_min.reshape(nA, nP),
        "final": (bx.reshape(nA, nP), by.reshape(nA, nP)),
        "angles": np.asarray(angles_deg, dtype=np.float64),
        "powers": P,
    }


def widest_run(mask_row, step_deg, wrap=True):
    """Widest contiguous run of True in a circular angle mask, in degrees."""
    n = mask_row.size
    if not mask_row.any():
        return 0.0
    if mask_row.all():
        return n * step_deg
    best = cur = 0
    seq = np.concatenate([mask_row, mask_row]) if wrap else mask_row
    for v in seq:
        cur = cur + 1 if v else 0
        best = max(best, cur)
    return min(best, n) * step_deg


def selfcheck(g, dt):
    """Vectorised engine vs the scalar port, on a handful of putts.

    THIS RUNS BY DEFAULT NOW. It was opt-in, and the one bug it exists to catch —
    the vectorised height field drifting away from the scalar one — then sat in
    the tree through every documented invariant run, because none of them passed
    the flag. A guard nobody turns on is not a guard.
    """
    worst = 0.0
    dis = 0
    tested = 0
    dts = as_dts(dt)
    for adeg in (0.0, 37.0, 111.0, 214.0, 300.5):
        for p in (0.3, 0.6, 0.95):
            r = sweep(g, [adeg], [p], dt)
            a = math.radians(adeg)
            o, _, fx, fy, _, _, _, _ = g.putt(math.cos(a), math.sin(a), p,
                                              dts=dts)
            v = {1: "sunk", 2: "stopped", 3: "timeout"}[int(r["outcome"][0, 0])]
            tested += 1
            if v != o:
                dis += 1
                print(f"  selfcheck disagree a={adeg} p={p}: vec={v} scalar={o}")
            worst = max(worst, abs(r["final"][0][0, 0] - fx),
                        abs(r["final"][1][0, 0] - fy))
    print(f"selfcheck: {tested - dis}/{tested} outcomes agree, "
          f"max final-pos delta {worst:.3e} px")
    return dis == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("probe")
    ap.add_argument("--rounds", type=int, default=24)
    # TIMESTEP: shared default, and it USED TO BE 60 here while golf_pick used
    # 120 — two tools written to corroborate each other integrating different
    # greens. `--dt-source probe` is the faithful setting and the default:
    # it replays the frame deltas golf_probe.py measured during a real roll.
    ap.add_argument("--fps", type=float, default=S.DEFAULT_FPS)
    ap.add_argument("--dt-source", choices=("probe", "fps"), default="probe",
                    help="probe: replay probe.json's dt_roll_ms (falls back to "
                         "--fps if absent). fps: uniform 1/fps.")
    ap.add_argument("--astep", type=float, default=1.0)
    ap.add_argument("--pstep", type=float, default=0.025)
    ap.add_argument("--pmin", type=float, default=0.1)
    ap.add_argument("--capture", type=float, default=S.CAPTURE_SPEED)
    ap.add_argument("--maxspeed", type=float, default=S.MAX_SPEED)
    ap.add_argument("--friction", type=float, default=S.FRICTION)
    ap.add_argument("--cupr", type=float, default=S.CUP_R)
    ap.add_argument("--selfcheck", action="store_true",
                    help="(now the default; kept so old invocations still run)")
    ap.add_argument("--no-selfcheck", action="store_true",
                    help="skip the vectorised-vs-scalar check")
    ap.add_argument("--only", default=None,
                    help="comma-separated round numbers to sweep")
    ap.add_argument("--undul", type=float, default=1.0,
                    help="multiplier on BOTH fbm amplitudes (1.16/0.26)")
    ap.add_argument("--tilt", type=float, default=1.0,
                    help="multiplier on the plane's tiltMag")
    ap.add_argument("--downhill-credit", type=float, default=None,
                    help="seconds of downhill drift credited as reach "
                         "(default MAX_ROLL=7)")
    ap.add_argument("--reach-safety", type=float, default=None,
                    help="enable the two-sided tee rule at this budget "
                         "fraction (forces --recompute: the tee moves)")
    ap.add_argument("--recompute", action="store_true",
                    help="ignore probe tee/cup; use the seeded values")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()

    probe = json.load(open(a.probe))
    # layout() rounds the wrap rect before it becomes cssW/cssH.
    w = max(1, round(probe["wrap"]["w"]))
    h = max(1, round(probe["wrap"]["h"]))
    cb, nr = probe["copyBottom"], probe["narrow"]
    dt, dt_label = S.resolve_dt(probe, a.dt_source, a.fps)

    angles = np.arange(0.0, 360.0, a.astep)
    powers = np.round(np.arange(a.pmin, 1.0 + 1e-9, a.pstep), 6)

    print(f"# {probe['viewport'][0]}x{probe['viewport'][1]}  narrow={nr}  "
          f"dt={dt_label}  grid={angles.size}ang x {powers.size}pow "
          f"= {angles.size * powers.size} putts/round")
    print(f"# capture<{a.capture:g}  MAX_SPEED={a.maxspeed:g}  "
          f"FRICTION={a.friction:g}  CUP_R={a.cupr:g}  "
          f"reachSafety={a.reach_safety} "
          f"downhillCredit={a.downhill_credit} "
          f"undul={a.undul} tilt={a.tilt}")

    if not a.no_selfcheck:
        g0 = S.Green(w, h, cb, nr, 1, copy_edge=probe["copyEdge"],
                     cup_r=a.cupr, capture_speed=a.capture,
                     max_speed=a.maxspeed, friction=a.friction)
        if not selfcheck(g0, dt):
            sys.exit(2)

    rows = []
    solved = 0
    print(f"{'rnd':>3} {'dist':>6} {'tilt':>5} {'mag':>4} {'sunk?':>5} "
          f"{'hits':>5} {'bestP':>5} {'tolDeg':>6} {'minMiss':>7} "
          f"{'hotPass':>7} {'maxReach':>8} {'upAcc':>6} {'aReach':>7}")
    todo = ([int(v) for v in a.only.split(",")] if a.only
            else list(range(a.rounds + 1)))
    # Prefer the browser's OWN reported tee/cup where the probe covers the round.
    # Rounds 1+ reproduce exactly from the seed; round 0 does not on narrow
    # viewports, because the initial tee is laid out before the final
    # `copyBottom` measurement lands and is then merely CLAMPED into the moved
    # play box rather than re-fractioned. Auditing the computed position there
    # would audit a hole the player never sees.
    measured = {r["round"]: r for r in probe.get("rounds", [])}
    for rnd in todo:
        g = S.Green(w, h, cb, nr, rnd, copy_edge=probe["copyEdge"],
                    cup_r=a.cupr, capture_speed=a.capture,
                    max_speed=a.maxspeed, friction=a.friction,
                    reach_safety=a.reach_safety,
                    downhill_credit=(1.0 / -math.log(a.friction)
                                     if a.downhill_credit is None
                                     else a.downhill_credit),
                    undul_scale=a.undul, tilt_scale=a.tilt)
        if rnd in measured and not a.recompute and a.reach_safety is None:
            m = measured[rnd]
            g.ball0 = (m["ball"][0], m["ball"][1])
            g.cup_x, g.cup_y = m["cup"][0], m["cup"][1]
        r = sweep(g, angles, powers, dt)
        sunk = r["outcome"] == 1
        d0 = math.hypot(g.cup_x - g.ball0[0], g.cup_y - g.ball0[1])
        n_hits = int(sunk.sum())
        # widest angular tolerance, over powers
        tol, bestp = 0.0, float("nan")
        for pi in range(powers.size):
            t = widest_run(sunk[:, pi], a.astep)
            if t > tol:
                tol, bestp = t, powers[pi]
        min_miss = float(r["closest"].min())
        hot_any = bool(r["hot"].any())
        fx, fy = r["final"]
        reach = float(np.max(np.hypot(fx - g.ball0[0], fy - g.ball0[1])))
        ok = n_hits > 0
        solved += ok
        # Analytic straight-line reach along ball->cup. `up` is the mean slope
        # acceleration OPPOSING the putt (positive = uphill), sampled along the
        # line; reach solves  dv/dt = -k v - up  for v -> 0.
        ux = (g.cup_x - g.ball0[0]) / (d0 or 1)
        uy = (g.cup_y - g.ball0[1]) / (d0 or 1)
        samp = []
        for f_ in (0.15, 0.35, 0.55, 0.75, 0.95):
            gx_, gy_ = g.slope_at(g.ball0[0] + ux * d0 * f_,
                                  g.ball0[1] + uy * d0 * f_)
            samp.append(-(gx_ * ux + gy_ * uy))
        up = sum(samp) / len(samp)
        k = -math.log(a.friction)
        v0 = a.maxspeed
        if up > 1e-6:
            a_reach = v0 / k - (up / (k * k)) * math.log1p(k * v0 / up)
        elif up < -1e-6:
            a_reach = v0 / k + (-up / k) * (
                1.0 / k if a.downhill_credit is None else a.downhill_credit)
        else:
            a_reach = v0 / k
        rows.append({
            "round": rnd, "dist": d0, "tiltAng": g.tilt_ang,
            "tiltMag": g.tilt_mag, "gSeed": g.g_seed,
            "ball": list(g.ball0), "cup": [g.cup_x, g.cup_y],
            "hits": n_hits, "tolDeg": tol,
            "bestPower": None if math.isnan(bestp) else float(bestp),
            "minMiss": min_miss, "hotPass": hot_any,
            "hotMinSpeed": (None if not hot_any
                            else float(np.min(r["hot_min"][r["hot"]]))),
            "maxReach": reach, "upAcc": up, "analyticReach": a_reach,
        })
        print(f"{rnd:>3} {d0:>6.0f} {math.degrees(g.tilt_ang):>5.0f} "
              f"{g.tilt_mag:>4.2f} {'YES' if ok else 'no':>5} {n_hits:>5} "
              f"{'-' if math.isnan(bestp) else f'{bestp:.3f}':>5} "
              f"{tol:>6.1f} {min_miss:>7.1f} {str(hot_any):>7} {reach:>8.0f} "
              f"{up:>6.1f} {a_reach:>7.0f}")

    n = len(todo)
    print(f"\nSOLVABLE {solved}/{n} = {100.0 * solved / n:.1f}%")
    tols = [x["tolDeg"] for x in rows if x["hits"]]
    if tols:
        print(f"aim tolerance on solvable rounds: min {min(tols):.1f}deg  "
              f"median {sorted(tols)[len(tols) // 2]:.1f}deg  "
              f"max {max(tols):.1f}deg")
    fails = [x for x in rows if not x["hits"]]
    if fails:
        print("UNSOLVABLE rounds: " + ", ".join(
            f"{x['round']} (dist {x['dist']:.0f}px, closest miss "
            f"{x['minMiss']:.1f}px, maxReach {x['maxReach']:.0f}px, "
            f"hotPass={x['hotPass']})" for x in fails))
    if a.json:
        json.dump({"config": vars(a), "rows": rows}, open(a.json, "w"),
                  indent=1)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
