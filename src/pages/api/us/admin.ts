/**
 * POST /api/us/admin — where I exchange my passcode for an admin token.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE CREDENTIAL FROM THE GATE
 *
 * Her three questions let you READ the wing. This passcode lets you WRITE to it.
 * Those are not the same privilege and must not share a key: the answers are
 * short, human and deliberately generously matched — which is exactly right for
 * a door she has to get through on a phone in an airport, and exactly wrong for
 * the credential that decides what appears on her page tomorrow morning.
 *
 * So this endpoint checks one long passcode, exactly as typed, against a keyed
 * digest, and mints a token whose purpose field says `admin` and nothing else.
 * session.ts re-checks that purpose on every verify, so an admin token cannot be
 * replayed as a session and a session can never post.
 *
 * ---------------------------------------------------------------------------
 * IT IS ALLOWLISTED AS PUBLIC IN middleware.ts, AND HAS TO BE
 *
 * This is the login endpoint for the admin cookie. Requiring the admin cookie to
 * reach it would be a locked door with the key inside. Everything that actually
 * writes — /api/us/song's POST — demands the token independently, so the only
 * thing an unauthenticated caller can do here is fail.
 *
 * WHY NO CSRF TOKEN
 *
 * A forged cross-site POST to this endpoint has to carry my passcode to achieve
 * anything, and an attacker holding my passcode does not need CSRF — they can
 * just open the page. The cookie is SameSite=Lax, so the token this mints is not
 * sent on cross-site POSTs afterwards either.
 *
 * And there is a third layer nobody has to maintain: Astro's own
 * `security.checkOrigin` is ON by default for on-demand routes and rejects
 * urlencoded / multipart / text-plain POSTs whose Origin does not match the host.
 * VERIFIED against the running server — a same-origin form post gets its 303, an
 * `Origin: https://evil.tld` form post gets a 403 before this handler runs. That
 * covers the form paths in this file, /api/us/song and /api/us/react for free.
 * It deliberately does NOT cover `application/json`, which is why every one of
 * those handlers still verifies a cookie of its own rather than leaning on it.
 *
 * ---------------------------------------------------------------------------
 * TWO REQUEST SHAPES, ON PURPOSE
 *
 * A plain `<form method="post">` (urlencoded, answered with a 303) and a `fetch`
 * (JSON in, JSON out). The form path is not a nicety: /samdrea/dj is a page I
 * will open one-handed on a phone with bad signal, and a login that works with
 * zero JavaScript is a login that works. The response shape follows the request
 * shape, so neither caller has to ask for anything special.
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { ADMIN_PASSCODE_DIGEST, ANSWER_PEPPER, SESSION_SECRET, checkAdminPasscode } from '../../../lib/us/config';
import { TTL, sign, writeCookie } from '../../../lib/us/session';
import { clientKey, hit } from '../../../lib/us/ratelimit';

export const prerender = false;

/**
 * 8 attempts per 10 minutes, per IP.
 *
 * Tighter than the gate's 12, because the shape of the secret is different: the
 * gate is a human answering from memory and mistyping is expected, whereas this
 * is one passcode I either have in my password manager or do not. Anyone needing
 * a ninth attempt in ten minutes is not me.
 */
const RATE_LIMIT = 8;
const RATE_WINDOW_SEC = 600;

/** Same fixed pause as the gate. Caps the practical guess rate even if the
 *  limiter has degraded to its in-memory backend, and flattens any residual
 *  timing difference between the rejection paths. Failure only — a correct
 *  passcode still feels instant. */
const REJECT_DELAY_MS = 350;

/** Where a browser form is sent afterwards, either way. */
const DJ = '/samdrea/dj';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * Did this request come from `fetch`, or from a browser submitting a form?
 *
 * Keyed off the request's own Content-Type rather than Accept, because that is
 * the one header a browser form cannot lie about and cannot be talked out of
 * sending. A form is always urlencoded; anything JSON is our own script.
 */
function isJsonRequest(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').toLowerCase().includes('application/json');
}

export const POST: APIRoute = async ({ request, cookies, url, clientAddress, redirect }) => {
  const wantsJson = isJsonRequest(request);

  /** One exit point, so the two response shapes can never drift apart. */
  const answer = (
    ok: boolean,
    status: number,
    error: string | null,
    extra: Record<string, unknown> = {},
  ): Response => {
    if (wantsJson) {
      return json({ ok, ...(error ? { error } : {}), ...extra }, status);
    }
    // 303 rather than 302: it forces the browser to follow with a GET, so a
    // refresh on the destination does not re-submit the passcode.
    return redirect(ok ? DJ : `${DJ}?e=${encodeURIComponent(error ?? 'no')}`, 303);
  };

  // ---- 1. Fail closed on misconfiguration -------------------------------
  // checkAdminPasscode() returns false when unconfigured, which is safe but
  // indistinguishable from a wrong passcode — and "you typed it wrong" is a
  // terrible thing to be told for an hour when the real problem is a missing
  // environment variable. So the three secrets are checked explicitly first.
  const secret = SESSION_SECRET();
  if (!secret || !ANSWER_PEPPER() || !ADMIN_PASSCODE_DIGEST()) {
    const missing = [
      !SESSION_SECRET() && 'US_SESSION_SECRET',
      !ANSWER_PEPPER() && 'US_ANSWER_PEPPER',
      !ADMIN_PASSCODE_DIGEST() && 'US_ADMIN_PASSCODE_DIGEST',
    ].filter(Boolean);
    console.error(`[us] admin login called but not configured. Missing: ${missing.join(', ')}`);
    return answer(false, 503, 'unconfigured');
  }

  // ---- 2. Rate limit before doing any crypto ----------------------------
  const limit = await hit(`admin:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!limit.ok) {
    if (wantsJson) {
      return json({ ok: false, error: 'rate', retryAfter: limit.retryAfter }, 429, {
        'Retry-After': String(limit.retryAfter),
      });
    }
    return redirect(`${DJ}?e=rate&s=${limit.retryAfter}`, 303);
  }

  // ---- 3. Parse, defensively --------------------------------------------
  let passcode = '';
  try {
    if (wantsJson) {
      const body = (await request.json()) as { passcode?: unknown };
      passcode = typeof body?.passcode === 'string' ? body.passcode : '';
    } else {
      const form = await request.formData();
      const value = form.get('passcode');
      passcode = typeof value === 'string' ? value : '';
    }
  } catch {
    return answer(false, 400, 'bad-request');
  }

  // Cap before hashing. Unbounded input into an HMAC is a free CPU-burn vector,
  // and no passcode I will ever type on a phone is 4KB. Not trimmed: the
  // passcode is compared exactly as typed (see checkAdminPasscode), so silently
  // eating a leading space would make a correct passcode fail with no clue why.
  if (passcode.length > 200) passcode = passcode.slice(0, 200);

  // ---- 4. Check it ------------------------------------------------------
  if (!passcode || !checkAdminPasscode(passcode)) {
    await sleep(REJECT_DELAY_MS);
    // Logged without the attempt itself. A near-miss in a log file is a partial
    // credential in a log file.
    console.warn('[us] admin passcode rejected.');
    return answer(false, 401, 'bad-passcode');
  }

  // ---- 5. Mint the token ------------------------------------------------
  // 12 hours (TTL.admin), which is short by design: this is the cookie that can
  // post. Long enough to survive a morning of edits, short enough that a phone
  // left on a table is not a standing write credential.
  writeCookie(cookies, url, 'admin', sign(secret, 'admin', TTL.admin), TTL.admin);

  /* AND a long-lived identity cookie, which is a separate fact with a separate
     lifetime. See Purpose in session.ts: these were one cookie, and because the
     admin half expires in 12 hours while his session cookie lasts 30 days, he
     silently became Andrea overnight and his photographs were filed as hers.

     This grants nothing. Every write still demands the `admin` token above; all
     this does is keep identify() answering "him" after that token has gone, so
     the failure mode of an expired admin session is "he cannot post as admin"
     rather than "he posts as her". */
  writeCookie(cookies, url, 'whoami', sign(secret, 'whoami', TTL.whoami), TTL.whoami);

  return answer(true, 200, null, { redirect: DJ });
};

/** Anything other than POST. Explicit, so a stray GET is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
