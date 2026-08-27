"""TERMINAL-LIE INVARIANT: from every lie the tee can leave you in, is the cup
still reachable?

Usage: golf_lies.py probe.json [--rounds 80] [--only 4,7,78] [--cell 24]
                              [--chunk 16] [--json out.json]
                              [--dt-source probe|fps]

Exit 0 = no terminal lie found. Exit 1 = at least one, with the lie printed.

WHY THIS EXISTS, AND WHY IT IS NOT THE SOLVABILITY SWEEP
    golf_sweep.py asks "does at least one (aim, power) pair sink FROM THE TEE" and
    answers 81/81. That says nothing about the second stroke. A hole can be
    perfectly solvable from the tee and still contain a lie -- reachable by an
    ordinary bad putt -- from which no putt can ever hole out. Nothing in this
    directory tested that, and one such lie would be a soft-lock a player could
    reach without doing anything unusual.

    golf_stuck.py is also not this: it drives a browser from five hand-picked lies
    and asks whether the BALL settles. This asks, deterministically and over the
    whole grid, whether the CUP is still winnable.

    It is a player-model-free invariant, which is the point. golf_par.py's answer
    to a trap lie depends on aim_sd, read and overshoot; this one does not depend
    on anything but the physics.

WHY IT IS STAGED, AND WHAT THE STAGES CANNOT DO
    The honest version of this question is expensive: hundreds of reachable lies
    per hole x 65520 putts each. So a lie is tested at a MID grid first (90 angles
    x 19 powers) and only escalated to the full 720 x 91 grid if that found
    nothing.

    THE ESCALATION IS SOUND IN ONE DIRECTION ONLY, which is the direction that
    matters. A sink found at a coarse resolution is a real simulated sink, so
    "LIVE" is never wrong. A coarse miss proves nothing, which is exactly why it
    escalates rather than reports. So this tool can waste time; it cannot invent a
    terminal lie out of grid resolution. The reverse arrangement -- trusting a
    coarse miss -- is the bug this ordering exists to avoid.

WHY IT BATCHES, AND WHY THE FIRST VERSION OF THIS FILE WAS UNUSABLE
    A sweep costs ~1.2s before it looks at a single candidate, because the frame
    loop runs a fixed ~844 iterations whatever N is: 300 putts measured 1.23s and
    65520 measured 15.4s. One sweep per lie is therefore ~11 hours of pure Python
    overhead across 81 holes, and the first version of this file duly failed to
    finish ONE hole in ten minutes.

    So every lie on a hole goes through `sweep(..., starts=(xs, ys))` in a single
    call. That parameter was added to golf_sweep.py rather than reimplemented here,
    because a batched copy of the roll loop would be a FOURTH place every physics
    rule has to be mirrored -- and forgetting the vectorised mirror is the
    recurring bug of this subsystem. It is proved bit-identical to the per-lie
    calls it replaces.

    The full-grid stage is CHUNKED because survivors x 65520 candidates is real
    memory: 100 survivors would allocate ~0.5GB across the loop's arrays.

WHY A LIE THAT CANNOT SINK IS STILL NOT NECESSARILY TERMINAL
    Already learned here the hard way: a lie was found from which 0 of 16,560
    pairs sank and was written up as unfinishable, and a proper search then showed
    it holes out in TWO putts (9 of its 60 onward lies can sink). A depth-1 result
    does not license a depth-infinity claim.

    So a lie that survives the full grid is not reported as terminal until a
    DEPTH-2 pass asks whether any putt from it lands on a lie that IS live. Only a
    lie that can neither sink nor reach a live lie is called terminal. Multi-putt
    recoveries are legitimate play and this tool treats them as such.

WHAT IT SAMPLES, STATED PLAINLY SO THE RESULT IS NOT OVER-READ
    Two deliberate approximations, both of which narrow the claim rather than
    inflate it:

    1. LIES ARE QUANTISED. The 65520 resting positions collapse onto a `--cell`
       grid (24px default) and one lie per cell is tested. The tested point is a
       REAL resting position -- the exact float coordinates of an actual putt in
       that cell, never the cell's centre, which might be a place no ball stops.
       So every lie tested is genuinely reachable; the set of them is a sample.
    2. ONLY DEPTH-1 LIES ARE ENUMERATED. These are the lies reachable in one
       stroke FROM THE TEE. A lie reachable only after two bad putts is not in the
       set. The transitive closure is the complete question and it explodes; this
       is the first stroke's worth of it, which is what a player meets first.

    So a PASS means "no terminal lie among the sampled depth-1 lies", not "this
    green has no terminal lie anywhere". Said this way it is still worth having:
    it is the difference between an untested claim and a bounded one.
"""
import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import golf_sim as S  # noqa: E402
from golf_sweep import sweep  # noqa: E402

# MID gate: dense enough that an ordinary lie with a wide sinking window passes
# first time, cheap enough to run over every lie at once. Deliberately NOT a claim
# about resolution -- anything it misses is escalated, never reported.
MID_A = np.arange(0.0, 360.0, 4.0)              # 90 angles
MID_P = np.round(np.arange(0.1, 1.0 + 1e-9, 0.05), 6)   # 19 powers
# FULL grid mirrors the documented sweep exactly, so an escalated verdict is
# comparable with golf_sweep's own.
FULL_A = np.arange(0.0, 360.0, 0.5)             # 720 angles
FULL_P = np.round(np.arange(0.1, 1.0 + 1e-9, 0.01), 6)


def build_green(probe, rnd):
    """Green for `rnd` with the tee and cup pinned to the probe's real values.

    Mirrors golf_par.build_green: copy_edge and reach_safety=0.9 are both the
    shipped rule, and dropping either simulates a green the component does not
    draw (61.7px of ball error, geometry 38/42).
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


def sink_mask(g, lies, dt, full=False):
    """For each lie, did ANY line sink? Returns (mask, finals).

    One batched sweep, results shaped (nLies, nA, nP). `finals` is the pair of
    resting-position arrays, kept because the depth-2 pass needs exactly the
    onward lies this stage already computed -- recomputing them would double the
    cost of the expensive stage for no new information.
    """
    xs = [l[0] for l in lies]
    ys = [l[1] for l in lies]
    A, P = (FULL_A, FULL_P) if full else (MID_A, MID_P)
    r = sweep(g, A, P, dt, starts=(xs, ys))
    out = r["outcome"]
    mask = (out == 1).reshape(len(lies), -1).any(axis=1)
    return mask, r["final"]


def reachable_lies(g, dt, cell):
    """Depth-1 lies from the tee, one real representative per `cell` grid square.

    Returns (lies, n_nonsunk, n_sunk). The representative is an actual resting
    position, not the cell centre -- see the module note.
    """
    r = sweep(g, FULL_A, FULL_P, dt)
    out = r["outcome"].ravel()
    fx, fy = r["final"][0].ravel(), r["final"][1].ravel()
    rest = np.flatnonzero(out != 1)
    seen, lies = {}, []
    for i in rest:
        k = (int(fx[i] // cell), int(fy[i] // cell))
        if k not in seen:
            seen[k] = True
            lies.append((float(fx[i]), float(fy[i])))
    return lies, int(rest.size), int((out == 1).sum())


def check_round(probe, rnd, dt, cell, chunk=16, verbose=True):
    g = build_green(probe, rnd)
    lies, n_rest, n_sunk = reachable_lies(g, dt, cell)
    if not lies:
        if verbose:
            print(f"round {rnd:>3}  no non-sunk lies at all")
        return {"round": rnd, "lies": 0, "live": 0, "escalated": 0,
                "noSink": 0, "terminal": [], "nonSunkPutts": n_rest,
                "sunkPutts": n_sunk}

    def key(x, y):
        return (int(x // cell), int(y // cell))

    live_cells = set()

    # STAGE 1 -- every lie at the mid grid, one call.
    m1, _ = sink_mask(g, lies, dt, full=False)
    for lie, ok in zip(lies, m1):
        if ok:
            live_cells.add(key(*lie))
    survivors = [l for l, ok in zip(lies, m1) if not ok]
    escalated = len(survivors)

    # STAGE 2 -- the full grid, but only for lies stage 1 could not settle, and
    # chunked so the allocation stays bounded. Onward resting positions are kept
    # here, with a REAL representative coordinate per onward cell, because stage 3
    # has to be able to play from them.
    still, onward = [], {}
    for i in range(0, len(survivors), chunk):
        part = survivors[i:i + chunk]
        m2, (fx, fy) = sink_mask(g, part, dt, full=True)
        for j, (lie, ok) in enumerate(zip(part, m2)):
            if ok:
                live_cells.add(key(*lie))
            else:
                still.append(lie)
                reps = {}
                for x, y in zip(fx[j].ravel(), fy[j].ravel()):
                    reps.setdefault(key(x, y), (float(x), float(y)))
                onward[lie] = reps

    # STAGE 3, THE ESCAPE SEARCH -- AND THE FIRST VERSION OF THIS WAS WRONG.
    #
    # It asked whether a survivor's onward cells intersected `live_cells`, where
    # `live_cells` only ever held lies enumerated FROM THE TEE. So an onward lie
    # that had simply never been tested counted as dead, and the tool reported 40
    # terminal lies on rounds 4/7/78 that were mostly artefacts of that. It is the
    # depth-1-does-not-license-depth-infinity mistake again, moved up one ply:
    # "not known to be live" was silently read as "known to be dead".
    #
    # So untested onward cells are now PLAYED. Proving an onward lie live only
    # needs one sink at ANY resolution, so the mid grid is enough here and no
    # escalation is required -- which is what keeps this affordable.
    unknown = {}
    for lie in still:
        for k, rep in onward[lie].items():
            if k not in live_cells:
                unknown.setdefault(k, rep)
    if unknown:
        ks = list(unknown)
        reps = [unknown[k] for k in ks]
        for i in range(0, len(reps), 256):
            part_k, part_r = ks[i:i + 256], reps[i:i + 256]
            m3, _ = sink_mask(g, part_r, dt, full=False)
            for k, ok in zip(part_k, m3):
                if ok:
                    live_cells.add(k)

    terminal = [l for l in still if not (set(onward[l]) & live_cells)]

    if verbose:
        d = math.hypot(g.cup_x - g.ball0[0], g.cup_y - g.ball0[1])
        # `liveCells` CAN EXCEED `lies` and that is not a bug: stage 3 proves
        # ONWARD cells live too, and those were never in the depth-1 lie set. It
        # is a count of cells proven to hole out, not a subset of the lies tested.
        print(f"round {rnd:>3}  dist {d:6.1f}  lies {len(lies):>5}  "
              f"liveCells {len(live_cells):>5}  escalated {escalated:>4}  "
              f"no-sink {len(still):>3}  TERMINAL {len(terminal):>3}"
              + ("   <-- INVARIANT FAILED" if terminal else ""))
        for (lx, ly) in terminal:
            print(f"      terminal lie ({lx:.2f}, {ly:.2f})  "
                  f"cup ({g.cup_x:.2f}, {g.cup_y:.2f})")
    return {"round": rnd, "lies": len(lies), "live": len(live_cells),
            "escalated": escalated, "noSink": len(still),
            "terminal": [[a, b] for a, b in terminal],
            "nonSunkPutts": n_rest, "sunkPutts": n_sunk}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("probe")
    ap.add_argument("--rounds", type=int, default=80)
    ap.add_argument("--only", default="",
                    help="comma-separated rounds; combos are independent so "
                         "shard freely across processes")
    ap.add_argument("--cell", type=float, default=24.0,
                    help="lie quantisation in px; smaller is stricter and slower")
    ap.add_argument("--chunk", type=int, default=16,
                    help="full-grid lies per batched sweep; bounds memory")
    ap.add_argument("--dt-source", choices=("probe", "fps"), default="fps")
    ap.add_argument("--fps", type=float, default=S.DEFAULT_FPS)
    ap.add_argument("--json")
    a = ap.parse_args()

    probe = json.load(open(a.probe))
    dt, dt_label = S.resolve_dt(probe, a.dt_source, a.fps)
    want = ([int(x) for x in a.only.split(",") if x.strip()] if a.only
            else list(range(0, a.rounds + 1)))

    print(f"# dt={dt_label}  cell={a.cell:g}px  holes={len(want)}  "
          f"mid {MID_A.size}x{MID_P.size} -> full "
          f"{FULL_A.size}x{FULL_P.size}", flush=True)

    rows, failed = [], 0
    for rnd in want:
        r = check_round(probe, rnd, dt, a.cell, a.chunk)
        sys.stdout.flush()
        rows.append(r)
        failed += len(r["terminal"])

    tot_lies = sum(r["lies"] for r in rows)
    print(f"\nlies tested: {tot_lies} over {len(rows)} hole(s)  "
          f"(escalated to the full grid: {sum(r['escalated'] for r in rows)})")
    if failed:
        print(f"TERMINAL LIES: {failed} -- a player can reach a lie from which "
              f"the cup cannot be won, directly or in two putts.")
    else:
        print("NO TERMINAL LIE among the sampled depth-1 lies. "
              "Every reachable lie can hole out, or reach a lie that can.")

    if a.json:
        json.dump({"config": vars(a), "rows": rows}, open(a.json, "w"), indent=1)
        print(f"-> {a.json}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
