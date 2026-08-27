/**
 * POST /api/us/push — register or forget one device for notifications.
 *
 * ---------------------------------------------------------------------------
 * JSON ONLY, AND THIS IS THE ONE ENDPOINT IN THE WING ALLOWED TO BE
 *
 * Every other write here keeps a no-JavaScript path, because a plain form is the
 * accessible route and the one that must never regress. This endpoint cannot
 * have one and it is not a compromise: a push subscription is minted by
 * `ServiceWorkerRegistration.pushManager.subscribe()`, in JavaScript, in the
 * browser. There is no subscription to submit without a script, so a <form>
 * pointing here could only ever post an empty body.
 *
 * The consequence is handled where it belongs — on the hub, where the whole
 * notification block is `hidden` in the markup and only revealed by the script
 * that has already established the browser can do this. With JavaScript off she
 * sees nothing there rather than a button that cannot work.
 *
 * ---------------------------------------------------------------------------
 * `who` COMES FROM THE COOKIE AND NEVER FROM THE BODY
 *
 * The body carries a device credential and an action, and that is all it is
 * allowed to carry. If it could name a person, either of them could register a
 * device under the other's name — and then every notification meant for her
 * would arrive on that device instead. identify() reads it off the signed cookie,
 * exactly as react.ts, reply.ts and song.ts all do, and for the same reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT SENSITIVE IN HERE
 *
 * An endpoint URL is a CAPABILITY: whoever holds it, plus the VAPID private key,
 * can put words on her lock screen. So it is never logged in full (see
 * safeLabel() in push.ts), never echoed back in a response, and never rendered
 * into a page. The response says whether it worked and nothing else.
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET, hasKV, hasPush } from '../../../lib/us/config';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import { crossSite, identify } from '../../../lib/us/together';
import { subscribeDevice, unsubscribeDevice } from '../../../lib/us/push';
import { trace } from '../../../lib/us/trace';

export const prerender = false;

/**
 * Generous, because the hub re-registers on every load once permission is
 * granted — that is what makes a subscription the store somehow lost heal itself
 * instead of needing her to notice. So the ordinary rate is one per page view,
 * and this number only has to sit above "she refreshed a lot" and below "a loop".
 */
const RATE_LIMIT = 40;
const RATE_WINDOW_SEC = 600;

/**
 * Repeated here rather than left to src/middleware.ts, for the reason
 * thinking.ts and mark.ts both repeat them: a future routing change that takes
 * this path out of the middleware's scope must not also make it indexable or leak
 * a referrer.
 */
const PRIVACY: Record<string, string> = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function json(body: unknown, status = 200): Response {
  /* THE TRACE GOES HERE, not at twelve `return json(...)` sites.
     This is the only response constructor in the file, and it already receives both
     halves of what a trace line needs — the status and the body carrying `code`. So one
     insertion is total, and it needs no per-request state, which is what makes putting
     it in a module-level function safe: nothing is remembered between invocations.

     No `who`: this endpoint identifies the caller, but the interesting question here is
     whether a device registration landed, and `code` answers that. `endpoint` and the
     subscription keys are never passed to trace() at all — they are a URL and two
     secrets, and both would come back as `len:` anyway. */
  trace('push.sub', {
    status,
    code:
      body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
        ? (body as { code: string }).code
        : null,
  });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...PRIVACY },
  });
}

export const POST: APIRoute = async ({ request, cookies, clientAddress, url }) => {
  /* Identity FIRST. identify() returns null with no signing key, which is the
     fail-closed direction; the two cases are split only so the log names the
     fix. Same order and same reasoning as every other write in the wing. */
  const who = identify(cookies, url);
  if (!who) {
    if (!SESSION_SECRET()) {
      console.error('[us] push called but US_SESSION_SECRET is missing.');
      return json({ ok: false, code: 'unconfigured' }, 503);
    }
    return json({ ok: false, code: 'unauthorized' }, 401);
  }

  /* Checked AFTER the cookie, so an unauthenticated cross-site probe learns
     nothing it did not already know.

     Astro's own checkOrigin is off (see astro.config.mjs, which explains why at
     length) and never covered `application/json` in the first place, so this is
     the only origin check this endpoint gets. It matters here specifically:
     without it, any page on any host under the same registrable domain could
     register a device of ITS choosing against her session, and then read every
     notification she was ever sent. */
  if (crossSite(request, url)) {
    console.warn('[us] refused a cross-site push subscription change.');
    return json({ ok: false, code: 'cross-site' }, 403);
  }

  const limit = await hit(`push:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!limit.ok) return json({ ok: false, code: 'rate', retryAfter: limit.retryAfter }, 429);

  /* Said out loud rather than accepting a subscription that has nowhere to live.
     A 503 lets the hub tell her "not set up yet" instead of showing a switch that
     turns on and then never does anything. */
  if (!hasPush() || !hasKV()) {
    console.error('[us] push called but VAPID keys or Upstash are not configured.');
    return json({ ok: false, code: 'unconfigured' }, 503);
  }

  let action = '';
  let subscription: unknown = null;
  let endpoint: unknown = null;
  try {
    const fields = (await request.json()) as Record<string, unknown>;
    action = typeof fields.action === 'string' ? fields.action.trim() : '';
    subscription = fields.subscription ?? null;
    /* Accepted at the top level as well as inside `subscription`, because
       unsubscribing only needs the endpoint and making the client wrap one field
       in an object to say "forget this" is friction with no purpose. */
    endpoint =
      typeof fields.endpoint === 'string'
        ? fields.endpoint
        : (subscription as { endpoint?: unknown } | null)?.endpoint ?? null;
  } catch {
    return json({ ok: false, code: 'bad-request' }, 400);
  }

  const nowMs = Date.now();

  if (action === 'subscribe') {
    /* subscribeDevice validates the shape and refuses anything it does not
       recognise — see readDevice(). A 400 rather than a 500: a malformed
       subscription is a bad request, and the hub's copy for it says so. */
    const ok = await subscribeDevice(who, subscription, nowMs);
    if (!ok) {
      return json({ ok: false, code: 'bad-subscription' }, 400);
    }
    /* NOTHING ABOUT THE DEVICE COMES BACK. Not the endpoint, not a count, not a
       list. The caller already knows what it sent, and a response carrying an
       endpoint is an endpoint in somebody's network log. */
    return json({ ok: true, code: 'on' });
  }

  if (action === 'unsubscribe') {
    const ok = await unsubscribeDevice(who, endpoint);
    if (!ok) {
      return json({ ok: false, code: 'bad-subscription' }, 400);
    }
    return json({ ok: true, code: 'off' });
  }

  return json({ ok: false, code: 'bad-action' }, 400);
};

/** Anything other than POST. Explicit, so a stray GET is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, code: 'method-not-allowed' }, 405);
