#!/usr/bin/env node
/**
 * audit-upload-ack.mjs — does the upload tell her, and does the page refresh?
 *
 *   npm run audit:upload
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A REAL BROWSER AND NOT A UNIT TEST
 *
 * This code path was "fixed" twice and was broken both times, for the same reason each
 * time: it was verified in FRAGMENTS. A structural repro of the promise chain proved the
 * chain and missed that `location.assign()` to the current URL does not reload. A CDP
 * test of that navigation proved the navigation and would have missed anything else.
 * Neither ever ran the real script against a real response.
 *
 * So this runs the ACTUAL inline script, extracted verbatim from day.astro at run time,
 * in real Chrome, against a real HTTP server replaying every response the real endpoint
 * can produce. Nothing is reimplemented: if day.astro changes this picks it up, and if
 * the extraction stops finding the script it exits 2 rather than passing on an empty
 * string. MAX_BYTES, PAGE and FRAGMENT are read out of the source for the same reason.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: touch R2 or Upstash. The endpoint is a mock. The
 * uploads themselves have always worked — the ack and the refresh are what broke, and
 * both live entirely on this side of the network. Proving the storage write would need a
 * POST writing bytes to the production bucket, which is what destroyed a photograph.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FIRST DRAFT OF THIS HARNESS GOT WRONG
 *
 * Recorded because every one of them made the CODE look broken when the harness was:
 *
 *   - Served the page at /day while the client navigates to /samdrea/vault/day, so every
 *     navigation 404'd and every refresh assertion failed.
 *   - Ignored `Accept`, so the native form fallback received JSON where the real endpoint
 *     sends a 303, leaving the browser displaying a JSON document.
 *   - Counted Chrome's "failed to load resource" for a 429 as a page error, so every
 *     correct refusal failed. Thrown exceptions and network log noise are separate now,
 *     and only the former is a failure.
 *   - Awaited a page Promise over CDP across a navigation and got "Promise was
 *     collected". Async results are parked on `window` and polled instead.
 *   - Used a fixed CDP port, so a leftover browser from a crashed run could be attached
 *     to instead of this one. The port is per-process now and cleanup is in a finally.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
/* Per-process, so a crashed run's browser can never be mistaken for this one. */
const PORT = 8800 + (process.pid % 400);
const CDP = 9400 + (process.pid % 400);

const fatal = (msg) => { console.error(`  FATAL: ${msg}`); process.exit(2); };

/* ---------------------------------------------------------------------------
   THE REAL SCRIPT AND THE REAL CONSTANTS, LIFTED OUT OF THE SOURCE
   --------------------------------------------------------------------------- */

const pageSrc = readFileSync(join(ROOT, 'src/pages/samdrea/vault/day.astro'), 'utf8');
/* NOT just `is:inline`: `<script is:inline src="/us-land.js">` also carries that
   directive and has an EMPTY body, so the old pattern matched it first and this
   harness silently tested an empty string. It failed loudly, which is the only reason
   it was caught — see the sanity check below, which is what makes that guaranteed. */
const scriptMatch = /<script\s+is:inline(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(pageSrc);
if (!scriptMatch) fatal('no inline script found in day.astro — refusing to test nothing.');
const CLIENT = scriptMatch[1];
/* THE EXTRACTION MUST HAVE GRABBED THE RIGHT BLOCK. A harness that quietly tests an
   empty string reports success about nothing, which is worse than no harness. */
if (!CLIENT.includes('data-fr-form') || CLIENT.length < 2000) {
  fatal(`extracted ${CLIENT.length} chars from day.astro and it is not the upload script.`);
}

/* The shared navigation helper, verbatim. If it ever stops defining window.usLand the
   audit fails loudly here rather than testing the fallback path by accident. */
const US_LAND = readFileSync(join(ROOT, 'public/us-land.js'), 'utf8');
if (!US_LAND.includes('window.usLand')) fatal('public/us-land.js no longer defines window.usLand');

const framesSrc = readFileSync(join(ROOT, 'src/lib/us/frames.ts'), 'utf8');
const mb = /export const MAX_BYTES = (\d+) \* 1024 \* 1024;/.exec(framesSrc);
if (!mb) fatal('MAX_BYTES not found in frames.ts');
const MAX_BYTES = Number(mb[1]) * 1024 * 1024;

const frameSrc = readFileSync(join(ROOT, 'src/pages/api/us/frame.ts'), 'utf8');
const pgM = /const PAGE = '([^']+)';/.exec(frameSrc);
const frM = /const FRAGMENT = '([^']+)';/.exec(frameSrc);
if (!pgM || !frM) fatal('PAGE / FRAGMENT not found in frame.ts');
const PAGE = pgM[1];
const FRAGMENT = frM[1];

/* Mirrors day.astro's form: same action, enctype, data- hooks and input names, because
   those are the contract the script reads. */
const FORM = `
<form class="fr-form" method="post" action="/api/us/frame" enctype="multipart/form-data" data-fr-form>
  <input class="fr-file" type="file" id="fr-photo" name="photo" accept="image/jpeg,image/png,image/webp" required>
  <input class="fr-input" type="text" id="fr-note" name="note" maxlength="200">
  <button class="fr-go" type="submit" data-fr-go>put it up</button>
  <p class="fr-status" data-fr-status role="status"></p>
</form>`;

/* Every exit of frame.ts's POST, read off its `return answer(...)` calls. */
const RESPONSES = {
  posted:       { status: 200, body: { ok: true,  code: 'posted', date: '2026-08-25', who: 'her', note: '', bytes: 1234 } },
  unauthorized: { status: 401, body: { ok: false, code: 'unauthorized' } },
  unconfigured: { status: 503, body: { ok: false, code: 'unconfigured' } },
  crossSite:    { status: 403, body: { ok: false, code: 'cross-site' } },
  rate:         { status: 429, body: { ok: false, code: 'rate', retryAfter: 42 } },
  tooBig:       { status: 413, body: { ok: false, code: 'too-big', max: MAX_BYTES } },
  badUpload:    { status: 400, body: { ok: false, code: 'bad-upload' } },
  noPhoto:      { status: 400, body: { ok: false, code: 'no-photo' } },
  notAnImage:   { status: 415, body: { ok: false, code: 'not-an-image' } },
  store:        { status: 502, body: { ok: false, code: 'store' } },
  htmlGateway:  { status: 502, body: '<html>bad gateway</html>', raw: true },
  /* HER CONNECTION, NOT THIS MACHINE'S. Over localhost the whole post finishes in
     milliseconds and navigates before anything can be observed, which is exactly why
     the shape of the wait was never noticed here: it only exists when the wait does.
     2.5s is a modest phone-on-mobile upload of a few hundred KB. */
  slowPosted:   { status: 200, delayMs: 2500,
                  body: { ok: true, code: 'posted', date: '2026-08-25', who: 'her', note: '', bytes: 1234 } },
  hang:         { hang: true },
};

/* ---------------------------------------------------------------------------
   SERVER — logs every request, so "did the page re-fetch" is measured not inferred
   --------------------------------------------------------------------------- */

let mode = 'posted';
let log = [];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/api/us/frame' && req.method === 'POST') {
    /* The body is COLLECTED, not just drained, so the multipart fields can be checked.
       Bounded, because an unbounded accumulate in a test server is its own bug. */
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size <= 2 * 1024 * 1024) chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('latin1');
    /* `w` and `h` exist so the next render can reserve the image's box. A missing pair
       is the old jerky behaviour, and it would be invisible from the outside. */
    const field = (name) => {
      const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(raw);
      return m ? m[1] : null;
    };
    const accept = req.headers.accept ?? '';
    const wantsJson = accept.includes('application/json');
    log.push({ kind: 'upload', wantsJson, w: field('w'), h: field('h'), bytes: size });

    const r = RESPONSES[mode];
    if (r.hang) return;                       // never answer: exercises the 45s deadline
    if (r.delayMs) await new Promise((rs) => setTimeout(rs, r.delayMs));

    /* Accept decides the shape, exactly as answer() in frame.ts does. The script's
       failure fallback is form.submit(), a NATIVE post sending Accept: text/html, which
       the real endpoint answers with a 303 back to the page carrying ?e=<code>. */
    if (!wantsJson && !r.raw) {
      const q = r.body.ok ? `?ok=${r.body.code}` : `?e=${r.body.code}`;
      res.writeHead(303, { Location: `${PAGE}${q}${FRAGMENT}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    res.writeHead(r.status, {
      'Content-Type': r.raw ? 'text/html' : 'application/json',
      'Cache-Control': 'no-store',
    });
    return res.end(r.raw ? r.body : JSON.stringify(r.body));
  }

  if (url.pathname === PAGE) {
    log.push({ kind: 'render', search: url.search });
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    /* us-land.js is served from the real file, not stubbed. day.astro's land() now
       delegates to window.usLand, so a harness that omitted it would exercise the
       console.error fallback and quietly pass on the OLD assign() behaviour — the very
       bug case 2 exists to catch. Read from disk so it cannot drift from what ships. */
    return res.end(`<!doctype html><meta charset=utf-8><title>day</title>
<body>${FORM}<div id="post" style="margin-top:1500px">anchor</div>
<script>${US_LAND}</script>
<script>var maxBytes=${MAX_BYTES};</script>
<script>${CLIENT}</script>
</body>`);
  }

  /* Chrome asks for a favicon on every navigation. Recording it as a 404 made the
     "nothing 404ed" assertion fail on a browser habit rather than on anything this code
     does — and an assertion that always fails is one nobody reads, which is how a REAL
     404 would slip past it. Excluded by name, not by loosening the assertion. */
  if (url.pathname !== '/favicon.ico') log.push({ kind: '404', path: url.pathname });
  res.writeHead(404);
  res.end();
});

/* ---------------------------------------------------------------------------
   CHROME
   --------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(homedir(), '.wingtest', 'audit-'));
let chrome = null;
let ws = null;
let pass = 0;
let fail = 0;
const findings = [];

function cleanup() {
  try { ws?.close(); } catch { /* already gone */ }
  try { chrome?.kill('SIGKILL'); } catch { /* already gone */ }
  try { server.close(); } catch { /* already closed */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* fine */ }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });

try {
  await new Promise((r) => server.listen(PORT, r));

  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 40 && !ver; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP}/json/version`);
      if (res.ok) ver = await res.json();
    } catch { /* not up yet */ }
    if (!ver) await sleep(500);
  }
  if (!ver) fatal(`Chrome never opened a debugging port on ${CDP}.`);

  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  let seq = 0;
  const waiting = new Map();
  let thrown = [];
  let netNoise = [];

  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    /* Thrown exceptions are the bug class that shipped and are invisible from outside
       the page. Network-level error logs (a 429, a 401) are the endpoint working. */
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails;
      thrown.push(d?.exception?.description ?? d?.text ?? 'exception');
    }
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      netNoise.push(m.params.entry.text);
    }
  });

  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const { result: { targetInfos } } = await send('Target.getTargets');
  const target = targetInfos.find((t) => t.type === 'page');
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);

  /* SYNCHRONOUS ONLY. Never awaits a page Promise over the wire: a navigation destroys
     the execution context mid-await and CDP answers "Promise was collected", which reads
     as a code failure and is not one. Anything asynchronous parks its result on `window`
     and is polled by a later call. */
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (r.error) return { __cdp: r.error.message };
    const d = r.result?.exceptionDetails;
    if (d) return { __threw: d.exception?.description ?? d.text ?? 'threw' };
    return r.result?.result?.value;
  };

  const poll = async (expr, ms = 6000) => {
    for (let waited = 0; waited < ms; waited += 150) {
      const v = await ev(expr);
      if (v !== undefined && v !== null && !v?.__cdp && !v?.__threw) return v;
      await sleep(150);
    }
    return undefined;
  };

  const is = (name, cond, got) => {
    cond ? pass += 1 : fail += 1;
    if (!cond) findings.push(`${name} — got ${JSON.stringify(got)}`);
    console.log(`      ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : `  got ${JSON.stringify(got)}`}`);
  };

  async function trial(label, responseMode, startSearch, opts = {}) {
    mode = responseMode;
    log = [];
    thrown = [];
    netNoise = [];
    console.log(`\n    ${label}`);

    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${PAGE}${startSearch}` }, sessionId);
    const ready = await poll('document.querySelector("[data-fr-form]") ? "yes" : null');
    if (ready !== 'yes') { is('the page and form loaded', false, ready); return null; }
    log = log.filter((l) => l.kind !== 'render');   // the setup render is not a refresh

    /* A real decodable image, built in the page, so shrink() takes its true path.
       Parked on window rather than awaited over CDP. */
    await ev(`window.__ready = null;
      (function(){
        var c = document.createElement('canvas');
        c.width = ${opts.big ? 2400 : 40}; c.height = ${opts.big ? 1200 : 40};
        var x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0,0,c.width,c.height);
        c.toBlob(function(b){
          var dt = new DataTransfer();
          dt.items.add(new File([b], 'photo.jpg', { type: 'image/jpeg' }));
          var inp = document.querySelector('input[type=file]');
          inp.files = dt.files;
          window.__ready = inp.files.length === 1 ? 'attached' : 'failed';
        }, 'image/jpeg', 0.9);
      })(); 1`);
    const attached = await poll('window.__ready');
    if (attached !== 'attached') { is('a file was attached', false, attached); return null; }

    /* The real submit path: a cancelable submit event, which is what a click produces.
       form.submit() bypasses the handler entirely — that is the FALLBACK, not this. */
    /* THE TIMELINE OF WHAT SHE IS TOLD, sampled rather than reasoned about. Installed
       before the submit so nothing is missed, and it records into the PAGE so a
       navigation ends the recording naturally — the last sample before the document goes
       away is the last thing she saw. */
    await ev(`window.__seen = []; window.__t0 = Date.now();
      window.__tick = setInterval(function () {
        var el = document.querySelector('[data-fr-status]');
        var t = el ? el.textContent : null;
        var last = window.__seen.length ? window.__seen[window.__seen.length - 1].text : undefined;
        if (t !== last) window.__seen.push({ text: t, at: Date.now() - window.__t0 });
      }, 60); 1`);

    /* WHERE SHE WAS LOOKING. Set before the submit and read back after the hand-back,
       because "the view window gets reset on mobile" is a claim about a number and was
       argued about before it was measured. The mock page is deliberately 1500px tall
       with #post at the bottom, so this is the real geometry the anchor jump exploits. */
    const scrollBefore =
      opts.scrollTo === undefined
        ? null
        : await ev(`window.scrollTo(0, ${opts.scrollTo}); Math.round(window.scrollY)`);

    await ev(`document.querySelector('[data-fr-form]')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); 1`);

    /* Read back before the wait finishes, because a successful post navigates and takes
       the recording with it. Sampled repeatedly and the longest run is kept. */
    let seen = [];
    for (let i = 0; i < Math.ceil((opts.wait ?? 2500) / 120); i += 1) {
      const snap = await ev('window.__seen ? JSON.stringify(window.__seen) : null');
      if (typeof snap === 'string') {
        try {
          const parsed = JSON.parse(snap);
          if (parsed.length > seen.length) seen = parsed;
        } catch { /* mid-navigation */ }
      }
      await sleep(120);
    }

    const said1 = await ev('(document.querySelector("[data-fr-status]")||{}).textContent');
    await sleep(1400);
    const said2 = await ev('(document.querySelector("[data-fr-status]")||{}).textContent');

    return {
      timeline: seen,
      said: said2,
      stillTicking: typeof said1 === 'string' && typeof said2 === 'string' && said1 !== said2,
      uploads: log.filter((l) => l.kind === 'upload'),
      renders: log.filter((l) => l.kind === 'render'),
      notFound: log.filter((l) => l.kind === '404'),
      thrown: thrown.slice(),
      netNoise: netNoise.slice(),
      scrollBefore,
      scrollAfter: opts.scrollTo === undefined ? null : await ev('Math.round(window.scrollY)'),
      docHeight: await ev('Math.round(document.documentElement.scrollHeight)'),
      viewport: await ev('Math.round(window.innerHeight)'),
      hash: await ev('location.hash'),
      search: await ev('location.search'),
      path: await ev('location.pathname'),
    };
  }

  /* -------------------------------------------------------------------------
     THE AUDIT
     ------------------------------------------------------------------------- */

  console.log('\n  ============ UPLOAD ACK + REFRESH AUDIT ============');
  console.log(`  client:    ${CLIENT.split('\n').length} lines, verbatim from day.astro`);
  console.log(`  page:      ${PAGE}${FRAGMENT}   (from frame.ts)`);
  console.log(`  MAX_BYTES: ${MAX_BYTES}   (from frames.ts)`);

  const SUCCESS = [
    ['1. first upload of the day (no query on arrival)', ''],
    ['2. SECOND upload of the day — the assign() no-op case', '?ok=posted'],
    ['3. upload after a previous error', '?e=bad-upload'],
  ];

  for (const [label, startSearch] of SUCCESS) {
    console.log(`\n  --- ${label} ---`);
    const r = await trial('POST -> {ok:true}', 'posted', startSearch);
    if (!r) continue;
    is('exactly one upload, no silent re-post', r.uploads.length === 1, r.uploads);
    is('it asked for JSON', r.uploads[0]?.wantsJson === true, r.uploads[0]);
    is('THE PAGE RE-FETCHED FROM THE SERVER', r.renders.length >= 1, r.renders);
    is('landed on the day page', r.path === PAGE, r.path);
    is('with ?ok=posted', r.search === '?ok=posted', r.search);
    is(`on ${FRAGMENT}`, r.hash === FRAGMENT, r.hash);
    is('the server was asked for ?ok=posted', r.renders.some((x) => x.search === '?ok=posted'), r.renders);
    /* The 40x40 source is under the resizer's early-return threshold, so shrink()
       resolves the ORIGINAL and must still report its own pixel size. */
    is('it sent the image dimensions (40x40, the untouched path)',
      r.uploads[0]?.w === '40' && r.uploads[0]?.h === '40', [r.uploads[0]?.w, r.uploads[0]?.h]);
    is('the clock is not still ticking', r.stillTicking === false, r.said);
    is('nothing 404ed', r.notFound.length === 0, r.notFound);
    is('no thrown exception', r.thrown.length === 0, r.thrown);

  }

  /* ---- DOES SHE KEEP HER PLACE? -------------------------------------------------

     Reported as "the view window gets reset on mobile", and it was: measured at
     scrollBefore=400 -> scrollAfter=1086 on a 1555px document, BEFORE the fix. The
     cause is `#post`, which is the post form and sits a screen and a half down, so
     every hand-back jumped there.

     Both cases are run because they take different branches of usLand and the bug was
     in neither branch specifically — the first upload navigates to a new URL
     (assign), the second reloads the one she is on. A fix that only covered the
     reload would have looked right in testing and still thrown her on the common
     path.

     The tolerance is 4px rather than exact equality: `scrollTo` is subpixel on a
     fractional device ratio and asserting equality would make this fail on a
     retina viewport for a reason that has nothing to do with keeping her place. */
  console.log('\n  --- 3a. she keeps her place across the hand-back ---');
  for (const [label, startSearch] of [
    ['first upload of the day — usLand takes the assign() branch', ''],
    ['second upload — usLand takes the reload() branch', '?ok=posted'],
  ]) {
    const r = await trial(`POST -> {ok:true}, scrolled to 400 first (${label})`, 'posted', startSearch, {
      scrollTo: 400,
    });
    if (!r) continue;
    console.log(
      `      before=${r.scrollBefore} after=${r.scrollAfter} doc=${r.docHeight} viewport=${r.viewport}`,
    );
    is('it actually scrolled before submitting', r.scrollBefore === 400, r.scrollBefore);
    is('THE PAGE STILL RE-FETCHED', r.renders.length >= 1, r.renders);
    is('SHE IS WITHIN 4px OF WHERE SHE WAS', Math.abs(Number(r.scrollAfter) - 400) <= 4, {
      before: r.scrollBefore,
      after: r.scrollAfter,
    });
    /* The specific old behaviour, named so a regression is recognisable rather than
       just numerically wrong: 1086 was the anchor's offset on this document. */
    is('and NOT dumped at the #post anchor', Number(r.scrollAfter) < 900, r.scrollAfter);
    is('the fragment is still in the URL for the no-JS path', r.hash === FRAGMENT, r.hash);
    is('no thrown exception', r.thrown.length === 0, r.thrown);
  }

  /* ---- THE SHAPE OF THE WAIT — a separate question from correctness -------------
     The song post says "it's up. I'll see it." in place and holds it 700ms before it
     hands over to the server. This path is being compared against that. Run against a
     SLOW response, because over localhost the post finishes before there is any wait to
     have a shape. */
  console.log('\n  --- 3b. what she is told during a slow post (her phone, not this machine) ---');
  {
    const r = await trial('POST -> {ok:true} after 2.5s', 'slowPosted', '', { wait: 5200 });
    if (r) {
      console.log(`      timeline ${JSON.stringify(r.timeline)}`);
      is('something was said during the wait', r.timeline.length > 0, r.timeline);
      const last = r.timeline.length ? String(r.timeline[r.timeline.length - 1].text) : '';
      is('SHE IS ACKNOWLEDGED before the page is taken away',
        Boolean(last) && !/^(sending|shrinking)/.test(last), last);
      is('and it still re-fetched', r.renders.length >= 1, r.renders);
      is('with ?ok=posted', r.search === '?ok=posted', r.search);
    }
  }

  console.log('\n  --- 4. success with a 2400px source, so shrink() really re-encodes ---');
  {
    const r = await trial('POST -> {ok:true}, big source', 'posted', '', { big: true });
    if (r) {
      is('exactly one upload', r.uploads.length === 1, r.uploads);
      is('re-fetched', r.renders.length >= 1, r.renders);
      is('with ?ok=posted', r.search === '?ok=posted', r.search);
      is('no thrown exception from the resize path', r.thrown.length === 0, r.thrown);
      /* 2400x1200 against LONG_EDGE 1600 scales by 2/3, so the CANVAS size is what must
         be reported — not the original's. Getting this backwards would reserve a box
         twice the right size, which is a worse shift than reserving none. */
      is('it sent the RESIZED dimensions (1600x800, not 2400x1200)',
        r.uploads[0]?.w === '1600' && r.uploads[0]?.h === '800', [r.uploads[0]?.w, r.uploads[0]?.h]);
    }
  }

  /* THE RETRY POLICY IS ASSERTED, NOT JUST REPORTED.
     `retry: true` means re-posting the untouched original is a materially different
     attempt that might succeed, so a second upload is correct. Everything else must
     upload ONCE and take her to the reason — a second upload that cannot do better
     than the first is her connection spent for nothing. This list must stay in step
     with `retryWithOriginal` in day.astro. */
  const REFUSALS = [
    ['5.  rate limited',       'rate',         { retry: false }],
    ['6.  session expired',    'unauthorized', { retry: false }],
    ['7.  store write failed', 'store',        { retry: false }],
    ['8.  too big',            'tooBig',       { retry: false }],
    ['9.  cross-site refused', 'crossSite',    { retry: false }],
    ['10. R2 unconfigured',    'unconfigured', { retry: false }],
    ['11. not an image',       'notAnImage',   { retry: true }],
    ['12. no photo',           'noPhoto',      { retry: true }],
    ['13. truncated upload',   'badUpload',    { retry: true }],
  ];

  const refusalNotes = [];
  for (const [label, key, policy] of REFUSALS) {
    const code = RESPONSES[key].body.code;
    console.log(`\n  --- ${label} (${RESPONSES[key].status} ${code}) ---`);
    const r = await trial(`POST -> ${code}`, key, '');
    if (!r) continue;
    is('the clock stopped', r.stillTicking === false, r.said);
    is('she is not left staring at "sending…"', !/^sending/.test(String(r.said ?? '')), r.said);
    is('no thrown exception', r.thrown.length === 0, r.thrown);
    is('she ends on the day page, not a JSON document', r.path === PAGE, r.path);
    is(`the page is told the reason (?e=${code})`, r.search === `?e=${code}`, r.search);
    if (policy.retry) {
      is('re-posts the ORIGINAL, which is a real second chance',
        r.uploads.length === 2, r.uploads.length);
    } else {
      is('DOES NOT re-upload — a second try cannot do better',
        r.uploads.length === 1, r.uploads.length);
    }
    refusalNotes.push({ code, uploads: r.uploads.length, expected: policy.retry ? 2 : 1 });
    console.log(`      note  uploads=${r.uploads.length} search=${JSON.stringify(r.search)}`);
  }

  console.log('\n  --- 14. an unreadable answer (HTML error page instead of JSON) ---');
  {
    const r = await trial('POST -> 502 text/html', 'htmlGateway', '');
    if (r) {
      is('the clock stopped', r.stillTicking === false, r.said);
      is('no thrown exception', r.thrown.length === 0, r.thrown);
      /* An unreadable answer is UNKNOWN, not failed: the server writes bytes before it
         replies, so the photograph may be saved. She must not be dumped onto the raw
         error document, and must not be told it failed. */
      is('she stays in the wing, not on the endpoint URL', r.path === PAGE, r.path);
      is('and it is called unknown, not failed', r.search === '?ok=maybe', r.search);
      is('no second upload on an unknown outcome', r.uploads.length === 1, r.uploads.length);
      console.log(`      note  uploads=${r.uploads.length} path=${r.path} search=${JSON.stringify(r.search)}`);
    }
  }

  console.log('\n  --- 15. the endpoint never answers (the 45s deadline) ---');
  {
    const r = await trial('POST -> no response ever', 'hang', '', { wait: 47000 });
    if (r) {
      is('the clock stopped once the deadline fired', r.stillTicking === false, r.said);
      is('it did NOT re-post the photograph', r.uploads.length === 1, r.uploads);
      is('it reloaded to let the page state answer', r.renders.length >= 1, r.renders);
      is('landed on the day page', r.path === PAGE, r.path);
      /* THE SILENCE THIS FIX EXISTS FOR. It used to reload with a bare URL, so after
         waiting out the deadline she was told nothing at all. */
      is('SHE IS TOLD SOMETHING (?ok=maybe)', r.search === '?ok=maybe', r.search);
      is('and the server was asked for it', r.renders.some((x) => x.search === '?ok=maybe'), r.renders);
      is('no thrown exception', r.thrown.length === 0, r.thrown);
      console.log(`      note  said=${JSON.stringify(r.said)} search=${JSON.stringify(r.search)}`);
    }
  }

  console.log('\n  ---------- uploads per outcome (2 = the original was re-posted) ----------');
  for (const n of refusalNotes) {
    const ok = n.uploads === n.expected;
    console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${n.code.padEnd(14)} uploads=${n.uploads} expected=${n.expected}`);
  }

  console.log('\n  ====================================================');
  if (findings.length) {
    console.log('  findings:');
    for (const f of findings) console.log(`    - ${f}`);
  }
  console.log(`  ${fail ? 'FAILED' : 'all good'} — ${pass} passed, ${fail} failed\n`);
} finally {
  cleanup();
}

process.exit(fail ? 1 : 0);
