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
MAX_ROLL = 7.0
MAX_SPEED = 900.0
TAU = math.pi * 2
CAPTURE_SPEED = 520.0  # the `speed < 520` in the cup test


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
                 friction=FRICTION, reach_safety=None,
                 downhill_credit=1.0 / -math.log(FRICTION),
                 undul_scale=1.0, tilt_scale=1.0):
        # Slope-budget knobs: undul_scale multiplies BOTH fbm amplitudes
        # (0.42 / 0.16), tilt_scale multiplies the plane's tiltMag.
        self.undul_scale = undul_scale
        self.tilt_scale = tilt_scale
        # None => the shipped (unbounded) tee rule; a float => the two-sided
        # rule under evaluation.
        self.reach_safety = reach_safety
        # Seconds of downhill terminal drift credited as "aimable" reach.
        self.downhill_credit = downhill_credit
        self.css_w = css_w
        self.css_h = css_h
        self.copy_bottom = copy_bottom
        self.narrow = narrow
        self.round = round_no
        self.cup_r = cup_r
        self.capture_speed = capture_speed
        self.max_speed = max_speed
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
            self.tilt_mag = (0.6 + r2 * 0.75) * tilt_scale
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
        return {"x": self.css_w * 0.48, "y": self.css_h * 0.16,
                "w": self.css_w * 0.46, "h": self.css_h * 0.68}

    def _place_cup(self):
        b = self.box
        m = self.cup_r * 3.2
        rx = hash2(self.round * 23 + 9, 41)
        ry = hash2(self.round * 31 + 4, 53)
        self.cup_x = b["x"] + m + (b["w"] - m * 2) * (0.25 + rx * 0.5)
        self.cup_y = b["y"] + m + (b["h"] - m * 2) * (0.2 + ry * 0.6)

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
        min_d = min(b["w"], b["h"]) * 0.42
        best_fx, best_fy, best_d = 0.2, 0.7, -1.0
        for k in range(12):
            fx = 0.08 + hash2(self.round * 97 + k, 17) * 0.84
            fy = 0.08 + hash2(self.round * 89 + k, 23) * 0.84
            px = b["x"] + b["w"] * fx
            py = b["y"] + b["h"] * fy
            dd = math.hypot(px - self.cup_x, py - self.cup_y)
            if dd > best_d:
                best_d, best_fx, best_fy = dd, fx, fy
            if dd > min_d:
                break

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
        undul = (fbm(nx * 1.25 + self.g_seed, ny * 1.25 - self.g_seed) * 0.42
                 + fbm(nx * 2.9 - self.g_seed * 1.7,
                       ny * 2.9 + self.g_seed * 1.3) * 0.16) * self.undul_scale
        return plane + undul

    def slope_at(self, x, y):
        h = 7.0
        hx = self.height_at(x + h, y) - self.height_at(x - h, y)
        hy = self.height_at(x, y + h) - self.height_at(x, y - h)
        return -hx * SLOPE_ACCEL, -hy * SLOPE_ACCEL

    # ---- integration ----
    def putt(self, dx, dy, power, dt=1.0 / 60.0, dts=None, trace=False,
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
                if speed < self.capture_speed:
                    return ("sunk", i, self.cup_x, self.cup_y, 0.0, hot_pass,
                            hot_min_speed, path)
                hot_pass = True
                hot_min_speed = min(hot_min_speed, speed)
                nx = dcx / (dist or 1)
                ny = dcy / (dist or 1)
                vx -= nx * speed * 0.9
                vy -= ny * speed * 0.9

            rgx, rgy = gx, gy
            if at_l and rgx < 0:
                rgx = 0.0
            if at_r and rgx > 0:
                rgx = 0.0
            if at_t and rgy < 0:
                rgy = 0.0
            if at_b and rgy > 0:
                rgy = 0.0
            holds = math.hypot(rgx, rgy) < SLOPE_ACCEL * 0.014

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
