/**
 * POST /api/us/reply — she sends one back.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ENDPOINT EXISTS AT ALL
 *
 * /api/us/react let her tell me she heard it. Five emoji, one tap. That is a
 * receipt, and a receipt is still a broadcast with an acknowledgement stapled to
 * it: I choose, she confirms. This endpoint is the one that makes the feature
 * two-way, because it lets her CHOOSE — a track of her own, with her own note,
 * filed on the same day as mine so the day reads as an exchange rather than as a
 * transmission and a nod.
 *
 * Over a year of long distance that is not a nice-to-have, it is the whole point.
 * The song was always the excuse.
 *
 * ---------------------------------------------------------------------------
 * SESSION ONLY — NOT ADMIN. AND THE OTHER HALF OF THAT RULE MATTERS MORE.
 *
 * This endpoint accepts HER session cookie and refuses my admin one, for the same
 * reason /api/us/react does: a reply I could write as her is a reply that means
 * nothing. If I want to see the round trip work, I answer the three questions like
 * anybody else.
 *
 * The half that is a real security boundary is the converse, and it is enforced
 * elsewhere on purpose: her session CANNOT post as me. POST /api/us/song demands
 * the admin token specifically and rejects a valid session exactly like an
 * anonymous caller. So the split is absolute in both directions, and it is not
 * enforced by convention — it is two endpoints, each naming one cookie, writing
 * two different key spaces in the store (`us:reply:*` vs `us:song:*`, or
 * `doc.replies` vs `doc.songs`). A bug in this file cannot produce a song.
 *
 * The cookie is verified HERE with verify(), not merely by src/middleware.ts. The
 * middleware is default-deny for everything under /api/us that is not explicitly
 * allowlisted — which is why this file needed no middleware change to be protected
 * the moment it existed — but its default check accepts EITHER token, so it cannot
 * tell us apart. Only this file knows which of us is allowed to write here, so
 * only this file can enforce it. A routing mistake upstairs must degrade to "the
 * endpoint says no", never to "either of us can post as the other".
 *
 * ---------------------------------------------------------------------------
 * ONE PARSER. THIS FILE DOES NOT OWN A SPOTIFY URL PARSER AND MUST NEVER GROW ONE.
 *
 * extractTrackId, resolveMetadata and cleanText are IMPORTED from ./song. That is
 * deliberate and it is the most important line in this file. The parser over there
 * is the one that rejects host confusion (`open.spotify.com.evil.tld`), the
 * `javascript:` scheme, albums, playlists, episodes and extra path segments, by
 * parsing a real URL and comparing a real hostname for equality. Its destination
 * is an iframe `src` on a page one of us will open on a phone.
 *
 * A second parser here — even a careful one, even one copy-pasted from there today
 * — is a second parser to keep right forever, and the first divergence between
 * them would be invisible until it was a live embed pointing somewhere it should
 * not. There is exactly one, it lives with the comment block explaining every
 * rejection, and both endpoints call it.
 *
 * ---------------------------------------------------------------------------
 * IT WORKS WITH JAVASCRIPT OFF
 *
 * A real <form method="post"> that 303s back to her page, exactly like the
 * reaction forms. Astro's `security.checkOrigin` is on by default, which gives
 * form-encoded POSTs origin checking for free; it does NOT cover
 * `application/json`, which is the other reason the cookie is verified in here
 * rather than assumed from the middleware.
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../lib/us/config';
import { readCookie, verify } from '../../../lib/us/session';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import { isWingDate, putReply, wingDate, type ReplyRecord } from '../../../lib/us/kv';
// The one parser, the one metadata resolver, the one text cleaner. See the header.
import { MAX_NOTE, cleanText, extractTrackId, resolveMetadata } from './song';

export const prerender = false;

/**
 * A ceiling on her posting, not a security control.
 *
 * Every accepted reply makes an outbound call to Spotify and (on the R2 tier) a
 * read-modify-write of the whole document. Twenty in ten minutes is far more than
 * "changed my mind about the link twice" and far less than anything a stuck retry
 * loop or a form-resubmitting phone browser could cost. Lower than the reaction
 * limit (90) because a reaction is a tap and this is a paste plus a paragraph:
 * nobody does it thirty times.
 */
const RATE_LIMIT = 20;
const RATE_WINDOW_SEC = 600;

/** Where a no-JavaScript form submission lands afterwards. */
const TODAY_PAGE = '/stronger/vault/today';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** See admin.ts: the response shape follows the request shape. */
function isJsonRequest(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').toLowerCase().includes('application/json');
}

export const POST: APIRoute = async ({ request, cookies, clientAddress, redirect, url }) => {
  const wantsJson = isJsonRequest(request);

  /** One exit point, so the fetch and no-JS paths can never drift apart. */
  const answer = (
    ok: boolean,
    status: number,
    error: string | null,
    extra: Record<string, unknown> = {},
  ): Response => {
    if (wantsJson) return json({ ok, ...(error ? { error } : {}), ...extra }, status);
    // 303 forces a GET, so the page she lands on re-renders from the store and a
    // refresh does not resubmit the reply. `sent` carries the date so the page can
    // say which day it landed on — she may have been answering an older morning.
    const query = ok
      ? `?sent=${encodeURIComponent(String(extra.date ?? ''))}`
      : `?e=${encodeURIComponent(error ?? 'no')}`;
    return redirect(`${TODAY_PAGE}${query}`, 303);
  };

  const secret = SESSION_SECRET();
  if (!secret) {
    console.error('[us] reply called but US_SESSION_SECRET is missing.');
    return answer(false, 503, 'unconfigured');
  }

  // Session, and only session. My admin token is refused here — see the header.
  if (!verify(secret, 'session', readCookie(cookies, 'session', url))) {
    return answer(false, 401, 'unauthorized');
  }

  const limit = await hit(`reply:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!limit.ok) return answer(false, 429, 'rate', { retryAfter: limit.retryAfter });

  // ---- parse ------------------------------------------------------------
  let rawUrl = '';
  let note = '';
  let date = wingDate();
  try {
    const fields: Record<string, unknown> = wantsJson
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries(await request.formData());

    rawUrl = typeof fields.url === 'string' ? fields.url : '';
    note = cleanText(fields.note, MAX_NOTE);

    // The form sends the date of the card she is answering, which is normally
    // today but is not required to be: answering yesterday's song at 1am is a
    // real thing that happens. It is still validated like any other key material
    // and it may not be in the future — a reply filed under tomorrow would vanish
    // from both our pages until tomorrow. String comparison is correct here: ISO
    // dates sort as text.
    const wanted = typeof fields.date === 'string' ? fields.date.trim() : '';
    if (wanted) {
      if (!isWingDate(wanted)) return answer(false, 400, 'bad-date');
      if (wanted > date) return answer(false, 400, 'future-date');
      date = wanted;
    }
  } catch {
    return answer(false, 400, 'bad-request');
  }

  const id = extractTrackId(rawUrl);
  if (!id) return answer(false, 400, 'bad-url');

  // ---- resolve + store --------------------------------------------------
  //
  // NOT checked: whether I posted a song that day. Letting her answer a morning I
  // missed is the point rather than an edge case — she gets to go first — and
  // checking would cost a store round trip to prevent something desirable.
  const meta = await resolveMetadata(id);

  const reply: ReplyRecord = {
    date,
    id,
    // ARTIST IS NOT A FIELD SHE FILLS IN. Her form is a link and a note, because
    // it is used one-handed in bed and a third input is the difference between
    // sending one and not. The Web API fills it when those credentials exist; the
    // credential-free path leaves it empty and her card omits the line, exactly as
    // mine does when Spotify gives us nothing.
    artist: meta.artist,
    title: meta.title,
    art: meta.art,
    note,
    postedAt: Date.now(),
    album: meta.album,
    year: meta.year,
    durationMs: meta.durationMs,
  };

  try {
    // Overwrites any earlier reply for that day, on purpose: the realistic mistake
    // is pasting the wrong link, and the fix has to be "send it again" from the
    // same phone. One reply per day is also what keeps a day readable as a single
    // exchange rather than as a thread nobody scrolls.
    await putReply(reply);
  } catch (err) {
    // Loud, and reported as a failure. The one outcome that must never happen is a
    // page that says "sent" over a write that did not land.
    console.error('[us] reply could not write to the store:', err);
    return answer(false, 502, 'store');
  }

  // `degraded` lets her page say "Spotify would not give us a title" out loud
  // instead of leaving a card that looks half-broken for no stated reason.
  return answer(true, 200, null, { date, reply, degraded: meta.title === '' });
};

/** Anything other than POST. Explicit, so a stray GET is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
