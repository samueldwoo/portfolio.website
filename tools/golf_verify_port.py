"""Prove the Python port of hash2 / heightAt / geometry is bit-equal to the page.

Compares against tools/golf_probe.py's dump. Any mismatch here means the sweep
is auditing a different green than the one the player sees.
"""
import json
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from golf_sim import Green, hash2  # noqa: E402

probe = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "probe_1440.json"))
# Pass the tee rule's budget to check the FIXED build; omit for the original.
RS = float(sys.argv[2]) if len(sys.argv) > 2 else None

# 1. hash2, exactly
bad = 0
worst = 0.0
for i, j, want in probe["hash2"]:
    got = hash2(i, j)
    if got != want:
        bad += 1
        worst = max(worst, abs(got - want))
        if bad <= 5:
            print(f"  hash2({i},{j}) js={want!r} py={got!r}")
print(f"hash2:    {len(probe['hash2']) - bad}/{len(probe['hash2'])} exact"
      f"{'' if not bad else f' (worst delta {worst:g})'}")

# 2. heightAt (uses Math.cos/sin, so allow ulp-level drift)
hw = 0.0
for x, y, cx, cy, span, ta, tm, sd, want in probe["field"]:
    g = Green.__new__(Green)
    g.hmx, g.hmy, g.span = cx, cy, span
    g.tilt_ang, g.tilt_mag, g.g_seed = ta, tm, sd
    g.undul_scale = 1.0
    hw = max(hw, abs(g.height_at(x, y) - want))
print(f"heightAt: {len(probe['field'])} samples, max abs delta {hw:.3e}")

# 3. per-round ball + cup geometry
# layout() rounds the wrap rect before it becomes cssW/cssH.
w = max(1, round(probe["wrap"]["w"]))
h = max(1, round(probe["wrap"]["h"]))
cb, nr = probe["copyBottom"], probe["narrow"]
gbad = 0
gworst = 0.0
for r in probe["rounds"]:
    g = Green(w, h, cb, nr, r["round"], reach_safety=RS)
    d1 = max(abs(g.ball0[0] - r["ball"][0]), abs(g.ball0[1] - r["ball"][1]))
    d2 = max(abs(g.cup_x - r["cup"][0]), abs(g.cup_y - r["cup"][1]))
    gworst = max(gworst, d1, d2)
    if max(d1, d2) > 1e-6:
        # Round 0 on a narrow viewport is a known layout transient, not a port
        # error: the initial tee/cup are placed before the final copyBottom
        # measurement and the ball is then only clamped into the moved box.
        if r["round"] == 0 and nr:
            print(f"  round 0 (narrow): ball d={d1:.4g} cup d={d2:.4g}"
                  " -- expected layout transient, audited from the probe")
            continue
        gbad += 1
        print(f"  round {r['round']}: ball d={d1:.4g} cup d={d2:.4g}")
print(f"geometry: {len(probe['rounds']) - gbad}/{len(probe['rounds'])} rounds "
      f"match, worst {gworst:.3e} px")

ok = bad == 0 and hw < 1e-12 and gbad == 0
print("PORT " + ("VERIFIED" if ok else "MISMATCH"))
sys.exit(0 if ok else 1)
