"""Search the player model's skill parameters for the ones that make par DISCRIMINATE.

THE PROBLEM THIS EXISTS FOR. Par is the median stroke count of a bounded-skill
player, and at the shipped parameters 72 of 81 holes come out par 2. A flat par-2
table would be right on 72 and the real one on 81, so par carries only 9 holes of
signal and is close to decoration. More spread is wanted.

WHY NOT JUST MAKE THE PLAYER WORSE. Because the two-putt anchor is what stops
aim_sd and power_sd being arbitrary. Without it par means "whatever skill level
somebody picked", and a worse player raises par EVERYWHERE — a real human then beats
it on most holes and Score runs permanently negative, which is worse than flat par.

So the anchor is kept as a CONSTRAINT and spread is the OBJECTIVE:

    maximise spread across holes, subject to the median hole still playing to par 2

That is well posed, and it leaves real room, because the anchor pins the median
across holes rather than each hole individually. The expectation going in is that
`read` matters more than `aim_sd`: a player who only half-believes the break does
fine on flat holes and badly on breaking ones, which DIFFERENTIATES holes, whereas
aim noise penalises all of them about equally.

FOUR SINGLE-FACTOR MODEL CHANGES WERE TRIED FIRST AND ALL FOUR LOST — a lay-up, two
pace-learning variants, and a roll-time correction (see the notes in golf_par.py).
They share a cause: the model's parameters were fitted jointly against the anchor, so
bolting one term on breaks the balance rather than improving it. This searches the
parameter set instead of adding to the model, and it judges on a measured objective
rather than on whether the reasoning sounds right.

    # one slice per worker; the combos are independent so this parallelises freely
    for i in 0 1 2 3 4 5; do
      $PY tools/golf_tune.py probe80.json --slice $i/6 \
          --json ~/.pf-verify/tune_$i.json &
    done

Then `--report` over the shards to rank them.
"""
import argparse
import glob
import json
import math
import statistics

import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])   # runnable from any cwd
import golf_par as P    # noqa: E402  — reuses the model, never a fourth copy of it
import golf_sim as S    # noqa: E402

# HOLES: every third round, minus the two whose par is set by hand. Those two are
# not model-derived, so including them would score the search on numbers it cannot
# move. It also excludes the deadlock-heavy holes (4, 25, 59 are not multiples of 3
# either), which is what makes a 36-combo grid affordable at all -- a stuck trial
# runs to the cap and costs ~20x a normal one.
DEFAULT_HOLES = [r for r in range(0, 81, 3) if r not in (7, 78)]

AIM_SD = (4.0, 6.0, 8.0, 10.0)
POWER_SD = (0.05, 0.07, 0.10)
READ = (0.4, 0.7, 0.9)


def grid():
    out = []
    for a in AIM_SD:
        for p in POWER_SD:
            for r in READ:
                out.append({"aim_sd": a, "power_sd": p, "read": r})
    return out


def score(pars, medians):
    """Spread statistics. `n_off2` is the headline: holes carrying any signal.

    sd and the distinct count are reported alongside because they disagree usefully
    -- a table of 2s and one 9 has a large sd and almost no signal, and n_off2 alone
    cannot tell a 1/2/3 spread from a 2/3 one.
    """
    n = len(pars)
    return {
        "median_par": statistics.median(pars),
        "mean_par": sum(pars) / n,
        "n_off2": sum(1 for p in pars if p != 2),
        "frac_off2": sum(1 for p in pars if p != 2) / n,
        "distinct": len(set(pars)),
        "sd_par": statistics.pstdev(pars) if n > 1 else 0.0,
        "sd_median": statistics.pstdev(medians) if n > 1 else 0.0,
        "hist": {str(p): pars.count(p) for p in sorted(set(pars))},
    }


def run_combo(probe, holes, combo, trials, max_strokes, dt, dts, overshoot, seed):
    pars, medians, stuck = [], [], 0
    for rnd in holes:
        g = P.build_green(probe, rnd)
        rng = np.random.default_rng(seed + rnd)
        r = P.hole_expectation(g, rng, combo["aim_sd"], combo["power_sd"], dt, dts,
                               trials, overshoot, combo["read"], max_strokes)
        pars.append(int(math.ceil(r["median"])))
        medians.append(r["median"])
        stuck += r["capped"]
    out = dict(combo)
    out.update(score(pars, medians))
    out["stuck_frac"] = stuck / (len(holes) * trials)
    out["pars"] = pars
    return out


def report(paths):
    rows = []
    for p in paths:
        rows += json.load(open(p))["rows"]
    if not rows:
        print("no rows found")
        return 1
    ok = [r for r in rows if r["median_par"] == 2]
    print(f"{len(rows)} combos, {len(ok)} hold the two-putt anchor "
          f"(median par == 2)\n")
    print(f"{'aim':>5} {'pwr':>5} {'read':>5} {'medPar':>7} {'off2':>6} "
          f"{'distinct':>9} {'sd':>6} {'stuck':>7}")
    for r in sorted(ok, key=lambda r: (-r["n_off2"], -r["distinct"])):
        print(f"{r['aim_sd']:>5.1f} {r['power_sd']:>5.2f} {r['read']:>5.1f} "
              f"{r['median_par']:>7.1f} {r['n_off2']:>3}/{len(r['pars']):<2} "
              f"{r['distinct']:>9} {r['sd_par']:>6.2f} {r['stuck_frac']:>6.1%}")
    if not ok:
        print("  (none — the anchor is not reachable on this grid; widen it)")
        return 0
    best = max(ok, key=lambda r: (r["n_off2"], r["distinct"]))
    cur = [r for r in ok if r["aim_sd"] == 6.0 and r["power_sd"] == 0.07
           and r["read"] == 0.7]
    print(f"\nBEST held-anchor combo: aim_sd {best['aim_sd']:g} "
          f"power_sd {best['power_sd']:g} read {best['read']:g} "
          f"-> {best['n_off2']}/{len(best['pars'])} holes off par 2, "
          f"{best['distinct']} distinct pars, hist {best['hist']}")
    if cur:
        c = cur[0]
        print(f"SHIPPED combo (6 / 0.07 / 0.7):        "
              f"-> {c['n_off2']}/{len(c['pars'])} off par 2, "
              f"{c['distinct']} distinct, hist {c['hist']}")
        if best["n_off2"] <= c["n_off2"]:
            print("\nNo combo beats the shipped one on spread while holding the "
                  "anchor. Report that rather than shipping a tie.")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("probe", nargs="?")
    ap.add_argument("--holes", default="")
    ap.add_argument("--trials", type=int, default=200)
    ap.add_argument("--max-strokes", type=int, default=32)
    ap.add_argument("--overshoot", type=float, default=1.15)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--slice", default="0/1", help="i/n — this worker's share")
    ap.add_argument("--dt-source", choices=("probe", "fps"), default="fps")
    ap.add_argument("--fps", type=float, default=S.DEFAULT_FPS)
    ap.add_argument("--json")
    ap.add_argument("--report", nargs="*", help="rank finished shards and exit")
    a = ap.parse_args()

    if a.report is not None:
        paths = a.report or sorted(glob.glob(
            "/Users/qsamwo/.pf-verify/tune_*.json"))
        return report(paths)

    probe = json.load(open(a.probe))
    # FIXED FPS BY DEFAULT here, unlike the rest of the chain: this is a comparison
    # between parameter sets, and the probe's measured per-frame dt would add a
    # systematic offset shared by every combo but not reproducible across runs.
    dt, dt_label = S.resolve_dt(probe, a.dt_source, a.fps)
    dts = ([v / 1000.0 for v in probe["dt_roll_ms"]]
           if a.dt_source == "probe" and probe.get("dt_roll_ms") else None)
    holes = ([int(x) for x in a.holes.split(",") if x.strip()] if a.holes
             else DEFAULT_HOLES)
    i, n = (int(x) for x in a.slice.split("/"))
    combos = [c for j, c in enumerate(grid()) if j % n == i]

    print(f"# dt={dt_label}  holes={len(holes)}  trials={a.trials}  "
          f"cap={a.max_strokes}  slice {i}/{n} -> {len(combos)} combos", flush=True)
    rows = []
    for c in combos:
        r = run_combo(probe, holes, c, a.trials, a.max_strokes, dt, dts,
                      a.overshoot, a.seed)
        rows.append(r)
        print(f"aim {c['aim_sd']:>4.1f} pwr {c['power_sd']:.2f} read {c['read']:.1f}"
              f"  medPar {r['median_par']:.1f}  off2 {r['n_off2']:>2}/{len(holes)}"
              f"  distinct {r['distinct']}  stuck {r['stuck_frac']:.1%}",
              flush=True)
        if a.json:
            json.dump({"config": vars(a), "holes": holes, "rows": rows},
                      open(a.json, "w"), indent=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
