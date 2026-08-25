"""Browser probe: dump the deterministic per-round geometry + hash2 samples.

Feeds the offline simulator (tools/golf_sim.py) the exact layout numbers the
live component is using, and gives us a ground-truth table of hash2 outputs so
the Python port of JS's lossy `hash2` can be proven bit-equal.

Usage: golf_probe.py [base_url] [width] [height] [rounds] > probe.json
"""
import json
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

# BASE URL: directory-format, and 8020 to match every other harness here. This
# file asked for "/index.html" on a default port of its own until 2026-08-25,
# which `python -m http.server` serves but production 301s — and since probe.json
# is what golf_verify_port.py and golf_sweep.py both consume, the whole invariant
# chain started on a URL the real site does not serve.
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8020").rstrip("/")
W = int(sys.argv[2]) if len(sys.argv) > 2 else 1440
H = int(sys.argv[3]) if len(sys.argv) > 3 else 900
ROUNDS = int(sys.argv[4]) if len(sys.argv) > 4 else 24

# Re-declared verbatim from HeroCanvas.tsx so the page evaluates the REAL JS
# semantics (double-rounded multiply, ToInt32/ToUint32 coercions).
HASH_JS = r"""
function hash2(i, j) {
  let n = (i * 374761393 + j * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
const out = [];
for (let i = -5; i < 40; i++) {
  for (let j of [13, 17, 23, 29, 41, 53, 71]) out.push([i, j, hash2(i, j)]);
}
// the exact call sites, for rounds 0..40
for (let r = 0; r <= 40; r++) {
  out.push([r * 7 + 1, 13, hash2(r * 7 + 1, 13)]);
  out.push([r * 11 + 5, 29, hash2(r * 11 + 5, 29)]);
  out.push([r * 17 + 3, 71, hash2(r * 17 + 3, 71)]);
  out.push([r * 23 + 9, 41, hash2(r * 23 + 9, 41)]);
  out.push([r * 31 + 4, 53, hash2(r * 31 + 4, 53)]);
  for (let k = 0; k < 12; k++) {
    out.push([r * 97 + k, 17, hash2(r * 97 + k, 17)]);
    out.push([r * 89 + k, 23, hash2(r * 89 + k, 23)]);
  }
}
return out;
"""

# fbm/heightAt samples, to prove the noise port too.
FIELD_JS = r"""
function hash2(i, j) {
  let n = (i * 374761393 + j * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y) {
  return (vnoise(x, y) - 0.5) * 1.34 + (vnoise(x * 2.17 + 11.3, y * 2.17 - 4.1) - 0.5) * 0.62;
}
function heightAt(x, y, cx, cy, span, tiltAng, tiltMag, seed) {
  const nx = (x - cx) / span, ny = (y - cy) / span;
  const plane = (nx * Math.cos(tiltAng) + ny * Math.sin(tiltAng)) * tiltMag;
  // !! MIRRORS HeroCanvas.tsx heightAt(). These two amplitudes and the octave
  // frequencies MUST match the component exactly. This block is a reimplementation
  // (the component does not expose heightAt), so it drifts silently the moment the
  // field changes -- which happened: the amplitudes were raised 2.5x in the
  // component and this copy still said 0.42/0.16, so golf_verify_port.py reported
  // a 0.63 heightAt delta and read as a PORT MISMATCH when the port was fine and
  // the PROBE was stale. If you change the field, change it here too.
  /* MIRROR of HeroCanvas.tsx heightAt(). Kept bit-identical on purpose:
     a stale mirror here once produced a false PORT MISMATCH. */
  const undul = fbm(nx * 0.85 + seed, ny * 0.85 - seed) * 1.16 +
    fbm(nx * 2.0 - seed * 1.7, ny * 2.0 + seed * 1.3) * 0.26;
  return plane + undul;
}
const out = [];
let s = 1;
for (let k = 0; k < 200; k++) {
  s = (s * 16807) % 2147483647;
  const x = (s / 2147483647) * 1400;
  s = (s * 16807) % 2147483647;
  const y = (s / 2147483647) * 900;
  s = (s * 16807) % 2147483647;
  const ta = (s / 2147483647) * 6.283185307179586;
  s = (s * 16807) % 2147483647;
  const tm = 0.6 + (s / 2147483647) * 0.75;
  s = (s * 16807) % 2147483647;
  const sd = 2 + (s / 2147483647) * 9;
  out.push([x, y, 1008, 450, 450, ta, tm, sd,
            heightAt(x, y, 1008, 450, 450, ta, tm, sd)]);
}
return out;
"""

DT_JS = r"""
const done = arguments[0];
const ds = [];
let last = 0;
function f(now) {
  if (last) ds.push(now - last);
  last = now;
  if (ds.length < 90) requestAnimationFrame(f);
  else done(ds);
}
requestAnimationFrame(f);
"""


def main():
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    opts.add_argument("--force-device-scale-factor=1")
    d = webdriver.Chrome(options=opts)
    try:
        d.set_window_size(W, H)
        d.execute_cdp_cmd(
            "Emulation.setDeviceMetricsOverride",
            {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False},
        )
        d.get(BASE + "/")
        d.set_script_timeout(30)
        # let fonts settle so copyEdge/copyBottom stop moving
        for _ in range(40):
            time.sleep(0.15)
            if d.execute_script("return !!window.__puttTest"):
                break
        time.sleep(1.5)

        wrap = d.execute_script(
            "const r=document.querySelector('.hero-canvas-wrap')"
            ".getBoundingClientRect();"
            "return {w:r.width,h:r.height,left:r.left,top:r.top};"
        )
        st0 = d.execute_script("return window.__puttTest.state();")

        rounds = [{
            "round": 0,
            "ball": st0["ball"],
            "cup": st0["cup"],
        }]
        for i in range(1, ROUNDS + 1):
            s = d.execute_script(
                "window.__puttTest.reset(); return window.__puttTest.state();"
            )
            rounds.append({"round": i, "ball": s["ball"], "cup": s["cup"]})

        out = {
            "viewport": [W, H],
            "wrap": wrap,
            "box": st0["box"],
            "narrow": st0["narrow"],
            "copyEdge": st0["copyEdge"],
            "copyBottom": st0["copyBottom"],
            "rounds": rounds,
            "hash2": d.execute_script(HASH_JS),
            "field": d.execute_script(FIELD_JS),
            "dt_ms": d.execute_async_script(DT_JS),
        }
        print(json.dumps(out))
    finally:
        d.quit()


if __name__ == "__main__":
    main()
