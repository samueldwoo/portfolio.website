/**
 * session.ts — signed, stateless tokens and the cookies that carry them.
 *
 * There is no database and no session store. A token is
 * `base64url(payload) + "." + base64url(HMAC-SHA256(payload))`, which is enough
 * because the only thing we need to know is "did the server issue this, and has
 * it expired". Everything is verified on every request; nothing is trusted.
 *
 * ---------------------------------------------------------------------------
 * THREE PURPOSES, ONE SECRET, NO CONFUSION
 *
 * `progress` — issued after each correct answer, carries which questions have
 *              been solved so far. Short-lived. This is what makes the
 *              question-by-question flow safe: the client cannot skip to the
 *              last question, because the final answer only mints a session if
 *              the accompanying progress token proves every earlier question
 *              was already answered correctly.
 * `session`  — the real thing. 30 days. Grants the vault.
 * `admin`    — me, posting a song. Separate passcode, separate purpose.
 *
 * The purpose is inside the SIGNED payload and is re-checked on verify, so a
 * progress token cannot be replayed as a session token even though both are
 * signed with the same key. Without that field, "solved question 1" and "may
 * read every photo" would be interchangeable strings.
 * ---------------------------------------------------------------------------
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `whoami` is NOT a permission. It is the answer to "which of the two people is
 * this", and it exists because that question and "may this request post as
 * admin" had been the same cookie — which produced a silent, dated bug.
 *
 * THE BUG, RECORDED BECAUSE THE FIX LOOKS ARBITRARY WITHOUT IT.
 * identify() resolved `admin` -> him and `session` -> her, admin first. Sam holds
 * BOTH: he passes the gate like she does, and then logs in at /samdrea/dj. But
 * TTL.admin is 12 hours and TTL.session is 30 days. So twelve hours after
 * installing the app his admin token expired, identify() fell through to the
 * session token, and the site decided he was Andrea — with nothing on screen
 * saying so. The next photograph he posted was filed as HERS, overwriting hers if
 * she had already posted that day. Verified before the fix: a request holding an
 * expired admin cookie and a live session cookie posted a frame that came back
 * `{"who":"her"}`.
 *
 * The two facts have genuinely different lifetimes. Who he is does not expire in
 * twelve hours; his ability to rewrite the answer key should. So they are now two
 * cookies: `whoami` is long-lived and carries no privilege whatsoever, `admin`
 * stays short and is the only one any write checks for.
 */
export type Purpose = 'session' | 'progress' | 'admin' | 'whoami';

export interface Payload {
  /** purpose — checked on verify to prevent cross-purpose token replay */
  p: Purpose;
  /** issued at (epoch seconds) */
  iat: number;
  /** expires at (epoch seconds) */
  exp: number;
  /** zero-based indices of questions solved so far. `progress` tokens only. */
  solved?: number[];
  /**
   * Wrong-attempt count per question index. `progress` tokens only.
   *
   * This lives inside the SIGNED payload rather than in the request body for one
   * reason: it drives which hint is released. If the client owned this number it
   * could claim two misses immediately and collect every hint for free, which
   * would quietly undo the questions' difficulty.
   */
  tries?: number[];
}

const b64url = {
  encode(input: string): string {
    return Buffer.from(input, 'utf8').toString('base64url');
  },
  decode(input: string): string {
    return Buffer.from(input, 'base64url').toString('utf8');
  },
};

function hmac(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
}

/**
 * Constant-time string compare that tolerates length mismatch instead of
 * throwing. `token` is fully attacker-controlled, so a length mismatch is an
 * expected input, not an exceptional one.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function sign(
  secret: string,
  purpose: Purpose,
  ttlSeconds: number,
  extra: Partial<Pick<Payload, 'solved' | 'tries'>> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Payload = { p: purpose, iat: now, exp: now + ttlSeconds, ...extra };
  const body = b64url.encode(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

/**
 * Verify signature, purpose and expiry. Returns null on ANY problem — a bad
 * signature, a malformed token, the wrong purpose, an expired token and
 * unparseable JSON are all just "no". Callers get one thing to check.
 */
export function verify(secret: string, purpose: Purpose, token: string | undefined): Payload | null {
  if (!token) return null;

  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // Signature FIRST, before parsing. Never JSON.parse attacker-controlled
  // bytes that have not been proven to be ours.
  if (!safeEqual(sig, hmac(secret, body))) return null;

  let payload: Payload;
  try {
    payload = JSON.parse(b64url.decode(body));
  } catch {
    return null;
  }

  if (payload?.p !== purpose) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}

/* ---------------------------------------------------------------------------
   COOKIES

   `__Host-` is a real defense worth the small complexity: the prefix makes the
   browser refuse the cookie unless it is Secure, Path=/ and has NO Domain
   attribute, which means no other host — including a subdomain of
   samueldwoo.com — can plant or overwrite it.

   But the prefix REQUIRES Secure, and `astro dev` serves plain http on
   localhost, so a __Host- cookie is silently dropped in development and the
   gate could never be tested locally. Hence two names: the hardened one in
   production, a plain one in dev. Reads try both; writes pick by protocol.
   --------------------------------------------------------------------------- */

interface CookiePair {
  /** production name — requires https */
  secure: string;
  /** development name — works on http://localhost */
  dev: string;
}

const NAMES: Record<Purpose, CookiePair> = {
  session: { secure: '__Host-us', dev: 'us_session' },
  progress: { secure: '__Host-us-p', dev: 'us_progress' },
  admin: { secure: '__Host-us-a', dev: 'us_admin' },
  whoami: { secure: '__Host-us-w', dev: 'us_whoami' },
};

export const TTL = {
  /** 30 days. Long on purpose: retaking the quiz should be a choice, not a chore. */
  session: 60 * 60 * 24 * 30,
  /** 20 minutes. Just long enough to answer three questions without rushing. */
  progress: 60 * 20,
  /** 12 hours. Short: this one can post. */
  admin: 60 * 60 * 12,
  /**
   * 180 days, and deliberately the longest TTL here.
   *
   * It grants NOTHING. Its only effect is that identify() says "him" instead of
   * "her", so the worst a stolen one can do is make a request be attributed to
   * the person who already has to pass the gate to get anywhere. Every write that
   * matters still demands `admin`, which still expires in twelve hours.
   *
   * Longer than TTL.session on purpose: if this expired FIRST, the exact bug it
   * was added to prevent would come back on a slower timer.
   */
  whoami: 60 * 60 * 24 * 180,
} as const;

function isSecure(url: URL): boolean {
  return url.protocol === 'https:';
}

/** Minimal shape of Astro's cookie API, so this file needs no Astro import. */
interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, opts: Record<string, unknown>): void;
  delete(name: string, opts?: Record<string, unknown>): void;
}

/**
 * Read a token, preferring the hardened name.
 *
 * The `url` argument exists so the DEV cookie name is only ever consulted over
 * plain http. An adversarial review pointed out that accepting `us_session`
 * unconditionally quietly undoes the reason `__Host-` exists: that prefix makes
 * the browser refuse a cookie unless it is Secure, Path=/ and carries no Domain,
 * which is precisely what stops a sibling subdomain from planting one. Reading a
 * non-prefixed fallback in production hands that protection back.
 *
 * The impact was limited — an attacker still needs a validly signed token they
 * do not have, so the ceiling was session FIXATION rather than unauthorized
 * reading — but it costs one argument to close, so it is closed.
 *
 * `url` is optional and defaults to the strict behaviour: a caller that forgets
 * to pass it gets production semantics, not dev semantics. Failing safe means
 * failing toward the hardened name.
 */
export function readCookie(
  cookies: CookieJar,
  purpose: Purpose,
  url?: URL,
): string | undefined {
  const { secure, dev } = NAMES[purpose];
  const hardened = cookies.get(secure)?.value;
  if (hardened) return hardened;
  // Only http (i.e. `astro dev` on localhost) may fall back to the plain name.
  const allowDevName = url ? !isSecure(url) : false;
  return allowDevName ? cookies.get(dev)?.value : undefined;
}

export function writeCookie(
  cookies: CookieJar,
  url: URL,
  purpose: Purpose,
  token: string,
  ttlSeconds: number,
): void {
  const secure = isSecure(url);
  cookies.set(secure ? NAMES[purpose].secure : NAMES[purpose].dev, token, {
    httpOnly: true,
    secure,
    // 'lax' not 'strict': she will arrive by tapping a link in iMessage, and
    // 'strict' withholds the cookie on that first cross-site navigation, which
    // would show her the gate again every single time.
    sameSite: 'lax',
    path: '/',
    maxAge: ttlSeconds,
  });
}

export function clearCookie(cookies: CookieJar, purpose: Purpose): void {
  // Both names, because dev and production cookies can coexist in one browser
  // profile and a logout that leaves one behind is not a logout.
  cookies.delete(NAMES[purpose].secure, { path: '/' });
  cookies.delete(NAMES[purpose].dev, { path: '/' });
}
