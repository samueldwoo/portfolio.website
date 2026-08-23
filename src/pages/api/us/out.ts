/**
 * GET /api/us/out — sign out.
 *
 * Allowlisted as public in src/middleware.ts, because a sign-out that requires
 * a valid session cannot clear an invalid one — and "I am stuck in a broken
 * session" is exactly when you need this.
 *
 * A POST, and it was a GET. The CSRF argument for a GET logout is sound and it
 * is not the reason this changed: the problem is not FORGERY, it is ACCIDENTAL
 * ACTIVATION by the platform.
 *
 * A GET link gets fetched by things that were never a click. iOS long-press
 * shows a link PREVIEW by loading the page. Prefetchers, link scanners and
 * HEAD probes do the same, and Astro maps HEAD onto GET, so a HEAD request
 * silently signed her out. In an installed app with no URL bar, the result is
 * being dropped back at the quiz for no reason she can see — possibly while the
 * gate is rate-limited, which turns a stray long-press into ten minutes locked
 * out of her own gift.
 *
 * So it needs a real intention behind it. The footer is now a one-button form,
 * which no preview or prefetch can trigger.
 *
 * All four purposes are cleared, and clearCookie() removes both the
 * production `__Host-` name and the dev name, because a browser profile used
 * for local testing can hold both and a partial logout is not a logout.
 */

import type { APIRoute } from 'astro';
import { crossSite } from '../../../lib/us/together';
import { clearCookie } from '../../../lib/us/session';

export const prerender = false;

export const POST: APIRoute = ({ request, cookies, redirect, url }) => {
  /* CROSS-SITE, checked here because Astro's own checkOrigin is now OFF — see the
     long comment in astro.config.mjs. The short version: Astro compares the Origin
     header to the full origin and treats a MISSING Origin as cross-site, and iOS
     Safari does not send Origin on a same-origin form submission. That 403'd every
     plain form in the wing on her phone. crossSite() reads Sec-Fetch-Site first,
     compares HOST rather than full origin so a proxy hop cannot break it, and
     refuses only on a positive mismatch. */
  if (crossSite(request, url)) {
    console.warn('[us] refused a cross-site sign-out.');
    return new Response(JSON.stringify({ ok: false, error: 'cross-site' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  clearCookie(cookies, 'session');
  clearCookie(cookies, 'progress');
  clearCookie(cookies, 'admin');
  /* AND the identity cookie, which lives 180 days and would otherwise outlive
     every sign-out. Without this, signing out on a shared device and letting the
     other person through the gate would leave them identified as HIM — the whole
     bug this cookie was added to fix, arriving from the other direction. */
  clearCookie(cookies, 'whoami');
  // Back to the front door, which will now render the gate rather than
  // redirecting onward — proving the cookies really are gone.
  return redirect('/samdrea', 303);
};

/* Anything but POST. Without this, Astro's HEAD->GET fallback made a HEAD probe a
   working logout — which is the bug above, arriving through the back door. */
export const ALL: APIRoute = () =>
  new Response(JSON.stringify({ ok: false, error: 'method-not-allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
