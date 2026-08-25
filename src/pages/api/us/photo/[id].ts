/**
 * GET /api/us/photo/[id] — the only door the photo bytes are ever behind.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ENDPOINT IS FOR
 *
 * The R2 bucket is private and has no public dev URL and no custom domain (see
 * config.ts). So there is exactly one way for a photograph to reach a browser:
 * this handler verifies the session cookie and then hands back a five-minute
 * presigned GET. An `<img src>` produced here is useless to anyone who did not
 * authenticate, and useless to her too by dinner.
 *
 * THE ID IS NOT A PATH
 *
 * `id` is attacker-controlled — it is a URL segment. It is used to SELECT a
 * manifest entry, never to BUILD an object key. findMemory() does an exact
 * match against a hardcoded list, so `../../.env`, `%2e%2e%2f`, a signed URL
 * for someone else's bucket and every other traversal shape all resolve to
 * "no such memory" and 404. There is deliberately no code path in this file
 * that interpolates the request into a key. If you add one, you have added an
 * arbitrary-object-read to a private bucket.
 *
 * DEFENSE IN DEPTH
 *
 * src/middleware.ts already default-denies everything under /api/us that is not
 * explicitly allowlisted, and this route is not allowlisted — so an
 * unauthenticated caller gets a 401 from the wall before reaching here. The
 * check below is what makes a future routing mistake in the middleware degrade
 * to "the endpoint says no" instead of "the album is public".
 *
 * TWO RESPONSE SHAPES, ONE CONTRACT
 *
 *   R2 configured     → 302 to the presigned URL. The bytes come from
 *                       Cloudflare, not through this function, so a page view
 *                       costs no egress and no function time per photo.
 *   R2 not configured → 200 with a generated SVG stand-in, same-origin.
 *
 * The caller treats both identically: point an <img> at this URL and you get an
 * image. That is what lets the entire room be built and reviewed before a
 * Cloudflare account exists, and it means the degraded path is exercised on
 * every local run instead of rotting until the day it is needed.
 *
 * A 302 to a `data:` URL is NOT the third option, before anyone tries it —
 * browsers refuse to follow a redirect to a data: URL, which is why the
 * unconfigured branch serves the bytes instead of redirecting to them.
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../../lib/us/config';
import {
  PRESIGN_BUCKET_SEC,
  findMemory,
  placeholderSvg,
  resolvePhotoUrl,
} from '../../../../lib/us/photos';
import { clientKey, hitLocal } from '../../../../lib/us/ratelimit';
import { readCookie, verify } from '../../../../lib/us/session';

export const prerender = false;

/**
 * Headers on every response. Privacy first, caching decided per-branch below.
 *
 * `X-Robots-Tag` and `Referrer-Policy` are set by src/middleware.ts too. They
 * are repeated here because a future routing change that takes this path out of
 * the middleware's scope must not also make the photo endpoint indexable.
 */
const PRIVACY: Record<string, string> = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
};

/**
 * For everything that is NOT the redirect: a hard no.
 *
 * An error body is worthless to cache and a cached 401 would be actively
 * confusing after signing in.
 */
const NO_STORE: Record<string, string> = {
  ...PRIVACY,
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
};

/* ---------------------------------------------------------------------------
   CACHING THE REDIRECT — AND THE THREE SEPARATE CACHES INVOLVED

   1. THIS RESPONSE (the 302). `private, max-age=900` lets HER browser reuse the
      redirect for one bucket width, which skips a serverless invocation per
      photo per page view. `private` is load-bearing: it forbids Vercel's CDN and
      any corporate proxy from holding a Location header that is, in effect, a
      bearer token. The arithmetic that makes this safe: the signed URL lives
      PRESIGN_TTL_SEC (3600s) from the START of its bucket, and this redirect can
      be reused for at most 900s after being issued at most 900s into that
      bucket — so a reused redirect points at a URL with at least 1800s left.

   2. THE OBJECT ITSELF. Not ours to set from here. R2 returns whatever
      Cache-Control was stored ON THE OBJECT at upload time, so the bytes are
      only browser-cacheable if the upload said so:
         rclone copy --header-upload "Cache-Control: private, max-age=604800"
      Without that the photos re-download even though the URL is now stable, and
      the stable-URL work above buys nothing. This is the step that is easy to
      forget because nothing in this repo can check it.

   3. WHAT ACTUALLY DELIVERS THE WIN. Stable URLs (photos.ts) plus (2). Even with
      this redirect uncached, a stable Location means the follow-up GET hits the
      browser's cache entry for the R2 URL from the previous page view. (1) is
      the smaller, additional saving.

   KNOWN LIMITATION, NOT A BUG IN THIS FILE: src/middleware.ts's
   withPrivacyHeaders() currently force-sets `Cache-Control: private, no-store`
   on every response leaving the wing, which overwrites the header below. So (1)
   does not take effect until the middleware is taught to leave an
   already-explicit Cache-Control alone. (2) and (3) work today regardless. The
   header is set here anyway, so that the day the middleware is relaxed this
   route is already correct rather than needing to be remembered.
   --------------------------------------------------------------------------- */
const REDIRECT_CACHE: Record<string, string> = {
  ...PRIVACY,
  'Cache-Control': `private, max-age=${PRESIGN_BUCKET_SEC}`,
};

/* ---------------------------------------------------------------------------
   THE CAP, AND WHY IT IS LOCAL AND GENEROUS

   Every other endpoint in the wing rate-limits, and for a while this one was left
   out as the exception. It is genuinely a different shape, though, and the numbers
   are what settle how to do it rather than whether.

   THIS IS NOT AN ACTION, IT IS AN IMAGE. The other endpoints are hit once when
   somebody taps something. This one is hit once per <img>: sixteen photographs on
   the board, plus the full-size copy of any she opens. So a limit here is priced
   per-image, not per-gesture.

   Which is why it uses hitLocal() and not hit(). hit() goes to Upstash whenever
   Upstash is configured, and that is a fetch with a two-second ceiling in front of
   every single image — on a handler that otherwise does NO network I/O on a warm
   instance, because photos.ts caches existence in process and signing is pure
   arithmetic. The three commands per call are affordable; the round trip in front
   of her photographs is not. hitLocal() costs nothing and leaves the endpoint as
   cheap as it was.

   WHAT IT ACTUALLY PROTECTS AGAINST is a runaway loop — a bug in a page script
   requesting images in a cycle, which today would burn a serverless invocation per
   iteration with nothing to stop it. It is not a defence against a person, and it
   does not need to be: the session cookie already decided who may look, and
   findMemory() matches ids against a hardcoded list so there is nothing to walk.

   THE CEILING IS SIZED SO A HUMAN CANNOT REACH IT. A heavy board session is about
   thirty-two requests, so 200 in ten minutes is roughly six full page loads a
   minute. Nobody browses like that and a loop passes it instantly. Erring high is
   deliberate: the cost of being wrong in the generous direction is a loop that runs
   a little longer, and in the strict direction it is a broken image in her room.
   --------------------------------------------------------------------------- */
const RATE_LIMIT = 200;
const RATE_WINDOW_SEC = 600;

function fail(status: number, error: string, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json', ...NO_STORE, ...extra },
  });
}

export const GET: APIRoute = async ({ params, cookies, url, request, clientAddress }) => {
  // ---- 1. Authorize, ourselves, from scratch -----------------------------
  const secret = SESSION_SECRET();
  if (!secret) {
    // Fail closed. A missing signing secret means we cannot tell an authorized
    // caller from anyone else, and the only safe answer to that is "no".
    console.error('[us] photo requested but US_SESSION_SECRET is not set.');
    return fail(503, 'unconfigured');
  }

  // Either purpose is accepted, matching src/middleware.ts: my own admin token
  // must be able to see her room, or I cannot check that it works.
  const authorized =
    verify(secret, 'session', readCookie(cookies, 'session', url)) ??
    verify(secret, 'admin', readCookie(cookies, 'admin', url));

  if (!authorized) return fail(401, 'unauthorized');

  /* ---- 1a. Cap the volume, after authorising and before doing any work ----
     AFTER the cookie check, so an unauthenticated flood cannot consume her bucket
     and lock her out of her own photographs. BEFORE findMemory() and the presign, so
     a refusal is the cheapest possible response and skips the R2 existence check
     that a cold instance would otherwise do.

     Retry-After is sent because this response can reach an <img>: a browser that
     gets a bare 429 for a picture has nothing to act on, and the header is the one
     thing that tells a client when it is worth trying again. */
  const capped = hitLocal(`photo:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!capped.ok) {
    return fail(429, 'rate', { 'Retry-After': String(capped.retryAfter) });
  }

  // ---- 2. Resolve the id against the manifest ----------------------------
  const memory = findMemory(params.id);
  // Unknown id and malformed id are the same answer on purpose. Distinguishing
  // them would turn this endpoint into an oracle for which keys exist.
  if (!memory) return fail(404, 'not-found');

  /* ---- 3. Which variant? ------------------------------------------------
     `?s=sm` asks for the downscaled sibling. Compared against a literal rather
     than passed through, for the same reason `id` is: nothing a caller sends may
     ever reach an object key. Any other value is simply the full size. */
  const small = url.searchParams.get('s') === 'sm';

  /* ---- 4a. Present in the bucket: hand over a bucketed, expiring URL ----
     resolvePhotoUrl() confirms the object EXISTS before signing for it. Without
     that check, wiring up credentials against a bucket with nothing in it yet
     produced thirteen perfectly valid URLs for thirteen 404s — a room of broken
     images that was strictly worse than having no credentials at all. */
  const signed = await resolvePhotoUrl(memory, { small });
  if (signed) {
    return new Response(null, {
      status: 302,
      headers: { Location: signed, ...REDIRECT_CACHE },
    });
  }

  /* ---- 4b. Otherwise: serve the stand-in --------------------------------
     Reached when R2 is unconfigured, when the object is not uploaded yet, or
     when the key is malformed. All three want the same answer: a labelled
     placeholder card, so the room looks deliberate at every stage instead of
     showing a broken image and making the empty bucket someone's debugging
     problem. As Sam pushes photographs they replace themselves, with no code
     change and no redeploy — see the negative-cache TTL in photos.ts. */
  return new Response(placeholderSvg(memory), {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // An SVG served to an <img> or a WebGL texture never executes script, but
      // this response is same-origin and someone will eventually open it in a
      // tab. CSP costs nothing and closes that off.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      ...NO_STORE,
    },
  });
};

/** Anything other than GET. Explicit, so a stray POST is a 405 and not a crash. */
export const ALL: APIRoute = () => fail(405, 'method-not-allowed');
