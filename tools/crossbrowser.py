#!/usr/bin/env python3
"""
crossbrowser.py — cross-engine verification harness for the portfolio site.

WHAT THIS IS FOR
    The site ships four animation libraries (GSAP + ScrollTrigger, SplitText,
    anime.js, Motion) and had only ever been exercised in headless Chrome.
    Everything here exists to find the things one engine does and another does
    not, and to say plainly which engines were genuinely driven.

WHAT IT CHECKS, per engine and per page
    1. Severe console errors      — uncaught exceptions and console.error.
    2. Horizontal overflow        — the requested scrollWidth > clientWidth
                                    comparison, PLUS a geometric right-edge
                                    sweep, because this site sets
                                    `body { overflow-x: hidden }` which clamps
                                    scrollWidth and would otherwise hide real
                                    overflow behind a clean number.
    3. Stranded elements          — after scrolling to the BOTTOM, every
                                    rendered .reveal / .pass / .case-block /
                                    h1 / h2 must be at opacity >= 0.99. The
                                    scroll comes first on purpose: an element
                                    at opacity 0 below the fold is waiting for
                                    its observer, not broken. Only after its
                                    trigger has passed is transparency a bug.
    4. Key layout metrics         — a fixed set of landmarks with numeric
                                    geometry and font metrics, so engines can
                                    be diffed rather than eyeballed.
    5. Vendored library loading   — window.gsap / anime / Motion / ScrollTrigger.
    6. overflow-clip-margin       — support AND a measured descender-clip test
                                    (see --clip-report and the README).

ENGINES
    chrome   Selenium + chromedriver.                        Real.
    firefox  Selenium + geckodriver (Selenium Manager).      Real.
    safari   Selenium + safaridriver against INSTALLED Safari.
             Requires `safaridriver --enable`, which is sudo-gated. When it is
             not enabled this engine reports status "unavailable" with the
             reason. It is never silently skipped and never reported as a pass.
    webkit   Playwright's WebKit build, via tools/webkit_runner.mjs.
             This is the SAME ENGINE FAMILY as the installed Safari but NOT the
             shipping Safari binary. Treat it as WebKit coverage, not as Safari
             coverage. Flagged `engineIsShippingSafari: false` in the output.

USAGE
    PY=~/personal/finance/finance/.venv/bin/python
    $PY tools/crossbrowser.py --base http://127.0.0.1:8899
    $PY tools/crossbrowser.py --base http://127.0.0.1:8899 --engines chrome,webkit
    $PY tools/crossbrowser.py --base http://127.0.0.1:8899 --json out.json --clip-report

EXIT CODE
    0  every engine that could be driven passed every check
    1  at least one real failure
    2  harness/setup problem (no engine could be driven at all)
    Engines reported "unavailable" do NOT set a failure code — an untested
    engine is not a passing engine and not a failing one. It is untested.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROBE_PATH = HERE / "probe.js"
MASK_RECORDER_PATH = HERE / "mask_recorder.js"
WEBKIT_RUNNER = HERE / "webkit_runner.mjs"

DEFAULT_PAGES = ["", "projects/", "travel/"]   # directory format (Vercel adapter forces it)

# Scroll choreography. MUST stay in step with the constants in
# webkit_runner.mjs — if one engine waits longer than another, a timing
# difference gets misattributed to the engine, which is the one mistake this
# harness must not make.
SETTLE_MS = 1400          # after load, before touching the page
STEP_MS = 260             # dwell between scroll steps
BOTTOM_SETTLE_MS = 1800   # at the bottom, before asserting opacity
MAX_STEPS = 120

# Console noise that is not a site defect: driver-injected content scripts and
# the perennial missing favicon. Kept deliberately short — over-filtering here
# is how a harness starts lying.
NOISE_PATTERNS = [
    "content script loaded",
    "Injecting javascript to wrap",
    "Injecting file system access api patch",
    "Injecting element creation patch",
    "First element creation parent found",
    "Injecting firefox replay listener",
    "favicon",
]


def is_noise(text):
    t = (text or "")
    return any(p.lower() in t.lower() for p in NOISE_PATTERNS)


def load_js(path):
    """Read a shared probe file as a bare JS expression.

    Each file is one parenthesised function literal; the trailing semicolon is
    stripped so the text can be dropped straight into `return (<here>)(...)`.
    """
    src = Path(path).read_text().strip()
    if src.endswith(";"):
        src = src[:-1]
    return src


def load_probe():
    return load_js(PROBE_PATH)


# ---------------------------------------------------------------------------
# viewport normalisation
# ---------------------------------------------------------------------------
def normalize_viewport(driver, width, height, tries=6):
    """Drive the *inner* viewport to an exact size.

    set_window_rect sets the OUTER window, and the chrome around it differs per
    browser (and per headless implementation). Comparing a 1440-outer Chrome
    against a 1440-outer Firefox means comparing two different viewport widths,
    which shows up as a bogus layout diff on every single landmark. This
    converges on the requested inner size instead.
    """
    for _ in range(tries):
        inner = driver.execute_script("return [window.innerWidth, window.innerHeight]")
        dw, dh = width - inner[0], height - inner[1]
        if abs(dw) <= 1 and abs(dh) <= 1:
            break
        rect = driver.get_window_rect()
        try:
            driver.set_window_rect(width=int(rect["width"] + dw),
                                   height=int(rect["height"] + dh))
        except Exception:
            break
        time.sleep(0.15)
    inner = driver.execute_script("return [window.innerWidth, window.innerHeight]")
    return {"requested": [width, height], "actual": inner,
            "exact": abs(inner[0] - width) <= 1 and abs(inner[1] - height) <= 1}


# ---------------------------------------------------------------------------
# scroll choreography
# ---------------------------------------------------------------------------
def wait_scroll_stable(driver, timeout=6.0, quiet=0.15):
    """Block until the scroll position stops moving.

    This site sets `html { scroll-behavior: smooth }`, which makes EVERY
    programmatic scroll an animation. A fixed sleep after scrollTo is therefore
    a race: the first version of this harness screenshotted while the page was
    still gliding and captured plain background, which read as "no ink" and
    silently turned the descender test into a no-op. `behavior:'instant'` is
    requested at the call site to opt out of the animation, and this poll is the
    belt to that braces — if an engine ignores the override, the harness waits
    the animation out instead of measuring mid-flight.
    """
    deadline = time.time() + timeout
    last = None
    stable_since = None
    while time.time() < deadline:
        y = driver.execute_script("return window.pageYOffset")
        if y == last:
            if stable_since is None:
                stable_since = time.time()
            elif time.time() - stable_since >= quiet:
                return True
        else:
            stable_since = None
            last = y
        time.sleep(0.05)
    return False


def scroll_to_instant(driver, y):
    """Jump the scroll position without an animation, whatever the CSS says."""
    driver.execute_script(
        "try { window.scrollTo({top: arguments[0], left: 0, behavior: 'instant'}); }"
        "catch (e) { window.scrollTo(0, arguments[0]); }", y)
    wait_scroll_stable(driver)


def scroll_through(driver):
    """Step down the whole page, then settle at the bottom.

    A single jump to document end is NOT equivalent: IntersectionObserver only
    evaluates the state it is handed, so teleporting past the middle of the page
    means those elements never intersect at any observed frame and their reveals
    never fire. Asserting opacity after a jump would manufacture stranded
    elements that no reader would ever see. Stepping is what makes the
    assertion trustworthy.

    Each step is an INSTANT scroll followed by a real dwell, so the dwell is
    time the observers actually get rather than time spent animating there.
    """
    steps = 0
    for _ in range(MAX_STEPS):
        y, ih, sh = driver.execute_script(
            "var d=document.documentElement;"
            "return [window.pageYOffset, window.innerHeight, d.scrollHeight]")
        if y + ih >= sh - 2:
            break
        scroll_to_instant(driver, y + int(ih * 0.8))
        after = driver.execute_script("return window.pageYOffset")
        steps += 1
        time.sleep(STEP_MS / 1000.0)
        if after <= y:
            break
    scroll_to_instant(driver, driver.execute_script(
        "return document.documentElement.scrollHeight"))
    time.sleep(BOTTOM_SETTLE_MS / 1000.0)
    return steps


# ---------------------------------------------------------------------------
# ink measurement — shared by every engine
# ---------------------------------------------------------------------------
def ink_extent(png_path, threshold=128):
    """Bounding box of dark pixels in a screenshot, normalised to CSS pixels.

    Every engine's descender screenshots are analysed by THIS function, so a
    difference in the verdict is a difference in rendering rather than a
    difference in measurement. Normalising by device pixel ratio is what makes
    a 2x WebKit shot comparable to a 1x Firefox shot.
    """
    try:
        from PIL import Image
    except ImportError:
        return {"error": "PIL not available"}
    try:
        im = Image.open(png_path).convert("L")
    except Exception as e:
        return {"error": str(e)[:200]}
    w, h = im.size
    mask = im.point(lambda v: 255 if v < threshold else 0)
    bbox = mask.getbbox()
    if not bbox:
        return {"imageSize": [w, h], "hasInk": False}
    left, top, right, bottom = bbox
    return {
        "imageSize": [w, h],
        "hasInk": True,
        "inkTopPx": top,
        "inkBottomPx": bottom,
        "inkHeightPx": bottom - top,
        "coveragePct": round(100.0 * (bottom - top) / h, 2) if h else None,
    }


def analyse_descenders(shots, css_cell_height=None):
    """Turn three screenshots into a defensible yes/no on descender clipping.

    control  : overflow visible          — unclipped truth
    masked   : clip + 0.2em clip margin  — what the site ships
    nomargin : clip, no clip margin      — what Safari < 16.4 renders, since it
                                           drops the unknown property and keeps
                                           the clip

    `nomargin` is a POSITIVE CONTROL. If it does not measurably lose ink
    relative to `control`, then this measurement cannot detect clipping at all
    and the verdict for `masked` is reported as inconclusive rather than as a
    pass. A test that cannot fail proves nothing.
    """
    res = {"shots": {}, "verdict": "inconclusive", "reason": None}
    ext = {}
    for key, path in (shots or {}).items():
        if not path or not os.path.exists(path):
            continue
        ext[key] = ink_extent(path)
        res["shots"][key] = ext[key]

    if not all(k in ext and ext[k].get("hasInk") for k in ("control", "masked", "nomargin")):
        res["reason"] = "missing or ink-free screenshots for one or more variants"
        return res

    # Normalise to the image height of each shot: all three cells are built
    # identically, so their images share dimensions and a raw row index is
    # already comparable. Guard anyway.
    heights = {k: ext[k]["imageSize"][1] for k in ("control", "masked", "nomargin")}
    if len(set(heights.values())) != 1:
        res["reason"] = "variant screenshots differ in height (%s)" % heights
        return res

    scale = 1.0
    if css_cell_height:
        scale = ext["control"]["imageSize"][1] / float(css_cell_height)
    res["devicePixelScale"] = round(scale, 3)

    ctrl_b = ext["control"]["inkBottomPx"]
    mask_b = ext["masked"]["inkBottomPx"]
    nom_b = ext["nomargin"]["inkBottomPx"]
    tol = max(1.0, 1.5 * scale)   # ~1.5 CSS px of antialiasing slack

    res["inkBottom"] = {"control": ctrl_b, "masked": mask_b, "nomargin": nom_b}
    res["lostVsControlPx"] = {
        "masked": round(ctrl_b - mask_b, 2),
        "nomargin": round(ctrl_b - nom_b, 2),
    }
    res["tolerancePx"] = round(tol, 2)

    sensitive = (ctrl_b - nom_b) > tol
    res["positiveControlFired"] = sensitive
    if not sensitive:
        res["reason"] = (
            "positive control did not clip: `overflow:clip` with no clip margin "
            "lost only %.1fpx vs control (tolerance %.1fpx), so this measurement "
            "cannot detect descender clipping here — verdict withheld"
            % (ctrl_b - nom_b, tol))
        return res

    if (ctrl_b - mask_b) > tol:
        res["verdict"] = "masked-clips-descenders"
        res["reason"] = (
            "shipped mask lost %.1fpx of descender ink vs unclipped control "
            "(tolerance %.1fpx); positive control lost %.1fpx"
            % (ctrl_b - mask_b, tol, ctrl_b - nom_b))
    else:
        res["verdict"] = "masked-preserves-descenders"
        res["reason"] = (
            "shipped mask matches unclipped control within %.1fpx, while the "
            "no-clip-margin control lost %.1fpx — overflow-clip-margin is doing "
            "its job in this engine" % (tol, ctrl_b - nom_b))
    return res


# ---------------------------------------------------------------------------
# Selenium engines
# ---------------------------------------------------------------------------
def build_selenium_driver(engine, width, height, headless):
    from selenium import webdriver

    if engine == "chrome":
        from selenium.webdriver.chrome.options import Options
        o = Options()
        if headless:
            o.add_argument("--headless=new")
        o.add_argument("--window-size=%d,%d" % (width, height))
        o.add_argument("--no-first-run")
        o.add_argument("--disable-features=Translate")
        o.enable_bidi = True
        return webdriver.Chrome(options=o)

    if engine == "firefox":
        from selenium.webdriver.firefox.options import Options
        o = Options()
        if headless:
            o.add_argument("-headless")
        # NO --width/--height here, deliberately. Those set the OUTER window
        # (1440 outer gives a 1222px viewport, since headless Firefox still
        # reserves chrome), and worse, Firefox re-asserts that preferred size
        # later in the run — which silently reverted normalize_viewport's
        # correction mid-page. The first baseline measured index.html at 1222px
        # in Firefox and 1440px in Chrome, making every width delta look like an
        # engine difference when it was the harness. set_window_rect alone
        # converges and holds.
        o.enable_bidi = True
        return webdriver.Firefox(options=o)

    if engine == "safari":
        from selenium.webdriver.safari.options import Options
        o = Options()
        # Safari has no headless mode and no BiDi via safaridriver; console
        # capture for this engine would be weaker even if it could be driven.
        return webdriver.Safari(options=o)

    raise ValueError("unknown selenium engine: %s" % engine)


def attach_log_handlers(driver, sink):
    """Wire BiDi log capture. Must happen BEFORE the first navigation.

    geckodriver does not implement the legacy `get_log('browser')` endpoint, so
    BiDi is the only way to read Firefox's console. Using it for Chrome too
    keeps the definition of "severe" identical across both engines instead of
    comparing CDP logs against BiDi logs.
    """
    status = {"javascriptError": False, "consoleMessage": False, "errors": []}
    try:
        driver.script.add_javascript_error_handler(
            lambda e: sink.append({
                "kind": "javascriptError",
                "level": "error",
                "text": str(getattr(e, "text", None) or e)[:400],
            }))
        status["javascriptError"] = True
    except Exception as e:
        status["errors"].append("javascriptError: %s" % str(e)[:200])
    try:
        driver.script.add_console_message_handler(
            lambda m: sink.append({
                "kind": "consoleMessage",
                "level": str(getattr(m, "level", "") or ""),
                "text": str(getattr(m, "text", None) or m)[:400],
            }))
        status["consoleMessage"] = True
    except Exception as e:
        status["errors"].append("consoleMessage: %s" % str(e)[:200])
    return status


def severe_only(entries):
    """Severe == uncaught JS exception, or a console message at error level.

    Warnings and info are excluded: they are noise for this purpose and would
    drown the signal the harness is looking for.
    """
    out = []
    for e in entries:
        if is_noise(e.get("text")):
            continue
        lvl = (e.get("level") or "").lower()
        if e.get("kind") == "javascriptError" or lvl in ("error", "severe"):
            out.append(e)
    return out


def run_selenium_engine(engine, base, pages, width, height, headless, shots_dir):
    probe_src = load_probe()
    result = {"engine": engine, "driver": "selenium", "status": "ok",
              "engineIsShippingSafari": engine == "safari",
              "viewport": {"width": width, "height": height},
              "timing": {"settleMs": SETTLE_MS, "stepMs": STEP_MS,
                         "bottomSettleMs": BOTTOM_SETTLE_MS},
              "pages": {}}

    try:
        driver = build_selenium_driver(engine, width, height, headless)
    except Exception as e:
        result["status"] = "unavailable"
        result["reason"] = "%s: %s" % (type(e).__name__, str(e)[:400])
        return result

    log_sink = []
    result["logCapture"] = attach_log_handlers(driver, log_sink)

    try:
        result["browserVersion"] = driver.capabilities.get("browserVersion")
        result["driverInfo"] = {
            k: v for k, v in driver.capabilities.items()
            if k in ("chrome", "moz:geckodriverVersion", "safari:platformVersion",
                     "platformName", "browserName")
        }
    except Exception:
        pass

    try:
        for page in pages:
            url = "%s/%s" % (base.rstrip("/"), page)
            entry = {"url": url, "ok": False}
            seen_before = len(log_sink)
            try:
                driver.get(url)
                # Poll for load rather than a blind sleep so a slow engine is
                # not measured mid-parse.
                for _ in range(50):
                    if driver.execute_script("return document.readyState") == "complete":
                        break
                    time.sleep(0.1)
                entry["viewportNormalisation"] = normalize_viewport(driver, width, height)

                # Install the live-mask recorder BEFORE scrolling. The real
                # .srline-mask nodes exist only for the ~1s of their tween and
                # are gone by the time any audit runs, so they can only be
                # observed as they are inserted.
                try:
                    entry["maskRecorder"] = driver.execute_script(
                        "return (%s)()" % load_js(MASK_RECORDER_PATH))
                except Exception as e:
                    entry["maskRecorder"] = "failed: %s" % str(e)[:200]

                time.sleep(SETTLE_MS / 1000.0)
                entry["scrollSteps"] = scroll_through(driver)

                try:
                    entry["liveMasks"] = driver.execute_script(
                        "return {samples: (window.__ovMasks||[]), "
                        "stats: (window.__ovMaskStats||null)}")
                except Exception as e:
                    entry["liveMasks"] = {"error": str(e)[:200]}

                audit = driver.execute_script(
                    "return (%s)(arguments[0])" % probe_src, {})
                entry["audit"] = audit

                # Verify the viewport the PROBE actually saw, not the one that
                # was set before scrolling. Those turned out to be different in
                # Firefox, and a silent 218px drift makes every cross-engine
                # width delta meaningless. Metrics measured at the wrong size
                # are marked not-comparable rather than quietly reported.
                probe_w = (audit.get("env") or {}).get("innerWidth")
                probe_h = (audit.get("env") or {}).get("innerHeight")
                drift = (probe_w is not None and
                         (abs(probe_w - width) > 1 or abs(probe_h - height) > 1))
                entry["viewportAtProbe"] = [probe_w, probe_h]
                entry["viewportDrifted"] = drift
                entry["metricsComparable"] = not drift
                if drift:
                    entry["viewportDriftNote"] = (
                        "viewport was %sx%s when the probe ran but %sx%s was "
                        "requested; keyMetrics for this page are NOT comparable "
                        "with other engines"
                        % (probe_w, probe_h, width, height))

                # Descender screenshots: back to the top first, since the probe
                # parks its cells at document 0,0. This MUST be an instant,
                # confirmed scroll — a smooth glide from the bottom of the
                # travel page takes well over a second and the capture would
                # land on empty background.
                scroll_to_instant(driver, 0)
                time.sleep(0.3)
                entry["descenderShots"] = {}
                for key in ("control", "masked", "nomargin"):
                    try:
                        el = driver.find_element("id", "__ov_cell_%s" % key)
                        out = os.path.join(
                            shots_dir, "%s_%s_%s.png" %
                            (engine, page.replace(".", "_"), key))
                        png = el.screenshot_as_png
                        with open(out, "wb") as fh:
                            fh.write(png)
                        entry["descenderShots"][key] = out
                    except Exception as e:
                        entry.setdefault("descenderShotErrors", []).append(
                            "%s: %s" % (key, str(e)[:200]))
                driver.execute_script(
                    "var n=document.getElementById('__ov_descender_probe');"
                    "if(n&&n.parentNode)n.parentNode.removeChild(n);")
                entry["ok"] = True
            except Exception as e:
                entry["error"] = "%s: %s" % (type(e).__name__, str(e)[:400])

            # Let async BiDi log events land before slicing them off.
            time.sleep(0.4)
            raw = log_sink[seen_before:]
            entry["severeConsole"] = severe_only(raw)
            entry["severeCount"] = len(entry["severeConsole"])
            entry["allLogCount"] = len(raw)
            result["pages"][page] = entry
    finally:
        try:
            driver.quit()
        except Exception:
            pass
    return result


# ---------------------------------------------------------------------------
# WebKit engine (Playwright, via node)
# ---------------------------------------------------------------------------
def run_webkit_engine(base, pages, width, height, shots_dir, pw_prefix):
    node = shutil.which("node")
    if not node:
        return {"engine": "webkit", "status": "unavailable",
                "reason": "node not on PATH; required to drive Playwright WebKit"}
    if not (Path(pw_prefix) / "node_modules" / "playwright").exists():
        return {"engine": "webkit", "status": "unavailable",
                "reason": ("playwright not installed at %s — run: "
                           "mkdir -p %s && cd %s && npm init -y && "
                           "npm i playwright@1.56.0 && npx playwright install webkit"
                           % (pw_prefix, pw_prefix, pw_prefix))}
    cmd = [node, str(WEBKIT_RUNNER),
           "--base", base, "--pages", ",".join(pages),
           "--shots", shots_dir, "--probe", str(PROBE_PATH),
           "--width", str(width), "--height", str(height),
           "--settle", str(SETTLE_MS), "--step", str(STEP_MS),
           "--bottom-settle", str(BOTTOM_SETTLE_MS)]
    env = dict(os.environ, OV_PW_PREFIX=pw_prefix)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=900, env=env)
    except subprocess.TimeoutExpired:
        return {"engine": "webkit", "status": "unavailable",
                "reason": "webkit_runner.mjs timed out after 900s"}
    if not proc.stdout.strip():
        return {"engine": "webkit", "status": "unavailable",
                "reason": "webkit_runner.mjs produced no output; stderr: %s"
                          % proc.stderr[-400:]}
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        return {"engine": "webkit", "status": "unavailable",
                "reason": "unparseable runner output (%s); stderr: %s"
                          % (e, proc.stderr[-300:])}
    if "fatal" in data:
        data["status"] = "unavailable"
        data["reason"] = data["fatal"][:400]
        return data

    data["status"] = "ok"
    data["stderrTail"] = proc.stderr[-600:] if proc.stderr else ""
    # Reshape the runner's console fields onto the same key the Selenium path
    # uses, so downstream verdict code has exactly one shape to handle.
    for page, entry in data.get("pages", {}).items():
        severe = []
        for e in entry.get("pageErrors", []) + entry.get("consoleErrors", []):
            if not is_noise(e.get("text")):
                severe.append({"kind": e.get("level"), "level": "error",
                               "text": e.get("text")})
        entry["severeConsole"] = severe
        entry["severeCount"] = len(severe)
    return data


# ---------------------------------------------------------------------------
# verdicts
# ---------------------------------------------------------------------------
def page_verdicts(entry):
    """Reduce one page's audit to named pass/fail checks.

    A check whose input is missing is UNKNOWN, never a pass. Silence is not
    evidence of correctness.
    """
    v = {}
    audit = entry.get("audit") or {}

    if not entry.get("ok"):
        return {k: "UNKNOWN" for k in
                ("console", "overflow", "stranded", "libs", "clipMarginSupport",
                 "viewport")}

    v["console"] = "PASS" if entry.get("severeCount", 0) == 0 else "FAIL"

    # Not a site check — a trust check on the run itself. If the viewport was not
    # what was asked for, the layout numbers cannot be compared across engines
    # and that has to be visible in the table rather than buried in JSON.
    if entry.get("viewportDrifted"):
        v["viewport"] = "DRIFT"
    else:
        v["viewport"] = "PASS"

    ho = audit.get("horizontalOverflow") or {}
    if not ho:
        v["overflow"] = "UNKNOWN"
    else:
        v["overflow"] = "FAIL" if ho.get("hasHorizontalOverflow") else "PASS"

    st = audit.get("stranded") or {}
    if not st:
        v["stranded"] = "UNKNOWN"
    else:
        v["stranded"] = "FAIL" if st.get("hasStranded") else "PASS"

    libs = audit.get("libs") or {}
    required = ("gsap", "anime", "Motion", "ScrollTrigger")
    if not libs:
        v["libs"] = "UNKNOWN"
    else:
        missing = [k for k in required if not (libs.get(k) or {}).get("loaded")]
        v["libs"] = "PASS" if not missing else "FAIL"
        if missing:
            v["libsMissing"] = missing

    css = audit.get("cssSupport") or {}
    if "overflow-clip-margin:0.2em" not in css:
        v["clipMarginSupport"] = "UNKNOWN"
    else:
        v["clipMarginSupport"] = "PASS" if css["overflow-clip-margin:0.2em"] else "FAIL"

    return v


def summarise(results):
    rows = []
    any_real_failure = False
    drivable = 0
    for engine, res in results.items():
        if res.get("status") != "ok":
            rows.append({"engine": engine, "status": res.get("status", "unavailable"),
                         "reason": res.get("reason", ""), "pages": {}})
            continue
        drivable += 1
        prow = {}
        for page, entry in res.get("pages", {}).items():
            v = page_verdicts(entry)
            prow[page] = v
            if any(val == "FAIL" for val in v.values()):
                any_real_failure = True
        rows.append({"engine": engine, "status": "ok",
                     "browserVersion": res.get("browserVersion")
                                       or res.get("webkitVersion"),
                     "pages": prow})
    return rows, any_real_failure, drivable


CHECKS = ["console", "overflow", "stranded", "libs", "clipMarginSupport", "viewport"]


def print_table(rows):
    print("\n" + "=" * 108)
    print("PER-ENGINE RESULTS")
    print("=" * 108)
    print("%-9s %-14s %-8s %-9s %-9s %-6s %-6s %-8s %-16s" % (
        "engine", "page", "console", "overflow", "stranded", "libs",
        "clipm", "viewport", "version"))
    print("-" * 108)
    for r in rows:
        if r["status"] != "ok":
            print("%-9s %-14s %s" % (r["engine"], "-", "UNAVAILABLE / UNTESTED"))
            print("%-9s %-14s reason: %s" % ("", "", (r.get("reason") or "")[:200]))
            continue
        for page, v in r["pages"].items():
            print("%-9s %-14s %-8s %-9s %-9s %-6s %-6s %-8s %-16s" % (
                r["engine"], page, v.get("console", "?"), v.get("overflow", "?"),
                v.get("stranded", "?"), v.get("libs", "?"),
                v.get("clipMarginSupport", "?"), v.get("viewport", "?"),
                r.get("browserVersion") or ""))
    print("-" * 108)


def print_details(results):
    for engine, res in results.items():
        if res.get("status") != "ok":
            continue
        for page, entry in res.get("pages", {}).items():
            audit = entry.get("audit") or {}
            head = "%s / %s" % (engine, page)
            issues = []

            for e in entry.get("severeConsole", []):
                issues.append("console[%s]: %s" % (e.get("level"), e.get("text")))

            ho = audit.get("horizontalOverflow") or {}
            if ho.get("hasHorizontalOverflow"):
                issues.append(
                    "overflow: scrollWidth signal=%s (clamped by overflow-x:hidden=%s), "
                    "worst right-edge overhang=%spx across %s element(s)" % (
                        ho.get("scrollWidthExceedsClientWidth"),
                        ho.get("clampedByOverflowXHidden"),
                        ho.get("worstOverhangPx"), ho.get("offenderCount")))
                for o in (ho.get("offenders") or [])[:5]:
                    issues.append("   overhang %spx  %s  '%s'"
                                  % (o.get("overhangPx"), o.get("el"), o.get("text")))

            st = audit.get("stranded") or {}
            if st.get("hasStranded"):
                issues.append("stranded: %s of %s rendered elements below opacity %s"
                              % (st.get("totalStranded"), st.get("totalRendered"),
                                 st.get("opacityMin")))
                for s in (st.get("examples") or [])[:8]:
                    issues.append(
                        "   %s  own=%s eff=%s docTop=%s  '%s'" % (
                            s.get("el"), s.get("ownOpacity"),
                            s.get("effectiveOpacity"), s.get("docTop"),
                            s.get("text")))

            libs = audit.get("libs") or {}
            missing = [k for k in ("gsap", "anime", "Motion", "ScrollTrigger")
                       if not (libs.get(k) or {}).get("loaded")]
            if missing:
                issues.append("libs NOT loaded: %s" % ", ".join(missing))

            for rf in (audit.get("resourceFailures") or []):
                issues.append("resource: %s" % json.dumps(rf))

            hov = audit.get("hoverAffordances") or {}
            if hov.get("liveRiskCount"):
                issues.append("hover-gated visibility rules matching live markup: %s"
                              % hov.get("liveRiskCount"))
                for h in (hov.get("risks") or [])[:5]:
                    if h.get("matchesOnPage"):
                        issues.append("   %s gates %s (%s nodes)"
                                      % (h.get("selector"), h.get("gates"),
                                         h.get("matchesOnPage")))

            if entry.get("viewportDrifted"):
                issues.append("VIEWPORT DRIFT: %s" % entry.get("viewportDriftNote"))

            if entry.get("error"):
                issues.append("DRIVER ERROR: %s" % entry["error"])

            if issues:
                print("\n--- %s ---" % head)
                for i in issues:
                    print("  " + i)


def print_clip_report(results):
    print("\n" + "=" * 100)
    print("overflow-clip-margin / SplitText descender-mask investigation")
    print("=" * 100)
    for engine, res in results.items():
        if res.get("status") != "ok":
            print("%-9s UNTESTED (%s)" % (engine, (res.get("reason") or "")[:70]))
            continue
        ver = res.get("browserVersion") or res.get("webkitVersion") or "?"
        shipping = res.get("engineIsShippingSafari")
        print("\n%s (version %s)%s" % (
            engine, ver,
            "" if shipping is not False or engine != "webkit"
            else "  [WebKit engine, NOT the installed Safari binary]"))
        for page, entry in res.get("pages", {}).items():
            audit = entry.get("audit") or {}
            css = audit.get("cssSupport") or {}
            comp = css.get("computed") or {}
            dp = audit.get("descenderProbe") or {}
            an = entry.get("descenderAnalysis") or {}
            print("  %-14s CSS.supports=%s  computed=%r (%spx)  honoured=%s  "
                  "matches-0.2em=%s  srline-masks-live=%s"
                  % (page, css.get("overflow-clip-margin:0.2em"),
                     comp.get("overflowClipMargin"),
                     comp.get("overflowClipMarginPx"), comp.get("honoured"),
                     comp.get("matchesExpected0_2em"),
                     (audit.get("revealState") or {}).get("srlineMasks")))
            if an:
                print("                 verdict=%s" % an.get("verdict"))
                print("                 %s" % (an.get("reason") or ""))
                if an.get("inkBottom"):
                    print("                 ink bottom row  control=%s masked=%s "
                          "nomargin=%s  (tolerance %spx)"
                          % (an["inkBottom"].get("control"),
                             an["inkBottom"].get("masked"),
                             an["inkBottom"].get("nomargin"),
                             an.get("tolerancePx")))
            if dp.get("displayFontLoaded") is not None:
                df = dp.get("displayFont") or {}
                print("                 synthetic probe: font-size=%spx  "
                      "Space Grotesk active=%s (advance width %s vs fallback %s, "
                      "fonts.check@700=%s @400=%s)"
                      % (dp.get("fontSize"), dp.get("displayFontLoaded"),
                         df.get("widthWithFamily"), df.get("widthFallback"),
                         df.get("checkAt700"), df.get("checkAt400")))
            if dp.get("error"):
                print("                 probe error: %s" % dp["error"])

            # The live masks are the real question; the synthetic probe only
            # establishes that the engine honours the property at all.
            lm = entry.get("liveMasks") or {}
            samples = lm.get("samples") or []
            stats = lm.get("stats") or {}
            if lm.get("error"):
                print("                 live .srline-mask capture failed: %s" % lm["error"])
            elif not samples:
                print("                 live .srline-mask nodes observed: 0 "
                      "(inserted=%s) — the shipped masks were NOT exercised on "
                      "this page, so the real-mask question is unanswered here"
                      % stats.get("inserted"))
            else:
                margins = {}
                for s in samples:
                    src = s.get("atRaf") or s.get("atInsert") or {}
                    key = (src.get("overflow"), src.get("overflowClipMargin"))
                    margins[key] = margins.get(key, 0) + 1
                print("                 live .srline-mask nodes observed: %s "
                      "(inserted=%s, vanished-before-raf=%s)"
                      % (len(samples), stats.get("inserted"),
                         stats.get("vanishedBeforeRaf")))
                for (ovf, clip), n in sorted(margins.items(), key=lambda kv: -kv[1]):
                    zero = clip in (None, "", "0px")
                    print("                   %sx  overflow=%r  clip-margin=%r%s"
                          % (n, ovf, clip,
                             "   <-- NO CLIP MARGIN: descenders would shave"
                             if zero else ""))
                first = samples[0].get("atRaf") or samples[0].get("atInsert") or {}
                print("                   sample geometry: mask=%spx inner-line=%spx "
                      "font=%s  text=%r"
                      % (first.get("maskHeight"), first.get("innerHeight"),
                         first.get("fontSize"), first.get("text")))
                print("                   SplitText inline style: %r"
                      % (first.get("inlineStyle") or "")[:120])


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Cross-engine verification harness (see module docstring).")
    ap.add_argument("--base", required=True,
                    help="base URL serving dist/, e.g. http://127.0.0.1:8899")
    ap.add_argument("--pages", default=",".join(DEFAULT_PAGES))
    ap.add_argument("--engines", default="chrome,firefox,safari,webkit")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--headed", action="store_true",
                    help="run Chrome/Firefox with a visible window")
    ap.add_argument("--shots", default="/tmp/ov-shots")
    ap.add_argument("--pw-prefix", default=os.environ.get("OV_PW_PREFIX", "/tmp/pw-webkit"))
    ap.add_argument("--json", default=None, help="write full results JSON here")
    ap.add_argument("--clip-report", action="store_true",
                    help="print the overflow-clip-margin investigation")
    args = ap.parse_args()

    pages = [p.strip() for p in args.pages.split(",") if p.strip()]
    engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    os.makedirs(args.shots, exist_ok=True)

    results = {}
    for engine in engines:
        print("[harness] running engine: %s" % engine, file=sys.stderr)
        t0 = time.time()
        if engine == "webkit":
            res = run_webkit_engine(args.base, pages, args.width, args.height,
                                    args.shots, args.pw_prefix)
        elif engine in ("chrome", "firefox", "safari"):
            res = run_selenium_engine(engine, args.base, pages, args.width,
                                      args.height, not args.headed, args.shots)
        else:
            res = {"engine": engine, "status": "unavailable",
                   "reason": "unknown engine name"}
        res["elapsedSec"] = round(time.time() - t0, 1)
        if res.get("status") != "ok":
            print("[harness]   %s UNAVAILABLE: %s"
                  % (engine, (res.get("reason") or "")[:200]), file=sys.stderr)

        # Ink analysis runs here, in one place, for every engine.
        for page, entry in (res.get("pages") or {}).items():
            shots = entry.get("descenderShots") or {}
            if shots:
                cells = ((entry.get("audit") or {})
                         .get("descenderProbe") or {}).get("cells") or {}
                css_h = (cells.get("control") or {}).get("height")
                entry["descenderAnalysis"] = analyse_descenders(shots, css_h)
        results[engine] = res

    rows, any_fail, drivable = summarise(results)
    print_table(rows)
    print_details(results)
    if args.clip_report:
        print_clip_report(results)

    untested = [r["engine"] for r in rows if r["status"] != "ok"]
    print("\n" + "=" * 100)
    print("ENGINES DRIVEN: %d  (%s)" % (
        drivable, ", ".join(r["engine"] for r in rows if r["status"] == "ok") or "none"))
    if untested:
        print("ENGINES UNTESTED: %s" % ", ".join(untested))
        print("  An untested engine is neither a pass nor a failure. Do not")
        print("  report it as verified.")
    print("=" * 100)

    if args.json:
        payload = {"results": results, "summary": rows,
                   "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                   "base": args.base, "pages": pages,
                   "timing": {"settleMs": SETTLE_MS, "stepMs": STEP_MS,
                              "bottomSettleMs": BOTTOM_SETTLE_MS}}
        Path(args.json).write_text(json.dumps(payload, indent=2))
        print("full results: %s" % args.json)

    if drivable == 0:
        return 2
    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main())
