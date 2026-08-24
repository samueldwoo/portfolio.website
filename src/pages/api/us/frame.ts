/**
 * /api/us/frame — one of them posts today's photograph.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY ENDPOINT IN THE WING THAT TAKES BYTES
 *
 * Everything else here accepts short strings: an answer, a note, a Spotify URL, a
 * tap with no payload at all. This one takes a file, which is a different kind of
 * input and needs a different kind of suspicion.
 *
 * Three things make it safe, and none of them is "we checked the Content-Type":
 *
 *   1. THE KEY IS ENTIRELY OURS. The date comes from the server's clock, `who`
 *      from the session cookie, the extension from sniffing the bytes. The
 *      uploaded filename is read nowhere and discarded — see frames.ts's
 *      frameKey(), which throws rather than build a key from anything that is not
 *      exactly a date, exactly 'her' or 'him', and exactly one of three
 *      extensions. There is no traversal to escape because there is no path
 *      component a caller can influence.
 *
 *   2. THE TYPE IS SNIFFED, NOT BELIEVED. A multipart part's Content-Type is a
 *      claim by the client. The first bytes are the fact. The sniffed type is
 *      also the one written to R2, so it is what the browser will be told later.
 *
 *   3. IT IS NEVER SERVED FROM THIS ORIGIN. The bytes go to a private R2 bucket
 *      and come back through a short-lived presigned URL on R2's own hostname, so
 *      even a file crafted to be both a valid JPEG and something else has no
 *      same-origin context to be interesting in.
 *
 * ---------------------------------------------------------------------------
 * WHY multipart AND NOT JSON
 *
 * A base64 JSON body is a third larger, has to be decoded in the function's
 * memory, and — the real reason — cannot be sent by a plain HTML form. This
 * endpoint has to work with JavaScript switched off, from `<form enctype>`, or
 * the no-JS promise the rest of the wing keeps would have one hole in it shaped
 * exactly like the feature she is most likely to use from a phone.
 */

import type { APIRoute } from 'astro';
import { SESSION_SECRET } from '../../../lib/us/config';
import { clientKey, hit } from '../../../lib/us/ratelimit';
import { wingDate } from '../../../lib/us/kv';
import { timer, trace } from '../../../lib/us/trace';
import { readCoords } from '../../../lib/us/exif';
import { notify } from '../../../lib/us/push';
import { crossSite, identify } from '../../../lib/us/together';
import {
  FramesError,
  MAX_BYTES,
  framesAvailable,
  putFrame,
  sniff,
  tidyNote,
} from '../../../lib/us/frames';

export const prerender = false;

/**
 * Deliberately tighter than the other endpoints' 20/10min.
 *
 * Each accepted request writes up to four megabytes to R2. A tap is cheap to
 * repeat and a photograph is not, so the limit is about the write cost rather
 * than about abuse — and posting today's picture six times in ten minutes is
 * already "I changed my mind twice", which is allowed for.
 */
const RATE_LIMIT = 6;
const RATE_WINDOW_SEC = 600;

const PAGE = '/samdrea/vault/day';
const FRAGMENT = '#post';

/**
 * The largest `exifhead` part that will be read.
 *
 * 64KB, and generous rather than tight: EXIF lives in the JPEG's APP1 segment
 * before any pixel data, and even with an embedded thumbnail it is a few tens of
 * kilobytes. Anything beyond this is not a metadata block, so refusing it costs
 * nothing and stops a client making the server read four megabytes twice.
 *
 * Not counted against MAX_BYTES, which measures the PHOTOGRAPH — conflating them
 * would make a legitimate 3.9MB upload fail for carrying its own metadata.
 */
const EXIF_HEAD_MAX = 64 * 1024;

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

/**
 * Does the caller want JSON back?
 *
 * NOT keyed off Content-Type, unlike the other endpoints in this wing — this
 * request's Content-Type is always `multipart/form-data`, on both paths, because
 * that is the only way to carry a file. So the fetch path announces itself with
 * `Accept` instead, and a plain form (which sends `Accept: text/html`) gets the
 * redirect. Getting this backwards would 303 the script and hand her a raw JSON
 * document as a page.
 */
function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').toLowerCase().includes('application/json');
}

export const POST: APIRoute = async ({ request, cookies, clientAddress, redirect, url }) => {
  /* THE STOPWATCH STARTS BEFORE EVERYTHING, including the guards, so the legs add up
     to something she would recognise as "how long that took".

     `readMs` DID NOT MEAN WHAT IT SAID, and this comment used to be the thing
     asserting that it did. It was one lap taken at the end of a run that had already
     awaited the rate limiter, and `hit()` is an HTTP round trip to Upstash with a
     two-second ceiling before it gives up and fails open. So a degraded store was
     reported as a slow upload: the single question this instrumentation exists to
     answer — "was it her connection?" — would have been answered wrong, confidently,
     with a number that looked measured. The limiter has its own leg now.

     A cold boot is still invisible from in here. It happens before this line and
     nothing in the process can observe it; Vercel's own duration minus `totalMs` is
     where it shows up. */
  const t = timer();
  const asJson = wantsJson(request);

  /** One exit, so the fetch and no-JS paths cannot drift apart. */
  const answer = (
    ok: boolean,
    status: number,
    code: string | null,
    extra: Record<string, unknown> = {},
  ): Response => {
    /* EVERY exit is traced, from inside the one function they all go through —
       adding a line at each `return answer(...)` would have missed one eventually,
       and the refusals are exactly the cases nobody thinks to instrument.

       `who` reads as undefined on the two exits that run before identity is known and
       is therefore simply absent from those lines, which is the right answer: it is
       the only field here that says whose upload failed, and "her photograph would not
       go up" is a different report from "his did not". No leg breakdown, because a
       refusal by definition did not get far enough to have legs. */
    if (!ok) trace('frame.post', { ok: false, code, status, who, totalMs: t.total() });
    if (asJson) return json({ ok, ...(code ? { code } : {}), ...extra }, status);
    const query = ok
      ? `?ok=${encodeURIComponent(code ?? 'posted')}`
      : `?e=${encodeURIComponent(code ?? 'no')}`;
    const res = redirect(`${PAGE}${query}${FRAGMENT}`, 303);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(PRIVACY)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  /* Identity first. identify() returns null with no signing key, which is the
     fail-closed direction — without one we cannot tell either of them from a
     stranger. The two cases are split only so the log says which fix is needed. */
  const who = identify(cookies, url);
  if (!who) {
    if (!SESSION_SECRET()) {
      console.error('[us] frame called but US_SESSION_SECRET is missing.');
      return answer(false, 503, 'unconfigured');
    }
    return answer(false, 401, 'unauthorized');
  }

  /* Checked after the cookie, so an unauthenticated cross-site probe learns
     nothing. It matters more here than anywhere else in the wing: without it any
     page on any host under the same registrable domain could put an image of its
     choosing on her page, under her name, from her browser. */
  if (crossSite(request, url)) {
    console.warn('[us] refused a cross-site frame upload.');
    return answer(false, 403, 'cross-site');
  }

  /* BEFORE the body is read. Astro's checkOrigin does not cover multipart any
     more than it covers JSON, and reading four megabytes off the wire to then
     refuse it is the one thing a rate limiter is supposed to prevent. */
  const limit = await hit(`frame:${clientKey(request, clientAddress)}`, RATE_LIMIT, RATE_WINDOW_SEC);
  /* THE LIMITER'S OWN LEG, because it is a NETWORK leg and was being counted as hers.
     `hit()` is an HTTP round trip to Upstash — three commands, a two-second ceiling,
     and it fails OPEN when that expires, so a sick store adds up to two silent seconds
     here and then allows the request anyway. Charging that to `readMs` meant the log
     said "her connection" about our own dependency.

     The two guards above it are in this leg too. They are an HMAC verification and a
     header comparison, both synchronous and both immeasurable at this resolution, so
     naming the leg after the limiter is honest rather than approximate. */
  const limitMs = t.lap();
  if (!limit.ok) return answer(false, 429, 'rate', { retryAfter: limit.retryAfter });

  /* R2 is the only place bytes can go, so no bucket means no feature — said
     plainly rather than accepting an upload that has nowhere to land. */
  if (!framesAvailable()) {
    console.error('[us] frame called but R2 is not configured.');
    return answer(false, 503, 'unconfigured');
  }

  /* Declared length first, so an oversized upload is refused from a header
     instead of after being buffered. It is only a hint — a chunked request has no
     Content-Length at all — which is why the real bytes are measured below too. */
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BYTES * 1.2) {
    return answer(false, 413, 'too-big', { max: MAX_BYTES });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    /* A truncated upload from a phone that lost signal mid-send lands here, and
       it is the single most likely failure of this endpoint in real use. It is not
       her fault and the message says so. */
    return answer(false, 400, 'bad-upload');
  }

  const file = form.get('photo');
  if (!(file instanceof File) || file.size === 0) {
    return answer(false, 400, 'no-photo');
  }
  if (file.size > MAX_BYTES) {
    return answer(false, 413, 'too-big', { max: MAX_BYTES });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  /* THE READ LEG, and now it is only that: everything since the limiter answered.
     `formData()` above is where the body genuinely crosses the wire — the runtime
     consumes the whole stream to parse the multipart, so by the time it resolves every
     byte has arrived and the `arrayBuffer()` on the line above is a copy of something
     already in memory.

     The multipart PARSE is inside this number too and is not separable without
     instrumenting the runtime, which is not worth it: at these sizes it is single-digit
     milliseconds against hundreds. Compare this against `bytes` when the question is
     "why did that feel slow". */
  const readMs = t.lap();
  /* Measured, not trusted. A multipart part can claim any size it likes; this is
     the length of what actually arrived. */
  if (bytes.byteLength === 0) return answer(false, 400, 'no-photo');
  if (bytes.byteLength > MAX_BYTES) return answer(false, 413, 'too-big', { max: MAX_BYTES });

  const sniffed = sniff(bytes);
  if (!sniffed) {
    /* Reached by a real non-image, and also by a HEIC straight off an iPhone with
       JavaScript disabled — which is a genuine case worth a specific message,
       because "that is not an image" would be a confusing thing to tell somebody
       who just picked a photograph out of their camera roll. */
    return answer(false, 415, 'not-an-image');
  }

  const note = tidyNote(form.get('note'));

  /* ---------------------------------------------------------------------------
     WHERE IT WAS TAKEN, PARSED HERE AND NOWHERE ELSE

     For the map that is meant to exist at the end of the long-distance stretch. The
     coordinates are stored as numbers on the day hash rather than left inside the
     file — exif.ts carries that argument in full.

     THE HARD PART IS THAT BY THE TIME THE BYTES ARRIVE, THE LOCATION IS USUALLY
     GONE. The page shrinks a photograph through a canvas before uploading it, and a
     canvas holds pixels; the re-encode discards every scrap of metadata. So on the
     ordinary path `bytes` has no EXIF at all, and there is nothing here to read.

     THE OBVIOUS FIX WAS WORSE. Parsing EXIF in the page and posting a latitude and
     longitude means a SECOND parser, written in the inline script, over the same
     hostile byte formats — duplicated logic, untested, in the one place where a
     thrown error costs her the upload.

     So the page posts the first 64KB of the ORIGINAL file instead, and the parser
     stays here: one implementation, unit-tested, running where a failure is a
     missing pin rather than a broken form. EXIF sits at the very start of a JPEG
     (APP1, before the pixel data) so the head is enough, thumbnail included.

     ORDER MATTERS AND IS DELIBERATE. The uploaded bytes are tried FIRST, because on
     the no-JavaScript path they ARE the original and are strictly better evidence
     than a truncated copy. The head is the fallback for the resized path. Both
     absent, or both unreadable, is the ordinary answer: null.

     `coords` can never make this request fail. readCoords() is total — every branch
     returns null rather than throwing — and a null simply means no pin. */
  let hadHead = false;
  let coords = readCoords(bytes);
  if (!coords) {
    const head = form.get('exifhead');
    if (head instanceof File && head.size > 0 && head.size <= EXIF_HEAD_MAX) {
      hadHead = true;
      try {
        coords = readCoords(new Uint8Array(await head.arrayBuffer()));
      } catch {
        /* A truncated or unreadable part. The photograph is already validated and
           is about to be saved; losing the pin is not worth losing that. */
      }
    }
  }

  /* ONE clock reading, taken here and passed down, so the day it files under and
     the timestamp it records cannot straddle midnight and disagree. */
  const nowMs = Date.now();
  const today = wingDate(new Date(nowMs));

  /* CLOSED OFF SO `storeMs` CANNOT ABSORB IT. lap() moves its own mark, which means a
     leg is whatever happened since the LAST lap and not since the thing its name
     mentions — so without this line the sniff, the caption tidy, the EXIF parse and the
     exifhead copy were all being reported as time spent in the store.

     It is a few milliseconds in practice (fromJpeg walks segment headers and stops at
     the scan; the head is at most 64KB already in memory) and that is exactly the
     argument for measuring it: a small number in the right place is how you know it is
     small, and a small number in the wrong place is how a name stops being true. */
  const prepMs = t.lap();

  let frame;
  let storeMs = 0;
  try {
    frame = await putFrame({ date: today, who, bytes, sniffed, note, atMs: nowMs, coords });
    storeMs = t.lap();
  } catch (err) {
    /* The bytes-first order in putFrame() means the worst case here is an
       orphaned object in R2 that nothing points at — invisible, harmless, and
       replaced by her next attempt. Nothing she can see is now wrong. */
    console.error('[us] frame write failed:', err instanceof Error ? err.message : err);
    return answer(false, err instanceof FramesError ? 502 : 500, 'store');
  }

  /* ---- THE PLACE LABEL IS NOT RESOLVED HERE, AND THAT IS THE SECOND VERSION.

     It was: lookupPlace() ran right here, after the bytes were durable, awaited so
     a frozen function could not cancel it. Correct about safety, wrong about the
     thing that actually mattered — it put a third-party network call between her
     and the end of her upload, and she had already reported uploads feeling slow.
     Nominatim measures 0.68s cold, so that was most of a second added to the exact
     "sending…" state she was complaining about, for a caption that nobody is waiting
     to read.

     So it moved to the day page, resolved lazily on first render and stored. Same
     one lookup per photograph and the same single disclosure — just paid by a page
     view instead of by her, and with a shorter deadline. See day.astro. */

  /* ---- THE NOTIFICATION -----------------------------------------------
     OUTSIDE the try, and that placement is the point rather than tidiness.

     Inside it, a notification that somehow threw would land in the catch above
     and be reported as `store` — a 502 over a photograph that is already in R2,
     which is the exact failure this feature is forbidden from causing. push.ts
     guarantees notify() cannot throw; putting the call where a throw would have
     nowhere to go means that guarantee is not the only thing holding.

     "Sam put a picture up", and that is the whole of it. `frame.note` is the
     caption and it is on the next line being returned to the caller — it is NOT
     passed here, and notify() has no argument it could be passed as. A caption
     is exactly the kind of thing somebody standing next to her must not read. */
  await notify(who, 'photo');
  const pushMs = t.lap();

  /* ONE LINE PER SUCCESSFUL UPLOAD, with the legs separated so the next "it felt slow"
     is answerable instead of arguable. `head` says whether the fallback EXIF slice was
     READ — not merely sent, since it is only looked at when the uploaded bytes had no
     coordinates of their own — and `coords` says whether a location was found at all.
     Neither the note, the coordinates nor the place name can appear here; trace()
     refuses strings with spaces or over 24 characters.

     AFTER THE NOTIFICATION, WHICH IS A MOVE RATHER THAN A PLACEMENT. It used to sit
     above, and `totalMs` therefore stopped at the store and omitted the push entirely —
     several hundred milliseconds of web-push on a leg the whole file agrees is hers
     (`await notify` is on her critical path by design; push.ts's header argues that at
     length). A number called `totalMs` that excludes part of the wait is the same defect
     as `readMs` including the rate limiter, in the other direction.

     THE REJECTED ALTERNATIVE was leaving it above, so a saved photograph is logged even
     if the push hangs. It buys little: notify() is bounded and cannot throw, and a
     function killed mid-push leaves Vercel's own error for that invocation, so the
     upload is not actually unobservable — whereas a `totalMs` that quietly understates
     what she waited for is wrong on every single successful upload. */
  trace('frame.post', {
    ok: true,
    who,
    ext: sniffed.ext,
    bytes: bytes.byteLength,
    head: hadHead,
    coords: coords !== null,
    limitMs,
    readMs,
    prepMs,
    storeMs,
    pushMs,
    totalMs: t.total(),
  });

  return answer(true, 200, 'posted', {
    date: today,
    who,
    note: frame.note,
    bytes: bytes.byteLength,
  });
};

/** Anything but POST. Named so the 405 is a sentence rather than a default. */
export const ALL: APIRoute = () =>
  json({ ok: false, code: 'method-not-allowed' }, 405);
