/* ============================================================================
 * webkit_runner.mjs — WebKit engine adapter for the cross-browser harness.
 *
 * Why this file exists at all: driving the *installed* Safari needs
 * `safaridriver --enable`, which is sudo-gated on this machine. Rather than
 * report WebKit as untested, this drives Playwright's WebKit build — the same
 * engine family as the installed Safari, though not the same shipping binary.
 * That distinction is recorded in the output as `engineIsShippingSafari:false`
 * and must survive into any summary: this covers WebKit, not Safari-the-product.
 *
 * It runs the SAME tools/probe.js as the Selenium engines and applies the SAME
 * scroll choreography, because a harness whose engines ask different questions
 * cannot attribute a difference to the engine.
 *
 * Emits one JSON document on stdout. All diagnostics go to stderr so stdout
 * stays machine-parseable for crossbrowser.py.
 *
 * Usage:
 *   node webkit_runner.mjs --base http://127.0.0.1:8020 \
 *     --pages ,projects/,travel/ \
 *     --shots ~/.pf-verify/ov-shots --probe ./probe.js
 * ==========================================================================*/
import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

/* Playwright is installed in a scratch prefix outside the repository so the
   harness never adds a 70 MB browser download to the site's dependencies. */
const PW_PREFIX = process.env.OV_PW_PREFIX || "/tmp/pw-webkit";
const require = createRequire(join(PW_PREFIX, "package.json"));

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/* THESE DEFAULTS ARE THE ONES THAT DELETED tools/suites/, so they are pinned to
   what the build actually serves. crossbrowser.py always passes --base and
   --pages explicitly, which is why the stale pair below survived unnoticed: the
   only way to reach them is to run this file by hand, exactly as the usage block
   above tells you to. `suites/gate.py` was deleted for carrying this same
   `index.html, projects.html, travel.html` list -- three URLs the Vercel adapter
   301s -- and `a11y_chrome.py`'s header records projects.html "passing" while the
   page was blank. Port 8899 was likewise a port nothing here serves; 8020 is the
   documented fallback. Directory format, mirroring crossbrowser.DEFAULT_PAGES. */
const BASE = arg("base", "http://127.0.0.1:8020").replace(/\/$/, "");
const PAGES = arg("pages", ",projects/,travel/").split(",");
const SHOTS = resolve(arg("shots", "/tmp/ov-shots"));
const PROBE_PATH = resolve(arg("probe", new URL("./probe.js", import.meta.url).pathname));
const WIDTH = parseInt(arg("width", "1440"), 10);
const HEIGHT = parseInt(arg("height", "900"), 10);

/* Scroll choreography — MUST match TIMING in crossbrowser.py. Changing one
   without the other silently makes engines incomparable. */
const SETTLE_MS = parseInt(arg("settle", "1400"), 10);
const STEP_MS = parseInt(arg("step", "260"), 10);
const BOTTOM_SETTLE_MS = parseInt(arg("bottom-settle", "1800"), 10);
const MAX_STEPS = 120;

const MASK_RECORDER_PATH = resolve(
  arg("mask-recorder", new URL("./mask_recorder.js", import.meta.url).pathname));

const PROBE_SRC = readFileSync(PROBE_PATH, "utf8").trim().replace(/;$/, "");
const MASK_SRC = readFileSync(MASK_RECORDER_PATH, "utf8").trim().replace(/;$/, "");

function log(...a) { console.error("[webkit]", ...a); }

/* Severity mapping kept identical in spirit to the Selenium side: a page-level
   uncaught exception and a console.error are both severe; warnings and info are
   not. Anything the harness itself injected is excluded by tag. */
const NOISE = [
  /favicon/i,
  /^\[webkit\]/,
  /Unrecognized Content-Security-Policy/i
];

function isNoise(text) {
  return NOISE.some((re) => re.test(text || ""));
}

/* The site sets `html { scroll-behavior: smooth }`, so every programmatic
   scroll is an animation. `behavior:'instant'` opts out; settleScroll waits out
   any engine that ignores the override. Measuring mid-glide is how the first
   version of this harness ended up screenshotting blank background. */
async function scrollToInstant(page, y) {
  await page.evaluate((top) => {
    try { window.scrollTo({ top, left: 0, behavior: "instant" }); }
    catch (e) { window.scrollTo(0, top); }
  }, y);
  await settleScroll(page);
}

async function settleScroll(page, timeoutMs = 6000, quietMs = 150) {
  await page.evaluate(async ({ timeoutMs, quietMs }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + timeoutMs;
    let last = null, stableSince = null;
    while (Date.now() < deadline) {
      const y = window.pageYOffset;
      if (y === last) {
        if (stableSince === null) stableSince = Date.now();
        else if (Date.now() - stableSince >= quietMs) return;
      } else { stableSince = null; last = y; }
      await sleep(50);
    }
  }, { timeoutMs, quietMs });
}

async function scrollThrough(page) {
  /* Stepped descent rather than a jump to the bottom. IntersectionObserver
     only evaluates the state it is given: teleporting to the end means the
     middle of the page never intersects at any observed frame, so its reveals
     would read as stranded when a real reader would have seen them fire. The
     step is what makes the later opacity assertion honest. */
  for (let guard = 0; guard < MAX_STEPS; guard++) {
    const [y, ih, sh] = await page.evaluate(() => [
      window.pageYOffset, window.innerHeight, document.documentElement.scrollHeight
    ]);
    if (y + ih >= sh - 2) break;
    await scrollToInstant(page, y + Math.round(ih * 0.8));
    const after = await page.evaluate(() => window.pageYOffset);
    await page.waitForTimeout(STEP_MS);
    if (after <= y) break;
  }
  const sh = await page.evaluate(() => document.documentElement.scrollHeight);
  await scrollToInstant(page, sh);
  await page.waitForTimeout(BOTTOM_SETTLE_MS);
}

async function run() {
  const { webkit } = require("playwright");
  mkdirSync(SHOTS, { recursive: true });

  const browser = await webkit.launch();
  const result = {
    engine: "webkit",
    engineIsShippingSafari: false,
    driver: "playwright",
    playwrightVersion: require("playwright/package.json").version,
    webkitVersion: browser.version(),
    viewport: { width: WIDTH, height: HEIGHT },
    timing: { settleMs: SETTLE_MS, stepMs: STEP_MS, bottomSettleMs: BOTTOM_SETTLE_MS },
    pages: {}
  };

  for (const pagePath of PAGES) {
    const url = `${BASE}/${pagePath}`;
    const ctx = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT }
    });
    const page = await ctx.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];

    /* Installed before navigation so load-time throws are caught. The same
       hook name is used by the Chrome adapter via CDP, which is what lets
       probe.js read window.__ovErrors uniformly. */
    await page.addInitScript(() => {
      window.__ovErrors = [];
      window.addEventListener("error", (e) => {
        window.__ovErrors.push({
          kind: "error",
          message: String(e.message || ""),
          source: String(e.filename || ""),
          line: e.lineno
        });
      });
      window.addEventListener("unhandledrejection", (e) => {
        window.__ovErrors.push({
          kind: "unhandledrejection",
          message: String((e.reason && e.reason.message) || e.reason || "")
        });
      });
    });

    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (isNoise(text)) return;
      consoleErrors.push({ level: "error", text: text.slice(0, 400) });
    });
    page.on("pageerror", (err) => {
      const text = String(err && err.message ? err.message : err);
      if (isNoise(text)) return;
      pageErrors.push({ level: "pageerror", text: text.slice(0, 400) });
    });
    page.on("requestfailed", (req) => {
      failedRequests.push({
        url: req.url().slice(-120),
        method: req.method(),
        failure: (req.failure() && req.failure().errorText) || null
      });
    });
    page.on("response", (res) => {
      if (res.status() >= 400) {
        failedRequests.push({ url: res.url().slice(-120), status: res.status() });
      }
    });

    const entry = { url, ok: false };
    try {
      await page.goto(url, { waitUntil: "load", timeout: 45000 });

      /* Install the live-mask recorder BEFORE scrolling: the real .srline-mask
         nodes live only for the ~1s of their tween and are deleted on complete,
         so they can only be observed at insertion time. */
      entry.maskRecorder = await page.evaluate(`${MASK_SRC}()`);

      await page.waitForTimeout(SETTLE_MS);
      await scrollThrough(page);

      entry.liveMasks = await page.evaluate(() => ({
        samples: window.__ovMasks || [],
        stats: window.__ovMaskStats || null
      }));

      const audit = await page.evaluate(
        `${PROBE_SRC}(${JSON.stringify({})})`
      );
      entry.audit = audit;

      /* Descender screenshots. The probe left its cells in the DOM; they sit at
         document 0,0 so the page is returned to the top before capture. PNGs
         are analysed by crossbrowser.py with PIL, so every engine's ink
         measurement runs through one implementation. */
      await scrollToInstant(page, 0);
      await page.waitForTimeout(250);
      entry.descenderShots = {};
      for (const key of ["control", "masked", "nomargin"]) {
        const id = `__ov_cell_${key}`;
        const el = await page.$(`#${id}`);
        if (!el) continue;
        const out = join(SHOTS, `webkit_${pagePath.replace(/\W/g, "_")}_${key}.png`);
        await el.screenshot({ path: out });
        entry.descenderShots[key] = out;
      }
      await page.evaluate(() => {
        const n = document.getElementById("__ov_descender_probe");
        if (n && n.parentNode) n.parentNode.removeChild(n);
      });

      entry.ok = true;
    } catch (e) {
      entry.error = String(e && e.message ? e.message : e).slice(0, 400);
      log("FAILED", url, entry.error);
    }

    entry.consoleErrors = consoleErrors;
    entry.pageErrors = pageErrors;
    entry.failedRequests = failedRequests;
    /* "Severe" is uncaught exceptions plus console.error — the same definition
       the Selenium adapters use, so the counts are comparable. */
    entry.severeCount = consoleErrors.length + pageErrors.length;

    result.pages[pagePath] = entry;
    await ctx.close();
  }

  await browser.close();
  process.stdout.write(JSON.stringify(result, null, 2));
}

run().catch((e) => {
  process.stdout.write(JSON.stringify({
    engine: "webkit",
    fatal: String(e && e.stack ? e.stack : e).slice(0, 2000)
  }, null, 2));
  process.exit(1);
});
