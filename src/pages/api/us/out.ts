/**
 * GET /api/us/out — sign out.
 *
 * Allowlisted as public in src/middleware.ts, because a sign-out that requires
 * a valid session cannot clear an invalid one — and "I am stuck in a broken
 * session" is exactly when you need this.
 *
 * A GET, not a POST, so it can be a plain link in the vault footer. The usual
 * objection to that is CSRF, which does not apply to a logout: the worst a
 * forged request achieves is signing her out, and every cookie here is
 * re-obtainable by answering three questions she knows the answers to.
 *
 * All four purposes are cleared, and clearCookie() removes both the
 * production `__Host-` name and the dev name, because a browser profile used
 * for local testing can hold both and a partial logout is not a logout.
 */

import type { APIRoute } from 'astro';
import { clearCookie } from '../../../lib/us/session';

export const prerender = false;

export const GET: APIRoute = ({ cookies, redirect }) => {
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
  return redirect('/stronger', 302);
};
