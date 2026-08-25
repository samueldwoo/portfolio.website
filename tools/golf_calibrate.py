"""Fit HeroCanvas's difficulty bands to the sweep's ground truth.

Emits the four numbers of `HOLE_CAL` and the three of `HOLE_CUTS`, ready to
paste into src/components/HeroCanvas.tsx.

Usage: golf_calibrate.py sweep.json [--bounds 0.45,1.0,2.0] [--emit]

WHY THIS FILE EXISTS AT ALL
    The bands were originally fitted by hand from a sweep and the numbers were
    then frozen in the component with no way to regenerate them. When the sweep's
    height field went stale (frequencies 1.25/2.9 against a real 0.85/2.0, fixed
    2026-08-25) the calibration silently became a description of a green nobody
    plays, and the shipped card over-reported difficulty for two days: 14 of 41
    holes read "Brutal" where the true hardest quartile is 10. A calibration you
    cannot re-run is a calibration you cannot check.

WHY THE BANDS ARE ANCHORED TO A SHARE OF THE AIM/POWER SPACE, NOT TO QUARTILES
    The first fit cut the composite at its own quartiles, which makes the bands
    RELATIVE: exactly a quarter of holes read "Brutal" no matter how hard the
    green actually is, and the word carries no information about the putt in
    front of you. It also means any change to the field silently redefines the
    labels.

    So the truth classes here are absolute: the fraction of the swept
    (aim x power) space that actually sinks. `hits` itself is grid-dependent --
    720 angles x 91 powers is 65520 putts, and a finer grid inflates the count --
    so the boundaries are expressed as PERCENTAGES of the grid, which are
    grid-independent to within sampling error. A hole where under 0.45% of all
    lines drop is hard in a way that does not depend on which other holes exist.

    The consequence is the one we want: make the green harder and more holes fall
    under 0.45% and legitimately read "Brutal" with no re-fit. Make it easier and
    the labels relax on their own. The rating stops being a ranking and becomes a
    measurement.

WHY THE RUNTIME STILL USES A z-SCORE
    The page cannot brute-force 65520 putts per hole at 60fps. It computes two
    cheap signals -- putt distance and mean up-slope along the line -- and sums
    their z-scores. This file's job is to pick the z thresholds that best
    reproduce the absolute classes above, and to REPORT that agreement honestly
    rather than assume the proxy is perfect. Spearman between the composite and
    `hits` is about -0.87, so it is good but not free.
"""
import argparse
import json

import numpy as np

BANDS = ["Gentle", "Fair", "Tricky", "Brutal"]


def truth_classes(hits, grid, bounds):
    """0..3 from the absolute share of the aim/power space that sinks."""
    pct = hits / grid * 100.0
    # bounds are ASCENDING difficulty boundaries in percent: (brutal, tricky, fair)
    b, t, f = bounds
    out = np.empty(len(pct), int)
    for i, p in enumerate(pct):
        out[i] = 3 if p < b else 2 if p < t else 1 if p < f else 0
    return out, pct


def fit_cuts_accuracy(z, truth):
    """Pick 3 thresholds on z that maximise per-hole agreement with `truth`.

    Fitted as three independent binary splits (class <= k vs > k) rather than by
    a joint search: the splits are what a threshold rule actually does, and doing
    it this way makes a non-monotonic outcome VISIBLE instead of hiding it inside
    a global optimum.

    NOT THE DEFAULT, and the reason is the whole point of the re-fit. Maximising
    accuracy leaves a systematic HARSH bias -- on 81 holes it mislabels 16 holes
    harder than they are against 8 softer -- because the composite is a weak
    proxy and the cuts drift toward the crowded middle of the distribution. The
    complaint that started this work was the card over-reporting difficulty, so a
    rule that is right more often while still skewing harsh does not fix it.
    Reported alongside the default for comparison.
    """
    cuts = []
    for k in range(3):
        want = truth > k                      # True => harder than band k
        zs = np.sort(z)
        best, best_c = -1, None
        cands = np.concatenate(([zs[0] - 1.0], (zs[:-1] + zs[1:]) / 2.0,
                                [zs[-1] + 1.0]))
        for c in cands:
            acc = int(((z > c) == want).sum())
            if acc > best:
                best, best_c = acc, float(c)
        cuts.append(best_c)
    return cuts


def fit_cuts_calibrated(z, truth):
    """Cuts that make the DISPLAYED mix of words match the true mix.

    Take the cumulative share of holes that truly belong in each band and cut z
    at those same quantiles. Per-hole errors remain -- the composite is only
    about -0.83 against the ground truth, so some holes will be one band off --
    but the errors stop leaning one way, which is the property being asked for:
    across a session the card says "Brutal" as often as a hole really is brutal,
    and no more.

    This is deliberately NOT the same as cutting at z's own quartiles, which is
    what the original calibration did. Quartiles force 25% into every band and
    would flatten exactly the leaning-hard distribution the tee sampler is
    designed to produce (0.55..1.00 of the reach budget, mean 0.775, "lean
    towards brutal usually"). Here the target proportions come from the absolute
    truth classes, so a green that really does deal 30% brutal holes gets a card
    that says so.
    """
    n = len(z)
    cuts = []
    cum = 0
    for k in range(3):
        cum += int((truth == k).sum())
        cuts.append(float(np.quantile(z, cum / n)))
    return cuts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sweep")
    ap.add_argument("--bounds", default="0.45,1.0,2.0",
                    help="percent-of-space boundaries: brutal,tricky,fair")
    ap.add_argument("--emit", action="store_true",
                    help="print the two TS lines and nothing else")
    a = ap.parse_args()

    d = json.load(open(a.sweep))
    rows, cfg = d["rows"], d["config"]
    grid = (360.0 / cfg["astep"]) * ((1.0 - cfg["pmin"]) / cfg["pstep"] + 1.0)

    dist = np.array([r["dist"] for r in rows], float)
    up = np.array([r["upAcc"] for r in rows], float)
    hits = np.array([r["hits"] for r in rows], float)

    bounds = tuple(float(x) for x in a.bounds.split(","))
    truth, pct = truth_classes(hits, grid, bounds)

    cal = dict(dMean=dist.mean(), dSd=dist.std(ddof=1),
               uMean=up.mean(), uSd=up.std(ddof=1))
    zd = (dist - cal["dMean"]) / cal["dSd"]
    zu = (up - cal["uMean"]) / cal["uSd"]

    def spearman(x, y):
        rx = np.argsort(np.argsort(x)).astype(float)
        ry = np.argsort(np.argsort(y)).astype(float)
        return float(np.corrcoef(rx, ry)[0, 1])

    # UP-SLOPE WEIGHT. A plain z(d) + z(up) sum assumes the two signals are
    # equally informative. They are not: against `hits`, distance ranks -0.27 and
    # mean up-slope -0.78, so an equal sum spends half its weight on the weaker
    # half. The shipped constants got a better composite than an honest equal sum
    # does (-0.867 vs -0.799) purely BY ACCIDENT -- their uSd was fitted on a
    # steeper green, which over-weighted up-slope, which happened to be the right
    # direction for the wrong reason. Fit the weight on purpose instead.
    grid_w = np.concatenate([np.arange(0.25, 8.001, 0.05)])
    scores = [spearman(zd + w * zu, hits) for w in grid_w]
    W = float(grid_w[int(np.argmin(scores))])   # most NEGATIVE rho is best
    cal["uW"] = W
    z = zd + W * zu
    cuts = fit_cuts_calibrated(z, truth)
    cuts_acc = fit_cuts_accuracy(z, truth)

    ts_cal = (f"    const HOLE_CAL = {{ dMean: {cal['dMean']:.1f}, "
              f"dSd: {cal['dSd']:.1f}, uMean: {cal['uMean']:.1f}, "
              f"uSd: {cal['uSd']:.1f}, uW: {cal['uW']:.2f} }};")
    ts_cuts = ("    const HOLE_CUTS = ["
               + ", ".join(f"{c:.3f}" for c in cuts) + "];")
    if a.emit:
        print(ts_cal)
        print(ts_cuts)
        return 0

    pred = np.array([3 if v > cuts[2] else 2 if v > cuts[1]
                     else 1 if v > cuts[0] else 0 for v in z])

    print(f"holes {len(rows)}  grid {grid:.0f} putts/round  "
          f"viewport {d.get('config', {}).get('probe', '?')}")
    print(f"bounds: Brutal <{bounds[0]}%  Tricky <{bounds[1]}%  "
          f"Fair <{bounds[2]}%  Gentle >={bounds[2]}% of the aim/power space")
    print()
    print(f"signal correlations vs hits (Spearman):")
    print(f"  distance       {spearman(dist, hits):+.3f}")
    print(f"  mean up-slope  {spearman(up, hits):+.3f}")
    print(f"  composite z    {spearman(z, hits):+.3f}")
    print()
    print("band          truth   fitted   median hits   median %space")
    for i, name in enumerate(BANDS):
        ti = int((truth == i).sum())
        pi = int((pred == i).sum())
        sub = hits[pred == i]
        med = f"{np.median(sub):11.0f}" if len(sub) else "          -"
        medp = f"{np.median(pct[pred == i]):8.2f}%" if len(sub) else "        -"
        print(f"  {name:<10} {ti:>5}   {pi:>6}   {med}   {medp}")
    agree = int((pred == truth).sum())
    print(f"\nagreement with absolute truth: {agree}/{len(rows)} = "
          f"{100.0 * agree / len(rows):.1f}%")
    off = pred - truth
    print(f"  off by one band: {int((abs(off) == 1).sum())}   "
          f"off by two or more: {int((abs(off) >= 2).sum())}")
    print(f"  fitted labels HARSHER than truth: {int((off > 0).sum())}   "
          f"softer: {int((off < 0).sum())}")
    mono = [float(np.median(hits[pred == i])) for i in range(4)
            if (pred == i).any()]
    print(f"  median hits per band descending (must be monotonic): "
          f"{'OK' if all(x > y for x, y in zip(mono, mono[1:])) else 'NOT MONOTONIC'}"
          f"  {[round(x) for x in mono]}")

    pa = np.array([3 if v > cuts_acc[2] else 2 if v > cuts_acc[1]
                   else 1 if v > cuts_acc[0] else 0 for v in z])
    oa = pa - truth
    print(f"\nfor comparison, accuracy-maximising cuts "
          f"[{', '.join(f'{c:.3f}' for c in cuts_acc)}]:")
    print(f"  agreement {int((pa == truth).sum())}/{len(rows)} = "
          f"{100.0 * int((pa == truth).sum()) / len(rows):.1f}%  "
          f"but harsher {int((oa > 0).sum())} vs softer {int((oa < 0).sum())}"
          f"  -- rejected, see fit_cuts_accuracy's docstring")
    print()
    print("paste into src/components/HeroCanvas.tsx:")
    print(ts_cal)
    print(ts_cuts)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
