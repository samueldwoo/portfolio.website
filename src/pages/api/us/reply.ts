/**
 * POST /api/us/reply — HER HALF OF THE DAY. Not a reply. See the name note below.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ENDPOINT EXISTS AT ALL
 *
 * /api/us/react let her tell me she heard it. Five emoji, one tap. That is a
 * receipt, and a receipt is still a broadcast with an acknowledgement stapled to
 * it: I choose, she confirms. This endpoint is the one that makes the feature
 * two-way, because it lets her CHOOSE — a track of her own, with her own note,
 * filed on the same day as mine so a day is a PAIR rather than a transmission and
 * a nod.
 *
 * Over a year of long distance that is not a nice-to-have, it is the whole point.
 * The song was always the excuse.
 *
 * ---------------------------------------------------------------------------
 * THE PATH SAYS `reply` AND THE PRODUCT NO LONGER DOES. THAT IS DELIBERATE.
 *
 * Nothing she reads says "reply" any more: the two halves of a day are peers, both
 * rendered by one card template, neither waiting on the other. The URL and the
 * store keys (`us:reply:<date>` / `doc.replies[date]`) keep the old word anyway.
 *
 * Renaming the PATH would break the live no-JavaScript form on a page her phone may
 * have had open for a week — the whole no-JS guarantee is that the form in front of
 * her posts somewhere that exists. Renaming the KEYS is a migration whose
 * half-applied state shows her entire history as deleted; kv.ts's header spells
 * that out at length.
 *
 * So the divergence is documented rather than resolved, in both places a reader
 * could land: `reply` is a WIRE AND STORAGE fact, "her half" is the PRODUCT fact.
 * Do not tidy the noun without a migration and a rollback plan.
 *
 * ---------------------------------------------------------------------------
 * SESSION ONLY — NOT ADMIN. AND THE OTHER HALF OF THAT RULE MATTERS MORE.
 *
 * This endpoint accepts HER session cookie and refuses my admin one, for the same
 * reason /api/us/react does: a song I could post as her is a song that means
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
 * THE TWO HALVES BEING EQUALS ON SCREEN DID NOT SOFTEN ANY OF THAT. The pages now
 * render one card template twice and give both sides the same weight — and the
 * reason that is safe to show is precisely that the credentials underneath are NOT
 * symmetric. One endpoint per identity is what makes "this half came from her" a
 * fact rather than a caption. Never merge these two endpoints, never let either one
 * choose its key space from a request field.
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
import { notify } from '../../../lib/us/push';
import { crossSite, identify } from '../../../lib/us/together';
import { isTimeZone, isWingDate, putReply, wingDate, type ReplyRecord } from '../../../lib/us/kv';
// The one parser, the one metadata resolver, the one text cleaner, and the SAME
// field caps as his side — a shorter note on her card would be an asymmetry
// nobody chose. See the header.
// MAX_ARTIST is no longer imported: nothing here reads a typed artist any more, and it
// still exists over in song.ts to cap what the embed page returns.
import { MAX_NOTE, cleanText, resolveMetadata, resolveTrackId } from './song';
import { timer, trace } from '../../../lib/us/trace';

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
const TODAY_PAGE = '/samdrea/vault/today';

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
  const t = timer();

  /** One exit point, so the fetch and no-JS paths can never drift apart. */
  const answer = (
    ok: boolean,
    status: number,
    error: string | null,
    extra: Record<string, unknown> = {},
  ): Response => {
    // One line per reply, at the shared exit. No `who`: this endpoint is hers alone.
    trace('reply.post', { ok, status, code: error, ms: t.total() });
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
  /* WHICH ONE OF THEM, not merely "someone with a session".
  
     This endpoint writes her half of the day — posting HER song into her own slot. While /api/us/song
     demanded an admin passcode, the two sides were kept apart by having
     two different credentials. Now the gate is the only credential and
     identity is a label (see whoami.ts), so the split has to be stated
     here instead. Verified before this: a him-cookie POST was accepted,
     filing one person's song under the other's name on the page whose
     entire subject is whose is whose.
  
     `who` comes from the cookie and never from the body, so it cannot be
     changed by editing a field. */
  const who = identify(cookies, url);
  if (!who) {
    return answer(false, 401, 'unauthorized');
  }
  if (who !== 'her') {
    return answer(false, 403, 'not-your-half');
  }

  /* CROSS-SITE. Checked AFTER the cookie, so an unauthenticated probe learns
     nothing it did not already know.
  
     This was absent here while frame.ts, mark.ts, thinking.ts and together.ts all
     had it. That gap was real, not theoretical: Astro's own origin check exempts
     `application/json` entirely (see origin-check.js — a non-form content type
     returns early), and `sameSite: 'lax'` is SITE-scoped rather than
     origin-scoped, so any host under the same registrable domain could make a
     JSON POST carrying her cookie. The 'cross-site' sentence the pages already
     had for this could never fire. */
  if (crossSite(request, url)) {
    console.warn('[us] refused a cross-site song reply.');
    return answer(false, 403, 'cross-site');
  }

  const limit = await hit(`reply:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!limit.ok) return answer(false, 429, 'rate', { retryAfter: limit.retryAfter });

  // ---- parse ------------------------------------------------------------
  let rawUrl = '';
  let note = '';
  let date = wingDate();
  let tz = '';
  try {
    const fields: Record<string, unknown> = wantsJson
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries(await request.formData());

    rawUrl = typeof fields.url === 'string' ? fields.url : '';
    note = cleanText(fields.note, MAX_NOTE);

    /* WHERE SHE WAS WHEN SHE POSTED IT, from a hidden field the page fills in with
       Intl.DateTimeFormat().resolvedOptions().timeZone. Same treatment as the field
       on his side, for the same reasons — see /api/us/song, which carries the long
       version of this comment.

       Dropped silently when absent or junk rather than 400ing: it is not something
       she typed, with JavaScript off it arrives empty, and '' simply means "we do
       not know", at which point the page falls back to HER_TZ. Validated with
       isTimeZone() and not cleanText() because it is an identifier bound for Intl,
       not prose. */
    tz = isTimeZone(fields.tz) ? fields.tz.trim() : '';

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

  /* resolveTrackId, not extractTrackId: it tries the strict synchronous parse
     first and only asks Spotify where a link goes when that fails. A canonical
     paste therefore costs nothing, and a shortlink — which carries no track id at
     all — stops being rejected as though it were invalid. */
  const id = await resolveTrackId(rawUrl);
  if (!id) return answer(false, 400, 'bad-url');

  // ---- resolve + store --------------------------------------------------
  //
  // NOT checked: whether I posted a song that day. A day with only her half on it
  // is a complete day, not a pending one — she is not answering me, she is posting.
  // Checking would cost a store round trip to prevent the ordinary case.
  const meta = await resolveMetadata(id);

  const reply: ReplyRecord = {
    date,
    id,
    /* RESOLVED, FULL STOP — see song.ts, which lost the same override.
       Her form used to have no artist field at all, then gained one because the
       credential-free metadata path returned no artist and her cards rendered a line
       poorer than mine every day. That asymmetry closed itself when the artist became
       resolvable from the embed page: both sides now get it from the same place, which
       is a better fix than a third input at 1am. */
    artist: meta.artist,
    title: meta.title,
    art: meta.art,
    note,
    postedAt: Date.now(),
    /* '' rather than a default of HER_TZ, exactly as on his side: the constant is
       consulted in one place only, the render, so an old record and a
       JavaScript-off one behave identically. */
    tz,
    album: meta.album,
    year: meta.year,
    durationMs: meta.durationMs,
  };

  try {
    // Overwrites her earlier song for that day, on purpose: the realistic mistake
    // is pasting the wrong link, and the fix has to be "send it again" from the
    // same phone. One song per side per day is also what keeps a day readable as a
    // pair rather than as a thread nobody scrolls. Exactly the same rule as
    // putSong, because the two halves are the same shape by design.
    await putReply(reply);
  } catch (err) {
    // Loud, and reported as a failure. The one outcome that must never happen is a
    // page that says "sent" over a write that did not land.
    console.error('[us] reply could not write to the store:', err);
    return answer(false, 502, 'store');
  }

  /* ---- THE NOTIFICATION -----------------------------------------------
     The SAME event key as his side. A song is a song: the wire carries
     `{"e":"song","a":"her"}` and public/sw.js turns the actor into the pronoun,
     so he reads "She picked a song" where she reads "Sam picked a song". Two
     event keys for one kind of thing would have meant two entries in the
     worker's table saying the same sentence twice.

     `who` is 'her' by the guard above, so notify() sends to him. Awaited, and it
     cannot throw — see push.ts. */
  await notify(who, 'song');

  // `degraded` lets her page say "Spotify would not give us a title" out loud
  // instead of leaving a card that looks half-broken for no stated reason.
  return answer(true, 200, null, { date, reply, degraded: meta.title === '' });
};

/** Anything other than POST. Explicit, so a stray GET is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
