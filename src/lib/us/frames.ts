/**
 * frames.ts — one photograph each, every day. `line 04`.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MISSING, AND WHY THE STUDIO IS NOT IT
 *
 * The studio (`line 02`) holds the CURATED PAST: twelve photographs chosen
 * because they are the twelve, each with a note written about it afterwards, on a
 * rail she moves along. It is a room you visit.
 *
 * There was nothing at all for TODAY. Not the twelve, not a memory, not anything
 * worth keeping — the coffee, the sky out of the window on the walk home, the dog
 * somebody else was walking, the mess on the desk at 1am. The whole content of it
 * is "this is what I was looking at". Nobody would ever choose one of these for
 * the studio, and that is exactly the point: a photograph you would only send to
 * one person is a different object from a photograph you would keep.
 *
 * So `line 04` is deliberately the opposite of the studio in every axis. Two
 * frames a day, one each, side by side. No chapters, no reveal, no hold gesture,
 * no scroll. A caption, if there is one worth writing. Then tomorrow, two more.
 *
 * ---------------------------------------------------------------------------
 * IT KEEPS EVERYTHING AND SHOWS A WEEK
 *
 * The display window is seven days. The bytes are kept FOREVER.
 *
 * Those are two separate decisions and both are deliberate. A page showing every
 * frame since the beginning becomes an archive, and an archive of snapshots is a
 * second studio with a worse curator — the point of a daily photograph is that it
 * is about today and stops mattering, and a feature that quietly turns into a
 * scroll of four hundred images has lost the thing that made it casual.
 *
 * But DELETING them is unthinkable and it would be a strange thing to build. They
 * are photographs of each other. Storage is the cheapest part of this entire
 * project — a year of two frames a day at 400KB is about 290MB, well inside R2's
 * free tier — and the cost of being wrong about "she will not want these" is
 * unrecoverable. So retention is forever, and only the window is a week.
 *
 * That also means "show me more than a week" is a future feature and not a
 * migration. The data is already there.
 *
 * ---------------------------------------------------------------------------
 * THE SPLIT: BYTES IN R2, WORDS IN UPSTASH
 *
 * R2 holds the image at a key this file builds — `frames/<date>/<who>-<atMs>.<ext>`
 * — and NEVER at a name that came from the client. The upload's filename is
 * discarded entirely: the date is the server's, `who` comes from the session
 * cookie, the extension comes from sniffing the bytes, and the millisecond is the
 * server's clock. There is no client-controlled character anywhere in the key, so
 * there is no traversal to escape and no key to collide with.
 *
 * THE MILLISECOND IS THERE BECAUSE THE KEY USED TO BE `<who>.<ext>` AND A SECOND
 * UPLOAD ON A DAY OVERWROTE THE FIRST. R2 is unversioned, so that was final, and on
 * 2026-08-24 it took the only copy of a real photograph. A unique key means a swap
 * leaves the previous object in place and merely stops pointing at it. Which object
 * a record refers to is now STORED (`<who>Key`) rather than recomputed by whoever is
 * reading — see keyFromHash(), which also still answers for the records written
 * before that field existed.
 *
 * Upstash holds one hash per day with both captions and both timestamps, so the
 * whole week's metadata is a single pipelined read rather than fourteen HEADs
 * against R2.
 *
 * WITHOUT R2 THERE IS NO FEATURE, and the page says so rather than pretending.
 * Photographs are bytes; there is no degraded version of storing bytes. Without
 * UPSTASH the frames still render — they are in R2, they are never lost — but the
 * captions and timestamps are unavailable, because those live in the hash. Both
 * of those are stated on the page instead of being silently absent.
 *
 * ---------------------------------------------------------------------------
 * WHY THE UPLOAD IS PROXIED AND NOT A PRESIGNED PUT
 *
 * A presigned PUT handed to the browser is one fewer hop and the wrong shape
 * here: it means the client names the object. Even signed to a single key it
 * moves the decision about WHERE bytes land to the least trusted participant, and
 * the whole reason photos are in R2 rather than in `public/` is that this wing
 * does not do that.
 *
 * Proxying costs one hop and buys: the key is server-derived, the size is checked
 * against real bytes rather than a promise, and the type is sniffed from the
 * magic number rather than believed from a header. The client resizes first (see
 * the page), so what arrives is a few hundred KB and comfortably inside the
 * serverless body limit.
 */

import { AwsClient } from 'aws4fetch';
/* `frameKey` is NOT imported: this file only RE-EXPORTS it (below) and never calls
   it, and an import that exists solely to be forwarded is what the re-export line
   already does. The two that ARE imported are both called here — which is the other
   half of the rule in CLAUDE.md: `export { x } from './y'` does not bind x locally,
   so anything this file CALLS needs the import as well as the re-export. */
import { frameKeyAt, keyFromHash } from './frame-keys';
import { validCoords } from './exif';
import { hasKV, hasR2, kvConfig, r2Config, r2Endpoint } from './config';
import { presignedUrl } from './photos';
import { countCommands, timer, trace } from './trace';
import { WING_TZ, shiftDate, wingDate } from './kv';
import type { Who } from './together';

/* ============================================================================
   THE SHAPE
   ========================================================================= */

/** How many days the strip shows. Retention is separate — see the file header. */
export const FRAME_DAYS = 7;

/**
 * Caption cap.
 *
 * The same 200 as a song's note, and for the same reason: this is a line under a
 * picture, not a post. Anything that wants four hundred words wants the letters
 * page, which exists and is built for it.
 */
export const NOTE_MAX = 200;

/**
 * The most bytes an upload may be.
 *
 * FOUR megabytes, not the platform limit. Vercel's serverless request body caps
 * at 4.5MB and hitting a PLATFORM limit produces a failure this code never sees
 * and cannot explain — she would get an opaque 413 from infrastructure with no
 * sentence attached. Refusing at 4MB means the refusal is ours, so it can say
 * something true and suggest the fix.
 *
 * The page resizes before uploading, so a normal phone photograph arrives at
 * 200–500KB and never comes near this. This is the guard for the no-JavaScript
 * path, where the original 12-megapixel file is what gets sent.
 */
export const MAX_BYTES = 4 * 1024 * 1024;

/**
 * What an image may be, by SNIFFED magic number — never by declared type.
 *
 * `Content-Type` on a multipart part is a claim made by the client, and the
 * client is a phone browser at best and a script at worst. The bytes are the
 * fact. So the declared type is not consulted at all: the first bytes decide
 * both whether this is an image and what extension the key gets.
 *
 * GIF and AVIF are absent deliberately. GIF invites an animation, which is a
 * different feature; AVIF encodes beautifully and decodes inconsistently on the
 * older phones this has to work on. Three formats cover every camera either of
 * them owns.
 */
export const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type FrameType = (typeof ALLOWED)[number];

export interface Sniffed {
  type: FrameType;
  /** The extension the key gets. Server-derived, never from a filename. */
  ext: 'jpg' | 'png' | 'webp';
}

/**
 * What kind of image these bytes actually are, or null.
 *
 * Magic numbers only, and short ones — this is a format check, not a validator.
 * A file that passes here is still only "plausibly a JPEG"; what makes that safe
 * is that it is stored under a server-chosen key with a server-chosen
 * Content-Type and served from R2's origin rather than from this domain, so a
 * crafted payload has nowhere to execute.
 */
export function sniff(bytes: Uint8Array): Sniffed | null {
  if (bytes.length < 12) return null;

  // FF D8 FF — JPEG SOI, every variant.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { type: 'image/jpeg', ext: 'jpg' };
  }
  // 89 50 4E 47 0D 0A 1A 0A — the full PNG signature, all eight bytes. The
  // trailing CR/LF/EOF bytes exist to catch transfer corruption, so checking
  // only "\x89PNG" would accept a file the decoder then rejects.
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { type: 'image/png', ext: 'png' };
  }
  // RIFF....WEBP — a container check: bytes 0-3 'RIFF', bytes 8-11 'WEBP'. The
  // four bytes between are the length and are not part of the signature.
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { type: 'image/webp', ext: 'webp' };
  }
  return null;
}

/** One person's frame for one day, as STORED. */
export interface Frame {
  /** `jpg` | `png` | `webp`. Kept for the legacy key and for the export tool. */
  ext: string;
  /**
   * The R2 object key, READ FROM THE STORE RATHER THAN RECOMPUTED.
   *
   * IT USED TO BE DERIVED AT BOTH ENDS, AND THAT IS WHAT DESTROYED A PHOTOGRAPH.
   * putFrame() built `frames/<date>/<who>.<ext>` and withUrls() built the same
   * string again from the same three inputs — so the key was a pure function of
   * the day and the person, and a second upload on a day landed exactly on top of
   * the first one. R2 is unversioned, so "exactly on top of" means gone.
   *
   * Storing it inverts that: the hash now says WHERE the bytes are instead of the
   * reader guessing, which is what lets the write side move to a key nothing can
   * collide with (frameKeyAt) without the read side having to agree on a formula.
   *
   * '' is impossible on the way out — keyFromHash() falls back to the legacy
   * layout for the records written before this field existed, so a photograph
   * uploaded in August still resolves to the object it has always been at.
   */
  key: string;
  /**
   * PIXEL DIMENSIONS OF THE STORED IMAGE, or 0 0 when they were never recorded.
   *
   * These exist for ONE reason and it is not metadata: without them the page cannot
   * reserve space for the photograph, so `<img>` renders at zero height, the bytes
   * arrive from R2, the intrinsic size becomes known, and everything below jumps down
   * the page. That shift is what "the picture upload was jerky" turned out to be — the
   * song page never did it because a Spotify embed has a fixed height.
   *
   * The client resizer already knows them: it computed the canvas size, or it resolved
   * the original untouched and read naturalWidth/naturalHeight. They cost two integers
   * on a write that was happening anyway.
   *
   * ZERO IS A REAL AND PERMANENT STATE. Every photograph posted before this field
   * existed has none, and the no-JavaScript path has no way to measure an image before
   * sending it, so the page must render correctly without them rather than treating
   * them as guaranteed.
   */
  w: number;
  h: number;
  /** Epoch ms it was posted. Also the discriminator in the key. */
  atMs: number;
  /** Her or his words under it. '' when there are none, which is common. */
  note: string;
  /**
   * Where it was taken, in decimal degrees, or null — the ordinary answer, not a
   * failure.
   *
   * NUMBERS HERE RATHER THAN EXIF LEFT INSIDE THE FILE, for the map that is meant
   * to exist at the end of the long-distance stretch: a list of points is what a
   * map wants, and re-parsing every JPEG ever posted at that moment is not. The
   * client resizer also cannot preserve an EXIF block through its canvas
   * re-encode, so the page reads the coordinates off the ORIGINAL file and posts
   * them beside the bytes. exif.ts carries the whole argument.
   *
   * Both or neither. A latitude without a longitude is not half a location, it is
   * a bug — so a reader can test one field and trust the other.
   */
  lat: number | null;
  lon: number | null;
  /**
   * Where that is, as a short human label, or null.
   *
   * Resolved ONCE at upload and stored, never computed on render — a lookup per
   * render would disclose her location to a third party dozens of times a week for
   * a string that cannot change. place.ts carries the argument.
   *
   * Null is ordinary: no network at upload time, a rate limit, or nowhere named
   * nearby. The page falls back to the coordinates, so the pin never disappears.
   */
  place: string | null;
}

/** One day, both sides. Either may be absent. */
export interface DayFrames {
  /** `YYYY-MM-DD` in WING_TZ. */
  date: string;
  her: Frame | null;
  him: Frame | null;
}

/** A frame with a URL an <img> can actually load. */
export interface VisibleFrame extends Frame {
  /** A short-lived presigned GET. '' when R2 could not sign it. */
  url: string;
}

export interface VisibleDayFrames {
  date: string;
  her: VisibleFrame | null;
  him: VisibleFrame | null;
}

/* ============================================================================
   KEYS
   ========================================================================= */

/**
 * THE KEYS LIVE IN frame-keys.ts, AND THE REASON IS THE INCIDENT.
 *
 * Re-exported here so every existing caller is unchanged. They were moved out
 * because this module imports the R2 client, the Upstash config and the geocoder,
 * which meant the key arithmetic could not be exercised without credentials — and
 * the way this project last checked it was a real upload, which destroyed the only
 * copy of a real photograph. frame-keys.ts is pure and has no import that can
 * reach a bucket, so `npm run test:frames-key` proves the layout without being able
 * to write a byte.
 */
export { frameKey, frameKeyAt, keyFromHash } from './frame-keys';

/** `us:frame:` — distinct from us:song:, us:mark:, us:letter:, us:together:. */
const DAY_KEY = (date: string) => `us:frame:${date}`;

/* ============================================================================
   TIDYING
   ========================================================================= */

/**
 * A caption, safe to store.
 *
 * Newlines to spaces because this renders on one or two lines under a picture and
 * a pasted paragraph would break the grid. Control characters out. Truncated
 * rather than refused: a caption two characters over the cap is not worth an
 * error message.
 */
export function tidyNote(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length <= NOTE_MAX ? s : s.slice(0, NOTE_MAX).trimEnd();
}

/* ============================================================================
   THE STORE
   ========================================================================= */

const TIMEOUT_MS = 4000;

export class FramesError extends Error {}

export type Tier = 'upstash' | 'memory';

/** Metadata tier. Bytes are always R2 — there is no fallback for bytes. */
export function framesTier(): Tier {
  return hasKV() ? 'upstash' : 'memory';
}

/** Dev-only, and per-instance. See the header on why this is not a real tier. */
const memory = new Map<string, DayFrames>();

async function redis(cmds: (string | number)[][]): Promise<unknown[]> {
  const { url, token } = kvConfig();
  if (!url || !token) throw new FramesError('upstash is not configured');

  const t = timer();
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map((c) => c.map(String))),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new FramesError('upstash unreachable', { cause: err });
  }
  countCommands('frames', cmds.length, res.status, t.total());
  if (!res.ok) throw new FramesError(`upstash HTTP ${res.status}`);

  let parsed: Array<{ result?: unknown; error?: string }>;
  try {
    parsed = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  } catch (err) {
    throw new FramesError('upstash response was not JSON', { cause: err });
  }
  if (!Array.isArray(parsed) || parsed.length !== cmds.length) {
    throw new FramesError('upstash returned a malformed pipeline response');
  }
  return parsed.map((e, i) => {
    if (e?.error) throw new FramesError(`upstash ${String(cmds[i][0])} failed: ${e.error}`);
    return e?.result ?? null;
  });
}

/** Upstash returns a hash as a flat array. Folded here, once. */
function foldHash(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  }
  return out;
}

/* `date` is a parameter rather than something read off the hash, and that is the
   security-relevant half of keyFromHash(): the caller already knows which day it
   asked the store for, so a stored key is checked against that instead of against
   anything the hash claims about itself. */
/**
 * A stored dimension, or 0.
 *
 * Re-validated on the way OUT for the same reason coordinates are: the store is not a
 * validation boundary. These land in `width`/`height` attributes, so a NaN or a negative
 * would produce markup the browser silently ignores — which is the old behaviour wearing
 * a disguise, and much harder to notice than an obviously missing attribute.
 *
 * 20000 is a ceiling no phone camera approaches and no resized upload can reach; it is
 * here so a corrupted value cannot ask a browser to reserve a screen-height of blank.
 */
export function frameDim(raw: unknown): number {
  const n = Number(raw ?? 0);
  return Number.isInteger(n) && n > 0 && n <= 20000 ? n : 0;
}

function frameFrom(h: Record<string, string>, who: Who, date: string): Frame | null {
  const ext = h[`${who}Ext`] ?? '';
  if (!/^(jpg|png|webp)$/.test(ext)) return null;
  const atMs = Number(h[`${who}At`] ?? 0);
  /* Re-validated on the way OUT, not trusted as stored. These arrived from a
     phone through a form field, and the store is not a validation boundary — a pin
     in the Gulf of Guinea would be forever, so the check is on both sides. */
  const at = validCoords(h[`${who}Lat`], h[`${who}Lon`]);

  return {
    ext,
    key: keyFromHash(h, who, date, ext),
    /* BOTH OR NEITHER. A width without a height reserves nothing and would make the
       page emit one attribute, which browsers treat as no intrinsic ratio at all. */
    w: frameDim(h[`${who}W`]) && frameDim(h[`${who}H`]) ? frameDim(h[`${who}W`]) : 0,
    h: frameDim(h[`${who}W`]) && frameDim(h[`${who}H`]) ? frameDim(h[`${who}H`]) : 0,
    atMs: Number.isFinite(atMs) && atMs > 0 ? atMs : 0,
    note: h[`${who}Note`] ?? '',
    lat: at ? at.lat : null,
    lon: at ? at.lon : null,
    place: (h[`${who}Place`] ?? '') || null,
  };
}

/**
 * R2 client for the byte writes. Header-signed, same as kv.ts's document writes.
 *
 * Returns null rather than throwing when unconfigured, so callers decide whether
 * a missing bucket is fatal — for an upload it is; for a read it is a blank page
 * with an explanation.
 */
function r2(): { client: AwsClient; base: string } | null {
  if (!hasR2()) return null;
  const { accessKeyId, secretAccessKey, bucket } = r2Config();
  const endpoint = r2Endpoint();
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) return null;
  return {
    client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }),
    base: `${endpoint}/${bucket}`,
  };
}

/**
 * Store one frame: bytes to R2, then metadata to the day's hash.
 *
 * THE ORDER MATTERS AND IT IS BYTES FIRST. If the metadata write fails after the
 * bytes land, the result is an orphaned object in R2 that nothing points at —
 * invisible, harmless, and overwritten by her next attempt. If the metadata
 * landed first and the bytes failed, the page would say she posted a photograph
 * and render a broken image, which is a worse thing to show her than nothing.
 *
 * Overwriting is deliberate: a second upload on the same day REPLACES the first,
 * because "actually, this one" is the normal case and there is no version of this
 * feature where she wants a stack of nine attempts at Tuesday.
 */
export async function putFrame(input: {
  date: string;
  who: Who;
  bytes: Uint8Array;
  sniffed: Sniffed;
  note: string;
  atMs: number;
  /** Where it was taken, if the page or the server could work it out. */
  coords?: { lat: number; lon: number } | null;
  /** Pixel size, when the client could measure it. 0 means "not recorded". */
  dims?: { w: number; h: number } | null;
}): Promise<Frame> {
  const { date, who, bytes, sniffed, note, atMs, coords = null, dims = null } = input;

  /* THE TWO WRITES ARE TIMED SEPARATELY, because one number for both cannot be acted
     on. The endpoint reports a single `storeMs` and it covers an R2 PUT of up to four
     megabytes AND a two-command Upstash pipeline — a byte-proportional write to one
     vendor and a fixed tiny round trip to another, with different timeouts (15s and 4s),
     different failure modes and different fixes. `storeMs=1900` is unactionable;
     `r2Ms=1850 kvMs=50` says resize harder, and `r2Ms=60 kvMs=1840` says the metadata
     store is sick and the photograph was never the problem. */
  const t = timer();

  const bucket = r2();
  if (!bucket) throw new FramesError('r2 is not configured, so there is nowhere to put a photograph');

  /* UNIQUE PER UPLOAD, so this PUT cannot be landing on an existing photograph.
     Before frameKeyAt() this line built `frames/<date>/<who>.<ext>` and a second
     upload for a day overwrote the first — including, on 2026-08-24, the only copy
     of a real one. The millisecond removes the collision rather than documenting
     it; see frameKeyAt() for why the old object is deliberately left behind. */
  const key = frameKeyAt(date, who, sniffed.ext, atMs);

  let res: Response;
  try {
    res = await bucket.client.fetch(`${bucket.base}/${key}`, {
      method: 'PUT',
      headers: {
        // The SNIFFED type, never the declared one. This is the value R2 hands
        // back on the presigned GET, so it is what the browser will believe.
        'Content-Type': sniffed.type,
        // Nothing else may cache a private photograph.
        'Cache-Control': 'private, max-age=0, no-store',
      },
      /* An explicit ArrayBuffer slice rather than the Uint8Array itself. TS's
         BodyInit wants `Uint8Array<ArrayBuffer>` and a view read off a request
         body is `Uint8Array<ArrayBufferLike>`, which is not the same type; the
         slice also guarantees the bytes sent are exactly this view's range and
         not the whole backing buffer it may be a window onto. */
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new FramesError('r2 unreachable', { cause: err });
  }
  if (!res.ok) throw new FramesError(`r2 PUT HTTP ${res.status}`);
  const r2Ms = t.lap();

  const frame: Frame = {
    ext: sniffed.ext,
    /* The key the bytes actually went to, carried on the returned Frame rather than
       recomputed by the reader. This is also what the memory tier stores, so dev
       and production resolve a photograph the same way instead of only agreeing as
       long as two formulas match. */
    key,
    atMs,
    note,
    /* Validated here as well as on the way out, so a bad value never reaches the store
       in the first place — the read-side check is the backstop, not the only guard. */
    w: dims ? frameDim(dims.w) : 0,
    h: dims ? frameDim(dims.h) : 0,
    lat: coords ? coords.lat : null,
    lon: coords ? coords.lon : null,
    /* Resolved AFTER the bytes are safe, by the caller, and written separately —
       see setPlace(). A geocoder must never sit between her and a saved
       photograph. */
    place: null,
  };

  if (!hasKV()) {
    // Dev without Upstash. The bytes are safely in R2 either way.
    const day = memory.get(date) ?? { date, her: null, him: null };
    day[who] = frame;
    memory.set(date, day);
    /* `tier` is on the line rather than assumed, because the two tiers make the SAME
       upload cost wildly different amounts of time and a reader comparing two log lines
       has no other way to know which one they are looking at. */
    trace('frame.store', { who, bytes: bytes.byteLength, r2Ms, tier: 'memory' });
    return frame;
  }

  /* HSET of that person's fields only — never a whole-object write. Both of them
     posting within the same second is the case this feature is designed to
     produce, and a read-modify-write would make one of the two disappear. */
  /* THE COORDINATES ARE ONLY WRITTEN WHEN THERE ARE COORDINATES — AND THEIR
     ABSENCE IS AN EXPLICIT DELETE, not an omission.

     Posting again the same day overwrites the first photograph; that is the "swap
     it for another one" affordance. If the replacement has no location — a
     screenshot, or Location Services off that afternoon — an HSET that merely
     omitted the two fields would leave the FIRST photograph's coordinates attached
     to the second one. That is a confidently wrong pin rather than a missing one,
     and on a map a wrong point is worse than a gap. So the empty case deletes the
     pair, in the same pipeline as the write. */
  /* `<who>Key` rides in the HSET that was already being sent, so recording WHERE the
     bytes went costs no extra Upstash command — the whole change is one more field
     on one existing write. It is also what makes the swap non-destructive end to
     end: the bytes go to a new key and this pipeline moves the pointer, so the
     previous photograph is unreferenced rather than gone. */
  const fields: (string | number)[] = [
    'HSET',
    DAY_KEY(date),
    `${who}Ext`, frame.ext,
    `${who}Key`, frame.key,
    `${who}At`, String(frame.atMs),
    `${who}Note`, frame.note,
  ];
  if (frame.lat !== null && frame.lon !== null) {
    fields.push(`${who}Lat`, String(frame.lat), `${who}Lon`, String(frame.lon));
    /* The OLD place is deleted in the same pipeline. A new photograph has new
       coordinates, and leaving yesterday's label attached while the new one is
       resolved would show a confidently wrong place for a few seconds — or forever,
       if the lookup then fails. */
    await redis([fields, ['HDEL', DAY_KEY(date), `${who}Place`]]);
  } else {
    await redis([fields, ['HDEL', DAY_KEY(date), `${who}Lat`, `${who}Lon`, `${who}Place`]]);
  }
  /* Only on the way out, so a thrown FramesError leaves this line ABSENT rather than
     misleading — the endpoint already reports that failure as `code=store`, and a
     half-written timing would look like a write that happened. */
  trace('frame.store', { who, bytes: bytes.byteLength, r2Ms, kvMs: t.lap(), tier: 'upstash' });
  return frame;
}

/**
 * The last `days` days, newest first, today always present.
 *
 * One pipelined read for the whole window. Days with nothing in them come back as
 * a record with both sides null rather than being omitted, because the page draws
 * a row per day and a missing Wednesday should read as "neither of us posted"
 * rather than as Wednesday not existing.
 */
export async function getDays(
  today: string = wingDate(),
  days: number = FRAME_DAYS,
): Promise<DayFrames[]> {
  const dates: string[] = [];
  for (let i = 0; i < Math.max(1, days); i += 1) dates.push(shiftDate(today, -i));

  if (!hasKV()) {
    return dates.map((d) => memory.get(d) ?? { date: d, her: null, him: null });
  }

  const out = await redis(dates.map((d) => ['HGETALL', DAY_KEY(d)]));
  return dates.map((date, i) => {
    const h = foldHash(out[i]);
    return { date, her: frameFrom(h, 'her', date), him: frameFrom(h, 'him', date) };
  });
}

/** As above, but never throws — a dead store costs the strip, not the page. */
export async function getDaysSafe(
  today: string = wingDate(),
  days: number = FRAME_DAYS,
): Promise<{ days: DayFrames[]; reachable: boolean }> {
  try {
    return { days: await getDays(today, days), reachable: true };
  } catch (err) {
    console.error('[us] frames store unreachable:', err instanceof Error ? err.message : err);
    const dates: string[] = [];
    for (let i = 0; i < Math.max(1, days); i += 1) dates.push(shiftDate(today, -i));
    return { days: dates.map((d) => ({ date: d, her: null, him: null })), reachable: false };
  }
}

/**
 * Attach a resolved place label to a frame that is already saved.
 *
 * SEPARATE FROM putFrame ON PURPOSE. The geocoder is a third-party network call and
 * putFrame's job is to get her photograph durable; putting a lookup on that path
 * would mean a slow Nominatim is a slow upload, and a dead one is a failed upload.
 * So the bytes land first and the label arrives a moment later.
 *
 * Never throws, and returns nothing worth checking: a missing label is a pin that
 * shows coordinates instead, which is a state the page already renders.
 */
export async function setPlace(date: string, who: Who, place: string): Promise<void> {
  const label = place.trim().slice(0, 80);
  if (!label) return;
  try {
    if (!hasKV()) {
      const day = memory.get(date);
      const f = day?.[who];
      if (f) f.place = label;
      return;
    }
    await redis([['HSET', DAY_KEY(date), `${who}Place`, label]]);
  } catch (err) {
    console.error('[us] could not store a place label:', err instanceof Error ? err.message : err);
  }
}

/**
 * Turn stored frames into ones with loadable URLs.
 *
 * Signing is per object and the URLs are short-lived — see PRESIGN_BUCKET_SEC in
 * photos.ts for why they are bucketed to a fifteen-minute boundary, which is what
 * lets a browser reuse a cached image between two renders of this page instead of
 * re-downloading every photograph on every visit.
 */
export async function withUrls(days: DayFrames[]): Promise<VisibleDayFrames[]> {
  const jobs: Array<Promise<void>> = [];
  const out: VisibleDayFrames[] = days.map((d) => ({ date: d.date, her: null, him: null }));

  days.forEach((day, i) => {
    (['her', 'him'] as const).forEach((who) => {
      const f = day[who];
      if (!f) return;
      jobs.push(
        /* f.key, NOT frameKey(...) — this call site recomputing the key from the day
           and the person is the other half of what made an overwrite possible, and
           it would now sign the wrong object for every new upload. keyFromHash() has
           already decided which layout this record uses and validated it. */
        presignedUrl(f.key)
          .then((url) => {
            out[i][who] = { ...f, url: url ?? '' };
          })
          .catch(() => {
            // A signing failure costs one picture, not the page.
            out[i][who] = { ...f, url: '' };
          }),
      );
    });
  });

  await Promise.all(jobs);
  return out;
}

/** Is this feature usable at all? Bytes have no fallback. */
export function framesAvailable(): boolean {
  return hasR2();
}

/** Dev-only reset, so tests do not leak state between cases. */
export function __resetMemory(): void {
  memory.clear();
}

/** Re-exported so pages need one import for the day arithmetic. */
export { WING_TZ, shiftDate };
