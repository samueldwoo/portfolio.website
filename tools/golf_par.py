"""Expected strokes per hole, for a player of bounded skill — i.e. par.

Usage: golf_par.py probe.json [--rounds 80] [--trials 240] [--aim-sd 6]
                             [--power-sd 0.07] [--seed 7] [--json out.json]

WHY THE SWEEP CANNOT ANSWER THIS
    golf_sweep.py proves a one-stroke line EXISTS on every hole -- 81/81. That
    makes it useless as par: par would be 1 everywhere. The existence proof comes
    from brute-forcing 65520 (aim, power) pairs at 0.5deg and 0.01 power, and the
    share of that space which actually drops has a median of 0.85%, with 48 of 81
    holes under 1%. Nobody finds those lines by looking.

    So par has to be an EXPECTATION over a player who misses, which means the
    number is only as meaningful as the skill model behind it. That model is
    stated here rather than buried, because it is the entire content of par.

THE PLAYER MODEL: reads distance, does not read break
    Each stroke, the simulated player aims straight at the cup and picks the
    power that a STRAIGHT, FLAT roll would need to stop there (dist / flat_run,
    which is exact for the flat case since roll length is v0/k and v0 scales
    linearly with power). Then aim is perturbed by a Gaussian in degrees and
    power by a multiplicative Gaussian.

    The player therefore never compensates for slope. That is deliberate and it
    is the thematic point of the whole hero: the contour lines exist so a HUMAN
    can read break, so par should be the score of someone who has not read it.
    Beating par means you read the green. A model that pre-compensated for slope
    would fold the skill being tested into the baseline and make par unbeatable
    for the right reason.

    Not modelled, and both push par UP, so par here is a slightly generous
    baseline rather than a tight one:
      - learning. A real player who watches the first putt break left will allow
        for it on the second. This player re-aims straight at the cup every time.
      - lag putting. A real player leaves a long putt short on purpose to avoid
        running past. This one always tries to hole out.

CALIBRATING THE SKILL, RATHER THAN GUESSING IT
    aim-sd and power-sd are free parameters and picking them by feel would make
    par arbitrary. Anchor instead on the convention every golfer already knows: a
    green is a TWO-PUTT. So choose the aim error at which the MEDIAN hole plays
    to an expected 2.0 strokes, and report the curve so the choice is auditable
    (--curve). Everything else follows from that one anchor.
"""
import argparse
import json
import math

import numpy as np

import golf_sim as S

MAX_STROKES = 8   # a cap, not a rule: reported separately so it cannot hide


def build_green(probe, rnd):
    """Green for `rnd`, with the tee and cup pinned to the probe's real values.

    copy_edge IS REQUIRED -- see the long note in golf_pick.py. Without it the
    play box reverts to the pre-derivation left edge and the walls move 271px.
    """
    w = max(1, round(probe["wrap"]["w"]))
    h = max(1, round(probe["wrap"]["h"]))
    g = S.Green(w, h, probe["copyBottom"], probe["narrow"], rnd,
                copy_edge=probe["copyEdge"], reach_safety=0.9)
    m = {r["round"]: r for r in probe["rounds"]}.get(rnd)
    if m:
        g.ball0 = (m["ball"][0], m["ball"][1])
        g.cup_x, g.cup_y = m["cup"][0], m["cup"][1]
    return g


BIAS_CAP = math.radians(35.0)


def play_hole(g, rng, aim_sd, power_sd, dt, dts, overshoot, read):
    """One full hole. Returns strokes taken (MAX_STROKES if it never drops)."""
    flat_run = g.max_speed / -math.log(g.friction)
    bx, by = g.ball0
    bias = 0.0
    for stroke in range(1, MAX_STROKES + 1):
        dx, dy = g.cup_x - bx, g.cup_y - by
        dist = math.hypot(dx, dy) or 1.0
        # Straight at the cup, plus what the last putt taught, plus noise.
        #
        # THE PLAYER HAS TO LEARN OR PAR IS INFINITE ON SOME HOLES. A player who
        # only ever aims straight at the cup cannot finish round 4 at all: its
        # fall line runs into the play box's left wall, the ball parks against it
        # at x=904.5, and every subsequent putt breaks straight back into the
        # same wall -- 40 of 40 trials failed to hole out in 8 strokes, on a hole
        # the sweep proves is a one-putt. That is not the hole being hard, it is
        # the model being blind, and it would have poisoned par on every
        # break-heavy green.
        #
        # So the player does what a human does: watches where the ball actually
        # went versus where it was aimed, and allows for that much break next
        # time. `read` is how much of the observed bend is believed, which makes
        # green-reading skill ONE named parameter instead of an assumption. No
        # slope field is consulted -- the correction comes only from what a
        # player could actually see.
        aim = math.atan2(dy, dx) + bias
        ang = aim + math.radians(rng.normal(0.0, aim_sd))
        # NEVER UP, NEVER IN. The first version of this aimed to STOP at the cup
        # (power = dist / flat_run) and it deadlocked: a ball dying at the hole
        # stops short of the cup radius on any error at all, the next putt is
        # shorter, and 48.7% of trials never holed out inside 8 strokes. Real
        # putters roll it past on purpose for exactly this reason, so the target
        # roll is `overshoot` x the remaining distance. This single factor is the
        # difference between a usable model and one whose every mean is really
        # just the stroke cap.
        want = dist * overshoot / flat_run
        power = float(np.clip(want * rng.normal(1.0, power_sd), 0.1, 1.0))
        out, _, fx, fy, _, _, _, path = g.putt(math.cos(ang), math.sin(ang),
                                               power, dt=dt, dts=dts,
                                               start=(bx, by), trace=True)
        if out == "sunk":
            return stroke
        # WHAT THE GREEN DID, MEASURED AT THE HOLE — not at the resting place.
        #
        # The first version took the angle from the ball's start to its FINAL
        # position. That conflates break with everything that happens after the
        # ball passes the cup: with `overshoot` it rolls on by design, then keeps
        # going downhill or parks on a wall, and none of that is information about
        # the line. Learning from it made `bias` slam to its +-35deg cap and stay
        # there, spraying putts 80-210px wide and stranding the player on holes
        # whose every lie was perfectly reachable. It looked like the game had
        # more dead ends than it does.
        #
        # A real player watches the ball AT the hole and says "it broke left".
        # So take the signed lateral offset at the point of closest approach and
        # correct by that angle. Off-line by `lat` after travelling `along` is an
        # aiming error of atan2(lat, along), which is the correction to apply.
        best = None
        for px, py, _sp in path or []:
            dd = math.hypot(px - g.cup_x, py - g.cup_y)
            if best is None or dd < best[0]:
                best = (dd, px, py)
        if best is not None:
            ex, ey = best[1] - bx, best[2] - by
            along = ex * math.cos(aim) + ey * math.sin(aim)
            lat = -ex * math.sin(aim) + ey * math.cos(aim)
            if along > 20.0:
                bend = math.atan2(lat, along)
                bias = max(-BIAS_CAP, min(BIAS_CAP, bias - read * bend))
        bx, by = fx, fy
    return MAX_STROKES


def hole_expectation(g, rng, aim_sd, power_sd, dt, dts, trials, overshoot,
                     read):
    s = np.array([play_hole(g, rng, aim_sd, power_sd, dt, dts, overshoot, read)
                  for _ in range(trials)], float)
    return dict(mean=float(s.mean()), median=float(np.median(s)),
                ace_rate=float((s == 1).mean()),
                capped=int((s >= MAX_STROKES).sum()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("probe")
    ap.add_argument("--rounds", type=int, default=80)
    ap.add_argument("--trials", type=int, default=240)
    ap.add_argument("--aim-sd", type=float, default=6.0, help="degrees")
    ap.add_argument("--power-sd", type=float, default=0.07, help="fraction")
    ap.add_argument("--overshoot", type=float, default=1.15,
                    help="target roll as a multiple of the remaining distance")
    ap.add_argument("--read", type=float, default=0.7,
                    help="how much of the observed break the player believes")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--dt-source", choices=("probe", "fps"), default="probe")
    ap.add_argument("--fps", type=float, default=S.DEFAULT_FPS)
    ap.add_argument("--curve", action="store_true",
                    help="expected strokes vs aim-sd, to pick the anchor")
    ap.add_argument("--json")
    a = ap.parse_args()

    probe = json.load(open(a.probe))
    dt, dt_label = S.resolve_dt(probe, a.dt_source, a.fps)
    greens = [(r, build_green(probe, r)) for r in range(0, a.rounds + 1)]
    dts = probe.get("dt_roll_ms")
    dts = [v / 1000.0 for v in dts] if dts and a.dt_source == "probe" else None

    print(f"# dt={dt_label}  holes={len(greens)}  trials/hole={a.trials}  "
          f"seed={a.seed}")

    if a.curve:
        print("\naim_sd  median E[strokes]  mean E[strokes]  ace rate")
        for sd in (2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 13.0, 16.0):
            rng = np.random.default_rng(a.seed)
            means, aces = [], []
            for _, g in greens:
                r = hole_expectation(g, rng, sd, a.power_sd, dt, dts,
                                     max(40, a.trials // 4), a.overshoot, a.read)
                means.append(r["mean"])
                aces.append(r["ace_rate"])
            print(f"{sd:6.1f}  {np.median(means):16.2f}  {np.mean(means):15.2f}"
                  f"  {np.mean(aces):8.1%}")
        return 0

    rows = []
    for rnd, g in greens:
        rng = np.random.default_rng(a.seed + rnd)
        r = hole_expectation(g, rng, a.aim_sd, a.power_sd, dt, dts, a.trials,
                             a.overshoot, a.read)
        d = math.hypot(g.cup_x - g.ball0[0], g.cup_y - g.ball0[1])
        rows.append({"round": rnd, "dist": d, "exp": r["mean"],
                     "median": r["median"], "aceRate": r["ace_rate"],
                     "capped": r["capped"]})
        print(f"round {rnd:>3}  dist {d:6.1f}  E[strokes] {r['mean']:5.2f}  "
              f"median {r['median']:.0f}  ace {r['ace_rate']:5.1%}"
              + (f"  CAPPED x{r['capped']}" if r["capped"] else ""))

    e = np.array([r["exp"] for r in rows])
    print(f"\nE[strokes] over {len(rows)} holes: min {e.min():.2f}  "
          f"q25 {np.quantile(e, .25):.2f}  median {np.median(e):.2f}  "
          f"q75 {np.quantile(e, .75):.2f}  max {e.max():.2f}")
    capped = sum(r["capped"] for r in rows)
    print(f"trials that hit the {MAX_STROKES}-stroke cap: {capped} of "
          f"{len(rows) * a.trials} "
          f"({100.0 * capped / (len(rows) * a.trials):.2f}%) -- a cap that is "
          f"hit often would bias every mean DOWNWARD, so this number is the "
          f"one that says whether the model is usable")
    print(f"mean ace rate: {np.mean([r['aceRate'] for r in rows]):.1%}")

    if a.json:
        json.dump({"config": vars(a), "rows": rows}, open(a.json, "w"), indent=1)
        print(f"\n-> {a.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
