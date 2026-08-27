"""Offline port of the HeroCanvas putting-green physics.

Ported line-for-line from src/components/HeroCanvas.tsx: hash2 / vnoise / fbm /
heightAt / slopeAt / stepBall, the play box, the per-round green roll, the cup
placement and the rejection-sampled ball start.

The one subtlety worth naming: JS's `hash2` is LOSSY. `(n ^ (n >>> 13)) *
1274126177` overflows 2^53, so the multiply is rounded as an IEEE double before
ToInt32/ToUint32 truncate it. Reproducing that exactly (rather than doing the
multiply in Python's arbitrary-precision ints) is the difference between a green
that matches the browser and one that does not. tools/golf_probe.py dumps 1504
ground-truth hash2 values from the page so this is provable, not assumed.
"""
import math

# ---- constants, verbatim ----
CUP_R = 13.0
STOP_SPEED = 26.0
FRICTION = 0.12
SLOPE_ACCEL = 2400.0
REST_SLOPE = 0.03   # mirrors HeroCanvas.tsx
MAX_ROLL = 7.0
MAX_SPEED = 900.0
TAU = math.pi * 2
# CAPTURE_SPEED: the `speed < CAPTURE_SPEED` in the cup test. 520 -> 175 -> 225.
#
# Read it as a DISTANCE, not a speed: a rolling ball has v/k of travel left with
# k = -ln(FRICTION) = 2.12, so the threshold is how far past the hole the ball
# would still have run when it dropped. 520 allowed 245px, most of the green, and
# made aiming straight at full power sink 68 of 81 holes. 175 allowed 83px; 225
# allows 106px, i.e. a putt struck ~28% firmer can still hole.
#
# MEASURE THIS ON BOTH AIM WINDOWS, BECAUSE THEY DISAGREE. Dead straight at full
# power, 225 sinks 16/81 -- identical to 175 without the lip-out, which was the
# reviewed state. Allow +-2deg of aim slop, which is closer to what a person does
# when they "aim at the hole", and 225 sinks 29/81 against that baseline's 21/81.
#
#     capture   dead straight   +-2deg slop
#     175 (no lip-out)  16/81       21/81
#     205 + lip-out     12/81       21/81
#     225 + lip-out     16/81       29/81
#
# 205 was proposed on the strength of the +-2deg row. THE OWNER CHOSE 225 KNOWING
# THE COST, for feel: 106px of run-past instead of 97px. Recorded rather than
# re-litigated -- the argument for 205 is above if it ever needs revisiting, and
# the counter-arguments were that the +-2deg window is an arbitrary slop figure and
# that exploitability is already viewport-dependent and worse on large screens
# (32% at 4K) whichever value is used.
#
# Re-run tools/golf_mash.py --aim-window 2 if you move it again. The curve is
# steep: 250 sinks 24/81 dead straight, 275 sinks 28/81, 300 sinks 33/81.
CAPTURE_SPEED = 225.0
# LIP-OUT: A ROTATION, DELIBERATELY, BECAUSE ANY DAMPING ENDS IN A CAPTURE.
#
# Two previous attempts to reject a fast ball both fed it into the hole: a radial
# 0.9 brake and a 0.85 per-frame damping, the second measurably worse (67 of 81
# mash putts still sank). A ball crosses a 26px cup in about ten frames and
# 0.85^10 = 0.20, so anything that shrinks |v| inside the radius walks the ball
# under CAPTURE_SPEED while it is still over the hole.
#
# A rotation cannot do that: |v| is invariant, so the capture test sees exactly
# the speed it saw before. Deflecting AWAY from the cup centre also bends the path
# outward, so the failure mode is impossible for two independent reasons rather
# than merely tuned away. Applied ONCE on the frame the ball enters the radius --
# per-frame rotation would spiral the ball around the cup.
#
# Magnitude scales with the impact parameter, which is what removes the need for a
# tie-break: at zero lateral offset the rotation is zero, so no arbitrary side has
# to be invented for the degenerate case and three ports agree without one.
#
# AIMING AT THE CUP IS NOT THE ZERO CASE. The offset is measured on the ENTRY
# FRAME, after break has bent the ball and quantised to that frame's heading. Over
# rounds 0..11 with the aim laid exactly on the cup it runs 1.2px to 10.1px, i.e.
# deflections of 5.4deg to 46.5deg. Read this as "always deflects, sometimes
# barely", not as "spares a straight putt".
LIP_DEFLECT = math.radians(60.0)
# LIP_LOSS: ENERGY GIVEN UP TO THE LIP, SCALED ON THE EXCESS ABOVE CAPTURE_SPEED.
#
# A real ball that catches the lip loses pace; a pure rotation gave none away. But
# a naive multiply walks straight back into the original bug: at CAPTURE_SPEED 225
# a ball arriving at 260 with a flat 20% loss leaves at 208, which is BELOW the
# threshold while still inside the radius, so it drops next frame. That is exactly
# what made the old radial 0.9 brake a capture device.
#
# So the loss applies to the EXCESS, not the total:
#     speed' = CAPTURE_SPEED + (speed - CAPTURE_SPEED) * (1 - LIP_LOSS)
# A putt hammered in at 800 gives up a lot, one trickling in at 180 almost nothing,
# and the result cannot fall below CAPTURE_SPEED from the hit itself. That is also
# the physically sensible grading: the harder you strike the lip, the more you lose.
#
# THE PROOF IS THE GATE, THOUGH, NOT THE FORMULA. Friction keeps acting on the
# frames after the hit, so scaling the excess alone only makes a capture unlikely.
# Once a ball has been lipped out it is not tested for capture again until it leaves
# the radius (see `in_cup`), which makes re-capture impossible for ANY value here.
#
# What that costs, deliberately: a ball can no longer rattle the lip and drop in on
# the same pass. That is a real golf shot, but it is mechanically identical to the
# exploit this subsystem just spent a day removing -- enter fast, decelerate inside
# the radius, drop -- so it is traded away on purpose rather than left as a loophole
# shaped like the old one.
LIP_LOSS = 0.35

# ---- THE TIMESTEP: ONE STORY, NOT FOUR ----
# HeroCanvas.tsx tick() computes `Math.min(0.05, (now - last) / 1000)`, seeded at
# 0.016 on the first frame after the loop starts. So the page integrates at the
# REAL frame delta, clamped at 50ms — never at a uniform 1/fps.
#
# This module owns those numbers because the tools disagreed about them: sweep
# defaulted to 1/60, pick and pick_fails to 1/120, and putt() to 1/60, so three
# scripts written to corroborate each other were integrating three different
# greens. The rejected alternative was to pick one fps and document it; that
# still would not have matched the page, and probe.json's `dt_ms` field existed
# to describe the real thing yet no caller ever read it.
#
# DEFAULT_FPS is a FALLBACK for callers with no measured sequence, not a claim
# about the page. Prefer `dts=frame_dts(probe["dt_roll_ms"])`.
DT_CLAMP = 0.05          # Math.min(0.05, ...) in tick()
DT_FIRST = 0.016         # tick()'s seed while `last` is still 0
DEFAULT_FPS = 120.0
DEFAULT_DT = 1.0 / DEFAULT_FPS


def frame_dts(ms, clamp=DT_CLAMP, seed_first=False):
    """Measured per-frame millisecond deltas -> the seconds tick() would use.

    `seed_first` reproduces tick()'s 0.016 first frame. It is OFF by default and
    that is deliberate: the seed only fires when `last` is 0, i.e. immediately
    after start(), and a putt launched on a visible page lands mid-loop where
    start() is a no-op. Turning it on for a mid-session putt would inject a
    16ms frame the page never took.
    """
    out = [min(clamp, v / 1000.0) for v in ms]
    if seed_first and out:
        out[0] = DT_FIRST
    return out


def resolve_dt(probe, source="probe", fps=DEFAULT_FPS):
    """(dt, label) for the sweepers. One resolver so they cannot drift apart.

    Returns a measured sequence when the probe carries one, else a uniform step.
    An older probe.json has no `dt_roll_ms` — it falls back rather than raising,
    but the label says so, because a silent fallback to 1/fps is how the three
    timesteps got out of step in the first place.
    """
    ms = (probe or {}).get("dt_roll_ms") or []
    if source == "probe" and ms:
        dts = frame_dts(ms)
        s = sorted(dts)
        return dts, (f"measured roll dt, {len(dts)} frames, "
                     f"p50 {s[len(s) // 2] * 1000:.2f}ms "
                     f"[{s[0] * 1000:.2f}..{s[-1] * 1000:.2f}]")
    if source == "probe":
        return 1.0 / fps, (f"uniform 1/{fps:g}s (probe has no dt_roll_ms — "
                           f"re-run golf_probe.py to get the real thing)")
    return 1.0 / fps, f"uniform 1/{fps:g}s (requested)"


def to_uint32(x: float) -> int:
    """JS ToUint32 on a double."""
    if not math.isfinite(x):
        return 0
    return int(math.trunc(x)) & 0xFFFFFFFF


def to_int32(x: float) -> int:
    u = to_uint32(x)
    return u - 0x100000000 if u & 0x80000000 else u


def hash2(i: int, j: int) -> float:
    # let n = (i * A + j * B) | 0
    n = to_int32(float(i) * 374761393.0 + float(j) * 668265263.0)
    # n = (n ^ (n >>> 13)) * K   -> stays a DOUBLE (rounded), not an int32
    xor1 = (n & 0xFFFFFFFF) ^ ((n & 0xFFFFFFFF) >> 13)
    xor1_signed = xor1 - 0x100000000 if xor1 & 0x80000000 else xor1
    prod = float(xor1_signed) * 1274126177.0
    u = to_uint32(prod)
    return ((u ^ (u >> 16)) & 0xFFFFFFFF) / 4294967295.0


def vnoise(x: float, y: float) -> float:
    xi = math.floor(x)
    yi = math.floor(y)
    xf = x - xi
    yf = y - yi
    u = xf * xf * (3 - 2 * xf)
    v = yf * yf * (3 - 2 * yf)
    a = hash2(xi, yi)
    b = hash2(xi + 1, yi)
    c = hash2(xi, yi + 1)
    d = hash2(xi + 1, yi + 1)
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v


def fbm(x: float, y: float) -> float:
    return (vnoise(x, y) - 0.5) * 1.34 + (
        vnoise(x * 2.17 + 11.3, y * 2.17 - 4.1) - 0.5
    ) * 0.62


class Green:
    """One round: layout + fall line + cup + ball start."""

    def __init__(self, css_w, css_h, copy_bottom, narrow, round_no,
                 cup_r=CUP_R, capture_speed=CAPTURE_SPEED, max_speed=MAX_SPEED,
                 lip_deflect=LIP_DEFLECT, lip_loss=LIP_LOSS, lip_gate=True,
                 friction=FRICTION, reach_safety=None,
                 downhill_credit=1.0 / -math.log(FRICTION),
                 undul_scale=1.0, tilt_scale=1.0, copy_edge=None):
        # Slope-budget knobs: undul_scale multiplies BOTH fbm amplitudes
        # (1.16 / 0.26), tilt_scale multiplies the plane's tiltMag.
        #
        # THOSE TWO NUMBERS WERE WRITTEN AS 0.42 / 0.16 HERE UNTIL 2026-08-25,
        # which is the pre-2026-08-22 field. Harmless in itself (it is prose, and
        # the code reads the real constants), but it is the same stale-mirror
        # class of bug that had golf_sweep rolling balls on a green nobody plays.
        # If you change the field, grep the whole of tools/ for the old numbers.
        self.undul_scale = undul_scale
        self.tilt_scale = tilt_scale
        # A float => the SHIPPED two-sided tee rule (0.9 is what the component
        # uses). None => unbounded, which is NOT what ships: dropping it takes
        # golf_verify_port from geometry 42/42 to 38/42, worst ball error 61.7px.
        # This comment said the opposite until 2026-08-25 — that `None` was
        # shipped and the float was "under evaluation".
        self.reach_safety = reach_safety
        # Seconds of downhill terminal drift credited as "aimable" reach.
        self.downhill_credit = downhill_credit
        self.css_w = css_w
        self.css_h = css_h
        self.copy_bottom = copy_bottom
        # Wide play box is DERIVED from the measured copy edge (see _play_box).
        # None keeps the pre-derivation constant so old callers still run, but
        # they are then simulating a green the component no longer draws.
        self.copy_edge = copy_edge
        self.narrow = narrow
        self.round = round_no
        self.cup_r = cup_r
        self.capture_speed = capture_speed
        self.max_speed = max_speed
        self.lip_deflect = lip_deflect
        self.lip_loss = lip_loss
        # MEASUREMENT KNOB, NOT A PHYSICS DIAL. Always True in the shipped game;
        # False reproduces the pre-gate behaviour so the gate's own contribution to
        # the mash line can be measured instead of inferred. It turned out to be
        # the dominant term (about 4 holes against the deflection's 3), which is
        # exactly the kind of claim that should be reproducible on demand.
        self.lip_gate = lip_gate
        self.friction = friction

        # home() / span for the height field
        if narrow:
            self.hmx = css_w * 0.5
            self.hmy = css_h * (copy_bottom + (1 - copy_bottom) * 0.52)
        else:
            self.hmx = css_w * 0.7
            self.hmy = css_h * 0.5
        self.span = min(css_w, css_h) * 0.5

        self.box = self._play_box()

        if round_no == 0:
            # initial mount: layout(); placeCup(); resetBall(false)
            self.tilt_ang = 0.0
            self.tilt_mag = 0.85 * tilt_scale
            self.g_seed = 3.1
            self._place_cup()
            self.start_fx, self.start_fy = 0.28, 0.72
        else:
            r1 = hash2(round_no * 7 + 1, 13)
            r2 = hash2(round_no * 11 + 5, 29)
            r3 = hash2(round_no * 17 + 3, 71)
            self.tilt_ang = r1 * TAU
            self.tilt_mag = (0.78 + r2 * 0.975) * tilt_scale
            self.g_seed = 2 + r3 * 9
            self._place_cup()
            self._pick_start()

        b = self.box
        self.ball0 = (b["x"] + b["w"] * self.start_fx,
                      b["y"] + b["h"] * self.start_fy)

    def _play_box(self):
        if self.narrow:
            pad = max(18.0, self.css_h * 0.022)
            top = self.copy_bottom * self.css_h + pad
            h = max(130.0, self.css_h - top - pad)
            return {"x": self.css_w * 0.16, "y": top,
                    "w": self.css_w * 0.68, "h": h}
        # MIRROR of HeroCanvas.tsx playBox(). This branch was STALE: it was
        # hardcoded to x=0.48 / w=0.46 long after the component started deriving
        # the left edge from the measured copy edge. At 1440 the real box is
        # x=0.628 / w=0.312, so every offline solvability number computed here
        # described a green ~1.5x too wide and 200px too far left. Any result
        # from before this fix is void.
        left = max(0.44, (0.44 if self.copy_edge is None else self.copy_edge) + 0.05)
        return {"x": self.css_w * left, "y": self.css_h * 0.16,
                "w": self.css_w * (0.94 - left), "h": self.css_h * 0.68}

    def _place_cup(self):
        """MIRROR of HeroCanvas.tsx placeCup().

        Twenty-four candidates from the same hash stream; the first flat enough
        for a ball to hold wins, else the flattest. `SLOPE_ACCEL * REST_SLOPE`
        is the same threshold the roll integrator uses for `holds`, so "a
        greenkeeper would cut here" and "a ball can rest here" are one test.
        """
        b = self.box
        m = self.cup_r * 3.2
        acceptable = SLOPE_ACCEL * REST_SLOPE
        bx = by = 0.0
        best_mag = float("inf")
        for i in range(24):
            rx = hash2(self.round * 23 + 9 + i * 7, 41)
            ry = hash2(self.round * 31 + 4 + i * 11, 53)
            x = b["x"] + m + (b["w"] - m * 2) * (0.25 + rx * 0.5)
            y = b["y"] + m + (b["h"] - m * 2) * (0.2 + ry * 0.6)
            gx, gy = self.slope_at(x, y)
            mag = math.hypot(gx, gy)
            if mag < best_mag:
                best_mag = mag
                bx, by = x, y
            if mag <= acceptable:
                break
        self.cup_x, self.cup_y = bx, by

    def reach_toward(self, px, py):
        """Max distance a FULL-power putt can roll from (px,py) toward the cup.

        Closed form of  dv/dt = -k v - up  with k = -ln(FRICTION) and `up` the
        mean slope acceleration opposing the putt, sampled along the line.
        """
        dx = self.cup_x - px
        dy = self.cup_y - py
        d = math.hypot(dx, dy) or 1.0
        ux, uy = dx / d, dy / d
        up = 0.0
        for f in (0.15, 0.35, 0.55, 0.75, 0.95):
            gx, gy = self.slope_at(px + ux * d * f, py + uy * d * f)
            up -= gx * ux + gy * uy
        up /= 5.0
        k = -math.log(self.friction)
        flat = self.max_speed / k
        if up > 1e-6:
            return flat - (up / (k * k)) * math.log1p(k * self.max_speed / up)
        return flat + (-up / k) * self.downhill_credit

    def _pick_start(self):
        b = self.box
        # MIRROR of HeroCanvas.tsx: the gimme floor is physics, not screen size.
        # The box-relative term scaled with the viewport and forced every putt
        # long on a big display (336px at 2560 vs a ~399px reach cap), which the
        # difficulty rating reported as Brutal 19 times in 20. 0.35 of the flat
        # run (MAX_SPEED / -ln(FRICTION)) is viewport-independent; the old term
        # survives as an upper bound so a small box still gets a reachable floor.
        min_d = min(min(b["w"], b["h"]) * 0.42,
                    0.35 * (self.max_speed / -math.log(self.friction)))
        # MIRROR of HeroCanvas.tsx: aim for a TARGET hole length instead of
        # taking the first lie past the floor. The old early-break made hole
        # length a property of the box (big box -> almost every candidate clears
        # the floor -> distance pinned at the reach cap -> every hole Brutal).
        # 0.55..1.00 of the reach budget, top-heavy on purpose.
        flat_run = self.max_speed / -math.log(self.friction)
        budget = 0.9 if self.reach_safety is None else self.reach_safety
        target_len = max(min_d,
                         (0.55 + hash2(self.round * 131 + 7, 37) * 0.45) * budget * flat_run)
        best_fx, best_fy, best_err = 0.2, 0.7, float("inf")
        far_fx, far_fy, far_d = 0.2, 0.7, -1.0
        for k in range(24):
            fx = 0.08 + hash2(self.round * 97 + k, 17) * 0.84
            fy = 0.08 + hash2(self.round * 89 + k, 23) * 0.84
            px = b["x"] + b["w"] * fx
            py = b["y"] + b["h"] * fy
            dd = math.hypot(px - self.cup_x, py - self.cup_y)
            if dd > far_d:
                far_d, far_fx, far_fy = dd, fx, fy
            if dd < min_d:
                continue
            err = abs(dd - target_len)
            if err < best_err:
                best_err, best_fx, best_fy = err, fx, fy
        if best_err == float("inf"):
            best_fx, best_fy = far_fx, far_fy

        if self.reach_safety is not None:
            # Pull the tee IN along its own line until a full-power putt can
            # actually get there. Direction (and so the character of the hole)
            # is preserved, and min_d is a hard floor, so this can never
            # degenerate into a gimme.
            px = b["x"] + b["w"] * best_fx
            py = b["y"] + b["h"] * best_fy
            for _ in range(6):
                dd = math.hypot(px - self.cup_x, py - self.cup_y)
                cap = self.reach_toward(px, py) * self.reach_safety
                if dd <= cap or dd <= min_d:
                    break
                t = max(cap, min_d) / dd
                px = self.cup_x + (px - self.cup_x) * t
                py = self.cup_y + (py - self.cup_y) * t
            best_fx = (px - b["x"]) / b["w"]
            best_fy = (py - b["y"]) / b["h"]

        self.start_fx, self.start_fy = best_fx, best_fy

    # ---- field ----
    def height_at(self, x, y):
        nx = (x - self.hmx) / self.span
        ny = (y - self.hmy) / self.span
        plane = (nx * math.cos(self.tilt_ang) + ny * math.sin(self.tilt_ang)) \
            * self.tilt_mag
        # MIRROR of HeroCanvas.tsx heightAt(). Frequencies went 1.25/2.9 ->
        # 0.85/2.0 for fewer, broader contours so the fall line is readable
        # again, and the amplitudes then came back UP to 1.16/0.26 to buy back
        # the difficulty the broader field gave away. This comment claimed
        # 0.58/0.13 until 2026-08-25, an intermediate that never shipped —
        # frequency and amplitude move independently here, which is the whole
        # point, so a comment naming a superseded pair is actively misleading.
        # Keep bit-identical with the component.
        undul = (fbm(nx * 0.85 + self.g_seed, ny * 0.85 - self.g_seed) * 1.16
                 + fbm(nx * 2.0 - self.g_seed * 1.7,
                       ny * 2.0 + self.g_seed * 1.3) * 0.26) * self.undul_scale
        return plane + undul

    def slope_at(self, x, y):
        h = 7.0
        hx = self.height_at(x + h, y) - self.height_at(x - h, y)
        hy = self.height_at(x, y + h) - self.height_at(x, y - h)
        return -hx * SLOPE_ACCEL, -hy * SLOPE_ACCEL

    # ---- integration ----
    def putt(self, dx, dy, power, dt=DEFAULT_DT, dts=None, trace=False,
             start=None):
        """Returns (outcome, frames, final_x, final_y, closest_dist, hot_pass).

        outcome: 'sunk' | 'stopped' | 'timeout'
        hot_pass: the ball entered the cup radius but was moving too fast
        """
        b = self.box
        bx, by = start if start else self.ball0
        L = math.hypot(dx, dy) or 1.0
        vx = (dx / L) * power * self.max_speed
        vy = (dy / L) * power * self.max_speed
        on_wall = False
        stalled = 0.0
        roll_time = 0.0
        closest = math.hypot(self.cup_x - bx, self.cup_y - by)
        hot_pass = False
        in_cup = False   # was the ball inside the cup radius LAST frame?
        hot_min_speed = math.inf
        path = [] if trace else None
        i = 0
        while True:
            if dts is not None:
                step_dt = dts[i] if i < len(dts) else dts[-1]
            else:
                step_dt = dt
            i += 1
            gx, gy = self.slope_at(bx, by)
            vx += gx * step_dt
            vy += gy * step_dt
            keep = math.pow(self.friction, step_dt)
            vx *= keep
            vy *= keep
            bx += vx * step_dt
            by += vy * step_dt

            at_l = at_r = at_t = at_b = False
            if bx < b["x"]:
                bx = b["x"]; vx = 0.0; at_l = True
            if bx > b["x"] + b["w"]:
                bx = b["x"] + b["w"]; vx = 0.0; at_r = True
            if by < b["y"]:
                by = b["y"]; vy = 0.0; at_t = True
            if by > b["y"] + b["h"]:
                by = b["y"] + b["h"]; vy = 0.0; at_b = True
            touching = at_l or at_r or at_t or at_b
            if touching and not on_wall:
                if at_l or at_r:
                    vy *= 0.5
                if at_t or at_b:
                    vx *= 0.5
            on_wall = touching

            dcx = self.cup_x - bx
            dcy = self.cup_y - by
            dist = math.sqrt(dcx * dcx + dcy * dcy)
            speed = math.sqrt(vx * vx + vy * vy)
            if dist < closest:
                closest = dist
            if trace:
                path.append((bx, by, speed))
            if dist < self.cup_r:
                # THE GATE: only a ball that has NOT already been lipped out on
                # this pass may be captured. See LIP_LOSS -- this is what makes a
                # speed reduction inside the radius provably safe.
                if (not (in_cup and self.lip_gate)) and speed < self.capture_speed:
                    return ("sunk", i, self.cup_x, self.cup_y, 0.0, hot_pass,
                            hot_min_speed, path)
                hot_pass = True
                hot_min_speed = min(hot_min_speed, speed)
                # MIRROR of HeroCanvas: too fast to be held, so the lip throws it
                # off line and takes some pace -- see LIP_DEFLECT and LIP_LOSS.
                if not in_cup:
                    in_cup = True
                    inv = 1.0 / (speed or 1.0)
                    ux, uy = vx * inv, vy * inv
                    # Signed lateral offset of the cup centre from the line of
                    # travel, on the axis p = (-uy, ux). Zero means dead centre.
                    lat = -dcx * uy + dcy * ux
                    frac = min(1.0, abs(lat) / self.cup_r)
                    sgn = 0.0 if lat == 0.0 else (1.0 if lat > 0.0 else -1.0)
                    ang = -sgn * self.lip_deflect * frac
                    ca, sa = math.cos(ang), math.sin(ang)
                    excess = speed - self.capture_speed
                    target = self.capture_speed + excess * (1.0 - self.lip_loss)
                    scale = target / (speed or 1.0)
                    vx, vy = ((vx * ca - vy * sa) * scale,
                              (vx * sa + vy * ca) * scale)
            else:
                in_cup = False

            rgx, rgy = gx, gy
            if at_l and rgx < 0:
                rgx = 0.0
            if at_r and rgx > 0:
                rgx = 0.0
            if at_t and rgy < 0:
                rgy = 0.0
            if at_b and rgy > 0:
                rgy = 0.0
            holds = math.hypot(rgx, rgy) < SLOPE_ACCEL * REST_SLOPE

            if speed < STOP_SPEED:
                stalled += step_dt
            else:
                stalled = 0.0
            roll_time += step_dt

            if roll_time > MAX_ROLL or (speed < STOP_SPEED
                                       and (holds or stalled > 0.9)):
                out = "timeout" if roll_time > MAX_ROLL else "stopped"
                return (out, i, bx, by, closest, hot_pass, hot_min_speed, path)
            if speed < 6 and not holds:
                vx += gx * step_dt * 0.5
                vy += gy * step_dt * 0.5
