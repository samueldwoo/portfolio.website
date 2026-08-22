/**
 * photos.ts — the memory manifest, and the only place a photo URL is minted.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS COMMITTED TO A PUBLIC REPO
 *
 * So it holds object KEYS, CAPTIONS and LAYOUT and nothing else. No bytes, no
 * bucket credentials, no anything that would embarrass either of us if a
 * stranger read it — which a stranger can, at any time, from the GitHub API
 * (verified: unauthenticated request → 200. See PLAN.md R1).
 *
 * ---------------------------------------------------------------------------
 * THE CAPTION CONVENTION: A SQUARE BRACKET MEANS "SAM, THIS IS YOURS"
 *
 * Every caption and note below is wrapped in [square brackets], and that is the
 * only signal that matters in this file. It is not decoration and it is not a
 * style — it is the thing that makes a placeholder impossible to mistake for
 * content, and it is why they can afford to be evocative.
 *
 * The previous set was NOT bracketed, and that was the actual bug: lines like
 * "somewhere with bad coffee" and "the kitchen, 1am" read as REAL captions for
 * memories that do not exist. They looked finished. A room full of plausible
 * invented specifics is the single easiest thing to ship by accident, because
 * nothing about it looks wrong — and worse, it puts words in her mouth and mine
 * about a relationship neither of us described that way.
 *
 * So each caption now names the SLOT rather than inventing the memory: it says
 * what KIND of photograph belongs there, in Sam's own second person, as a
 * directive he can either follow or ignore. Brackets everywhere also match the
 * wing's `[us]` lockup, so a half-finished room still looks deliberate.
 *
 * THREE RULES IF YOU EDIT THESE:
 *   1. Keep the brackets until the line is real. Dropping them is how you say
 *      "this one is finished".
 *   2. Never invent a specific. No named places, no dates, no quoted speech, no
 *      claims about what either of them did. A slot description is honest; a
 *      fabricated memory is not.
 *   3. `note` is what she reaches at MAX TENSION, and every one of them says the
 *      word "replace" out loud, because that is the field most likely to ship
 *      unedited — it is hidden behind a gesture, so nobody sees it in review.
 * ---------------------------------------------------------------------------
 * TWO MODES, AND WHY THE SECOND ONE EXISTS
 *
 * `hasR2()` true  → a photo URL is a SigV4 presigned GET against a PRIVATE R2
 *                   bucket, valid for five minutes, minted only after
 *                   /api/us/photo/[id] has verified the session cookie.
 *
 * `hasR2()` false → `placeholderSvg()` generates a labelled concrete-and-blue
 *                   card per memory. The whole room is then demoable, and
 *                   reviewable, with no Cloudflare account in existence. This
 *                   is not a nicety: a three.js room that cannot be looked at
 *                   until credentials arrive is a room that gets reviewed once,
 *                   badly, on the day it ships.
 *
 * Both modes are consumed through the SAME endpoint, so the client never
 * branches on configuration and the degraded path is exercised on every local
 * run rather than rotting.
 * ---------------------------------------------------------------------------
 */

import { AwsClient } from 'aws4fetch';
import { hasR2, r2Config, r2Endpoint } from './config';

/* ===========================================================================
   CHAPTERS — solidcore's real MUSCLE GROUPINGS, used as navigation.

   These are the four filter tabs on solidcore's own /exercises page — "Center
   core", "Lower body", "Obliques", "Upper body" — and every exercise they
   publish is filed under one of them.

   They replaced the class formats (starter50 / focus50 / signature50 /
   advanced65) deliberately. A format name describes how LONG a class is and how
   hard; a muscle grouping describes what the work is ABOUT. For a room whose
   chapters are meant to mean something — how we started, the funny sideways
   ones, the long-distance stretch — "what this is about" is the axis that
   carries a memory, and "50 minutes vs 65 minutes" is not.

   It also reads better out loud. `line 03 · obliques` is a section of a room.
   `line 03 · signature50` is a booking confirmation.

   `line` is the carriage line (1–4). The real machine has numbered position
   lines on the rail; the room borrows them as its progress indicator, which is
   why this is a small integer and not a percentage.
   =========================================================================== */

export type ChapterId = 'core' | 'lower' | 'obliques' | 'upper';

export interface Chapter {
  id: ChapterId;
  /** Carriage line 1–4. Doubles as the display number and the sort order. */
  line: 1 | 2 | 3 | 4;
  /** The muscle grouping, spelled the way solidcore spells it. */
  label: string;
  /** One line of what this stretch of the rail is about. */
  blurb: string;
}

export const CHAPTERS: readonly Chapter[] = [
  /* Their class structure opens with a core-activation warm-up, so core is
     line 1 — the panel the room opens on, dead centre and low-lit. */
  { id: 'core', line: 1, label: 'center core', blurb: 'how we started' },
  { id: 'lower', line: 2, label: 'lower body', blurb: 'everywhere we went' },
  { id: 'obliques', line: 3, label: 'obliques', blurb: 'the sideways ones' },
  { id: 'upper', line: 4, label: 'upper body', blurb: 'the long-distance one' },
] as const;

/* ===========================================================================
   MEMORIES
   =========================================================================== */

export interface Memory {
  /**
   * Stable public id. This is the ONLY thing a URL is allowed to contain, and
   * it is matched against this list exactly — see findMemory(). Constrained to
   * [a-z0-9-] so that even a bug cannot turn it into a path segment.
   */
  id: string;
  /**
   * R2 object key, relative to the bucket root. Never built from user input,
   * never concatenated with anything a caller supplied. If you find yourself
   * writing `key: \`photos/${something}\`` at request time, stop: that is the
   * arbitrary-object-read bug this indirection exists to prevent.
   */
  key: string;
  /** Shown on the panel and in the fallback grid. */
  caption: string;
  /**
   * The hidden note, revealed at MAX TENSION.
   *
   * This ships to the browser with the page. That is deliberate and it is not a
   * leak: the entire page is behind the session cookie, and the reveal has to
   * be instant at the top of the meter — a fetch at that moment would put a
   * network round-trip in the middle of the one beat the interaction exists
   * for. It is hidden from HER for thirty seconds, not from an attacker.
   */
  note: string;
  chapter: ChapterId;
  /**
   * OPTIONAL, and free text. "last spring", "that tuesday", "somewhere in the
   * middle of august" — or omitted entirely.
   *
   * This replaced a `monthIndex: number` that derived a strict `MMM YYYY` label
   * off a single MONTH_ZERO constant, which turned the room into a calendar:
   * exactly twelve panels, one per month, each stamped with a date. Sam asked
   * for casual and less structured, and he is right — a filing system is the
   * wrong frame for this. A memory is allowed to be "that weekend" or to carry
   * no date at all, and the room should not imply a gap where a month has no
   * photograph. Nothing is derived from this and nothing validates it.
   */
  when?: string;
  /**
   * Width / height HINT, used to lay the panel out before its bytes arrive and
   * to shape the placeholder card.
   *
   * Only a hint: StudioRoom re-derives the true aspect from the decoded image
   * and rescales the panel, so a stale value here cannot stretch a photo. That
   * matters because this number would otherwise be a silent footgun — a field
   * in a manifest that must be kept in sync by hand with a file in a bucket.
   */
  aspect: number;
  /**
   * "still one more." The panel past the apparent end of the rail. Unlit and
   * unloaded until the carriage reaches max extension.
   */
  hidden?: true;
}

/**
 * The memories, in the order the carriage meets them, plus one past the end.
 *
 * There is no required count and no required cadence — add or remove freely.
 * `when` is optional free text, not a date.
 *
 * Keys are `photos/mNN.webp`, and the prefix is not a free choice: it is the one
 * the upload script writes to. Aligning on it here means `npm run photos:push`
 * and this manifest agree with no translation layer and no second place to keep
 * in step — the class of mismatch that produces thirteen 404s and a room full of
 * broken images.
 *
 * Each also has an `@sm` sibling (`photos/m01@sm.webp`) produced by the same
 * script; see smallKey() and resolvePhotoUrl(), which prefer it on phones.
 *
 * WebP because these are photographs going over a phone connection; a 1600px
 * WebP is ~120KB where the JPEG is ~400KB.
 */
export const MEMORIES: readonly Memory[] = [
  /* ---- WARM-UP / CORE ACTIVATION -----------------------------------------
     One panel, dead centre, low light, before the room widens into chapters.
     This is the first thing she sees, so it is the one caption worth writing
     first — and the one placeholder it would be most embarrassing to ship. */
  {
    id: 'm01',
    key: 'photos/m01.webp',
    caption: '[the earliest one of us you still have]',
    note: '[replace this note. she reaches it at max tension and nowhere else, so it is the one nobody catches in review. two sentences, in your voice, about why this is the one that opens the room.]',
    chapter: 'core',
    when: '[when it started]',
    aspect: 0.8,
  },
  {
    id: 'm02',
    key: 'photos/m02.webp',
    caption: '[the one she would delete and you never will]',
    note: '[replace this note. tell her why you kept it.]',
    chapter: 'core',
    when: '[roughly when]',
    aspect: 1.5,
  },
  {
    id: 'm03',
    key: 'photos/m03.webp',
    /* `when` deliberately omitted on this one and several below. It is optional
       free text, and leaving some blank is how the room demonstrates that a
       memory is allowed to carry no date at all — which is the whole reason the
       monthly calendar was torn out. */
    caption: '[one where neither of you is looking at the camera]',
    note: '[replace this note.]',
    chapter: 'core',
    aspect: 0.8,
  },
  /* ---- LINE 02 - LOWER BODY - everywhere we went ------------------------- */
  {
    id: 'm04',
    key: 'photos/m04.webp',
    caption: '[somewhere the two of you went together]',
    note: '[replace this note.]',
    chapter: 'lower',
    when: '[a trip]',
    aspect: 1.0,
  },
  {
    id: 'm05',
    key: 'photos/m05.webp',
    caption: '[an ordinary evening that turned out to matter]',
    note: '[replace this note.]',
    chapter: 'lower',
    aspect: 1.5,
  },
  {
    id: 'm06',
    key: 'photos/m06.webp',
    caption: '[her, mid-laugh, at something off-frame]',
    note: '[replace this note. you are the only person who knows what was off-frame.]',
    chapter: 'lower',
    aspect: 0.8,
  },
  /* ---- LINE 03 - OBLIQUES - the sideways ones ---------------------------- */
  {
    id: 'm07',
    key: 'photos/m07.webp',
    caption: '[the one where something went wrong and it was fine]',
    note: '[replace this note.]',
    chapter: 'obliques',
    aspect: 0.8,
  },
  {
    id: 'm08',
    key: 'photos/m08.webp',
    caption: '[not a photograph of either of you]',
    note: '[replace this note. a room of faces needs one thing in it that is not a face.]',
    chapter: 'obliques',
    aspect: 1.5,
  },
  {
    id: 'm09',
    key: 'photos/m09.webp',
    caption: '[the least remarkable day you would both go back to]',
    note: '[replace this note.]',
    chapter: 'obliques',
    when: '[a weekday]',
    aspect: 1.0,
  },
  /* ---- LINE 04 - UPPER BODY - the long-distance one ---------------------- */
  {
    id: 'm10',
    key: 'photos/m10.webp',
    caption: '[a goodbye, or the hour before one]',
    note: '[replace this note.]',
    chapter: 'upper',
    aspect: 0.8,
  },
  {
    id: 'm11',
    key: 'photos/m11.webp',
    caption: '[a screen, a distance, a bad connection]',
    note: '[replace this note. the year of long distance gets at least one honest picture.]',
    chapter: 'upper',
    when: '[this year, somewhere]',
    aspect: 1.5,
  },
  {
    id: 'm12',
    key: 'photos/m12.webp',
    caption: '[the most recent one of the two of you]',
    note: '[replace this note. this is the last one on the rail before the room gives her one more.]',
    chapter: 'upper',
    when: '[recently]',
    aspect: 0.8,
  },
  /* ---- "still one more." -------------------------------------------------
     Past the apparent end of the rail, and it comes to HER rather than asking
     for travel the machine has already said it will not give. Whatever goes here
     is the last thing she sees, so it should be the one you would have put
     first. */
  {
    id: 'still-one-more',
    key: 'photos/still-one-more.webp',
    caption: '[still one more - put the best one here]',
    note: '[replace this note. she only reaches this panel by scrolling to the very end, or by holding the + in the index. it is the one place in the room where being thorough is rewarded, so make it worth it.]',
    chapter: 'upper',
    aspect: 1.0,
    hidden: true,
  },
] as const;

/* ===========================================================================
   LOOKUP AND VALIDATION

   Everything a request can touch goes through here.
   =========================================================================== */

/**
 * The shape an id is allowed to have.
 *
 * This is belt-and-braces on top of findMemory()'s exact-match lookup, and the
 * reason it exists anyway is that a regex is a claim a reader can check in one
 * second, whereas "it must be in the array" requires trusting every future edit
 * to the array. No dots, no slashes: nothing that could ever be a path.
 */
const ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The shape a KEY is allowed to have, checked at mint time rather than trusted.
 *
 * A key with `..` or a leading `/` would be a traversal against the bucket, so
 * those are out. But the character set is narrow for a second, less obvious
 * reason, and it is worth writing down because widening it carelessly produces a
 * 403 that looks like a credentials problem:
 *
 *   SigV4 signs a CANONICAL path, and the signature only verifies if the client's
 *   canonicalisation matches the server's. aws4fetch canonicalises with
 *   `encodeURIComponent`; AWS's UriEncode leaves only `A-Za-z0-9-_.~` alone. The
 *   two AGREE on `@` (both -> %40) and on space (both -> %20), and DISAGREE on
 *   `!'()*` — which encodeURIComponent leaves literal and AWS escapes. A key
 *   containing a bracket would therefore be signed one way and read another.
 *
 *   `+` is excluded for a third reason: aws4fetch maps `+` to a space for s3
 *   before canonicalising (aws4fetch.esm.mjs, the `replace(/\+/g, ' ')`), so a
 *   key with a plus in it silently addresses a different object.
 *
 * `@` is in the set on purpose — the upload script's small variants are
 * `<stem>@sm.webp`.
 */
const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._~/@-]{0,255}$/;

/**
 * Key -> the path to actually put in the URL.
 *
 * Per SEGMENT, so `/` survives as a path separator. This is not cosmetic: a
 * literal `@` in the URL is signed as `%40` by aws4fetch's canonicaliser while
 * the request goes out with the raw `@`, and the two disagreeing is a
 * SignatureDoesNotMatch. Verified both ways — with a literal `@` the canonical
 * path is `/bucket/photos/m01%40sm.webp` against a sent path of
 * `/bucket/photos/m01@sm.webp`; pre-encoding makes them identical. Every `@sm`
 * request would have been a 403 without this.
 */
function encodeKeyForUrl(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * Resolve an id to a memory, or null.
 *
 * An EXACT match against the manifest is the whole security property of the
 * photo endpoint: a user-supplied string is used to *select* a key, never to
 * *build* one. `?id=../../.env` cannot select anything, so it 404s like any
 * other unknown id.
 */
export function findMemory(id: unknown): Memory | null {
  if (typeof id !== 'string' || !ID_SHAPE.test(id)) return null;
  return MEMORIES.find((m) => m.id === id) ?? null;
}

/** Chapter record for a memory. Falls back to line 1 rather than throwing. */
export function chapterOf(m: Memory): Chapter {
  return CHAPTERS.find((c) => c.id === m.chapter) ?? CHAPTERS[0];
}


/* ===========================================================================
   PLACEHOLDERS — the room, with no Cloudflare account
   =========================================================================== */

/** Minimal XML escaping. Captions are ours, but a stray `&` should not break the doc. */
function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A generated stand-in card for one memory.
 *
 * Concrete and blue ONLY, and that is the point: a placeholder must never be
 * mistaken for a photo. The moment one of these looks warm and photographic,
 * somebody ships the room with twelve fake memories in it.
 *
 * Rendering notes that are load-bearing, not decoration:
 *  - `width`/`height` are set on the root element as well as `viewBox`. An SVG
 *    with only a viewBox has no intrinsic size, and an intrinsically-sizeless
 *    SVG loaded through `<img>` decodes to a 0×0 image in some engines — which
 *    in WebGL is a silently black panel rather than an error.
 *  - No external references of any kind (no <image>, no @font-face, no CSS
 *    import). An SVG that fetches a subresource is not usable as a WebGL
 *    texture: the image never becomes CORS-clean and texImage2D throws.
 *  - Deterministic per memory, so panels are visually distinguishable while the
 *    room is being reviewed. The variation is a walk along the concrete ramp,
 *    never a hue shift out of the palette.
 */
export function placeholderSvg(m: Memory): string {
  const H = 1000;
  const W = Math.max(200, Math.round(H * m.aspect));

  // Deterministic, from the id. Not random: a placeholder that changes on every
  // request makes texture caching and visual diffing both meaningless.
  let seed = 0;
  for (let i = 0; i < m.id.length; i += 1) seed = (seed * 31 + m.id.charCodeAt(i)) | 0;
  const pick = (n: number) => Math.abs(seed >> (n * 3)) % 100;

  const concrete = ['#2a2c31', '#33353b', '#3d3f45', '#4a4c52'];
  const band = concrete[pick(1) % concrete.length];
  const band2 = concrete[pick(2) % concrete.length];
  const barY = 0.30 + (pick(3) / 100) * 0.34;
  const ch = chapterOf(m);

  // `when` is optional now, so the placeholder falls back to the chapter rather
  // than inventing a date. Never shows an empty strip where a label used to be.
  const label = m.hidden ? 'still one more' : (m.when || ch.label).toUpperCase();
  const line = `line 0${ch.line} · ${ch.label}`;

  // Type sizes are in user units against a 1000-unit tall box, so they scale
  // with the panel rather than with the viewport.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#0e0f12"/>
<rect x="0" y="${Math.round(H * barY)}" width="${W}" height="${Math.round(H * 0.11)}" fill="${band}"/>
<rect x="0" y="${Math.round(H * (barY + 0.13))}" width="${Math.round(W * 0.62)}" height="${Math.round(H * 0.035)}" fill="${band2}"/>
<rect x="0" y="0" width="${W}" height="6" fill="#3e7bff"/>
<rect x="0" y="${H - 6}" width="${W}" height="6" fill="#1e3ae0"/>
<text x="46" y="104" font-family="monospace" font-size="46" letter-spacing="6" fill="#3e7bff">${xml(label)}</text>
<text x="46" y="164" font-family="monospace" font-size="30" letter-spacing="4" fill="#6e7075">${xml(line)}</text>
<text x="46" y="${H - 116}" font-family="monospace" font-size="34" letter-spacing="3" fill="#9a9ca1">PLACEHOLDER</text>
<text x="46" y="${H - 66}" font-family="monospace" font-size="26" letter-spacing="2" fill="#4a4c52">${xml(m.key)}</text>
</svg>`;
}

/**
 * The same card as a data: URL, for the static fallback grid and for the
 * island's error path.
 *
 * `encodeURIComponent`, not base64: it keeps the markup readable in devtools
 * and it is the only one of the two that reliably escapes `#`, which appears in
 * every colour literal above and would otherwise terminate the URL at the first
 * fill attribute.
 */
export function placeholderDataUrl(m: Memory): string {
  return `data:image/svg+xml,${encodeURIComponent(placeholderSvg(m))}`;
}

/* ===========================================================================
   PRESIGNING
   =========================================================================== */

/* ---------------------------------------------------------------------------
   WHY THE URL IS STABLE, AND NOT UNIQUE PER REQUEST

   The obvious implementation — sign with `new Date()` on every request, expire
   in five minutes — has a bug that only shows up on a phone. SigV4 puts the
   signing timestamp and the signature IN THE QUERY STRING, so a fresh signature
   means a different URL, and a different URL means the HTTP cache has never
   seen it. Every single page view would re-download all thirteen photographs
   over her mobile data, and bill Cloudflare a Class B operation for each one.
   The room would feel slow for a reason that has nothing to do with three.js.

   So the signing timestamp is FLOORED to a bucket. Every request inside the
   same 15-minute window produces a byte-identical URL, which the browser cache
   can hit; the credential still genuinely expires.

   Floored, never rounded to nearest — rounding could produce a timestamp in the
   future, and a presigned URL is not valid before its X-Amz-Date. And the TTL
   is four times the bucket width, so the URL handed out in the last second of a
   bucket still has 45 minutes of life. A TTL shorter than the bucket would mint
   URLs that were already dead, intermittently, which is the worst kind of bug.

   THE TRADE-OFF, WRITTEN DOWN RATHER THAN LEFT IMPLICIT

   A stable URL is replayable by anyone who obtains it, for up to an hour,
   instead of for a few minutes. That is a real reduction in the strength of R5
   and it is accepted deliberately: PLAN.md §2 already declares that this design
   is "not resistant to her choosing to share it", and the threat model is
   crawlers and randoms, not somebody she forwarded a link to. What the presign
   still buys — and what actually matters — is that the URL cannot be GUESSED,
   cannot be found by enumerating a bucket, and does not work at all for anyone
   who never presented the session cookie. Those properties are unchanged.

   If that ever stops being acceptable, the lever is PRESIGN_BUCKET_SEC: set it
   to 0 and every URL becomes unique and short-lived again, at the cost of the
   cache.
   --------------------------------------------------------------------------- */

/**
 * How wide a signing bucket is. Every request in the same bucket gets the same
 * URL. 0 disables bucketing entirely (unique URL per request).
 */
export const PRESIGN_BUCKET_SEC = 900;

/**
 * Lifetime of a signed URL. Must comfortably exceed PRESIGN_BUCKET_SEC — see
 * above. One hour against a 15-minute bucket leaves a 45-minute floor.
 */
export const PRESIGN_TTL_SEC = 3600;

/**
 * SigV4 `X-Amz-Date` for the bucket containing `nowMs`.
 *
 * Format is the compact ISO-8601 basic form AWS requires (`20240821T153000Z`),
 * produced the same way aws4fetch produces it internally so the two agree
 * exactly. Exported because it is the one piece of this that is worth asserting
 * in a test: that it is monotonic, that it is stable across a bucket, and that
 * it never lands in the future.
 */
export function signingDatetime(nowMs: number, bucketSec = PRESIGN_BUCKET_SEC): string {
  const bucketMs = Math.max(0, Math.floor(bucketSec)) * 1000;
  // Math.floor, not Math.round: a timestamp in the future is not yet valid, so
  // rounding up would mint URLs that 403 until the clock caught up.
  const floored = bucketMs > 0 ? Math.floor(nowMs / bucketMs) * bucketMs : nowMs;
  return new Date(floored).toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * One client, reused.
 *
 * AwsClient keeps a Map of derived SigV4 signing keys, and deriving one is four
 * chained HMACs. On a warm serverless instance serving thirteen panels for one
 * page view, reusing the instance turns 52 HMACs into 4. It holds no per-request
 * state, so sharing it is safe.
 */
let cachedClient: AwsClient | null = null;
let cachedKeyId: string | null = null;

function client(): AwsClient | null {
  const { accessKeyId, secretAccessKey } = r2Config();
  if (!accessKeyId || !secretAccessKey) return null;
  // Rebuild if the credential rotated under us (a redeploy with new env vars
  // can reuse a warm instance).
  if (!cachedClient || cachedKeyId !== accessKeyId) {
    cachedClient = new AwsClient({
      accessKeyId,
      secretAccessKey,
      // Passed explicitly even though aws4fetch does recognise
      // `*.r2.cloudflarestorage.com` and guess ['s3', 'auto'] itself
      // (node_modules/aws4fetch/dist/aws4fetch.esm.mjs:251). Relying on a
      // hostname sniff for the two values that go into the credential scope is
      // a silent 403 waiting for the day that heuristic changes.
      service: 's3',
      region: 'auto',
    });
    cachedKeyId = accessKeyId;
  }
  return cachedClient;
}

/**
 * A presigned GET for one object key, or null if R2 is not configured.
 *
 * Query-signed (`signQuery: true`) rather than header-signed, because the whole
 * point is a URL an `<img>` can load with no cooperation from the client.
 *
 * `nowMs` is injectable purely so the bucketing behaviour can be asserted
 * without waiting fifteen minutes.
 */
export async function presignedUrl(
  key: string,
  ttlSeconds = PRESIGN_TTL_SEC,
  nowMs = Date.now(),
): Promise<string | null> {
  if (!hasR2()) return null;

  if (!KEY_SHAPE.test(key)) {
    // A manifest bug, not a request bug. Loud, because the symptom otherwise is
    // one mysteriously black panel.
    console.error(`[us] refusing to sign a malformed object key: ${JSON.stringify(key)}`);
    return null;
  }

  const endpoint = r2Endpoint();
  const { bucket } = r2Config();
  const aws = client();
  if (!endpoint || !bucket || !aws) return null;

  // Path-style: R2's S3 endpoint is `<account>.r2.cloudflarestorage.com` and the
  // bucket is the first path segment. Virtual-host style is not offered here.
  // encodeKeyForUrl, not the raw key — see that function for the 403 it prevents.
  const url = new URL(`${endpoint}/${bucket}/${encodeKeyForUrl(key)}`);
  // Set BEFORE signing: aws4fetch signs whatever query is present and defaults
  // s3 to X-Amz-Expires=86400 if we do not say otherwise
  // (aws4fetch.esm.mjs:118). A 24-hour photo URL is exactly the leak PLAN.md R5
  // says this design does not have.
  const ttl = Math.max(1, Math.floor(ttlSeconds));
  url.searchParams.set('X-Amz-Expires', String(ttl));

  const signed = await aws.sign(url.toString(), {
    method: 'GET',
    aws: {
      signQuery: true,
      // The bucketed timestamp. This is the ONE input that decides whether the
      // resulting URL is cacheable; see the long comment above PRESIGN_BUCKET_SEC.
      datetime: signingDatetime(nowMs),
    },
  });
  return signed.url;
}

/* ===========================================================================
   DOES THE OBJECT ACTUALLY EXIST?

   ---------------------------------------------------------------------------
   THE CONFIGURATION CLIFF THIS EXISTS TO REMOVE

   `hasR2()` answers "are there credentials", which is not the same question as
   "are there photographs". The moment the bucket was created and the credentials
   were wired up, hasR2() went true, every request started returning a perfectly
   valid presigned URL for an object that did not exist yet, and the room filled
   with broken images. Adding configuration made it STRICTLY WORSE than having
   none — which is the worst shape a config switch can have, because the
   degradation is invisible until you look at the page.

   So: confirm the key is really there before handing out a URL for it, and fall
   back to the generated placeholder card when it is not. The room then looks
   right at every stage — placeholders today with an empty bucket, real
   photographs as they land, and not one line of code changed in between.
   ---------------------------------------------------------------------------
   WHY THIS IS CHEAP

   A signed HEAD is a Class B operation, and doing one per photo per page view
   would be thirteen of them every time she opens the room. So results are cached
   in-process, which on a warm lambda makes it roughly one HEAD per object per
   instance. Positives are cached for a long time (an uploaded photo does not
   un-upload) and NEGATIVES for ninety seconds, which is the whole reason the
   negative TTL is short: it means a freshly pushed photograph starts appearing
   on its own, with no redeploy and nothing to remember.
   ---------------------------------------------------------------------------
   WHY IT FAILS TOWARD SHOWING THE PHOTO

   Every ambiguous answer — a 5xx, a throttle, a network error, a 403 — resolves
   to "presign it anyway". Only an explicit 404 counts as missing. That asymmetry
   is deliberate: the cost of a false "missing" is that a real memory silently
   turns into a grey placeholder card, which is much worse than the cost of a
   false "exists", which is one broken image. In particular 403 is NOT treated as
   missing, even though S3 returns it for a missing key when the credential lacks
   ListBucket — because it is also what a token with the wrong scope returns for
   an object that is right there.
   =========================================================================== */

/**
 * Hard deadline on one existence check.
 *
 * Thirteen of these run per cold page view, and they are on the critical path to
 * the first photograph appearing. Better to give up, presign optimistically, and
 * let the browser show a broken image than to hold the whole room hostage to a
 * slow bucket.
 */
const HEAD_TIMEOUT_MS = 2500;

/** How long a confirmed-present object stays confirmed. */
const EXISTS_TTL_MS = 10 * 60 * 1000;
/** How long a confirmed-absent object stays absent. Short, on purpose. */
const MISSING_TTL_MS = 90 * 1000;

const existence = new Map<string, { exists: boolean; at: number }>();

/** Only ever called with keys from the manifest, so this cannot grow unbounded. */
async function objectExists(key: string): Promise<boolean> {
  const now = Date.now();
  const cached = existence.get(key);
  if (cached && now - cached.at < (cached.exists ? EXISTS_TTL_MS : MISSING_TTL_MS)) {
    return cached.exists;
  }

  const aws = client();
  const endpoint = r2Endpoint();
  const { bucket } = r2Config();
  if (!aws || !endpoint || !bucket) return false;

  /* SIGN, THEN FETCH OURSELVES — deliberately NOT AwsClient.fetch().
     AwsClient.fetch retries a 5xx `retries` times (default 10) with exponential
     backoff from initRetryMs=50, which is 50+100+200+...+25600ms — about 51
     seconds of stalling on a single throttled HEAD, times thirteen panels, inside
     a serverless function with a timeout. Measured: one 500 produced eleven
     requests. We fail OPEN on an ambiguous answer anyway, so a retry buys nothing
     and costs the whole response. One attempt, hard deadline, move on. */
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEAD_TIMEOUT_MS);
  try {
    // Header-signed, not query-signed: nothing needs to hand this request to a
    // browser, so there is no reason to put the signature in a URL.
    // Same encoding as the GET, for the same signature reason.
    const req = await aws.sign(`${endpoint}/${bucket}/${encodeKeyForUrl(key)}`, {
      method: 'HEAD',
    });
    const res = await fetch(req, { signal: ctrl.signal });
    if (res.status === 404) {
      existence.set(key, { exists: false, at: now });
      return false;
    }
    if (res.ok) {
      existence.set(key, { exists: true, at: now });
      return true;
    }
    // Anything else is "cannot tell". Not cached, and resolved optimistically.
    console.warn(`[us] HEAD ${key} returned ${res.status}; presigning anyway.`);
    return true;
  } catch (err) {
    // Includes the abort. A slow bucket must not hold up her room.
    console.warn(`[us] HEAD ${key} failed or timed out; presigning anyway.`, err);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The small variant, following the naming the upload script already writes:
 * `photos/m01.webp` -> `photos/m01@sm.webp`.
 */
export function smallKey(key: string): string {
  const dot = key.lastIndexOf('.');
  if (dot <= 0) return `${key}@sm`;
  return `${key.slice(0, dot)}@sm${key.slice(dot)}`;
}

/**
 * The URL for one memory, or null to mean "serve the placeholder instead".
 *
 * `small` asks for the downscaled variant first and falls back to the full-size
 * key if it is not there — so requesting it is always safe even before the
 * upload script has produced any. This is the single biggest lever on the mobile
 * texture budget: thirteen full-resolution photographs is the tab-crash risk
 * PLAN.md R4 is about, and a phone asking for the small ones instead cuts it by
 * roughly the square of the scale factor.
 */
export async function resolvePhotoUrl(
  memory: Memory,
  opts: { small?: boolean; nowMs?: number } = {},
): Promise<string | null> {
  if (!hasR2()) return null;

  const candidates = opts.small ? [smallKey(memory.key), memory.key] : [memory.key];
  for (const key of candidates) {
    if (!KEY_SHAPE.test(key)) continue;
    // eslint-disable-next-line no-await-in-loop -- at most two, and the second
    // only runs when the first is a confirmed 404.
    if (await objectExists(key)) {
      return presignedUrl(key, PRESIGN_TTL_SEC, opts.nowMs);
    }
  }
  return null;
}

/** Test seam. Not called in production; exported so a suite can start clean. */
export function __resetExistenceCache(): void {
  existence.clear();
}

/* ===========================================================================
   WHAT SHIPS TO THE BROWSER
   =========================================================================== */

/**
 * The island's view of a memory.
 *
 * Note what is NOT here: `key`. The browser has no business knowing the object
 * layout of the bucket, and omitting it means a bug in the client cannot
 * possibly ask for a key — only for an id, which the server then resolves.
 */
export interface ClientMemory {
  id: string;
  caption: string;
  note: string;
  chapter: ChapterId;
  /** Carriage line 1–4, denormalised so the island needs no chapter lookup. */
  line: number;
  /** Free text or '' — see Memory.when. Never derived, never a date format. */
  when: string;
  aspect: number;
  hidden: boolean;
  /** Same-origin URL that resolves to the bytes. Never an R2 URL. */
  src: string;
  /**
   * Same, but asking for the downscaled variant. Safe to use unconditionally:
   * the endpoint falls back to the full-size object when no `@sm` exists yet.
   */
  srcSmall: string;
  /** Inline stand-in, used if `src` fails to decode. */
  placeholder: string;
}

export function clientManifest(): ClientMemory[] {
  return MEMORIES.map((m) => ({
    id: m.id,
    caption: m.caption,
    note: m.note,
    chapter: m.chapter,
    line: chapterOf(m).line,
    when: m.when ?? '',
    aspect: m.aspect,
    hidden: Boolean(m.hidden),
    src: `/api/us/photo/${m.id}`,
    srcSmall: `/api/us/photo/${m.id}?s=sm`,
    placeholder: placeholderDataUrl(m),
  }));
}
