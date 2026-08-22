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
 * THE WEB API IS AN OPTIONAL UPGRADE, GATED ON CREDENTIALS THAT MAY NEVER EXIST
 *
 * Album, release year and duration are not available without an app registration,
 * so they come from Spotify's Web API — and ONLY when `SPOTIFY_CLIENT_ID` and
 * `SPOTIFY_CLIENT_SECRET` are both set. When they are not, which is the state this
 * shipped in, resolveMetadata() goes straight to oEmbed and every enriched field
 * is stored empty. Nothing on either page renders a label for an empty one.
 *
 * THIS ORDERING IS THE POINT: the credential-free path is not a fallback bolted
 * on for robustness, it is the DEFAULT, and the credentialed path is the thing
 * wrapped in a try/catch. A feature that stopped working the day a token expired
 * would be a feature that depends on my remembering to renew it, and the whole
 * design premise of the wing is that it survives me forgetting things.
 *
 * Deliberately NOT used from the Web API: `preview_url`. Spotify stopped issuing
 * it to new applications, so it is null for us and anything built on it is dead.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXPORTS ITS PARSER AND ITS METADATA RESOLVER
 *
 * /api/us/reply — her side — imports extractTrackId(), resolveMetadata() and
 * cleanText() from here rather than owning copies. That is the single most
 * important decision in the two-way feature: this parser is where the host
 * confusion, `javascript:`, playlist and path-traversal rejections live, and a
 * second parser written for her endpoint would be a second parser to get right.
 * There is only ever one, and it is this one.
 *
 * They live HERE, and not in a shared lib module, because this is the file whose
 * header documents WHY each rule exists. Moving the code away from that reasoning
 * is how the reasoning stops being read.
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
  getExchange,
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

/** Exported so her endpoint applies the same caps rather than picking its own. */
export const MAX_NOTE = 600;
export const MAX_ARTIST = 120;

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

export interface Metadata {
  title: string;
  art: string;
  /** Web API only. '' without credentials. */
  artist: string;
  /** Web API only. '' without credentials. */
  album: string;
  /** Web API only, four digits. '' without credentials. */
  year: string;
  /** Web API only. 0 without credentials. */
  durationMs: number;
}

const EMPTY_METADATA: Metadata = { title: '', art: '', artist: '', album: '', year: '', durationMs: 0 };

/**
 * Read one environment variable at REQUEST time.
 *
 * Bracket access on a variable rather than `import.meta.env.SPOTIFY_CLIENT_ID`,
 * for the reason config.ts spells out at length: Vite statically replaces the
 * dotted form during `astro build`, so the value baked into the bundle is whatever
 * the build container had — which for a secret is `undefined`, forever, with no
 * error anywhere. Duplicated here rather than added to config.ts because these two
 * variables belong to this endpoint's Spotify story and nothing else in the wing
 * reads them.
 */
function env(name: string): string | undefined {
  const fromMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromNode = typeof process !== 'undefined' ? process.env : undefined;
  const value = fromMeta?.[name] ?? fromNode?.[name];
  // Empty string is absent. A blank secret saved in a dashboard must never look
  // like a configured one.
  return value && value.length > 0 ? value : undefined;
}

function spotifyApp(): { id: string; secret: string } | null {
  const id = env('SPOTIFY_CLIENT_ID');
  const secret = env('SPOTIFY_CLIENT_SECRET');
  // BOTH or neither. Half-configured is treated as unconfigured rather than as an
  // error, because the degraded path is fully functional and a 500 here would take
  // down posting for the sake of a field nobody has yet seen.
  return id && secret ? { id, secret } : null;
}

/**
 * The client-credentials token, cached for the life of the container.
 *
 * A token is good for an hour and a serverless container rarely lives that long,
 * so in practice this caches across the handful of requests in one warm instance
 * and nothing more. That is enough: it turns "two round trips per post" into "two
 * on a cold start, one after". The 60-second safety margin is there so a token
 * that expires mid-flight is refreshed before use rather than producing a 401 that
 * silently loses the enrichment.
 *
 * No locking around the refresh. Two concurrent posts on one instance would each
 * mint a token, which Spotify permits and which costs one wasted request — and the
 * only two posters are two people, one of whom posts once a morning. A mutex here
 * would be more code than the problem.
 */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function appToken(app: { id: string; secret: string }): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        // Basic auth rather than the body form: the secret stays out of the
        // request body, which is the part most likely to end up in a log.
        Authorization: `Basic ${Buffer.from(`${app.id}:${app.secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      // The status, never the body: a token endpoint's error body can echo back
      // request material, and this log line is not worth that risk.
      console.error(`[us] spotify token HTTP ${res.status} — falling back to oEmbed.`);
      return null;
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    const value = typeof body?.access_token === 'string' ? body.access_token : '';
    if (!value) return null;
    const ttl = Number(body?.expires_in);
    cachedToken = {
      value,
      expiresAt: Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 3600) * 1000,
    };
    return value;
  } catch (err) {
    console.error('[us] spotify token unreachable — falling back to oEmbed:', err);
    return null;
  }
}

/** An https URL under a known Spotify CDN, or '' — see resolveMetadata(). */
function safeArtUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'https:' && ART_HOSTS.some((suffix) => host.endsWith(suffix))) {
      return u.toString();
    }
    console.error(`[us] spotify art host not allowed: ${host} — dropping the art.`);
  } catch {
    /* unparseable: no art, no drama. */
  }
  return '';
}

/**
 * The credentialed path. Returns null on ANY problem so the caller falls through
 * to oEmbed — a missing album name must never cost us the title.
 */
async function resolveViaWebApi(id: string): Promise<Metadata | null> {
  const app = spotifyApp();
  if (!app) return null;

  const token = await appToken(app);
  if (!token) return null;

  try {
    const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      // 401 means the cached token went stale early (revoked, or the app's
      // credentials rotated). Dropping it means the NEXT post mints a fresh one
      // instead of failing for the rest of the container's life.
      if (res.status === 401) cachedToken = null;
      console.error(`[us] spotify track HTTP ${res.status} for ${id} — falling back to oEmbed.`);
      return null;
    }

    const body = (await res.json()) as {
      name?: unknown;
      duration_ms?: unknown;
      artists?: unknown;
      album?: unknown;
    };

    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max).trim() : '');

    const title = str(body?.name, 200);
    // Every artist, comma-joined, because a collaboration listing only the first
    // name is a small wrong answer and the field is free-text anyway.
    const artist = Array.isArray(body?.artists)
      ? body.artists
          .map((a) => str((a as { name?: unknown })?.name, 120))
          .filter(Boolean)
          .join(', ')
          .slice(0, MAX_ARTIST)
      : '';

    const album = (body?.album ?? {}) as { name?: unknown; release_date?: unknown; images?: unknown };
    const released = str(album?.release_date, 10);
    // `release_date` is `YYYY`, `YYYY-MM` or `YYYY-MM-DD` depending on
    // `release_date_precision`. Only the year is ever shown, so only the year is
    // stored, and it is stored only if it is really four digits.
    const year = /^\d{4}/.test(released) ? released.slice(0, 4) : '';

    // Images arrive largest-first. The 300px one is picked deliberately, not the
    // 640: the card renders it at 320 CSS px on a phone at DPR 2-3, and 640 is
    // four times the bytes for a difference that only a desktop would see. Falls
    // back to whatever exists when there are fewer than three sizes.
    const images = Array.isArray(album?.images) ? (album.images as Array<{ url?: unknown }>) : [];
    const chosen = images[1] ?? images[0] ?? null;
    const art = safeArtUrl(chosen?.url);

    if (!title) return null;

    const durationMs = Number(body?.duration_ms);
    return {
      title,
      art,
      artist,
      album: str(album?.name, 200),
      year,
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.floor(durationMs) : 0,
    };
  } catch (err) {
    console.error('[us] spotify web api unreachable — falling back to oEmbed:', err);
    return null;
  }
}

/**
 * Ask Spotify for whatever it will tell us about a track. Never throws.
 *
 * The Web API is tried first and only when both credentials exist; oEmbed is the
 * floor underneath it and needs nothing. If the API answers with a title, its
 * answer is used whole — mixing the two sources per-field would mean a card whose
 * title and art could come from different responses about the same track, which is
 * a class of inconsistency with no upside.
 *
 * 3s rather than the store's 2s: this is a third party over the public internet
 * from a cold serverless container, not a database in the next rack. Still short
 * enough that a hung Spotify does not hold my phone's form submission open. Note
 * the credentialed path can spend that twice (token, then track), which is the
 * honest cost of the upgrade and is bounded because both calls are separately
 * timed out and both failures are non-fatal.
 *
 * Everything in every response is treated as untrusted. The art URL in particular
 * goes into an `<img src>` on her page, so it must be https and its hostname must
 * sit under a known Spotify CDN — if Spotify ever starts returning something
 * else, the card degrades to the no-art layout rather than making her browser
 * fetch from a host this code has never heard of. Logged loudly, because "the art
 * quietly stopped working" is otherwise invisible.
 */
export async function resolveMetadata(id: string): Promise<Metadata> {
  const enriched = await resolveViaWebApi(id);
  if (enriched) return enriched;

  const empty: Metadata = { ...EMPTY_METADATA };
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

    // Same host allowlist as the credentialed path, via the same function. Two
    // copies of an art-URL check is two chances to relax one of them.
    return { ...empty, title, art: safeArtUrl(body?.thumbnail_url) };
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
export function cleanText(raw: unknown, max: number): string {
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
    // One composite read, then split. `today` is whatever is filed under today's
    // date, and the archive is everything else — so a morning I never posted shows
    // an empty card above a full archive rather than silently promoting
    // yesterday's song. Pretending yesterday is today would be a small lie that
    // makes the whole feature untrustworthy.
    const { songs, reactions, replyByDate } = await getExchange(ARCHIVE_LIMIT);

    // Her reply rides along with the day it answers. A client that had to make a
    // second call for the other half of a conversation would eventually render
    // half of one.
    const decorate = (s: SongRecord) => ({
      ...s,
      reactions: reactions[s.date] ?? [],
      reply: replyByDate[s.date] ?? null,
    });
    const todaySong = songs.find((s) => s.date === today);

    return json({
      ok: true,
      date: today,
      today: todaySong ? decorate(todaySong) : null,
      // Present even on a day I have not posted, because she may have gone first
      // and a null `today` must not mean "nothing happened today".
      reply: replyByDate[today] ?? null,
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
    // WHAT I TYPED WINS. The Web API's artist string is a good default and a bad
    // override: for a feature or a remix I may deliberately want to name it
    // differently, and having the server quietly replace what I typed would make
    // the field feel broken. So the resolver only fills a blank.
    artist: artist || meta.artist,
    art: meta.art,
    note,
    postedAt: Date.now(),
    album: meta.album,
    year: meta.year,
    durationMs: meta.durationMs,
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
