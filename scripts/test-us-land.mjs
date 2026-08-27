#!/usr/bin/env node
/**
 * test-us-land.mjs — usLand() actually re-fetches, for every URL the wing hands it.
 *
 *   npm run test:us-land
 *
 * ---------------------------------------------------------------------------
 * WHY A BROWSER, AND WHY MEASURED SERVER-SIDE
 *
 * The thing under test is a browser behaviour nothing documents: `location.assign()`
 * does NOT reload when the target differs from the current URL only in the fragment, or
 * not at all. MDN's assign() page does not cover the identical-URL case. So the only
 * honest test drives real Chrome, and asks the SERVER whether it was asked for the page
 * — a client-side assertion cannot tell "re-rendered" from "scrolled to an anchor".
 *
 * Four pages hand control back to the server through a URL built from the outcome, and
 * every one of them can target the URL she is already on:
 *
 *   the photograph  ?ok=posted#post        posting a second photo the same day
 *   the song        ?sent=<date>           fixing a wrong link the same day
 *   a letter        ?read=<id>&sent=1      replying to the same letter again
 *   the question    ?ok=answered#question  answering again
 *
 * The photograph case shipped broken: the write succeeded and the page did nothing. The
 * other three were found by asking whether they had the same shape, which they did.
 *
 * Every case below is run from the URL that makes it a repeat, because that is the one
 * that was broken — running them from a different URL would pass on the old code too.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 8600 + (process.pid % 300);
const CDP = 9600 + (process.pid % 300);

const US_LAND = readFileSync(join(ROOT, 'public/us-land.js'), 'utf8');
if (!US_LAND.includes('window.usLand')) {
  console.error('  FATAL: public/us-land.js no longer defines window.usLand');
  process.exit(2);
}

/* THE REAL CALL SITES, read out of the pages rather than listed by hand — so a page
   that stops using usLand, or a fifth one that starts, shows up here. */
const PAGES = ['day', 'today', 'index', 'letters'];
const missing = PAGES.filter((p) => {
  const src = readFileSync(join(ROOT, `src/pages/samdrea/vault/${p}.astro`), 'utf8');
  return !src.includes('usLand') || !src.includes('src="/us-land.js"');
});
if (missing.length) {
  console.error(`  FATAL: these pages reference usLand without loading it, or vice versa: ${missing.join(', ')}`);
  process.exit(2);
}

/* Every path any case navigates to or from. */
const PATHS = new Set([
  '/samdrea/vault/day',
  '/samdrea/vault/today',
  '/samdrea/vault',
  '/samdrea/vault/letters',
]);

let asked = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (!PATHS.has(url.pathname)) { res.writeHead(404); return res.end(); }
  asked.push(url.pathname + url.search);
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset=utf-8><title>t</title><body>
<div id="post" style="margin-top:1200px">a</div><div id="question">q</div>
<script>${US_LAND}</script></body>`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(homedir(), '.wingtest', 'usland-'));
let chrome = null;
let ws = null;
let pass = 0;
let fail = 0;

function cleanup() {
  try { ws?.close(); } catch { /* gone */ }
  try { chrome?.kill('SIGKILL'); } catch { /* gone */ }
  try { server.close(); } catch { /* closed */ }
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
      const r = await fetch(`http://127.0.0.1:${CDP}/json/version`);
      if (r.ok) ver = await r.json();
    } catch { /* not up */ }
    if (!ver) await sleep(500);
  }
  if (!ver) { console.error(`  FATAL: no CDP on ${CDP}`); process.exit(2); }

  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { result: { targetInfos } } = await send('Target.getTargets');
  const t = targetInfos.find((x) => x.type === 'page');
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    return r.result?.result?.value;
  };

  const is = (name, cond, got) => {
    cond ? pass += 1 : fail += 1;
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : `  got ${JSON.stringify(got)}`}`);
  };

  /**
   * @param from  the URL she is sitting on
   * @param args  what the page passes to usLand
   */
  async function landsFresh(label, from, args) {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${from}` }, sessionId);
    await sleep(700);
    asked = [];
    await ev('window.__alive = 1; 1');
    await ev(`usLand(${args.map((a) => JSON.stringify(a)).join(', ')}); 1`);
    await sleep(1200);
    const alive = await ev('typeof window.__alive');
    const reFetched = asked.length > 0;
    /* BOTH halves, because either alone is satisfiable the wrong way. A fresh document
       with no server hit would mean a cache served it; a server hit with the marker
       still set is not possible, but asserting both keeps the test honest if it ever is. */
    is(label, reFetched && alive === 'undefined', { asked, alive });
    return { path: await ev('location.pathname'), hash: await ev('location.hash') };
  }

  console.log('\n  --- the four real call sites, each from the URL that repeats ---');

  const r1 = await landsFresh(
    'photograph: ?ok=posted#post from the same',
    '/samdrea/vault/day?ok=posted#post',
    ['/samdrea/vault/day', '?ok=posted', '#post'],
  );
  is('  and keeps #post', r1.hash === '#post', r1.hash);

  await landsFresh(
    'song: ?sent=<date> from the same (fixing a wrong link)',
    '/samdrea/vault/today?sent=2026-08-27',
    ['/samdrea/vault/today', '?sent=2026-08-27', ''],
  );

  await landsFresh(
    'letter: ?read=<id>&sent=1 from the same',
    '/samdrea/vault/letters?read=l01&sent=1',
    ['/samdrea/vault/letters', '?read=l01&sent=1', ''],
  );

  const r4 = await landsFresh(
    'question: ?ok=answered#question from the same',
    '/samdrea/vault?ok=answered#question',
    ['/samdrea/vault', '?ok=answered', '#question'],
  );
  is('  and keeps #question', r4.hash === '#question', r4.hash);

  console.log('\n  --- differs only by FRAGMENT: assign() would not reload either ---');
  await landsFresh(
    'photograph: no fragment yet',
    '/samdrea/vault/day?ok=posted',
    ['/samdrea/vault/day', '?ok=posted', '#post'],
  );

  console.log('\n  --- genuinely different documents still work ---');
  await landsFresh(
    'from an error query',
    '/samdrea/vault/day?e=bad-upload',
    ['/samdrea/vault/day', '?ok=posted', '#post'],
  );
  await landsFresh(
    'from no query at all',
    '/samdrea/vault/day',
    ['/samdrea/vault/day', '?ok=posted', '#post'],
  );
  const cross = await landsFresh(
    'across pages',
    '/samdrea/vault/today?sent=2026-08-27',
    ['/samdrea/vault/day', '?ok=posted', '#post'],
  );
  is('  and lands on the other page', cross.path === '/samdrea/vault/day', cross.path);

  console.log('\n  --- an empty search is not the same as no search ---');
  await landsFresh(
    'bare path from a queried URL',
    '/samdrea/vault/day?ok=posted',
    ['/samdrea/vault/day', '', '#post'],
  );
  await landsFresh(
    'bare path from the bare path',
    '/samdrea/vault/day#post',
    ['/samdrea/vault/day', '', '#post'],
  );

  console.log(`\n  ${fail ? 'FAILED' : 'all good'} — ${pass} passed, ${fail} failed\n`);
} finally {
  cleanup();
}

process.exit(fail ? 1 : 0);
