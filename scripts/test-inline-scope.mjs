#!/usr/bin/env node
/**
 * test-inline-scope.mjs — every identifier in an `is:inline` script resolves.
 *
 *   npm run test:inline
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND IT IS NOT A GENERAL LINTER
 *
 * The inline scripts in this wing are checked by NOTHING. `astro check` says so out
 * loud on every one of them — "this script will be treated as if it has the is:inline
 * directive, therefore features that require processing are unavailable" — and the
 * build passes them through as opaque text. There is no eslint in the repo. So a
 * reference to a name that does not exist is not a build error, not a type error, and
 * not a warning. It is a runtime ReferenceError on her phone.
 *
 * That is not hypothetical. The upload acknowledgement shipped with `killer` and `ctl`
 * declared with `var` INSIDE one `.then()` callback and cleared from two sibling
 * callbacks that never had them. `var` is function-scoped, so the first
 * `clearTimeout(killer)` threw, the `.catch` threw the identical error on its own first
 * line, and the rejection went unhandled. The photograph uploaded fine. The page just
 * never found out: no message, no picture, and a clock that counted past its own 45s
 * deadline until she gave up at 60 and refreshed by hand.
 *
 * Every layer that should have caught that was structurally unable to. This is the one
 * check that can.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES AND WHAT IT DELIBERATELY DOES NOT
 *
 * It resolves every identifier reference against the scope chain, treating `var` and
 * function declarations as function-scoped and `let`/`const`/`class`/params/catch
 * bindings as belonging to the nearest enclosing scope it tracks. Anything unresolved
 * and not a known browser or language global is an error.
 *
 * It is deliberately NOT block-scope-exact: a `let` inside an `if` is treated as
 * belonging to the enclosing function. That direction is safe — it can miss a
 * temporal-dead-zone bug, but it cannot invent one, and a checker that cries wolf on
 * this codebase would be turned off within a day. The bug class it exists for is
 * cross-FUNCTION, which it catches exactly.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'acorn';

const ROOT = new URL('..', import.meta.url).pathname;
/* An argument overrides the scan root, which exists so this check can be pointed at a
   known-bad copy and proved to FAIL. A checker that has only ever passed is a rubber
   stamp — see the negative case in the commit that introduced this. */
const WING = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'src/pages/samdrea');

/* Names the browser and the language provide. Not exhaustive by design — an unknown
   global is worth a look, and adding one here is a deliberate act. */
const GLOBALS = new Set([
  // language
  'undefined', 'NaN', 'Infinity', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Function', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'globalThis', 'console', 'arguments', 'eval', 'Intl', 'Notification',
  // timers and scheduling
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  // dom and platform
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'localStorage',
  'sessionStorage', 'customElements', 'getComputedStyle', 'matchMedia', 'devicePixelRatio',
  'Element', 'HTMLElement', 'HTMLImageElement', 'HTMLCanvasElement', 'Node', 'Event',
  'CustomEvent', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
  'AbortController', 'AbortSignal', 'FormData', 'URL', 'URLSearchParams', 'Blob', 'File',
  'FileReader', 'Image', 'Audio', 'Response', 'Request', 'Headers', 'fetch',
  'DOMParser', 'TextEncoder', 'TextDecoder', 'atob', 'btoa', 'structuredClone',
  'Uint8Array', 'Uint16Array', 'Int8Array', 'Float32Array', 'ArrayBuffer', 'DataView',
  'CSS', 'performance', 'crypto', 'alert', 'confirm', 'scrollTo', 'scrollBy',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'top', 'self', 'parent',
  'innerWidth', 'innerHeight', 'pageXOffset', 'pageYOffset', 'scrollX', 'scrollY',
  // libraries these pages load from <script src>
  'gsap', 'ScrollTrigger', 'Draggable', 'InertiaPlugin', 'Motion', 'anime', 'THREE',
]);

/* ---------------------------------------------------------------------------
   EXTRACTION
   --------------------------------------------------------------------------- */

/** Every `.astro` under the wing. */
function pages(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...pages(p));
    else if (name.endsWith('.astro')) out.push(p);
  }
  return out;
}

/**
 * Inline blocks, with the line they start on so an error can be clicked.
 *
 * `define:vars={{ a, b }}` injects those names as real bindings at runtime, so they
 * are collected and pre-declared. Missing that would report every one of them as
 * undefined, which is the fastest way to make a check useless.
 */
function inlineBlocks(src) {
  const out = [];
  /* EXTERNAL references are skipped. `<script is:inline src="/us-land.js">` carries the
     directive too, and its body is empty — counting those inflated the block count and
     diluted the check with blocks that trivially pass. */
  const re = /<script\s+is:inline(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) {
    const injected = [];
    const dv = /define:vars=\{\{([\s\S]*?)\}\}/.exec(m[1]);
    if (dv) {
      for (const part of dv[1].split(',')) {
        const name = part.split(':')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) injected.push(name);
      }
    }
    out.push({
      code: m[2],
      injected,
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
   SCOPE RESOLUTION
   --------------------------------------------------------------------------- */

const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function declaredNames(pattern, into) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier': into.add(pattern.name); break;
    case 'ObjectPattern':
      for (const p of pattern.properties) {
        declaredNames(p.type === 'RestElement' ? p.argument : p.value, into);
      }
      break;
    case 'ArrayPattern':
      for (const e of pattern.elements) declaredNames(e, into);
      break;
    case 'AssignmentPattern': declaredNames(pattern.left, into); break;
    case 'RestElement': declaredNames(pattern.argument, into); break;
    default: break;
  }
}

function childNodes(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') out.push(c);
    } else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
}

/**
 * Collect declarations belonging to `scope`, not descending into nested functions.
 *
 * THE NAME IS RECORDED BEFORE THE DESCENT IS REFUSED, and the order is the whole
 * correctness of this function. A `function say() {}` declares `say` in the scope it
 * SITS IN while owning its own scope for its body — so returning at the nested-function
 * guard first (which the first draft did) drops the name and then reports every call to
 * it as undefined. That produced 27 false positives on the first run, all of them
 * top-level helpers, which is exactly how a checker earns being switched off.
 */
function collectDecls(node, scope, isRoot) {
  if (node.type === 'VariableDeclaration') {
    for (const d of node.declarations) declaredNames(d.id, scope.names);
  }
  if (node.type === 'FunctionDeclaration' && node.id) scope.names.add(node.id.name);
  if (node.type === 'ClassDeclaration' && node.id) scope.names.add(node.id.name);
  if (!isRoot && FN.has(node.type)) return;      // its body is its own business
  for (const c of childNodes(node)) collectDecls(c, scope, false);
}

function makeScope(node, parent) {
  const scope = { names: new Set(), parent };
  if (FN.has(node.type)) {
    for (const p of node.params) declaredNames(p, scope.names);
    // A named function expression can refer to itself.
    if (node.id) scope.names.add(node.id.name);
  }
  const body = FN.has(node.type) ? node.body : node;
  collectDecls(body, scope, true);
  return scope;
}

function resolves(name, scope) {
  for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
  return GLOBALS.has(name);
}

/** Walk, tracking scope, reporting unresolved identifier REFERENCES. */
function check(node, scope, problems) {
  if (FN.has(node.type)) scope = makeScope(node, scope);
  if (node.type === 'CatchClause' && node.param) {
    const s = { names: new Set(), parent: scope };
    declaredNames(node.param, s.names);
    collectDecls(node.body, s, true);
    scope = s;
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const v = node[key];
    const kids = Array.isArray(v) ? v : [v];
    for (const c of kids) {
      if (!c || typeof c.type !== 'string') continue;

      // Positions where an Identifier is a NAME, not a reference.
      if (node.type === 'MemberExpression' && key === 'property' && !node.computed) continue;
      if (node.type === 'Property' && key === 'key' && !node.computed) continue;
      if (node.type === 'MethodDefinition' && key === 'key' && !node.computed) continue;
      if (key === 'id' && (node.type === 'VariableDeclarator' || FN.has(node.type)
        || node.type === 'ClassDeclaration')) continue;
      if (FN.has(node.type) && key === 'params') continue;
      if (node.type === 'LabeledStatement' && key === 'label') continue;
      if ((node.type === 'BreakStatement' || node.type === 'ContinueStatement') && key === 'label') continue;
      if (node.type === 'CatchClause' && key === 'param') continue;
      if (node.type === 'ExportSpecifier' || node.type === 'ImportSpecifier') continue;

      if (c.type === 'Identifier') {
        if (!resolves(c.name, scope)) problems.push({ name: c.name, node: c });
      } else {
        check(c, scope, problems);
      }
    }
  }
}

/* ---------------------------------------------------------------------------
   RUN
   --------------------------------------------------------------------------- */

let pass = 0;
const failures = [];

for (const file of pages(WING).sort()) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  const blocks = inlineBlocks(src);
  if (!blocks.length) continue;

  blocks.forEach((block, i) => {
    let ast;
    try {
      ast = parse(block.code, { ecmaVersion: 2022, sourceType: 'script', locations: true });
    } catch (err) {
      failures.push(`${rel} block ${i}: will not parse — ${err.message}`);
      return;
    }

    const root = makeScope(ast, null);
    for (const n of block.injected) root.names.add(n);

    const problems = [];
    check(ast, root, problems);

    if (problems.length) {
      for (const p of problems) {
        const line = block.line + (p.node.loc ? p.node.loc.start.line - 1 : 0);
        failures.push(`${rel}:${line}  '${p.name}' is not defined in any enclosing scope`);
      }
    } else {
      pass += 1;
      console.log(`  ok   ${rel} block ${i} — ${block.code.split('\n').length} lines, every name resolves`);
    }
  });
}

if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`\n  FAILED — ${failures.length} unresolved reference(s)\n`);
  process.exit(1);
}

console.log(`\n  all good — ${pass} inline script block(s), every identifier resolves\n`);
