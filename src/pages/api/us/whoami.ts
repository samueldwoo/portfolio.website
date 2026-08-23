/**
 * POST /api/us/whoami — say which of the two you are.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY IS A LABEL HERE, NOT A PERMISSION, AND THAT IS THE WHOLE POINT
 *
 * This replaces a second credential. There used to be an admin passcode whose job
 * was partly to prove "I am Sam" and partly to authorise posting a song — and it
 * was the only endpoint in the wing that demanded it. Photos, letters, the daily
 * question, the list, the marks and her songs all accepted a plain session. So
 * anybody through the gate could already write nine-tenths of the site, and the
 * passcode was guarding exactly one form while costing a second login on every
 * device.
 *
 * THE GATE IS THE SECURITY BOUNDARY. Everything private is behind three questions
 * and an HMAC. Inside it there are two people who do not need protecting from each
 * other, and the honest consequence of that is that identity does not need proving
 * — it needs DECLARING. So this endpoint takes a name and writes it to a cookie
 * that grants nothing.
 *
 * What it changes: pronouns, clock labels, which half of a mutual feature a write
 * lands in. What it does not change: whether anything renders at all. Every page
 * still self-guards on `session`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A HOLE
 *
 * The threat it appears to open — "someone through the gate could claim to be Sam"
 * — was already fully open, because they could already post photographs, answer
 * the question, write back on every memory and reply to every letter as HER. An
 * attacker inside the gate does not need to impersonate him to do damage; they are
 * already inside. Adding a passcode on top of one form did not change that, it
 * just made the one form inconsistent with the other nine.
 *
 * What DOES protect this: the gate itself, the session cookie's httpOnly +
 * sameSite=lax + __Host- prefix, and the cross-site check every write performs.
 *
 * ---------------------------------------------------------------------------
 * IT MUST BE DELIBERATE, AND VISIBLE AFTERWARDS
 *
 * A mis-tap here would file his photograph as hers. So it is a POST from a real
 * button — never a GET, which iOS long-press previews and prefetchers activate on
 * their own (see out.ts, which had exactly that bug) — and the hub footer states
 * the resolved identity on every page load, so a wrong answer is visible in one
 * glance rather than discovered in the data weeks later.
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../lib/us/config';
import { TTL, clearCookie, sign, writeCookie } from '../../../lib/us/session';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import { crossSite, identify } from '../../../lib/us/together';
import { forget } from '../../../lib/us/presence';

export const prerender = false;

const HUB = '/samdrea/vault';

/**
 * Generous, because this is a toggle a person taps to fix a mistake, not a
 * credential anybody guesses. It exists only so a script cannot spin the cookie.
 */
const RATE_LIMIT = 20;
const RATE_WINDOW_SEC = 600;

const PRIVACY: Record<string, string> = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...PRIVACY },
  });
}

export const POST: APIRoute = async ({ request, cookies, clientAddress, redirect, url }) => {
  const wantsJson = (request.headers.get('accept') ?? '').toLowerCase().includes('application/json');

  const answer = (ok: boolean, status: number, code: string | null, extra: Record<string, unknown> = {}) => {
    if (wantsJson) return json({ ok, ...(code ? { code } : {}), ...extra }, status);
    const q = ok ? `?ok=${encodeURIComponent(code ?? 'switched')}` : `?e=${encodeURIComponent(code ?? 'no')}`;
    const res = redirect(`${HUB}${q}`, 303);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(PRIVACY)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  /* A SESSION IS REQUIRED. This grants nothing, but it is still a write, and a
     stranger has no business setting cookies on this domain. identify() also tells
     us who they currently are, which is what makes a bare toggle possible. */
  const current = identify(cookies, url);
  if (!current) {
    if (!SESSION_SECRET()) {
      console.error('[us] whoami called but US_SESSION_SECRET is missing.');
      return answer(false, 503, 'unconfigured');
    }
    return answer(false, 401, 'unauthorized');
  }

  if (crossSite(request, url)) {
    console.warn('[us] refused a cross-site identity switch.');
    return answer(false, 403, 'cross-site');
  }

  const limit = await hit(`whoami:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!limit.ok) return answer(false, 429, 'rate', { retryAfter: limit.retryAfter });

  const secret = SESSION_SECRET();
  if (!secret) return answer(false, 503, 'unconfigured');

  /* An explicit `who`, or a plain toggle when the form sends nothing.
     The toggle is what the footer button uses: there are two people, so "not me"
     is unambiguous and needs no field. */
  let form: FormData | null = null;
  try {
    form = await request.formData();
  } catch {
    // A JSON caller, or an empty body. Both mean "just flip it".
  }
  const asked = String(form?.get('who') ?? '').trim();
  const want = asked === 'her' || asked === 'him' ? asked : current === 'him' ? 'her' : 'him';

  if (want === 'him') {
    /* 180 days, and it carries NO privilege — see Purpose in session.ts. Longer
       than the session on purpose: if it expired first, an expired identity would
       silently fall through to "her" and file his writes as hers, which is the
       exact bug this cookie was introduced to end. */
    writeCookie(cookies, url, 'whoami', sign(secret, 'whoami', TTL.whoami), TTL.whoami);
  } else {
    /* Being HER is the absence of the cookie, not a second value. One less state
       to keep consistent, and it means a cleared cookie jar defaults to her —
       which is right, because she is who the wing is for. */
    clearCookie(cookies, 'whoami');
  }

  /* ---------------------------------------------------------------------------
     AND DROP THE FOOTPRINT THE ABANDONED IDENTITY LEFT BEHIND.

     THE BUG, reported from her phone as "it still says she's logged in when it's
     really me": presence is stamped on EVERY vault page render, keyed by whoever
     the reader is at that moment (presence.ts). Browsing as her — which is the only
     way to check her copy — stamps `us:presence:her` with his clock. Switching
     identity used to touch nothing but a cookie, so the hub then read the OTHER
     key, found that stamp seconds old, and told him "she is in here too, right
     now." About himself.

     Clearing it is the switch's job and not the hub's, because the hub cannot tell
     a stale stamp from a live one — that is the whole point of a timestamp. The
     moment identity changes is the only moment anything in the system KNOWS the
     record is no longer about the person whose slot it sits in.

     ONLY WHEN IDENTITY ACTUALLY CHANGES. `who=her` posted while already her is a
     no-op, and deleting `us:presence:him` there would throw away HIS genuinely live
     stamp — the other key existing is the feature, not the fault.

     Never awaited for a value and never able to throw: every function in
     presence.ts resolves rather than rejects. A store that is down means the
     record expires on its own inside the hour instead of now, which is a late fix
     rather than a broken response. */
  if (want !== current) await forget(current);

  return answer(true, 200, 'switched', { who: want });
};

/** Anything but POST. A GET here would be activated by a link preview. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
