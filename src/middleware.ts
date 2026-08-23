/**
 * middleware.ts — the guard on the private wing.
 *
 * ---------------------------------------------------------------------------
 * SCOPE, AND WHY IT IS NARROW
 *
 * This file runs for on-demand routes AND during `astro build` while the public
 * pages are being prerendered. So the first thing it does is get out of the way
 * for anything that is not part of the private wing. A middleware that threw —
 * or redirected — on `/index.html` would break the entire public site's build,
 * not just its runtime.
 *
 * WHAT IT CANNOT DO
 *
 * Astro middleware does not run for prerendered pages or for files served out of
 * `public/`. Therefore NO private byte may ever live in `public/` — it would be
 * world-readable at a guessable URL with this guard never consulted. That single
 * constraint is why photos go to R2 behind short-lived presigned URLs rather
 * than into the repo. If you are ever tempted to drop a photo in `public/`
 * "just for now": that is the one thing this design cannot survive.
 *
 * DEFENSE IN DEPTH
 *
 * Every private endpoint re-checks authorization itself. This guard is the outer
 * wall, not the only one — a routing mistake here should downgrade to "the
 * endpoint says no", not "everything is public".
 * ---------------------------------------------------------------------------
 */

import { defineMiddleware } from 'astro:middleware';
import { readCookie, verify } from './lib/us/session';
import { SESSION_SECRET } from './lib/us/config';

/** The wing's base path. Renaming this also means renaming src/pages/samdrea/. */
const WING = '/samdrea';

/** Pages that require a valid `session` token (she is through the gate). */
const NEEDS_SESSION = [`${WING}/vault`];

/**
 * Pages that require a valid `admin` token (me, posting).
 *
 * `/samdrea/dj` is deliberately NOT here. It is the admin LOGIN page, and a
 * login page guarded by the credential it exists to collect is a locked door
 * with the key inside. So dj.astro self-guards instead: no admin token renders
 * a bare passcode form and nothing else, a valid one renders the posting UI.
 *
 * That is safe because the page itself holds no secrets — the passcode is
 * verified by /api/us/admin against a digest, and every write endpoint
 * independently demands the admin token. The worst case for a bug here is that
 * a stranger sees an empty passcode box.
 */
const NEEDS_ADMIN: string[] = [];

/**
 * API endpoints reachable WITHOUT any token. This is an allowlist, not a
 * denylist, and that direction is the whole point: everything else under
 * /api/us is private by DEFAULT, so a new endpoint added in Phase 2 or 3 is
 * guarded from the moment the file exists, even if I forget to write a check
 * inside it. Adding a path here is a deliberate decision to make it public.
 *
 *   gate  — the login endpoint itself; it cannot require a login
 *   out   — signing out must work whether or not the cookie is still valid
 *   admin — where I exchange my passcode for an admin token (Phase 2)
 *
 * Endpoints still authorize themselves for the SPECIFIC purpose they need
 * (session vs admin); this wall only establishes that a caller has one of them.
 */
const PUBLIC_API = ['/api/us/gate', '/api/us/out', '/api/us/admin'];

function startsWithSegment(path: string, base: string): boolean {
  // Segment-aware so `/samdrea/vaultsomething` does not match `/samdrea/vault`.
  return path === base || path.startsWith(`${base}/`);
}

export const onRequest = defineMiddleware(async (ctx, next) => {
  // Normalize a trailing slash so `/samdrea/vault/` and `/samdrea/vault` are
  // one path for every comparison below.
  const path = ctx.url.pathname.length > 1
    ? ctx.url.pathname.replace(/\/+$/, '')
    : ctx.url.pathname;

  const isApi = path.startsWith('/api/us');
  const inWing = startsWithSegment(path, WING) || isApi;
  if (!inWing) return next();

  // Private-by-default for the API: anything not explicitly allowlisted needs
  // a token. `admin` counts, because I must be able to reach her endpoints too.
  const apiIsPublic = isApi && PUBLIC_API.some((p) => startsWithSegment(path, p));

  const needsSession = NEEDS_SESSION.some((p) => startsWithSegment(path, p)) || (isApi && !apiIsPublic);
  const needsAdmin = NEEDS_ADMIN.some((p) => startsWithSegment(path, p));

  if (needsSession || needsAdmin) {
    const secret = SESSION_SECRET();
    const read = (purpose: 'session' | 'admin') =>
      secret ? verify(secret, purpose, readCookie(ctx.cookies, purpose, ctx.url)) : null;

    // An admin page demands the admin token specifically. Everything else
    // accepts either, so my own admin session is not locked out of her rooms.
    const valid = needsAdmin ? read('admin') : (read('session') ?? read('admin'));

    if (!valid) {
      /* A SCRIPT gets a status code; a PERSON gets sent to the front door — and
         "is this an API path" was the wrong way to tell them apart.

         Every endpoint here is posted to two ways: by fetch, which wants JSON,
         and by a plain <form>, which is a NAVIGATION whose response BECOMES the
         page. Keying off the path meant a form post carrying a stale cookie
         returned `{"ok":false,"error":"unauthorized"}` as the page. Her session
         lapses, she taps a reaction, and she is looking at a JSON blob — inside
         an installed app with no URL bar and no back button.

         It also made dead code of a sentence written four times over ("your
         session ran out. Answer the questions again and you are back in."):
         every copy was unreachable, because this branch fired first and never
         redirected.

         So the test is now what the CALLER can render. A form-encoded or
         multipart POST is a navigation and goes to the gate. Everything else —
         fetch, JSON, anything asking for JSON back — still gets the 401 it can
         parse. */
      if (path.startsWith('/api/')) {
        const ct = (ctx.request.headers.get('content-type') ?? '').toLowerCase();
        const accept = (ctx.request.headers.get('accept') ?? '').toLowerCase();
        const isFormNavigation =
          !accept.includes('application/json') &&
          (ct.includes('application/x-www-form-urlencoded') ||
            ct.includes('multipart/form-data'));

        if (!isFormNavigation) {
          return withPrivacyHeaders(
            new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }

        /* 303, not 302: the request was a POST and the destination is a page to
           GET. A 302 would have the browser re-POST to the gate. */
        const back = new URL(WING, ctx.url);
        back.searchParams.set('e', 'unauthorized');
        return withPrivacyHeaders(
          new Response(null, { status: 303, headers: { Location: back.toString() } }),
        );
      }

      const gate = new URL(WING, ctx.url);
      // `next` is echoed back into a redirect after login, so it is only ever
      // allowed to be a path inside this wing — never a full URL, never an
      // absolute path elsewhere. Otherwise this is an open redirect that
      // borrows the trust of my own domain.
      if (startsWithSegment(path, `${WING}/`) || startsWithSegment(path, WING)) {
        gate.searchParams.set('next', path);
      }
      return withPrivacyHeaders(Response.redirect(gate, 302));
    }
  }

  return withPrivacyHeaders(await next());
});

/**
 * Applied to every response from the wing, authorized or not.
 *
 * `noindex, nofollow, noarchive` is set as a HEADER rather than only a <meta>
 * tag because it then also covers JSON endpoints and redirects, which cannot
 * carry a meta tag. Note what is deliberately absent: any mention of this wing
 * in robots.txt. A Disallow rule is a publicly readable directory of the exact
 * paths you were hoping nobody would try.
 */
function withPrivacyHeaders(res: Response): Response {
  // Response.redirect() produces an immutable-headers response in some runtimes,
  // so mutation is attempted and a fresh Response is built if it is refused.
  const headers = new Headers(res.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  headers.set('Referrer-Policy', 'no-referrer');
  // Never let a shared cache hold a page that was rendered for an authorized
  // session. Without this, Vercel's CDN could serve her vault to the next caller.
  headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');

  try {
    res.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.headers.set('Referrer-Policy', 'no-referrer');
    res.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    return res;
  } catch {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
