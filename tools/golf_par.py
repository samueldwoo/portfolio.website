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

THE PLAYER MODEL: reads the green competently, then misses by a skill error
    Each stroke the player reads BOTH things a putt needs, then executes
    imperfectly:
      - LINE. Samples the slope across the line at five fractions, works out the
        drift it will cause, and aims that far the other way. This is the same
        five-sample integral the shipped reachToward() trusts, used for aim.
      - PACE. Divides the target roll by reach_toward(), which is how far a
        full-power putt actually travels here, so an uphill putt is hit harder.
      - Then aim is perturbed by a Gaussian in degrees and power by a
        multiplicative Gaussian, and whatever the last putt taught is carried as
        a small residual correction.

    Reading the green is legitimate and is the whole point: the contour lines
    exist to be read, so par should be what a competent reader scores, and
    beating par means reading it better. What is NOT legitimate is evaluating
    candidate putts — the model never asks the simulator whether a line works, it
    only uses slope the way a player uses their eyes.

    THREE MODEL BUGS PRODUCED PLAUSIBLE NUMBERS THAT WERE REALLY THE STROKE CAP,
    so distrust any version of this whose cap rate is not near zero:
      1. aiming to STOP at the cup deadlocks — a ball dying at the hole falls
         short on any error and the next putt is shorter. 48.7% never holed out.
         Fixed by --overshoot.
      2. learning break from the FINAL resting position conflates break with
         everything after the ball passes the cup. `bias` slammed to its cap and
         sprayed putts 80-210px wide. Fixed by measuring at closest approach.
      3. taking pace from the FLAT roll formula left every uphill putt short. On
         round 7 the sinking band is 0.890..1.000 and the flat formula asked for
         0.775 — 2.1 sd below it — so the hole read as unholeable when the line
         that sinks it is 0.4deg off straight. This one nearly shipped a false
         conclusion that the GAME was broken. Fixed by dividing by reach_toward.

    Still not modelled, and it pushes par UP, so par here is a slightly generous
    baseline: lag putting. A real player leaves a long putt short on purpose
    rather than risk running past; this one always tries to hole out.

CALIBRATING THE SKILL, RATHER THAN GUESSING IT
    aim-sd and power-sd are free parameters and picking them by feel would make
    par arbitrary. Anchor instead on the convention every golfer already knows: a
    green is a TWO-PUTT. At the defaults the median hole plays to 2.02 expected
    strokes with a 0.31% cap rate, which is that convention reproduced rather than
    imposed. Use --curve to re-audit the anchor if the field ever changes.
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

# A LAY-UP WAS TRIED AND MEASURED WORSE. DO NOT REBUILD IT WITHOUT READING THIS.
#
# The model has one plan -- aim at the cup -- and power is clipped at 1.0, so on a
# steep uphill lie it hits short, lands in much the same place, and repeats. About a
# third of trials on rounds 4, 7 and 78 never hole out, which is why par on those
# three is not a measurement (see the note on hole_expectation).
#
# The obvious fix is to let it putt sideways to a flatter spot and hole out from
# there. Implemented 2026-08-26: sample 12 directions x 3 distances, keep spots from
# which reach_toward covers the cup, aim at the best one. Three iterations, two of
# which fixed real bugs found by measurement:
#   - triggering on dist*overshoot/reach > 1.0 ("cannot roll PAST the cup") fires in
#     ordinary playable positions, so it laid up instead of holing out: round 7's
#     ace rate collapsed 26.6% -> 2.0%, stuck share 24% -> 86%.
#   - aiming to STOP at the lay-up spot re-created the dying-short deadlock this
#     file already documents: a lay-up is chosen because the lie is uphill, so a
#     putt that dies short rolls back. Stuck share 86% -> 66%.
# With both fixed it STILL lost to not laying up at all:
#     stuck share      no lay-up      with lay-up
#     round 4             21%             29%
#     round 7             24%             31%
#     round 78            38%             33%
# Best remaining guess at why: candidates are ranked by reachability margin, which
# can select a spot far across the green and burn strokes getting there; nearest-
# adequate was never tested. Reverted rather than left in, because a player model
# that plays worse is not an improvement, and dead code invites a silent revival.
#
# Par on rounds 7 and 78 is instead set by hand for a human player -- see PAR_TABLE
# in HeroCanvas.tsx. That is a deliberate choice about what to show a person, not a
# claim about this simulator.


def play_hole(g, rng, aim_sd, power_sd, dt, dts, overshoot, read,
              max_strokes=MAX_STROKES):
    """One full hole. Returns strokes taken (max_strokes if it never drops)."""
    flat_run = g.max_speed / -math.log(g.friction)
    bx, by = g.ball0
    bias = 0.0
    for stroke in range(1, max_strokes + 1):
        dx, dy = g.cup_x - bx, g.cup_y - by
        dist = math.hypot(dx, dy) or 1.0
        # READ THE GREEN, THEN MISS BY A SKILL ERROR.
        #
        # Aiming straight at the cup and correcting afterwards does not work, and
        # the evidence was unambiguous: round 15 has a 38.5deg sinking window,
        # which 6deg of aim noise should find on the first putt, and the
        # straight-aiming player stranded on it 53 times in 60. Window size barely
        # predicted stranding at all (Spearman -0.23), which is the signature of a
        # broken policy rather than a hard hole. One correction per stroke cannot
        # cover a green whose line sits well off the direct path.
        #
        # So the player reads the break the way the contour lines exist to be
        # read: sample the slope along the line, take the component ACROSS it, and
        # allow for the drift it will cause. This is not the simulator solving the
        # hole for itself -- it never evaluates a candidate putt -- it is the same
        # five-sample slope integral the shipped reachToward() already trusts,
        # used for aim instead of for reach.
        #
        # Roll time comes out near-constant, which is why a single estimate works:
        # power is chosen as dist*overshoot/flat_run, so v0 scales WITH distance
        # and t ~ 2*dist/v0 ~ 2/(overshoot*k) regardless of how long the putt is.
        ux, uy = dx / dist, dy / dist
        rx, ry = -uy, ux                      # across the line
        a_lat = 0.0
        for f in (0.15, 0.35, 0.55, 0.75, 0.95):
            gx, gy = g.slope_at(bx + ux * dist * f, by + uy * dist * f)
            a_lat += gx * rx + gy * ry
        a_lat /= 5.0
        k = -math.log(g.friction)
        t_roll = 2.0 / (overshoot * k)
        drift = 0.5 * a_lat * t_roll * t_roll
        # Aim OPPOSITE the drift, by `read` of it, plus whatever the last putt
        # taught. `bias` stays as a smaller second-order term: with a real prior
        # the residual it has to explain is small, which is also what stops it
        # saturating the way it did when it was the only correction.
        aim = math.atan2(dy, dx) - read * math.atan2(drift, dist) + bias
        ang = aim + math.radians(rng.normal(0.0, aim_sd))
        # NEVER UP, NEVER IN. The first version of this aimed to STOP at the cup
        # (power = dist / flat_run) and it deadlocked: a ball dying at the hole
        # stops short of the cup radius on any error at all, the next putt is
        # shorter, and 48.7% of trials never holed out inside 8 strokes. Real
        # putters roll it past on purpose for exactly this reason, so the target
        # roll is `overshoot` x the remaining distance. This single factor is the
        # difference between a usable model and one whose every mean is really
        # just the stroke cap.
        # PACE MUST ANSWER THE SLOPE, NOT JUST THE DISTANCE.
        #
        # This used to be dist*overshoot/flat_run, the FLAT requirement, and it is
        # what made rounds 4 and 7 look unholeable. Measured on round 7: the
        # sinking power band is 0.890..1.000 and the flat formula asks for 0.775,
        # which is 2.1 standard deviations BELOW the band, so the player could
        # never generate enough pace no matter how well it aimed. And it aimed
        # essentially perfectly — the line that sinks there is 0.4deg off straight
        # at the cup. 0 aces in 480 putts came entirely from being too weak uphill.
        #
        # The honest reading: an uphill putt needs more pace, which every golfer
        # knows and this model did not. reach_toward() already integrates the
        # up-slope over the line and returns how far a FULL-power putt actually
        # travels, so dividing by that instead of by the flat run is both the
        # smaller change and the physically correct one. On round 7 it asks for
        # 1.03, clipped to 1.0, which lands inside the band.
        reach = g.reach_toward(bx, by) or flat_run
        want = dist * overshoot / reach
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
                bias = max(-BIAS_CAP, min(BIAS_CAP, bias - 0.25 * read * bend))
        bx, by = fx, fy
    return max_strokes


def hole_expectation(g, rng, aim_sd, power_sd, dt, dts, trials, overshoot,
                     read, max_strokes=MAX_STROKES):
    s = np.array([play_hole(g, rng, aim_sd, power_sd, dt, dts, overshoot, read,
                            max_strokes)
                  for _ in range(trials)], float)
    # SD AND SE ARE REPORTED BECAUSE PAR IS A ROUNDING OF THIS MEAN, so the only
    # thing that decides a displayed par is whether the mean sits clear of a .5
    # boundary. Quoting the mean alone hid that: the shipped table tie-broke four
    # holes to the harder par by hand, with nothing in the output saying which
    # holes were close enough to need it.
    sd = float(s.std(ddof=1)) if trials > 1 else 0.0
    # PAR IS THE MEDIAN, AND THE HISTOGRAM IS KEPT BECAUSE THE MEAN LIED.
    #
    # On rounds 4, 7 and 78 the player model has no lay-up: it always aims at the
    # cup, power is hard-clipped at 1.0, so a lie needing a deliberate sideways
    # putt to escape traps it forever. Those trials record `max_strokes`, which
    # makes the mean a function of the CAP rather than of the golf -- round 78
    # read 3.98 at cap 8, 17.07 at cap 48 and 77.75 at cap 200 while its MEDIAN
    # stayed 2. The median is unaffected as long as fewer than half the trials are
    # stuck, so it is what par is taken from now.
    #
    # The histogram is returned so that claim is checkable rather than asserted:
    # it is what `emit_table` uses to ask whether the 50th percentile sits clear
    # of a stroke boundary, which is the median's version of "is this par settled".
    hist = {int(v): int(c) for v, c in zip(*np.unique(s, return_counts=True))}
    return dict(mean=float(s.mean()), median=float(np.median(s)),
                sd=sd, se=sd / math.sqrt(trials) if trials else 0.0,
                ace_rate=float((s == 1).mean()),
                capped=int((s >= max_strokes).sum()), hist=hist)


def par_from_median(r):
    """Par for one hole: the median stroke count, ties resolved to the harder par.

    A median over integers is already an integer unless the sample size is even
    and the 50th percentile falls between two values, so the .5 tie-break the
    mean needed is nearly always moot here. Where it does land on x.5 it goes UP,
    which is the same conservative direction the hand-built table used.
    """
    return int(math.ceil(r["median"]))


def median_settled(r, trials):
    """Is this hole's median clear of the stroke boundary that decided it?

    The median's failure mode is not noise around a .5 boundary, it is the
    cumulative distribution crossing 0.5 right at a stroke value: if 49.5% of
    trials two-putt, par is 3, and a different seed makes it 2. So the question is
    how far P(strokes <= par-1) sits from 0.5, measured against the binomial
    standard error sqrt(0.25/n) -- the same "+-2 SE" idea the mean used, applied
    to the quantity that actually decides a median.
    """
    par = par_from_median(r)
    n = max(1, trials)
    below = sum(c for v, c in r["hist"].items() if v <= par - 1) / n
    at_or_below = sum(c for v, c in r["hist"].items() if v <= par) / n
    se = math.sqrt(0.25 / n)
    margin = min(abs(below - 0.5), abs(at_or_below - 0.5))
    return margin >= 2 * se, below, at_or_below, margin, se


def emit_table(rows, a):
    """The 81-char PAR_TABLE, from the MEDIAN, plus every hole it cannot settle.

    WHY THIS LIVES IN THE TOOL AND NOT IN A HEAD. The shipped table was
    hand-assembled from this script's printed means, and four holes were
    hand-nudged to the harder par because their mean sat a hair under a .5
    boundary. Both steps were invisible afterwards: nothing said which cap
    produced the table, and nothing said which pars were judgement rather than
    arithmetic. A calibration you cannot re-run is one you cannot check.

    WHY THE MEDIAN AND NOT THE MEAN. See hole_expectation: on three holes the
    model has no recovery move and a third of its trials never hole out, so the
    mean is the stroke cap wearing a decimal point. The median ignores that tail
    for as long as the tail is under half the sample, which it is at cap 48.

    Nothing here is auto-resolved. An unsettled hole and a par too large for the
    component's one-character encoding are both REPORTED, never silently rounded
    or clamped, because a table that quietly invents a plausible number is the
    exact failure this emitter was written to stop.
    """
    e = {r["round"]: r for r in rows}
    # A PARTIAL RUN MUST NOT EMIT A TABLE. Unmeasured rounds would have to be
    # filled with the component's fallback 2, and an 81-char string that is
    # mostly invented is indistinguishable from one that is measured -- which is
    # the failure this emitter exists to prevent. Refuse instead.
    missing = [i for i in range(81) if i not in e]
    if missing:
        print(f"\nPAR_TABLE not emitted: {len(missing)} of 81 rounds were not "
              f"measured in this run (first missing: {missing[0]}).\n"
              f"  Re-run without --only, at --rounds 80, to emit a table.")
        return None
    pars, unsettled, unencodable, degenerate = [], [], [], []
    for i in range(81):
        r = e[i]
        par = par_from_median(r)
        pars.append(par)
        ok, below, at_or_below, margin, se = median_settled(r, a.trials)
        if not ok:
            unsettled.append((i, par, r["median"], below, at_or_below, margin, se))
        if par > 9:
            unencodable.append((i, par, r["capped"]))
        # A MEDIAN AT THE CAP IS NOT A MEDIAN. It means over half the trials never
        # holed out, so the number is the ceiling and would move if the ceiling
        # did -- which is what pinned round 7 to 8 at cap 8 and to 13 at cap 48.
        if r["median"] >= a.max_strokes:
            degenerate.append((i, r["median"], r["capped"]))

    t = "".join(str(p) if p <= 9 else "?" for p in pars)
    print(f"\nPAR_TABLE (from the MEDIAN, cap {a.max_strokes}, "
          f"{a.trials} trials):\n  '{t}'")
    counts = {p: pars.count(p) for p in sorted(set(pars))}
    print(f"  len {len(t)}  " + "  ".join(f"par{p}x{c}"
                                          for p, c in counts.items()))

    if degenerate:
        print(f"\n  {len(degenerate)} hole(s) whose MEDIAN IS AT THE CAP -- over "
              f"half the trials never holed out, so this par is the ceiling and "
              f"not a measurement. Raise --max-strokes and re-run.")
        for i, med, cap in degenerate:
            print(f"    round {i:>3}  median {med:.1f} >= cap "
                  f"{a.max_strokes}  (CAPPED x{cap})")

    if unencodable:
        print(f"\n  {len(unencodable)} hole(s) CANNOT BE ENCODED. PAR_TABLE is one "
              f"character per hole and the component reads it as "
              f"`charCodeAt(round) - 48`, so par must be 1..9. These are '?' "
              f"above and need a decision, not a clamp to 9.")
        for i, par, cap in unencodable:
            print(f"    round {i:>3}  median par {par}"
                  + (f"  (CAPPED x{cap})" if cap else ""))

    if unsettled:
        print(f"\n  {len(unsettled)} hole(s) NOT settled by the measurement: the "
              f"share of trials below the par is within 2 SE of 50%, so a "
              f"different seed could move the par by one.")
        for i, par, med, below, aob, margin, se in unsettled:
            print(f"    round {i:>3}  par {par}  median {med:.1f}  "
                  f"P(<=par-1)={below:.3f}  P(<=par)={aob:.3f}  "
                  f"margin {margin:.4f} vs 2SE {2 * se:.4f}")
    else:
        print("\n  every par's median is clear of its stroke boundary at 2 SE")

    capped_holes = {r["round"]: r["capped"] for r in rows if r["capped"]}
    if capped_holes:
        print(f"\n  holes with stuck trials (median still valid while under half "
              f"the sample): {capped_holes}")
        worst = max(capped_holes.items(), key=lambda kv: kv[1])
        frac = worst[1] / max(1, a.trials)
        print(f"  worst is round {worst[0]} at {frac:.1%} stuck"
              + ("  -- OVER HALF, its median is not trustworthy"
                 if frac >= 0.5 else "  -- under half, medians hold"))
    return t


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
    # THE CAP IS A FLAG BECAUSE THREE HOLES' PAR WAS ONLY EVER A LOWER BOUND.
    # At 8, rounds 7/78/4 capped 1076/757/507 of 2000 trials, so their means were
    # really the ceiling. Editing the constant to re-measure left no record of
    # which cap produced a table; a flag lands in the JSON's config block.
    ap.add_argument("--max-strokes", type=int, default=MAX_STROKES)
    ap.add_argument("--only", default="",
                    help="comma-separated rounds to measure instead of 0..N, "
                         "for sizing the cap on the holes that hit it")
    ap.add_argument("--table", action="store_true",
                    help="emit the 81-char PAR_TABLE string and the straddle "
                         "list, so the last mile is not hand-assembled")
    ap.add_argument("--dt-source", choices=("probe", "fps"), default="probe")
    ap.add_argument("--fps", type=float, default=S.DEFAULT_FPS)
    ap.add_argument("--curve", action="store_true",
                    help="expected strokes vs aim-sd, to pick the anchor")
    ap.add_argument("--json")
    a = ap.parse_args()

    probe = json.load(open(a.probe))
    dt, dt_label = S.resolve_dt(probe, a.dt_source, a.fps)
    want = ([int(x) for x in a.only.split(",") if x.strip()] if a.only
            else list(range(0, a.rounds + 1)))
    greens = [(r, build_green(probe, r)) for r in want]
    dts = probe.get("dt_roll_ms")
    dts = [v / 1000.0 for v in dts] if dts and a.dt_source == "probe" else None

    print(f"# dt={dt_label}  holes={len(greens)}  trials/hole={a.trials}  "
          f"seed={a.seed}  cap={a.max_strokes}")

    if a.curve:
        print("\naim_sd  median E[strokes]  mean E[strokes]  ace rate")
        for sd in (2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 13.0, 16.0):
            rng = np.random.default_rng(a.seed)
            means, aces = [], []
            for _, g in greens:
                r = hole_expectation(g, rng, sd, a.power_sd, dt, dts,
                                     max(40, a.trials // 4), a.overshoot,
                                     a.read, a.max_strokes)
                means.append(r["mean"])
                aces.append(r["ace_rate"])
            print(f"{sd:6.1f}  {np.median(means):16.2f}  {np.mean(means):15.2f}"
                  f"  {np.mean(aces):8.1%}")
        return 0

    rows = []
    for rnd, g in greens:
        rng = np.random.default_rng(a.seed + rnd)
        r = hole_expectation(g, rng, a.aim_sd, a.power_sd, dt, dts, a.trials,
                             a.overshoot, a.read, a.max_strokes)
        d = math.hypot(g.cup_x - g.ball0[0], g.cup_y - g.ball0[1])
        rows.append({"round": rnd, "dist": d, "exp": r["mean"],
                     "median": r["median"], "sd": r["sd"], "se": r["se"],
                     "aceRate": r["ace_rate"], "capped": r["capped"],
                     "hist": r["hist"]})
        # PAR FIRST, because par is what ships. The mean is kept beside it as the
        # diagnostic it now is: where the two disagree wildly the hole has stuck
        # trials, and that is worth seeing on the same line rather than inferring.
        print(f"round {rnd:>3}  dist {d:6.1f}  par {par_from_median(r):>2}  "
              f"median {r['median']:5.1f}  mean {r['mean']:6.2f}  "
              f"ace {r['ace_rate']:5.1%}"
              + (f"  STUCK x{r['capped']}" if r["capped"] else ""))

    e = np.array([r["exp"] for r in rows])
    print(f"\nE[strokes] over {len(rows)} holes: min {e.min():.2f}  "
          f"q25 {np.quantile(e, .25):.2f}  median {np.median(e):.2f}  "
          f"q75 {np.quantile(e, .75):.2f}  max {e.max():.2f}")
    capped = sum(r["capped"] for r in rows)
    print(f"trials that hit the {a.max_strokes}-stroke cap: {capped} of "
          f"{len(rows) * a.trials} "
          f"({100.0 * capped / (len(rows) * a.trials):.2f}%) -- a cap that is "
          f"hit often would bias every mean DOWNWARD, so this number is the "
          f"one that says whether the model is usable")
    print(f"mean ace rate: {np.mean([r['aceRate'] for r in rows]):.1%}")

    if a.table:
        emit_table(rows, a)

    if a.json:
        json.dump({"config": vars(a), "rows": rows}, open(a.json, "w"), indent=1)
        print(f"\n-> {a.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
