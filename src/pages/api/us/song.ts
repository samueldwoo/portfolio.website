/**
 * /api/us/song — GET reads the shelf, POST puts something on it.
 *
 * ---------------------------------------------------------------------------
 * TWO METHODS, TWO DIFFERENT CREDENTIALS
 *
 *   GET  — needs a `session` (her) OR an `admin` (me) token. Reading is shared.
 *   POST — needs the `admin` token SPECIFICALLY. A session must never be able to
 *          write: her cookie lives for 30 days on a phone that goes to the gym,
 *          and the whole point of the feature is that what appears tomorrow
 *          morning came from me.
 *
 * Both are verified in this file with verify(), not merely by middleware.ts. The
 * middleware is default-deny for /api/us/* and would already have stopped an
 * anonymous caller — but it accepts EITHER token for anything not on its admin
 * list, so it cannot tell a reader from a writer. Only this file knows that
 * distinction, so only this file can enforce it. That is also the defense-in-depth
 * rule for the whole wing: a routing mistake upstairs should downgrade to "the
 * endpoint says no", never to "anyone can post".
 *
 * ---------------------------------------------------------------------------
 * THE SPOTIFY DECISIONS (verified, and deliberately boring)
 *
 * METADATA: `https://open.spotify.com/oembed?url=<track-url>` returns a title and
 * album art with NO credentials and NO app registration, so the custom card works
 * from day one and there is no client secret to leak. It is wrapped in try/catch
 * and a timeout because it is an undocumented-ish endpoint on someone else's
 * infrastructure: when it fails we still store the song, and her page still gets
 * the official embed, which needs no metadata call at all.
 *
 * PLAYBACK: the official `open.spotify.com/embed/track/<id>` iframe, rendered by
 * her page. Explicitly NOT `preview_url` — Spotify removed 30-second previews for
 * new applications, so anything built on it is dead on arrival.
 *
 * ARTIST: oEmbed does not reliably return one, so it is an optional field I can
 * type. Empty is a supported state, not a bug; her page just omits the line.
 *
 * ---------------------------------------------------------------------------
 * THE URL IS PARSED, NEVER TRUSTED
 *
 * A pasted link is the only attacker-shaped input this endpoint has, and its
 * destination is an iframe `src`. So nothing is interpolated anywhere until a
 * 22-character base62 id has been extracted from a URL whose host is literally
 * `open.spotify.com`. Everything else — a different host, a playlist, an extra
 * path segment, a `javascript:` scheme — is rejected outright rather than
 * sanitized, because "sanitized" is a thing you can be wrong about.
 * ---------------------------------------------------------------------------
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../lib/us/config';
import { readCookie, verify } from '../../../lib/us/session';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import {
  StoreError,
  getReactions,
  getSongs,
  isWingDate,
  putSong,
  wingDate,
  type SongRecord,
} from '../../../lib/us/kv';

export const prerender = false;

/** How far back the archive goes in one response. ~2 months of mornings. */
const ARCHIVE_LIMIT = 60;

/**
 * A ceiling on my own posting, not a security control.
 *
 * Every POST makes an outbound call to Spotify and (on the R2 tier) a
 * read-modify-write of the whole document. This exists so that a stuck retry loop
 * in a script — or a phone browser that resubmits a form every time it wakes —
 * cannot turn into a hundred of those a minute.
 */
const POST_LIMIT = 30;
const POST_WINDOW_SEC = 600;

/** Spotify track ids are exactly 22 base62 characters. */
const TRACK_ID_RE = /^[A-Za-z0-9]{22}$/;

/**
 * Hosts album art is allowed to come from. See resolveMetadata().
 *
 * BOTH entries are load-bearing and this was measured, not guessed: a live oEmbed
 * call for a real track came back with art on `image-cdn-ak.spotifycdn.com`, not
 * the `i.scdn.co` that most documentation shows. An allowlist of `.scdn.co` alone
 * would have silently dropped the art on every card while looking correct.
 */
const ART_HOSTS = ['.scdn.co', '.spotifycdn.com'];

const MAX_NOTE = 600;
const MAX_ARTIST = 120;

/** Where a browser form is sent afterwards, either way. */
const DJ = '/stronger/dj';

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

/* ============================================================================
   URL VALIDATION
   ========================================================================= */

/**
 * Pull a Spotify track id out of whatever I pasted, or return null.
 *
 * Accepted, and nothing else:
 *   spotify:track:<22>
 *   https://open.spotify.com/track/<22>            (+ any query string)
 *   https://open.spotify.com/intl-de/track/<22>    (the localized share links
 *                                                   the iOS app now produces)
 *
 * Written as URL parsing rather than one big regex on purpose. A regex over a raw
 * string is where host-confusion bugs live — `https://open.spotify.com.evil.tld/`
 * and `https://evil.tld/?x=open.spotify.com/track/aaaa` both contain the literal
 * text you were matching on. `new URL()` gives a real, parsed hostname that can be
 * compared for equality, which is the only comparison that is actually safe.
 */
export function extractTrackId(raw: unknown): string | null {
  const input = typeof raw === 'string' ? raw.trim() : '';
  // No legitimate share link is anywhere near this long; bail before parsing.
  if (input.length === 0 || input.length > 500) return null;

  const uri = /^spotify:track:([A-Za-z0-9]{22})$/.exec(input);
  if (uri) return uri[1];

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  // Scheme first. Without this, `javascript:` and `data:` URLs reach the path
  // logic below, and a hostname of '' is not a hostname worth reasoning about.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.hostname.toLowerCase() !== 'open.spotify.com') return null;

  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  const trackAt = segments.indexOf('track');
  // Only /track/<id> or /<locale>/track/<id>. Anything deeper is some other
  // Spotify surface (an album, an episode, a user) and is not what this is for.
  if (trackAt === -1 || trackAt > 1) return null;
  if (trackAt === 1 && !/^intl-[a-z]{2,3}$/i.test(segments[0])) return null;

  const id = segments[trackAt + 1] ?? '';
  return TRACK_ID_RE.test(id) ? id : null;
}

/** The canonical share URL for an id. Used for the oEmbed lookup. */
function trackUrl(id: string): string {
  return `https://open.spotify.com/track/${id}`;
}

/* ============================================================================
   METADATA
   ========================================================================= */

interface Metadata {
  title: string;
  art: string;
}

/**
 * Ask Spotify for the title and album art. Never throws.
 *
 * 3s rather than the store's 2s: this is a third party over the public internet
 * from a cold serverless container, not a database in the next rack. Still short
 * enough that a hung Spotify does not hold my phone's form submission open.
 *
 * Everything in the response is treated as untrusted. The art URL in particular
 * goes into an `<img src>` on her page, so it must be https and its hostname must
 * sit under a known Spotify CDN — if Spotify ever starts returning something
 * else, the card degrades to the no-art layout rather than making her browser
 * fetch from a host this code has never heard of. Logged loudly, because "the art
 * quietly stopped working" is otherwise invisible.
 */
async function resolveMetadata(id: string): Promise<Metadata> {
  const empty: Metadata = { title: '', art: '' };
  try {
    const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl(id))}`;
    const res = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.error(`[us] spotify oembed HTTP ${res.status} for ${id} — storing without metadata.`);
      return empty;
    }

    const body = (await res.json()) as { title?: unknown; thumbnail_url?: unknown };
    const title = typeof body?.title === 'string' ? body.title.slice(0, 200).trim() : '';

    let art = '';
    if (typeof body?.thumbnail_url === 'string') {
      try {
        const u = new URL(body.thumbnail_url);
        const host = u.hostname.toLowerCase();
        if (u.protocol === 'https:' && ART_HOSTS.some((suffix) => host.endsWith(suffix))) {
          art = u.toString();
        } else {
          console.error(`[us] spotify oembed art host not allowed: ${host} — dropping the art.`);
        }
      } catch {
        /* unparseable thumbnail_url: no art, no drama. */
      }
    }

    return { title, art };
  } catch (err) {
    // R7 in the plan: oEmbed is undocumented-ish and may change or disappear. The
    // mitigation is exactly this — post the song anyway. The official embed iframe
    // needs no metadata at all, so her page is still fully functional.
    console.error('[us] spotify oembed unreachable — storing without metadata:', err);
    return empty;
  }
}

/* ============================================================================
   INPUT CLEANING
   ========================================================================= */

/**
 * Control characters that are stripped from anything persisted.
 *
 * Built from escapes rather than written as a literal character class so the
 * source file stays printable ASCII — a literal U+0000 in a regex is invisible in
 * a diff, and one editor "helpfully" normalizing it changes the behaviour with no
 * visible change to the line. Tab (09), newline (0A) and carriage return (0D) are
 * deliberately ABSENT: they are the three a human typing a note legitimately
 * produces, and a note with a line break in it is a note.
 */
const CONTROL_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]',
  'g',
);

/**
 * Trim, cap, and strip control characters.
 *
 * Not an XSS control — Astro escapes on render and the client script uses
 * textContent, so escaping happens where it belongs. This is about what gets
 * PERSISTED: a stray NUL in a stored note is the kind of thing that breaks a JSON
 * round trip or a terminal three months later, for no benefit at all.
 */
function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(CONTROL_CHARS, '').slice(0, max).trim();
}

/* ============================================================================
   GET — the shelf
   ========================================================================= */

export const GET: APIRoute = async ({ cookies, url }) => {
  const secret = SESSION_SECRET();
  if (!secret) {
    console.error('[us] song GET called but US_SESSION_SECRET is missing.');
    return json({ ok: false, error: 'unconfigured' }, 503);
  }

  // Either token reads. Verified here rather than trusted from middleware — see
  // the header.
  const authed =
    verify(secret, 'session', readCookie(cookies, 'session', url)) ??
    verify(secret, 'admin', readCookie(cookies, 'admin', url));
  if (!authed) return json({ ok: false, error: 'unauthorized' }, 401);

  const today = wingDate();

  try {
    // One list, then split. `today` is whatever is filed under today's date, and
    // the archive is everything else — so a morning I never posted shows an empty
    // card above a full archive rather than silently promoting yesterday's song.
    // Pretending yesterday is today would be a small lie that makes the whole
    // feature untrustworthy.
    const songs = await getSongs(ARCHIVE_LIMIT);
    const reactions = await getReactions(songs.map((s) => s.date));
    const decorate = (s: SongRecord) => ({ ...s, reactions: reactions[s.date] ?? [] });
    const todaySong = songs.find((s) => s.date === today);

    return json({
      ok: true,
      date: today,
      today: todaySong ? decorate(todaySong) : null,
      archive: songs.filter((s) => s.date !== today).map(decorate),
    });
  } catch (err) {
    // A store failure is reported as one. Her page is server-rendered from the
    // same store and prints its own honest message, so this only ever reaches the
    // day-rollover refresh — which is written to leave the card alone on error.
    console.error('[us] song GET could not read the store:', err);
    return json({ ok: false, error: 'store' }, err instanceof StoreError ? 502 : 500);
  }
};

/* ============================================================================
   POST — putting something on it
   ========================================================================= */

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
    const query = ok
      ? `?posted=${encodeURIComponent(String(extra.date ?? ''))}`
      : `?e=${encodeURIComponent(error ?? 'no')}`;
    return redirect(`${DJ}${query}`, 303);
  };

  const secret = SESSION_SECRET();
  if (!secret) {
    console.error('[us] song POST called but US_SESSION_SECRET is missing.');
    return answer(false, 503, 'unconfigured');
  }

  // ADMIN ONLY. Note that a valid session token is rejected here exactly like an
  // anonymous caller: being allowed to read is not a step towards writing.
  if (!verify(secret, 'admin', readCookie(cookies, 'admin', url))) {
    return answer(false, 401, 'unauthorized');
  }

  const limit = await hit(`song:${clientKey(request, clientAddress)}`, POST_LIMIT, POST_WINDOW_SEC);
  if (!limit.ok) return answer(false, 429, 'rate', { retryAfter: limit.retryAfter });

  // ---- parse ------------------------------------------------------------
  let rawUrl = '';
  let note = '';
  let artist = '';
  let date = wingDate();
  try {
    const fields: Record<string, unknown> = wantsJson
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries(await request.formData());

    rawUrl = typeof fields.url === 'string' ? fields.url : '';
    note = cleanText(fields.note, MAX_NOTE);
    artist = cleanText(fields.artist, MAX_ARTIST);

    // An explicit date is allowed so I can backfill a morning I missed, but it is
    // validated like any other key material and it may not be in the future: a
    // song filed under tomorrow would vanish from her page until tomorrow, and "I
    // posted it and she never saw it" is the failure this file is arranged to
    // prevent. String comparison is correct here — ISO dates sort as text.
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
  const meta = await resolveMetadata(id);

  const song: SongRecord = {
    date,
    id,
    title: meta.title,
    artist,
    art: meta.art,
    note,
    postedAt: Date.now(),
  };

  try {
    await putSong(song);
  } catch (err) {
    // Loud, and reported as a failure to the caller. The one outcome that must
    // never happen is a form that says "posted" over a write that did not land.
    console.error('[us] song POST could not write to the store:', err);
    return answer(false, 502, 'store');
  }

  // `degraded` tells the dj page to say "Spotify did not give us a title" out
  // loud, instead of leaving me to wonder why the card looks half-empty.
  return answer(true, 200, null, { date, song, degraded: meta.title === '' });
};

/** Anything else. Explicit, so a stray PUT is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
