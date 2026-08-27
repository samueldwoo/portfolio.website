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
# never becomes a dependency of the site itself. NOT in /tmp: it is mode 1777 and
# world-readable, and CLAUDE.md puts every artefact under a 700 dir in $HOME.
mkdir -p ~/.pf-verify/pw-webkit && chmod 700 ~/.pf-verify
npm --prefix ~/.pf-verify/pw-webkit init -y
npm --prefix ~/.pf-verify/pw-webkit i playwright@1.56.0
(cd ~/.pf-verify/pw-webkit && npx playwright install webkit)
```

The `--prefix` form and the subshell are deliberate: a bare `cd` here leaves the shell parked
outside the repo, and this tool's working directory **persists between calls**, so every later
`tools/…` path silently resolves under the directory you cd'd into. That cost three runs once,
each of which looked like a missing file.

Chrome and Firefox drivers are fetched automatically by Selenium Manager; nothing to
install by hand.

## Serving the build

Both harnesses test the **built output**, not the dev server:

```bash
npm run build
(cd .vercel/output/static && python3 -m http.server 8020)   # subshell: see below
```

**Keep that `cd` in a subshell.** This tool's working directory persists between calls, so a bare
`cd .vercel/output/static` to start the server leaves every later `tools/…` path resolving to
`.vercel/output/static/tools/…`. Three runs failed that way once, each looking like a missing file.

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
| `golf_calibrate.py` | fits `HOLE_CAL` / `HOLE_CUTS` for the hero's difficulty card from a sweep, and prints the two lines to paste. Bands are anchored to an absolute share of the aim/power space, not to quartiles |
| `golf_par.py` | strokes per hole for a competent-but-imperfect putter — this is where `PAR_TABLE` comes from, and `--table` emits the 81-char string so the last mile is not hand-assembled. Par is the **median**, not the mean; see the median note below. `--max-strokes` sets the give-up cap and `--only` targets individual holes |
| `golf_tune.py` | searches the player model's skill parameters for the ones that make par DISCRIMINATE — maximise spread across holes subject to the median still playing par 2. Reuses `golf_par`'s model by import, never a copy. Combos are independent, so `--slice i/n` shards across processes |
| `golf_mash.py` | **the check no other invariant performs**: how many holes fall to aiming straight at the cup at full power. Run it after ANY change to the cup test. `--capture 520` is its positive control and must reproduce the pre-fix 68/81 |
| `golf_frames.py` | passenger rAF loop that measures the REAL per-frame dt during a roll; `golf_probe.py` uses it for `dt_roll_ms` |
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

**And the same stale list outlived the deletion, in `webkit_runner.mjs` — fixed 2026-08-26.** Its
defaults were `--base http://127.0.0.1:8899` and `--pages index.html,projects.html,travel.html`:
a port nothing here serves, and the identical three URLs `suites/gate.py` was deleted for. It
survived because `crossbrowser.py` always passes `--base` and `--pages` explicitly, so the only way
to reach the defaults is to run the file by hand — which its own usage block told you to do, with
the `.html` names spelled out. Now `8020` and `,projects/,travel/`, mirroring
`crossbrowser.DEFAULT_PAGES`. When you delete a stale copy, grep for what made it stale; the copy
was the symptom and the literal was the bug.

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

### The physics chain, and its measured baseline (2026-08-27, capture 225 + lip-out)

    $PY tools/golf_probe.py http://localhost:8020 1440 900 80 > probe80.json
    $PY tools/golf_verify_port.py probe80.json 0.9          # base + safety are POSITIONAL
    $PY tools/golf_sweep.py probe80.json --rounds 80 --reach-safety 0.9 --astep 0.5 --pstep 0.01 \
        --json sweep80.json                                 # --json IS REQUIRED, see below
    $PY tools/golf_mash.py probe80.json --dt-source fps     # the dominant-strategy check
    $PY tools/golf_pick.py probe80.json trials.json --rounds 6
    $PY tools/golf_validate.py trials.json
    $PY tools/golf_calibrate.py sweep80.json      # -> HOLE_CAL / HOLE_CUTS
    $PY tools/golf_par.py probe80.json --rounds 80 --trials 500 --max-strokes 32 --table
    $PY tools/golf_mash.py probe80.json --aim-window 2 --dt-source fps   # run BOTH windows

`golf_verify_port`: hash2 1504/1504 · heightAt Δ 2.220e-16 · **numpy heightAt Δ 2.220e-16** ·
geometry 81/81 · `PORT VERIFIED`. `golf_sweep`: **SOLVABLE 81/81 = 100%**, selfcheck **0.000e+00**
(~25 min at this grid). `golf_mash`: **16/81 = 19.8%** dead straight, **29/81 = 35.8%** at `--aim-window 2`. `golf_validate`: **24/24 = 100%**, resting
error median 0.2px / max 0.7px. Browser harnesses: `golf_stuck` 0 · `golf_keys` PASS ·
`golf_mouse` 0 · `golf_touch` 0/7 · `hero_ink` PASS.

> **THE SWEEP WRITES NOTHING WITHOUT `--json`, AND THE NEXT LINE OF THE CHAIN READS THAT FILE.**
> `golf_sweep.py`'s `--json` defaults to `None`, so the chain as printed here until 2026-08-27 spent
> ~25 minutes, printed its verdict, and left `golf_calibrate.py sweep80.json` with nothing to open.
> The failure lands at the *end* of the expensive step, which is the worst place for it. A documented
> pipeline has to name the artefact each stage hands the next one.

> **SWEEP RE-RUN AT SHIPPED PHYSICS 2026-08-27** (capture 225 + lip-out + gate, full 81 holes,
> 0.5° × 0.01): **SOLVABLE 81/81**, selfcheck **0.000e+00** on every shard, min `hits` **71**,
> aim tolerance **min 3.0° / median 10.0° / max 252.5°** — the tolerance figures are byte-identical to
> the capture-175 sweep, independently confirming that the cup test moves the PACE window and not the
> aim window. `HOLE_CUTS` was refitted from it; see the next note.
>
> **Sharding:** 6 × `--only <13–14 rounds>` ran in **~13 min** against ~25 single-process. Each shard
> runs its own selfcheck (keep it). Merge by concatenating `rows` and taking any shard's `config` —
> `golf_calibrate` derives its grid from `astep`/`pmin`/`pstep`, which are shard-invariant — but
> **assert the physics fields match across shards and that rounds 0..80 appear exactly once**, or a
> silent concat fits the bands to two different greens. Note there is **no `sunk` field** in a row:
> solvability is `hits > 0`, and guessing `r["sunk"]` reports a confident `0/81`.
>
> **And the refit went the OPPOSITE way to the prediction.** Both handoffs said the stale cuts made
> the word *overstate* difficulty. Measured, the old cuts were **softer** than truth on 26 of 81 holes
> and harsher on 13, so the word **understated** — the refit made the card harsher (Brutal 24 → 32).
> The premise counted capture 175 → 225 widening the window and missed that the lip-out and gate ship
> in the same change and narrow it. `HOLE_CAL`'s four statistics were genuinely unchanged; its fifth
> field `uW` is a **fitted** weight and moved 1.25 → 2.05, because distance stopped being the dominant
> signal (ρ −0.63 → **−0.259**) and mean up-slope took over (**−0.676**).

**`golf_par`'s DEFAULT SKILL PARAMETERS CHANGED on 2026-08-27: 10 / 0.10 / 0.9, not 6 / 0.07 / 0.7.**
They came from `golf_tune.py`, not from feel. The two-putt anchor turned out to constrain almost
nothing — it pins the median ACROSS holes, and 34 of 36 grid combos held it — so the old values were
the FLATTEST feasible point, giving 72 of 81 holes par 2. At 10 / 0.10 / 0.9 it is 37 of 81 off par 2
with four holes at par 4 on ~0% stuck trials. Mean par rose 1.98 → 2.49, so par is deliberately a
more generous target than "what a competent player scores". Re-run `golf_tune.py` rather than editing
the defaults by hand.

**FOUR ATTEMPTS TO MAKE THE PLAYER MODEL SMARTER ALL MEASURED WORSE** — a lay-up, two pace-learning
variants and a roll-time correction. The long notes are in `golf_par.py` beside the code they would
have touched. The cause is that these parameters were fitted jointly, so adding a term breaks the
balance. Search the parameters; do not add to the model.

**`golf_par`'s arguments changed and the old ones give a wrong answer.** Par is now the MEDIAN
stroke count, not the mean, and `--max-strokes 32` matters as much as the trial count. On rounds 4, 7
and 78 the player model has no lay-up — it always aims at the cup and power is hard-clipped at 1.0 —
so roughly a third of its trials never hole out and the MEAN is a function of the give-up cap rather
than of the golf. Round 78 read 3.98 at cap 8, 17.07 at cap 48 and 77.75 at cap 200 while its median
stayed 2. A median is unaffected while fewer than half the trials are stuck, which at cap 32 they
are; the tool prints the stuck share per hole and says so if it crosses half.

500 trials rather than 2000 because a median is far more stable than a mean, and `--table` reports
which holes are unsettled (the share below par within 2 SE of 50%) so the borderline ones can be
topped up with `--only` instead of paying 4× on all 81. `--table` refuses to emit from a partial run
and refuses to clamp a par above 9 to fit the one-character encoding.

Sweep a shipped build **without** `--recompute` — it tests the simulator's own tee picker and has
reported a false unsolvable round. `--reach-safety 0.9` is REQUIRED: it is the shipped tee rule, and
dropping it takes geometry to 38/42 with a 61.7px worst ball error.

> **THE TWO FLAGS ARE NOT MECHANICALLY DIFFERENT, THOUGH THIS SAID THEY WERE.** `golf_sweep.py:397`
> is `if rnd in measured and not a.recompute and a.reach_safety is None:` — so `--reach-safety`
> *also* discards the probe's measured tee/cup for computed ones, and its own `--help` says it
> "forces `--recompute`". The reason 0.9 is trustworthy is that `golf_verify_port.py probe.json 0.9`
> proves the computed tee matches the browser's to **3.4e-13 px across 81/81 rounds**; the bare
> recompute path (safety `None`) uses a *different* rule and drifts to 38/42 / 61.7px. Pass 0.9 —
> just don't believe the claim that it leaves the measured geometry alone. Verified 2026-08-27.

**`--selfcheck` runs by default and is the guard on the THIRD MIRROR.** Every physics rule lives in
`HeroCanvas.tsx`, `golf_sim.py` and `golf_sweep.py`'s numpy path, and the vectorised one has been
forgotten twice — once for three days on the height field, once within an hour on a rest rule. Both
times a non-zero final-position delta was the only thing that said so.

### The thing this subsystem is FOR, in one paragraph

The green exists so that reading the contour lines pays. Until 2026-08-26 it did not: aiming at the
cup at full power sank 68 of 81 holes, because break is proportional to time on the green so pace
suppresses it, and nothing punished pace. `CAPTURE_SPEED` 520 → 175 plus removing a mis-implemented
"rim-out" (which braked the ball to a crawl inside the cup and so dropped it) took that to 16/81
with **no change to aim tolerance**.

**`golf_mash.py` now performs that check, so it no longer depends on remembering.** It was the one
gap both handoffs named — solvability said 81/81 for the entire time the game was trivially
winnable, because solvability asks whether AT LEAST ONE (aim, power) pair sinks and a dominant
strategy makes MORE pairs sink. Measured on the shipped build:

| setting | mash line |
|---|---|
| `--capture 520` (pre-fix, the positive control) | **68/81 = 84.0%** |
| shipped, dead straight at full power | **16/81 = 19.8%** |
| shipped, `--aim-window 2` (a sloppy aim) | **29/81 = 35.8%** |

> That last row read **21/81 = 25.9%** until 2026-08-27, which is the **capture 175** figure, not
> the shipped one. It contradicted this file's own baseline 60 lines up and `golf_mash.py`'s table.
> Of every number in this directory it is the worst one to get wrong: the ±2° window is the whole
> reason capture 225 was known to cost 8 holes, and a stale copy reading 21/81 says it cost nothing.
> When a measurement exists in two places, the flattering copy is the one that gets quoted.

`--capture` exists so the check can be SEEN to fail. A tool that has only ever printed 16/81 has not
been shown to measure exploitability, and this directory has shipped a test that could not fail
before. Run the control alongside the real number.

`golf_scroll.py` exists because the hero pin used to scrub the canvas plane
(`y: 0 -> 6vh, scale: 1 -> 1.12`), which both moved an interactive playfield under the player and
forced `toCanvas()` to divide out a live scale that reached 1.0991. If that check ever shows a scale
other than 1.0000, someone has re-added a transform to `.hero-canvas-wrap`.
