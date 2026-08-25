# `tools/` — cross-browser and touch verification harness

This site ships five animation scripts — GSAP + ScrollTrigger, SplitText, Draggable,
anime.js, and `motion-shim.js` — and, before this harness existed, had only ever been
exercised in **headless Chrome**. Everything here exists to close that gap: to find what
one engine does and another does not, and — just as importantly — to be explicit about
which engines were genuinely driven and which were not.

> `motion-shim.js` is OURS: a ~5KB-brotli reimplementation of the four Motion APIs this
> site actually uses, which replaced the vendored 136KB `motion.min.js`. It still defines
> `window.Motion`, so the `libs` check below is unchanged — but "Motion is present" no
> longer means a third-party bundle loaded. `InertiaPlugin.min.js` is likewise gone: the
> throw it existed for was replaced by a swap.

These tools **measure only**. They never modify site files. The one thing they add to a
page is a detached measurement node, which they remove again.

---

## Prerequisites

```bash
# Python + Selenium 4.46 (drives Chrome, Firefox, and — if enabled — Safari)
PY=~/personal/finance/finance/.venv/bin/python
$PY -c "import selenium, PIL; print(selenium.__version__)"   # 4.46.0, PIL required

# Playwright's WebKit, installed OUTSIDE the repo so a 70 MB browser download
# never becomes a dependency of the site itself.
mkdir -p /tmp/pw-webkit && cd /tmp/pw-webkit
npm init -y && npm i playwright@1.56.0
npx playwright install webkit
```

Chrome and Firefox drivers are fetched automatically by Selenium Manager; nothing to
install by hand.

## Serving the build

Both harnesses test the **built output**, not the dev server:

```bash
npm run build
cd .vercel/output/static && python3 -m http.server 8020
```

**The static build is in `.vercel/output/static`, NOT `dist/`.** `dist/` contains only a
`client/` subdirectory, so serving `dist/` itself returns 404 for every path — which looks
exactly like a broken build. (`dist/client` happens to hold the same file list today, but
it is the adapter's intermediate; `.vercel/output/static` is what deploys.)

**Restart the server after every build.** A build deletes and recreates that directory, so
a long-running `http.server` goes on serving the old unlinked inode and 404s every path
while the new files sit on disk. Several minutes were once spent debugging this as a build
failure.

Port **8020** is not arbitrary — it is the default every tool here falls back to when given
no base. Serving on a different port means passing `--base`/`[base]` to every invocation.

---

## 1. `crossbrowser.py` — per-engine page audit

```bash
$PY tools/crossbrowser.py --base http://127.0.0.1:8020 --clip-report \
    --json /tmp/ov-cross.json

# subsets
$PY tools/crossbrowser.py --base http://127.0.0.1:8020 --engines chrome,webkit
$PY tools/crossbrowser.py --base http://127.0.0.1:8020 --pages travel/
$PY tools/crossbrowser.py --base http://127.0.0.1:8020 --headed        # watch it
$PY tools/crossbrowser.py --base http://127.0.0.1:8020 --width 1280 --height 800
```

Checks `/`, `/projects/` and `/travel/` in each available engine — **directory format**,
which is what `--pages` expects (`""`, `projects/`, `travel/`). A `.html` page name is not
a shorthand here: the Vercel adapter emits directory URLs, so `travel.html` 404s on the
static server and 301s in production.

| check | what it means |
|---|---|
| `console` | no uncaught exceptions and no `console.error` during load + full scroll |
| `overflow` | no horizontal overflow (see the caveat below — this one is subtle) |
| `stranded` | after scrolling to the bottom, every rendered `.reveal` / `.pass` / `.case-block` / `h1` / `h2` is at opacity >= 0.99 |
| `libs` | `window.gsap`, `window.anime`, `window.Motion`, `window.ScrollTrigger` all present |
| `clipm` | the engine supports `overflow-clip-margin` |
| `viewport` | **a check on the run, not on the site.** `PASS` means the probe really ran at the requested viewport; `DRIFT` means it did not, and that page's `keyMetrics` are flagged `metricsComparable: false` |

It also records **key layout metrics** — geometry plus font metrics for a fixed list of
landmarks — so engines can be diffed numerically instead of by eye. Selectors that match
nothing are reported as `present: false` rather than dropped, so every engine's JSON has
the same shape.

**Exit codes:** `0` everything driven passed · `1` a real failure · `2` no engine could be
driven at all. An engine reported `unavailable` does **not** produce a failure code —
untested is neither pass nor fail.

### Engines

| engine | driver | what it actually is |
|---|---|---|
| `chrome` | Selenium + chromedriver | real Chrome |
| `firefox` | Selenium + geckodriver | real Firefox |
| `safari` | Selenium + safaridriver | the **installed Safari**. Needs `safaridriver --enable`, which is sudo-gated. When not enabled the engine reports `unavailable` with the reason and is never counted as a pass. |
| `webkit` | Playwright | **WebKit, not Safari.** Same engine family as the installed Safari, different binary. Flagged `engineIsShippingSafari: false` in the output. |

### Three details that are easy to get wrong

**Scrolling must come before the opacity assertion, and it must be stepped.**
An element at opacity 0 below the fold is waiting for its scroll observer, not broken —
asserting on it would be a guaranteed false positive. So the harness scrolls the whole
page first, then asserts. But it steps down in viewport-sized increments rather than
jumping to the end: `IntersectionObserver` only evaluates the state it is handed, so
teleporting past the middle of a page means those elements never intersect at any observed
frame and their reveals never fire. A jump-to-bottom would manufacture "stranded" elements
that no real reader would ever see.

**`html { scroll-behavior: smooth }` makes every programmatic scroll asynchronous.**
This bit the first version of this harness: `scrollTo` returned immediately, the page was
still gliding, and a screenshot taken 300 ms later captured plain background. Every scroll
here uses `behavior: 'instant'` **and** then polls until the scroll position stops moving,
so an engine that ignores the override is waited out rather than measured mid-flight.

**The viewport must be verified at probe time, not just at setup.**
Firefox's `--width`/`--height` arguments set the *outer* window — 1440 outer yields a
1222px viewport — and Firefox then re-asserts that preferred size partway through the run,
silently undoing `set_window_rect`. The first baseline consequently measured `index.html`
at 1222px in Firefox and 1440px in Chrome, which made a 100px content-width difference and
a 79.7px-vs-89.9px heading size look like genuine engine divergence. They were the
harness. Firefox is now sized by `set_window_rect` alone, and the width the probe actually
observed is recorded and compared, so a drift of this kind surfaces as `DRIFT` instead of
as a fake finding. With that fixed, Firefox and Chrome agree to within 3px on every
landmark.

**`body { overflow-x: hidden }` clamps `scrollWidth`.**
The requested `scrollWidth > clientWidth` comparison is reported verbatim, but on this
site it is suppressed by design — the scrolling box cannot grow, so the number stays
clean even when content genuinely hangs off the edge. A geometric right-edge sweep
therefore runs alongside it, and it is the sweep that decides the verdict.

That sweep classifies what it finds, because this site paints deliberately oversized
ambient art (`.glow`, `.atmosphere`, the `shape-field` SVGs) that is *meant* to bleed past
the viewport and be clipped. Those are recorded as `decorativeOffenders` and reported but
not failed; only overhanging **content** (text, or anything interactive) counts against
the verdict. Elements that scroll their own content horizontally are recorded as
`intentionalScrollers` and never failed.

---

## 2. `touch.py` — real touch emulation via Chrome CDP

```bash
$PY tools/touch.py --base http://127.0.0.1:8020 --json /tmp/ov-touch.json
$PY tools/touch.py --base http://127.0.0.1:8020 --device iphone14,small360
$PY tools/touch.py --base http://127.0.0.1:8020 --headed
```

Devices: `iphone14` (390x844 @3x), `iphonese` (375x667 @2x), `pixel7` (412x915 @2.625x),
`small360` (360x740 @3x — below the site's 420px breakpoint).

### Why CDP and not a small window

**Headless Chrome will not shrink its window below roughly 500 CSS px.** Ask for a 390px
window and you get ~500px: the 760px mobile breakpoint still matches, the page looks
plausible, and the test has proved nothing about a phone. Worse, a small *window* has no
touch input at all — the hamburger would be driven by a synthetic mouse click, so "the nav
opens on tap" would be a claim about mice.

So this harness uses `Emulation.setDeviceMetricsOverride` with `mobile: true`,
`Emulation.setTouchEmulationEnabled`, `Emulation.setUserAgentOverride`, and
`Input.dispatchTouchEvent` for genuine `touchstart`/`touchmove`/`touchend` streams. The
override is honoured independently of the OS window, so 390px means 390px.

**It asserts the override took effect before measuring anything.** If `innerWidth` does
not match, or `maxTouchPoints` is 0, or `(any-hover: hover)` is still true, the run fails
loudly and reports no per-check results — a viewport that silently clamped would produce a
desktop measurement wearing a phone's name, and a fake pass is worse than no data.

### What it verifies

1. **The override is real** — `innerWidth`, touch points, coarse pointer, `any-hover: none`, breakpoint engaged.
2. **Nav toggle opens and closes by TAP** — dispatched touch only, asserting `aria-expanded`, `.nav-links.is-open`, `body.nav-open`, opacity and visibility; and that the revealed links are actually hit-testable at their centres, because a panel that animates in but stays `pointer-events: none` is a dead menu.
3. **The page scrolls by SWIPE** — a 14-step touch drag must move `scrollY`, and the reverse swipe must bring it back, so what was measured is scrolling and not a one-way layout shift.
4. **No hover-only affordance is unreachable** — every visible interactive element must be hit-testable, and any `:hover` rule that *gates visibility* (rather than merely decorating) on markup present in the page is reported, since hover does not exist here.
5. **Tap targets >= 44x44 CSS px** — measured on what is actually visible, in **both** nav states, since the open panel has its own targets and its own overlay.

Elements parked outside the viewport (this site's `.skip-link` sits at `top: -60px` and
slides in only on `:focus`) are excluded from the tap-target check — they are keyboard
affordances, not touch targets — but the exclusion is **printed**, so it can be audited
rather than trusted. Below-the-fold elements are *not* excluded; they become real targets
as soon as the user scrolls.

---

## 3. `overflow-clip-margin` / SplitText descender masks

`--clip-report` settles this specific risk. `.srline-mask` gets `overflow: clip` inline
from SplitText, and `styles.css` adds `overflow-clip-margin: 0.2em` to give Space
Grotesk's descenders room inside a line box that `line-height: 1.0` makes exactly 1em
tall. If the clip margin is not honoured, every `g`, `y`, `p` and `q` is shaved for the
duration of the ~1s tween.

Three independent measurements, per engine:

1. **Capability** — `CSS.supports`, plus a computed-style round-trip on a real element, because a browser can parse a property and then ignore it. The value is parsed numerically, not string-matched: Chrome reports `0.2em` as `3.1875px` (3.2 snapped to 1/16px), and a naive `startsWith("3.2")` reported a working browser as broken.
2. **Rendered effect** — three synthetic line boxes are screenshotted and their ink extents compared:
   - `control` — `overflow: visible`, the unclipped truth
   - `masked` — `overflow: clip` + `overflow-clip-margin: 0.2em`, what the site ships
   - `nomargin` — `overflow: clip` alone, what a browser without the property renders

   `nomargin` is a **positive control**. If it does not measurably lose ink relative to
   `control`, the measurement cannot detect clipping at all and the verdict for `masked` is
   reported as `inconclusive` rather than as a pass. A test that cannot fail proves nothing.
   All engines' screenshots are analysed by one function (`ink_extent`, PIL) so a
   difference in verdict is a difference in rendering, not in measurement.
3. **The real masks** — `mask_recorder.js` installs a `MutationObserver` *before* the
   triggering scroll and samples every real `.srline-mask` as it is inserted. This matters
   because those nodes are transient: SplitText builds them at trigger time and `revert()`
   deletes them on complete, so an audit that runs afterwards finds zero of them and can
   only ever speak about a synthetic replica. Each mask is sampled twice (at insertion and
   on the next frame) since SplitText may set its inline styles after insertion.

The probe also records whether **Space Grotesk actually loaded**, since the fonts come from
Google Fonts over the network and a fallback face has different descender metrics. Note
`document.fonts.check()` needs an explicit weight — called without one it defaults to 400,
which this site never loads, so it reports a perfectly working webfont as missing. An
advance-width comparison against a deliberately non-existent family is used as the real
proof.

---

## Files

| file | role |
|---|---|
| `crossbrowser.py` | engine drivers, verdicts, ink analysis, reporting |
| `touch.py` | CDP touch emulation, tap/swipe primitives, mobile checks |
| `probe.js` | the shared in-page audit — **one** copy of the measurement logic, evaluated identically in every engine |
| `mask_recorder.js` | `MutationObserver` that catches transient `.srline-mask` nodes |
| `webkit_runner.mjs` | WebKit adapter (Playwright/node); runs the same `probe.js` |
| `a11y_chrome.py` | WCAG 2.1 AA audit of the global chrome (nav, palette, drawer, rail, skip link, focus). Takes `--base` |
| `a11y_pixel.py` | contrast measured from RENDERED PIXELS rather than the DOM. Takes `--base` |
| `gate_dir.py` | the merge gate: runs the stated verification bar against a served build. Base is **positional** |
| `golf_sim.py` | offline line-for-line port of the `HeroCanvas` physics, and the **owner of the timestep** (`DT_CLAMP`, `DT_FIRST`, `DEFAULT_FPS`, `resolve_dt`). `Green()` needs `copy_edge` passed |
| `golf_probe.py` | dumps the live page's geometry, `hash2` samples and the **measured roll timestep** to `probe.json` |
| `golf_frames.py` | per-frame browser ball log vs `golf_sim`, and the only honest measurement of the dt the game integrates with |
| `golf_verify_port.py` | proves BOTH ports — `golf_sim`'s scalar field and `golf_sweep`'s numpy one — are bit-equal to the page. Base/safety **positional** |
| `golf_sweep.py` | exhaustive (aim × power) numpy sweep: solvability and difficulty calibration |
| `golf_pick.py` | turns a sweep into browser-replayable trials, deliberately including predicted MISSES |
| `golf_pick_fails.py` | for a round the sweep calls unsolvable, the closest-possible lines, so the claim can be corroborated in a browser instead of trusted |
| `golf_relief.py` | how much of the height variation is undulation vs plane, per undulation setting |
| `golf_validate.py` | replays picked trials in a real browser and scores agreement (physics only — bypasses the pointer path) |
| `golf_keys/stuck/mouse/touch/scroll.py`, `hero_ink.py` | the six input/render harnesses — see the golf section below |

### `tools/suites/` was DELETED 2026-08-25 — recover from git only if you know why

It held the pre-move originals, which had gone stale in a way that failed silently:

- `suites/golfmouse.py`, `golfscroll.py`, `golfstuck.py`, `golftouch.py` hardcoded
  `http://localhost:8123/index.html` with no way to override it — superseded by `golf_mouse.py`,
  `golf_scroll.py`, `golf_stuck.py`, `golf_touch.py`, which are supersets of them.
- `suites/gate.py` was byte-identical to `tools/gate_dir.py` **except** for
  `PAGES = ["index.html", "projects.html", "travel.html"]` — three URLs this build does not serve.
  That is the exact bug `a11y_chrome.py`'s header warns about: `projects.html` once "passed" while
  the page was blank. Use `gate_dir.py`.

Two copies of a harness is worse than one, because the stale copy is the one that reports a pass on
a page that does not exist. `tools/a11y-motion/gate_dir.py` survives on purpose — it is a lane-local
copy differing from `tools/gate_dir.py` only in its default port (8130), kept as that audit's record.

`probe.js` and `mask_recorder.js` are each a single parenthesised function literal, read as
text and evaluated by both drivers. That is deliberate: a harness whose engines ask
different questions cannot attribute a difference to the engine. `probe.js` must stay
**synchronous** — Selenium's `execute_script` does not await promises, so anything async
would silently return `null` in Chrome and Firefox while working in WebKit, which is
exactly the cross-engine asymmetry this harness exists to prevent.

---

## What this harness canNOT cover

Read this before quoting any result as coverage.

**The installed Safari is not driven.** `safaridriver` requires *Allow Remote Automation*,
enabled via `safaridriver --enable`, which needs `sudo`. That was deliberately not
attempted. The `safari` engine therefore reports `unavailable`. `webkit` (Playwright)
covers the **engine**, not the shipping browser: same family, different binary, and it
cannot speak to Safari-specific UI, WebKit feature flags as Apple ships them, or the
installed build's exact version behaviour. To close this gap, run `sudo safaridriver
--enable` once by hand, then `--engines safari`.

**No real devices, and no iOS or Android at all.** `touch.py` is Chrome's *emulation* of a
phone: correct viewport, DPR, media queries and touch event streams, but desktop Chrome's
engine underneath. It does not reproduce mobile Safari or Android Chrome, and specifically
cannot reproduce iOS Safari's dynamic viewport (`100vh` vs. the collapsing URL bar),
momentum-scroll behaviour, `-webkit-overflow-scrolling`, or real touch latency and
compositor threading. Mobile WebKit is **entirely untested** — which matters here, since
WebKit is the engine that fails the `overflow-clip-margin` check.

**No visual regression.** Nothing compares full-page renderings against a baseline. The
descender screenshots are the only pixel measurement, and they are scoped to one property.
Layout differences show up only as numeric deltas in `keyMetrics`.

**No animation-timeline verification.** The harness asserts the *resting* state after a
full scroll: it proves elements are not stranded, not that they animated pleasantly, with
correct easing, or without jank. Frame rate, dropped frames and tween overlap are not
measured.

**Tap targets are measured from the element's own box.** A hit area enlarged by a
pseudo-element or a transparent overlay is not detected, so a `FAIL` here needs a human
look before it is believed.

**Console capture differs by engine.** Chrome and Firefox use Selenium BiDi log handlers
(geckodriver does not implement the legacy `get_log` endpoint at all); WebKit uses
Playwright's native `console`/`pageerror` events. Both reduce to the same definition of
severe — uncaught exception or `console.error` — but they are not literally the same
mechanism. Safari, if enabled, has no BiDi at all and would have weaker capture than the
other engines.

**Only three pages, one desktop viewport, one scroll path.** No hash-navigation entry, no
back/forward, no reduced-motion run, no slow-network or offline run. Since the fonts and
nothing else come from a third party, an offline run would change the descender numbers.
`prefers-reduced-motion` is recorded but never forced on, so the reduced-motion code path
is untested.

---

## Golf / hero harnesses (moved out of /tmp, 2026-08-25)

These six lived in `/tmp` and were load-bearing for every change to the putting green and the hero
canvas — a reboot would have lost them. They now live here. All take an optional base URL as the
first argument (or `SITE_BASE`), defaulting to `http://localhost:8020`, and all use
**directory-format** URLs: they previously requested `/index.html`, which `python -m http.server`
serves but production 301s.

The same sweep missed two files on the first pass, fixed 2026-08-25: `golf_probe.py` and
`golf_validate.py` also requested `/index.html`, and defaulted to a port (8123) no other tool
here uses. `golf_probe.py` is the one that matters — it writes the `probe.json` that
`golf_verify_port.py` and `golf_sweep.py` both read, so the invariant chain itself started on a
URL the real site does not serve. Both now use `/` and 8020. If you audit a class of bug, count
the call sites.

    PY=~/personal/finance/finance/.venv/bin/python     # selenium + numpy live here, not in system python3

    $PY tools/golf_keys.py    [base]   # keyboard putting: 20 checks (tab reach, ring, live region, no scroll)
    $PY tools/golf_stuck.py   [base]   # soft-locks: must report 0
    $PY tools/golf_mouse.py   [base]   # desktop click-drag from 5 lies: must report 0 failures
    $PY tools/golf_touch.py   [base]   # touch putting, 7 lies: must report 0 failures
    $PY tools/golf_scroll.py  [base]   # canvas must NOT move/scale on scroll (scale stays 1.0000)
    $PY tools/hero_ink.py     [base]   # canvas ink over hero copy: must be 0% at every width

`tools/golf_frames.py` joined them on 2026-08-25 and never lived in `/tmp`. It is part of the
physics chain rather than the input suites, so it is documented below.

Last known-good on the shipped build: `golf_keys` PASS · `golf_stuck` 0 · `golf_mouse` 0 ·
`golf_touch` 0/7 · `hero_ink` PASS (0% × 12 widths).

### The physics chain, and its measured baseline (2026-08-25, field + timestep fix in place)

    $PY tools/golf_probe.py http://localhost:8020 1440 900 41 > probe.json
    $PY tools/golf_verify_port.py probe.json 0.9          # base + safety are POSITIONAL
    $PY tools/golf_sweep.py probe.json --rounds 40 --reach-safety 0.9 --astep 0.5 --pstep 0.01
    $PY tools/golf_pick.py probe.json trials.json --rounds 6
    $PY tools/golf_validate.py trials.json [base]
    $PY tools/golf_frames.py [base] --round 3 --angle 240 --power 0.825   # frame-by-frame diff

`golf_verify_port`: hash2 1504/1504 exact · heightAt max Δ 2.220e-16 · **numpy heightAt max Δ
2.220e-16** · geometry 42/42 rounds, worst 3.411e-13 px · `PORT VERIFIED`. `golf_sweep`:
**SOLVABLE 41/41 = 100%**, aim tolerance min 4.0° / median 16.0° / max 237.5°.

`golf_validate`: **AGREEMENT 24/24 = 100% (desyncs: 0)**, resting-position error on the misses
median 0.1px / max 0.3px.

`--reach-safety 0.9` is not optional here. It is the shipped tee rule, not a proposal: without it
`golf_verify_port` drops to geometry 38/42 with a 61.7px worst ball error. It does mean the sweep
uses the SEEDED tee rather than the probe's measured one, which reads like the `--recompute`
warning below — but the two agree to 3.4e-13 px, so nothing is being audited that the player
does not see. Never pass `--recompute` itself: that tests the simulator's own tee picker and has
reported a false unsolvable round.

#### Why the old 16/24 was not a harness bug (resolved 2026-08-25)

This section used to record **AGREEMENT 16/24 = 66.7%** and guess that the harness sampled after
the 1.5s auto-re-tee. **That guess was wrong** and the data already contradicted it:
`trials_browser.json` showed ball displacement of 41–595px per trial and four genuine `sunk`
phases, so the browser really rolled and really was read. Worse, the 12 agreeing misses sat a
median 116px and up to 451px from the sim's predicted resting point — the outcomes matched while
the trajectories did not, which is not what a sampling-window bug looks like. And a simulator whose
every sink prediction was wrong still scores 12/24 on this trial set, because a miss agrees whenever
the ball fails to sink for any reason. 66.7% was four sinks above the floor.

The actual cause was a **third, stale mirror of `heightAt`**. `golf_sweep.Field.height` — the
vectorised field that every sweep, every trial and every solvability number is computed from — was
still on the pre-2026-08-22 frequencies and amplitudes (1.25/2.9 and 1.05/0.40) after the component
moved to 0.85/2.0 and 1.16/0.26. Up to **1.14 units of height error**, mean |grad| 202 against a
real 179, and less than half the restable area. `golf_verify_port` printed `PORT VERIFIED` all the
way through because it only ever checked the *scalar* port in `golf_sim.py`. `golf_sweep --selfcheck`
would have caught it on day one — patched back in, it reports 6/15 outcomes agreeing and a 344px
final-position delta — but it was opt-in and no documented invocation passed the flag.

Fixed, and each fix has a measurement behind it:

- `golf_sweep.Field.height` now matches the component. `golf_verify_port` checks **both** mirrors,
  so this class of drift cannot pass again.
- `--selfcheck` **runs by default**; `--no-selfcheck` opts out. A guard nobody turns on is not a guard.
- `golf_pick` was building trials with `Green(...)` and **no `copy_edge`**, so the play box reverted
  to the pre-derivation 0.44 left edge — the left wall sat 271px too far out at 1440 (633→1354 against
  a real 905→1354). Overriding the tee and cup from the probe hid it. Now passed, in `golf_pick` and
  `golf_pick_fails` both.
- **One timestep, one owner.** `golf_sim.py` holds `DT_CLAMP` / `DT_FIRST` / `DEFAULT_FPS` and
  `resolve_dt()`; `golf_sweep`, `golf_pick` and `golf_pick_fails` all resolve through it and default
  to `--dt-source probe`. They used to default to 1/60, 1/120 and 1/120 — three scripts written to
  corroborate each other integrating three different greens, none of them the page's.

#### The timestep the page actually uses

`HeroCanvas.tsx` `tick()` integrates at `Math.min(0.05, (now - last) / 1000)`, seeded at 0.016 while
`last` is 0. `probe.json` used to carry a `dt_ms` field that looked like evidence about that, but it
sampled a **quiet page with no ball on it** and nothing consumed it anyway. It is now `dt_idle_ms`,
kept only so the difference stays visible, and the number the tools integrate with is `dt_roll_ms`
— measured by `golf_frames.py` while a putt is in flight.

Measured at 1440×900 headless over 841 stepped frames: min 7.30ms · p50 8.30ms · p95 9.20ms ·
max 9.40ms · mean 8.333ms · **zero frames clamped at 50ms**. That mean is 120.0fps, so `golf_pick`'s
old 1/120 was accidentally close and `golf_sweep`'s 1/60 was 2× out. Feeding the captured sequence
through `golf_sim.putt(dts=...)` reproduces the browser's roll with a **worst position delta of
exactly 0.000e+00 px across all 841 frames** — the offline integrator is bit-identical to `stepBall`,
which is the proof the port never had.

**The 0.016 seed does NOT fire for a putt on a live page**, and believing it did cost an hour.
The rAF loop is already running while the hero idles (measured: 120fps with `phase === 'idle'`), so
`start()` inside `aim()` is a no-op and `last` is never reset. The first capture launched the putt
from outside the observer and silently dropped the roll's first step — and because two real 8.3ms
frames sum to ~16.6ms, the missing step looked exactly like the seed and matched the browser to
0.03px over 841 frames. A wrong story that fits to a thirtieth of a pixel is the trap this
directory keeps falling into. `golf_frames.py` therefore warms up for two frames, fires the putt
from **inside** its own rAF callback, and asserts `__heroFrames` advanced by exactly 1 between every
sample, because a passenger loop that misses a frame is not reading `tick()`'s clock.

The timestep mattered less than the field: at 1/60 on the *corrected* field solvability is still
41/41 and the median aim tolerance is 16.5° against 16.0° at the measured dt, with total sinking
lines differing by 0.4% and no round changing solvability. Worth aligning, not the bug.

`golf_scroll.py` exists because the hero pin used to scrub the canvas plane
(`y: 0 -> 6vh, scale: 1 -> 1.12`), which both moved an interactive playfield under the player and
forced `toCanvas()` to divide out a live scale that reached 1.0991. If that check ever shows a scale
other than 1.0000, someone has re-added a transform to `.hero-canvas-wrap`.
