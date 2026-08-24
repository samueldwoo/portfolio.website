/* ===========================================================================
   exif.ts — read the GPS coordinates out of an image, and nothing else.
   ===========================================================================

   ---------------------------------------------------------------------------
   WHY THIS EXISTS, WHICH IS A REVERSAL

   A day ago the plan was to REMOVE location data. The exporter still carries
   `--strip-location` for the case where a folder of photographs leaves for a print
   shop, and that flag is still right for that.

   But the reason to keep the data turned out to be better than the reason to drop
   it: at the end of the long-distance stretch there is meant to be a map of
   everywhere she photographed across France. That is not a privacy leak, it is the
   point of the thing.

   ---------------------------------------------------------------------------
   AND THE COORDINATES ARE STORED AS NUMBERS, NOT LEFT INSIDE THE FILE

   The obvious approach — preserve the EXIF block through the upload — is worse in
   three ways, and one of them is fatal.

   FATAL: the client resizer cannot preserve it. It draws the photograph into a
   canvas and re-encodes, and a canvas holds pixels; it has no concept of EXIF.
   Keeping the block would mean writing EXIF back into the re-encoded JPEG on the
   phone, which means an EXIF *writer* in the page — far more code, and far more
   ways to corrupt a photograph — instead of the reader below.

   Worse for the actual purpose: building a map out of baked EXIF means re-parsing
   every JPEG ever posted at the moment you want the map. Numbers in the day hash
   are just a list of points, which is what a map wants.

   And better for privacy, not worse: coordinates in the store are private by
   construction and never travel with a file that gets shared, saved out of the
   page, or handed to a print shop.

   ---------------------------------------------------------------------------
   IT IS DELIBERATELY NOT A GENERAL EXIF LIBRARY

   It reads GPS latitude and longitude. It does not read orientation, timestamps,
   camera make, or anything else, because nothing here needs them and every extra
   tag is more untrusted parsing for no gain.

   THIS PARSES BYTES A PHONE PRODUCED AND A NETWORK CARRIED, so every read is
   bounds-checked, the IFD entry count is capped, offsets outside the buffer are
   refused, and the next-IFD chain is never followed — IFD0 is the only directory
   walked, which makes a circular pointer impossible rather than merely handled.
   Any surprise returns null. There is no input for which this throws, and none for
   which it loops.
   =========================================================================== */

/** A point, in decimal degrees. */
export interface Coords {
  lat: number;
  lon: number;
}

/**
 * Null Island, and why it is refused rather than stored.
 *
 * Exactly 0,0 is off the coast of Africa and is overwhelmingly an artefact rather
 * than a place: a zeroed GPS block, a failed fix, a stripper that blanked the
 * values without removing the tags. One of those on the map would be a point in the
 * Gulf of Guinea with a photograph of a Paris apartment attached.
 */
function realPlace(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  return Math.abs(lat) > 1e-7 || Math.abs(lon) > 1e-7;
}

/**
 * Range-check a pair that came from somewhere other than this parser.
 *
 * The page sends coordinates it read off the ORIGINAL file before resizing, which
 * is the only place they still exist by then — so the server cannot re-derive them
 * and has to accept a number from a client. That is fine here (the gate is the
 * boundary, and the two people inside it are not attacking each other) but a
 * fat-fingered or malformed value would put a pin in the sea forever, so the shape
 * is still checked.
 */
export function validCoords(lat: unknown, lon: unknown): Coords | null {
  const la = typeof lat === 'number' ? lat : Number(String(lat ?? '').trim());
  const lo = typeof lon === 'number' ? lon : Number(String(lon ?? '').trim());
  if (!realPlace(la, lo)) return null;
  return { lat: la, lon: lo };
}

/* ===========================================================================
   THE TIFF BLOCK

   EXIF is a TIFF file wearing a hat. Inside a JPEG it sits in an APP1 segment
   behind the signature `Exif\0\0`; inside a PNG it is the whole `eXIf` chunk; and
   inside a WebP it is the whole `EXIF` chunk. All three then contain the identical
   structure, which is why there is one parser and three ways of finding it.
   =========================================================================== */

/**
 * Little- or big-endian readers over a fixed buffer, refusing out-of-range.
 *
 * A factory returning three closures rather than a class with parameter
 * properties: `constructor(private readonly b: Uint8Array)` is TypeScript that
 * EMITS code rather than merely declaring a type, so it cannot be stripped, and
 * `node --experimental-strip-types` refuses the file outright. That matters here
 * because this module is unit-tested on bare node — see the test — and a shape that
 * needs a compiler to run is a shape that does not get tested.
 *
 * Every read returns null rather than throwing when it would cross the end, so the
 * callers below can treat "ran off the buffer" and "not a coordinate" as the same
 * uninteresting answer.
 */
interface Reader {
  ok: (at: number, len: number) => boolean;
  u16: (at: number) => number | null;
  u32: (at: number) => number | null;
}

function reader(b: Uint8Array, le: boolean): Reader {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ok = (at: number, len: number): boolean =>
    at >= 0 && len >= 0 && at + len <= b.byteLength;
  return {
    ok,
    u16: (at) => (ok(at, 2) ? d.getUint16(at, le) : null),
    u32: (at) => (ok(at, 4) ? d.getUint32(at, le) : null),
  };
}

/** EXIF tags. Only the five that describe a position. */
const TAG_GPS_IFD = 0x8825;
const GPS_LAT_REF = 0x0001;
const GPS_LAT = 0x0002;
const GPS_LON_REF = 0x0003;
const GPS_LON = 0x0004;

/**
 * A cap on directory entries.
 *
 * A real IFD holds tens. The count is a 16-bit field read straight out of the
 * file, so a corrupt or hostile one can claim 65535 and each entry costs a bounds
 * check — bounded work either way, but there is no legitimate file above this and
 * refusing early is cheaper than proving it harmless.
 */
const MAX_ENTRIES = 256;

/** Degrees/minutes/seconds as three rationals, to decimal degrees. */
function dmsToDegrees(r: Reader, at: number, count: number): number | null {
  // Three RATIONALs is the spec. Some cameras write fewer; anything else is not
  // a coordinate and is refused rather than guessed at.
  if (count < 2 || count > 3) return null;

  let deg = 0;
  const scale = [1, 60, 3600];
  for (let i = 0; i < count; i += 1) {
    const num = r.u32(at + i * 8);
    const den = r.u32(at + i * 8 + 4);
    if (num === null || den === null || den === 0) return null;
    deg += num / den / scale[i];
  }
  return Number.isFinite(deg) ? deg : null;
}

/**
 * Walk IFD0, find the GPS directory, read the four tags that matter.
 *
 * `tiff` starts at the TIFF header — all offsets inside EXIF are relative to that
 * byte, which is the single most common way a hand-rolled parser goes wrong.
 */
function fromTiff(tiff: Uint8Array): Coords | null {
  if (tiff.byteLength < 8) return null;

  // Byte order: 'II' little-endian, 'MM' big-endian. Anything else is not TIFF.
  const b0 = tiff[0];
  const b1 = tiff[1];
  const le = b0 === 0x49 && b1 === 0x49;
  const be = b0 === 0x4d && b1 === 0x4d;
  if (!le && !be) return null;

  const r = reader(tiff, le);
  if (r.u16(2) !== 0x002a) return null; // the TIFF magic, in the declared order

  const ifd0 = r.u32(4);
  if (ifd0 === null || !r.ok(ifd0, 2)) return null;

  /* ---- find the GPS IFD pointer in IFD0 ---- */
  const n0 = r.u16(ifd0);
  if (n0 === null || n0 === 0 || n0 > MAX_ENTRIES) return null;

  let gpsAt: number | null = null;
  for (let i = 0; i < n0; i += 1) {
    const e = ifd0 + 2 + i * 12;
    if (!r.ok(e, 12)) return null;
    if (r.u16(e) === TAG_GPS_IFD) {
      gpsAt = r.u32(e + 8);
      break;
    }
  }
  // No GPS directory. The overwhelmingly common case: Location Services off, or a
  // screenshot, or a re-encode that dropped it. Not an error.
  if (gpsAt === null || !r.ok(gpsAt, 2)) return null;

  /* ---- read the GPS directory ---- */
  const nG = r.u16(gpsAt);
  if (nG === null || nG === 0 || nG > MAX_ENTRIES) return null;

  let lat: number | null = null;
  let lon: number | null = null;
  let latRef = '';
  let lonRef = '';

  for (let i = 0; i < nG; i += 1) {
    const e = gpsAt + 2 + i * 12;
    if (!r.ok(e, 12)) return null;

    const tag = r.u16(e);
    const count = r.u32(e + 4);
    if (tag === null || count === null) return null;

    if (tag === GPS_LAT_REF || tag === GPS_LON_REF) {
      /* An ASCII field of 2 bytes ('N\0'), so it is stored INLINE in the value
         field rather than at an offset — anything <= 4 bytes is. Reading it as a
         pointer is the other classic way this goes wrong. */
      const c = tiff[e + 8];
      const ch = c ? String.fromCharCode(c).toUpperCase() : '';
      if (tag === GPS_LAT_REF) latRef = ch;
      else lonRef = ch;
      continue;
    }

    if (tag === GPS_LAT || tag === GPS_LON) {
      // 3 RATIONALs is 24 bytes, far over 4, so this one IS an offset.
      const at = r.u32(e + 8);
      if (at === null || !r.ok(at, count * 8)) continue;
      const deg = dmsToDegrees(r, at, count);
      if (deg === null) continue;
      if (tag === GPS_LAT) lat = deg;
      else lon = deg;
    }
  }

  if (lat === null || lon === null) return null;

  // The refs carry the sign. A missing ref is a malformed block, not a default of
  // north-east — guessing would put a Paris photograph in the wrong hemisphere.
  if (latRef === 'S') lat = -lat;
  else if (latRef !== 'N') return null;
  if (lonRef === 'W') lon = -lon;
  else if (lonRef !== 'E') return null;

  return realPlace(lat, lon) ? { lat, lon } : null;
}

/* ===========================================================================
   FINDING THE TIFF BLOCK IN EACH CONTAINER
   =========================================================================== */

/** Bytes equal to an ASCII string at an offset. */
function tag(b: Uint8Array, at: number, s: string): boolean {
  if (at + s.length > b.byteLength) return false;
  for (let i = 0; i < s.length; i += 1) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

/** JPEG: walk the segment markers to the APP1 that begins `Exif\0\0`. */
function fromJpeg(b: Uint8Array): Coords | null {
  if (b.byteLength < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;

  let p = 2;
  // Bounded by the buffer: every step advances by a length read from the file, and
  // a non-advancing or backward length breaks the loop rather than spinning.
  while (p + 4 <= b.byteLength) {
    if (b[p] !== 0xff) break;
    const marker = b[p + 1];
    // Start of scan: pixels from here on, no more metadata worth walking.
    if (marker === 0xda) break;
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2) break;

    if (marker === 0xe1 && tag(b, p + 4, 'Exif\0\0')) {
      const start = p + 10;
      const end = Math.min(p + 2 + len, b.byteLength);
      if (end > start) return fromTiff(b.subarray(start, end));
    }
    p += 2 + len;
  }
  return null;
}

/** PNG: the `eXIf` chunk is a bare TIFF block. */
function fromPng(b: Uint8Array): Coords | null {
  if (!tag(b, 1, 'PNG')) return null;
  let p = 8; // past the signature
  while (p + 8 <= b.byteLength) {
    const len = new DataView(b.buffer, b.byteOffset + p, 4).getUint32(0, false);
    if (!Number.isFinite(len) || len < 0 || p + 12 + len > b.byteLength) break;
    if (tag(b, p + 4, 'eXIf')) return fromTiff(b.subarray(p + 8, p + 8 + len));
    if (tag(b, p + 4, 'IEND')) break;
    p += 12 + len; // length + type + data + CRC
  }
  return null;
}

/** WebP: a RIFF container; the `EXIF` chunk is a bare TIFF block. */
function fromWebp(b: Uint8Array): Coords | null {
  if (!tag(b, 0, 'RIFF') || !tag(b, 8, 'WEBP')) return null;
  let p = 12;
  while (p + 8 <= b.byteLength) {
    const len = new DataView(b.buffer, b.byteOffset + p + 4, 4).getUint32(0, true);
    if (!Number.isFinite(len) || len < 0 || p + 8 + len > b.byteLength) break;
    if (tag(b, p, 'EXIF')) return fromTiff(b.subarray(p + 8, p + 8 + len));
    p += 8 + len + (len % 2); // RIFF chunks are word-aligned
  }
  return null;
}

/**
 * The coordinates an image was taken at, or null.
 *
 * Null is the ordinary answer, not a failure: it means Location Services was off,
 * or the photograph is a screenshot, or something re-encoded it on the way here —
 * which is exactly what the page's own resizer does, and why the page reads the
 * ORIGINAL file rather than relying on this. This runs on the server for the
 * no-JavaScript path, where the untouched file is what arrives.
 *
 * Total: every branch inside returns null rather than throwing, and the try is
 * belt and braces for a DataView constructed over a detached buffer.
 */
export function readCoords(bytes: Uint8Array): Coords | null {
  try {
    if (bytes.byteLength < 12) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return fromJpeg(bytes);
    if (bytes[0] === 0x89 && tag(bytes, 1, 'PNG')) return fromPng(bytes);
    if (tag(bytes, 0, 'RIFF')) return fromWebp(bytes);
    return null;
  } catch {
    return null;
  }
}
