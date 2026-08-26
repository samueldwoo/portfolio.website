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
const scriptMatch = /<script\s+is:inline[^>]*>([\s\S]*?)<\/script>/.exec(pageSrc);
if (!scriptMatch) fatal('no inline script found in day.astro — refusing to test nothing.');
const CLIENT = scriptMatch[1];

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
    for await (const _ of req) { /* drain, so the upload genuinely completes */ }
    const accept = req.headers.accept ?? '';
    const wantsJson = accept.includes('application/json');
    log.push({ kind: 'upload', wantsJson });

    const r = RESPONSES[mode];
    if (r.hang) return;                       // never answer: exercises the 45s deadline

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
    return res.end(`<!doctype html><meta charset=utf-8><title>day</title>
<body>${FORM}<div id="post" style="margin-top:1500px">anchor</div>
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
    await ev(`document.querySelector('[data-fr-form]')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); 1`);

    await sleep(opts.wait ?? 2500);

    const said1 = await ev('(document.querySelector("[data-fr-status]")||{}).textContent');
    await sleep(1400);
    const said2 = await ev('(document.querySelector("[data-fr-status]")||{}).textContent');

    return {
      said: said2,
      stillTicking: typeof said1 === 'string' && typeof said2 === 'string' && said1 !== said2,
      uploads: log.filter((l) => l.kind === 'upload'),
      renders: log.filter((l) => l.kind === 'render'),
      notFound: log.filter((l) => l.kind === '404'),
      thrown: thrown.slice(),
      netNoise: netNoise.slice(),
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
    is('the clock is not still ticking', r.stillTicking === false, r.said);
    is('nothing 404ed', r.notFound.length === 0, r.notFound);
    is('no thrown exception', r.thrown.length === 0, r.thrown);
  }

  console.log('\n  --- 4. success with a 2400px source, so shrink() really re-encodes ---');
  {
    const r = await trial('POST -> {ok:true}, big source', 'posted', '', { big: true });
    if (r) {
      is('exactly one upload', r.uploads.length === 1, r.uploads);
      is('re-fetched', r.renders.length >= 1, r.renders);
      is('with ?ok=posted', r.search === '?ok=posted', r.search);
      is('no thrown exception from the resize path', r.thrown.length === 0, r.thrown);
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
