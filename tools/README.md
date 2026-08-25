# `tools/` — cross-browser and touch verification harness

This site ships four animation libraries (GSAP + ScrollTrigger, SplitText, anime.js,
Motion) and, before this harness existed, had only ever been exercised in **headless
Chrome**. Everything here exists to close that gap: to find what one engine does and
another does not, and — just as importantly — to be explicit about which engines were
genuinely driven and which were not.

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
npm run build                  # -> dist/
cd dist && python3 -m http.server 8899
```

---

## 1. `crossbrowser.py` — per-engine page audit

```bash
$PY tools/crossbrowser.py --base http://127.0.0.1:8899 --clip-report \
    --json /tmp/ov-cross.json

# subsets
$PY tools/crossbrowser.py --base http://127.0.0.1:8899 --engines chrome,webkit
$PY tools/crossbrowser.py --base http://127.0.0.1:8899 --pages travel.html
$PY tools/crossbrowser.py --base http://127.0.0.1:8899 --headed        # watch it
$PY tools/crossbrowser.py --base http://127.0.0.1:8899 --width 1280 --height 800
```

Checks `index.html`, `projects.html` and `travel.html` in each available engine:

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
$PY tools/touch.py --base http://127.0.0.1:8899 --json /tmp/ov-touch.json
$PY tools/touch.py --base http://127.0.0.1:8899 --device iphone14,small360
$PY tools/touch.py --base http://127.0.0.1:8899 --headed
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

    PY=~/personal/finance/finance/.venv/bin/python     # selenium + numpy live here, not in system python3

    $PY tools/golf_keys.py    [base]   # keyboard putting: 20 checks (tab reach, ring, live region, no scroll)
    $PY tools/golf_stuck.py   [base]   # soft-locks: must report 0
    $PY tools/golf_mouse.py   [base]   # desktop click-drag from 5 lies: must report 0 failures
    $PY tools/golf_touch.py   [base]   # touch putting, 7 lies: must report 0 failures
    $PY tools/golf_scroll.py  [base]   # canvas must NOT move/scale on scroll (scale stays 1.0000)
    $PY tools/hero_ink.py     [base]   # canvas ink over hero copy: must be 0% at every width

Last known-good on the shipped build: `golf_keys` PASS · `golf_stuck` 0 · `golf_mouse` 0 ·
`golf_touch` 0/7 · `hero_ink` PASS (0% × 12 widths).

`golf_scroll.py` exists because the hero pin used to scrub the canvas plane
(`y: 0 -> 6vh, scale: 1 -> 1.12`), which both moved an interactive playfield under the player and
forced `toCanvas()` to divide out a live scale that reached 1.0991. If that check ever shows a scale
other than 1.0000, someone has re-added a transform to `.hero-canvas-wrap`.
