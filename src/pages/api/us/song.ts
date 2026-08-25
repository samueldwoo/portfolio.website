/**
 * /api/us/song — GET reads the shelf, POST puts something on it.
 *
 * ---------------------------------------------------------------------------
 * TWO METHODS, TWO DIFFERENT CREDENTIALS
 *
 *   GET  — needs a `session` (her) OR an `admin` (me) token. Reading is shared,
 *          and it reads BOTH halves of every day: a day is a pair now, and an
 *          endpoint that returned one side would guarantee a page that renders
 *          one side.
 *   POST — needs the `admin` token SPECIFICALLY. A session must never be able to
 *          write MY half: her cookie lives for 30 days on a phone that goes to the
 *          gym, and the guarantee worth keeping is that each half of a day came
 *          from the person it is attributed to. Her half is written by
 *          /api/us/reply, which is the mirror of this rule — it takes her session
 *          and refuses my admin token. The two endpoints are equals; the cookies
 *          are not interchangeable. That asymmetry of CREDENTIALS is what makes
 *          the symmetry of CONTENT safe to show.
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
import { notify } from '../../../lib/us/push';
import { crossSite, identify } from '../../../lib/us/together';
import { timer, trace } from '../../../lib/us/trace';
import {
  StoreError,
  emptyPair,
  getExchange,
  isTimeZone,
  isWingDate,
  putSong,
  wingDate,
  type SongRecord,
} from '../../../lib/us/kv';

export const prerender = false;

/**
 * How far back the archive goes in one response. ~2 months.
 *
 * It caps EACH SIDE's history, not the number of days — see getExchange(). Two
 * sides of 60 records that never overlap would yield up to 120 days, which is fine
 * for a JSON response and is the honest thing to return rather than truncating
 * whichever side sorted second.
 */
/* 7, and it must equal the page's ARCHIVE_LIMIT — the two are the same window seen
   from two sides, and a mismatch shows her a day in one place and not the other. */
const ARCHIVE_LIMIT = 7;

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
/* The posting form moved onto /samdrea/vault/today, so that is where a no-JS
   submit has to land — it used to bounce back to the booth, which after the merge
   is a page he was never on. */
const DJ = '/samdrea/vault/today';

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
 * Shortlinks — `open.spotify.com/s/<code>` and `spotify.link/<code>` — are NOT
 * accepted here and cannot be, because they contain no track id to extract. They are
 * handled by resolveTrackId() below, which asks Spotify where they go and then comes
 * back through this function. Keeping this one synchronous and network-free is what
 * makes the accept/reject decision testable.
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
  // NOTHING AFTER THE ID. This bound was missing for a revision, and an
  // adversarial review caught the gap: `/track/<22>/anything` was accepted. It was
  // never exploitable — the host is compared for equality and the id is
  // re-validated below — but this file's own header claims "an extra path segment"
  // is rejected outright, and a comment that overstates what the code does is worse
  // than no comment. A trailing slash still passes: the filter above drops empty
  // segments, so `/track/<22>/` is two segments, not three.
  if (segments.length !== trackAt + 2) return null;

  const id = segments[trackAt + 1] ?? '';
  return TRACK_ID_RE.test(id) ? id : null;
}

/**
 * Spotify hosts a shortlink may legitimately start on.
 *
 * THE ALLOWLIST IS THE SSRF BOUNDARY. Resolving a shortlink means the server makes
 * a request to a URL somebody pasted, which is the shape of every SSRF bug ever
 * written. Only these three are ever fetched, so a pasted link to an internal
 * address, a cloud metadata endpoint or a file scheme is refused before any request
 * happens rather than being caught afterwards.
 *
 * `spotify.link` is included because it is what the iOS share sheet now produces,
 * and it redirects onward to `spotify.app.link` — Branch.io's deep-link service,
 * which is a third party but is Spotify's own choice of one, not a caller's.
 */
const SHORTLINK_HOSTS = new Set(['open.spotify.com', 'spotify.link', 'spotify.app.link']);

/** Bounded, because a redirect loop is somebody else's bug and our hang. */
const RESOLVE_TIMEOUT_MS = 4000;

/** Enough for an interstitial's <head>; a track id is never deep in a document. */
const RESOLVE_MAX_BYTES = 96 * 1024;

/**
 * Resolve a share link that carries no track id of its own, then parse it strictly.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SEPARATE FROM extractTrackId AND ASYNC
 *
 * `open.spotify.com/s/<code>` and `spotify.link/<code>` are real links from real
 * Spotify share sheets, and they were being rejected as invalid — which reads as
 * "the site is broken" when you have just copied a link the app gave you. But there
 * is nothing in them to parse: the track id genuinely is not present, and the only
 * way to learn it is to ask Spotify where the link goes.
 *
 * extractTrackId stays synchronous, pure and total, because it is the thing that
 * decides what is ACCEPTED and that decision should be testable without a network.
 * This wraps it instead: one network hop, then the same strict parser on whatever
 * came back. A shortlink cannot widen what is accepted — the final URL still has to
 * satisfy the host-equality and path checks in full.
 *
 * CANONICAL LINKS NEVER REACH HERE, so the ordinary paste costs nothing: the caller
 * tries extractTrackId first and only falls through on a miss.
 *
 * TWO WAYS TO LEARN THE DESTINATION, because Spotify uses both. Usually the
 * shortlink 30x-redirects and `res.url` after following is the real track URL. Some
 * of them instead serve an interstitial page, so the body is scanned for a track id
 * as a fallback — and only a 22-character alphanumeric id is taken from it, which is
 * then re-validated and rebuilt into a canonical URL by us. Nothing from that
 * document is trusted or echoed.
 *
 * Total: every failure returns null, which the callers already render as "that link
 * did not work", the same as any other unusable paste.
 */
export async function resolveTrackId(raw: unknown): Promise<string | null> {
  const direct = extractTrackId(raw);
  if (direct) return direct;

  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input || input.length > 500) return null;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!SHORTLINK_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const t = timer();
  try {
    /* ---- HOP BY HOP, READING Location, WITHOUT DOWNLOADING ANYTHING ----------

       `/s/<code>` is Spotify's DEFAULT share format, so this cost is paid on
       essentially every song either of them posts — which makes it worth doing
       properly rather than simply.

       The first version used `redirect: 'follow'` and then read `res.url`. Correct,
       and wasteful: following the chain downloads the destination PAGE, measured at
       316,936 bytes in ~290ms, purely to learn a URL that the 302 had already
       stated in a header. Reading the header instead is 195 bytes in ~120ms — the
       same answer, two and a half times faster, on the hot path.

       Manual hops also restore a boundary that `follow` had given away: with the
       platform following, a redirect could land anywhere and only the FINAL host was
       ever checked. Here every hop is checked against the allowlist before it is
       taken, so the chain cannot be walked off Spotify's own hosts at all. */
    let current = parsed;
    let hops = 0;
    let landed: Response | null = null;

    while (hops < 5) {
      hops += 1;
      const res = await fetch(current.toString(), {
        redirect: 'manual',
        headers: {
          /* Spotify serves a different response to something that does not look
             like a browser. Not evasion — asking for the page a person clicking the
             link would get. */
          'User-Agent': 'Mozilla/5.0 (compatible; us-private-wing/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      });

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        let next: URL;
        try {
          // Resolved against the current URL, because a Location may be relative.
          next = new URL(location, current);
        } catch {
          break;
        }

        /* THE ANSWER IS USUALLY RIGHT HERE, one hop in, and this is the fast exit:
           no body has been read and nothing has been downloaded. */
        const viaHeader = extractTrackId(next.toString());
        if (viaHeader) {
          trace('song.resolve', { ok: true, via: 'header', hops, ms: t.total() });
          return viaHeader;
        }

        /* Not a track yet. Keep going only while the chain stays on a host we were
           willing to contact in the first place. */
        if (!SHORTLINK_HOSTS.has(next.hostname.toLowerCase())) {
          trace('song.resolve', { ok: false, via: 'offhost', hops, ms: t.total() });
          return null;
        }
        current = next;
        continue;
      }

      landed = res;
      break;
    }

    /* ---- THE INTERSTITIAL FALLBACK ------------------------------------------
       Some share links serve a page rather than redirecting to the track. Only
       reached when the header route found nothing, so the 316KB is paid by the rare
       case instead of every case. Capped: this is somebody else's document and there
       is no reason to hold megabytes of it to find 22 characters. */
    if (landed && landed.ok) {
      const text = (await landed.text()).slice(0, RESOLVE_MAX_BYTES);
      const found =
        /spotify:track:([A-Za-z0-9]{22})/.exec(text) ??
        /open\.spotify\.com\/(?:intl-[a-z]{2,3}\/)?track\/([A-Za-z0-9]{22})/.exec(text);
      if (found && TRACK_ID_RE.test(found[1])) {
        trace('song.resolve', { ok: true, via: 'body', hops, ms: t.total() });
        return found[1];
      }
    }

    trace('song.resolve', {
      ok: false,
      via: 'none',
      hops,
      status: String(landed?.status ?? 0),
      ms: t.total(),
    });
    return null;
  } catch {
    /* Timed out, unreachable, or a redirect loop. The paste is simply unusable this
       time, which is a state the form already has copy for. */
    trace('song.resolve', { ok: false, via: 'error', ms: t.total() });
    return null;
  }
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
      /* THE TRACK ID IS NOT LOGGED, and it used to be.
         A 22-character Spotify id resolves to an exact title and artist through a
         public, unauthenticated oEmbed call — so an id in a log IS the song in the
         log, which is the precise thing trace.ts is built to make impossible. This
         line reached a raw console.error and bypassed all of it. The status is the
         only actionable part; the id told a debugger nothing the status did not. */
      console.error(`[us] spotify track HTTP ${res.status} — falling back to oEmbed.`);
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
      // Same reason as above: the id is the song, so only the status is printed.
      console.error(`[us] spotify oembed HTTP ${res.status} — storing without metadata.`);
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
    // One composite read, already folded into days. `pair` is whatever is filed
    // under today's date — never "the most recent day". Promoting yesterday would
    // be a small lie that makes the whole feature untrustworthy: neither of us
    // could tell a day the other posted from a day they did not.
    const { pairs, pairByDate } = await getExchange(ARCHIVE_LIMIT);

    return json({
      ok: true,
      date: today,
      // ALWAYS a pair, never null, even when nobody has posted. A caller that had
      // to distinguish "no day" from "an empty day" would grow a branch for a
      // state that is not different: an empty slot is the ordinary case here.
      pair: pairByDate[today] ?? emptyPair(today),
      archive: pairs.filter((p) => p.date !== today),

      /* ---- deprecated, and kept on purpose -------------------------------
         The old one-sided shape: `today` was his song with her reply nested
         inside it. Her phone keeps this tab alive for a week, so a page rendered
         before this deploy is still running the OLD rollover probe, which reads
         exactly these two keys. Without them that probe silently stops noticing
         the day change — it fails safe (it just never reloads) but it fails
         invisibly, and the whole point of the probe is that the page does not go
         stale on her. Two keys is a cheap way to not break a tab I cannot reach.

         Delete both once no live tab predates the deploy — a fortnight is plenty. */
      today: pairByDate[today]?.his ?? null,
      reply: pairByDate[today]?.hers ?? null,
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
    /* `s=` carries retryAfter through to the page, which admin.ts already did and
       this did not — so dj.astro fell back to its `|| '600'` default and said
       "wait 600 seconds" when thirty were left. Only appended when there is a
       number, so no other error grows a meaningless query param. */
    const secs = Number(extra.retryAfter);
    const query = ok
      ? `?posted=${encodeURIComponent(String(extra.date ?? ''))}`
      : `?e=${encodeURIComponent(error ?? 'no')}` +
        (Number.isFinite(secs) && secs > 0 ? `&s=${Math.round(secs)}` : '');
    return redirect(`${DJ}${query}`, 303);
  };

  const secret = SESSION_SECRET();
  if (!secret) {
    console.error('[us] song POST called but US_SESSION_SECRET is missing.');
    return answer(false, 503, 'unconfigured');
  }

  /* A SESSION IS ENOUGH, and this used to demand `admin`.
  
     It was the ONLY endpoint in the wing that did. Photos, letters, the daily
     question, the list, the marks and HER song all accept a session — so anybody
     through the gate could already write nine-tenths of the site, and the passcode
     was protecting exactly one form. That is an inconsistency, not a threat model,
     and it cost a second credential and a second login on every device.
  
     THE GATE IS THE SECURITY BOUNDARY. Inside it there are two people who do not
     need protecting from each other. So `whoami` is a LABEL rather than a
     permission (see identify() in together.ts), and this endpoint now asks the same
     question every other write asks: is this a request from someone who is through
     the gate, and which of the two do they say they are?
  
     identify() answers both. `who` is not read from the body, so a caller cannot
     post as the other person by editing a field — it comes from the cookie. */
  const who = identify(cookies, url);
  if (!who) {
    return answer(false, 401, 'unauthorized');
  }

  /* YOU MAY ONLY WRITE YOUR OWN HALF, and this line is the whole of the new
     identity model's teeth.
  
     The two endpoints are per-SIDE, not per-person: this one writes his slot,
     /api/us/reply writes hers. While this demanded `admin` that split enforced
     itself. The moment it accepted a session, a session alone could post into his
     slot — verified: a her-cookie POST came back `?posted=`, filing her song as
     his. That is precisely the misattribution the whoami split exists to prevent,
     arriving from the other direction.
  
     `who` is read from the cookie and never from the body, so this cannot be
     bypassed by editing a field. If she wants to post, /api/us/reply is her
     endpoint and the page gives her that form. */
  if (who !== 'him') {
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
    console.warn('[us] refused a cross-site song post.');
    return answer(false, 403, 'cross-site');
  }

  const limit = await hit(`song:${clientKey(request, clientAddress)}`, POST_LIMIT, POST_WINDOW_SEC);
  if (!limit.ok) return answer(false, 429, 'rate', { retryAfter: limit.retryAfter });

  // ---- parse ------------------------------------------------------------
  let rawUrl = '';
  let note = '';
  let artist = '';
  let date = wingDate();
  let tz = '';
  try {
    const fields: Record<string, unknown> = wantsJson
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries(await request.formData());

    rawUrl = typeof fields.url === 'string' ? fields.url : '';
    note = cleanText(fields.note, MAX_NOTE);
    artist = cleanText(fields.artist, MAX_ARTIST);

    /* WHERE HE WAS WHEN HE POSTED IT, from a hidden field the page fills in with
       Intl.DateTimeFormat().resolvedOptions().timeZone.

       DROPPED SILENTLY WHEN IT IS ABSENT OR JUNK, never a 400. It is not something
       he typed and there is nothing he could do about it being wrong, so refusing
       the whole song over it would be punishing him for his browser: with
       JavaScript off the field arrives empty, which is the ordinary
       no-JavaScript path this endpoint is required to keep working. An empty
       value means "we do not know", and the page falls back to HIS_TZ.

       NOT cleanText(): that is for prose. This is validated as an identifier —
       isTimeZone() bounds the length, checks the shape and then asks Intl whether
       it will actually accept the name, because the value's whole future is being
       handed to Intl. See its header in kv.ts. */
    tz = isTimeZone(fields.tz) ? fields.tz.trim() : '';

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

  /* resolveTrackId, not extractTrackId: it tries the strict synchronous parse
     first and only asks Spotify where a link goes when that fails. A canonical
     paste therefore costs nothing, and a shortlink — which carries no track id at
     all — stops being rejected as though it were invalid. */
  const id = await resolveTrackId(rawUrl);
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
    /* Stored '' rather than defaulted to HIS_TZ here, on purpose. '' is the honest
       record of "his device did not tell us", it is what every song already on the
       shelf says, and it means the constant is consulted in exactly ONE place — the
       render — so a JavaScript-off post from today and a post from last month behave
       identically, and correcting the constant retroactively fixes both. */
    tz,
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

  /* ---- THE NOTIFICATION -----------------------------------------------
     AFTER putSong has resolved, never before, and it goes to HER because
     notify() sends to otherOne(actor) and `who` is 'him' by the check above.

     It says "Sam picked a song" and nothing else. The title, the artist and the
     note are all sitting in `song` two lines up and NONE of them is passed —
     notify() takes two enums and has no parameter one of them could occupy. See
     push.ts's header for why that is a shape rather than a habit.

     Awaited and unable to throw, so a push service having a bad minute cannot
     turn a saved song into a 502. */
  await notify(who, 'song');

  // `degraded` tells the dj page to say "Spotify did not give us a title" out
  // loud, instead of leaving me to wonder why the card looks half-empty.
  return answer(true, 200, null, { date, song, degraded: meta.title === '' });
};

/** Anything else. Explicit, so a stray PUT is a 405 and not a crash. */
export const ALL: APIRoute = () => json({ ok: false, error: 'method-not-allowed' }, 405);
