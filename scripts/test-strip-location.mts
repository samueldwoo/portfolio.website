/**
 * test-strip-location.mts — the location strip really removes location, really
 * leaves everything else alone, and really notices when it is broken.
 *
 *   npm run test:strip-location
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 *
 * `PLAN.md` §6 has carried "GPS stripping — never verified" since the beginning,
 * and the honest reason was structural. The only assurance was a line printed
 * during a real run: `photos-prep.mjs` shells out to ImageMagick and reports
 * `GPS stripped`, and `frames-export.mjs --strip-location` reports what it
 * removed. Both are assertions ABOUT REAL PHOTOGRAPHS, made while handling them.
 * Proving a privacy feature by running it over the private data it protects is
 * the shape of test this project has already been burnt by.
 *
 * So the strip needed a file that carries GPS and is not anybody's photograph.
 * There isn't one to download — a real GPS-bearing JPEG is by definition a real
 * place — so the fixtures here are BUILT, byte by byte, and the coordinates in
 * them are 11.111 / 22.222: a legal point (it is in the Atlantic, ~700km off
 * Liberia) that could not be mistaken for anywhere either of them has been.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE IS PROVED BY THE APPLICATION'S OWN READER
 *
 * A test that builds its own GPS block and then checks its own stripper can pass
 * while both halves are wrong in the same direction — the classic failure of a
 * self-built fixture, and the reason `CLAUDE.md` insists a harness assert it
 * grabbed the right thing.
 *
 * So the fixture is verified with `readCoords()` out of `src/lib/us/exif.ts` —
 * the parser the UPLOAD endpoint uses to decide where a photograph was taken.
 * When it answers 11.111 / 22.222, the fixture is not merely "shaped like" EXIF
 * GPS: it is EXIF GPS to the one reader whose opinion the wing acts on. Then the
 * strip runs and the SAME reader must answer null.
 *
 * That has a second effect worth naming, because it was a gap rather than a
 * bonus: `readCoords()` had NO test of its own, and this is now the only thing
 * that reads a coordinate out of a file and checks the number.
 *
 * ---------------------------------------------------------------------------
 * UNREACHABLE IS NOT REMOVED, AND THAT IS THE MAIN ASSERTION
 *
 * The easy way to make `readCoords()` return null is to unlink the GPS pointer
 * and leave the coordinates sitting in the file. `zeroIfd()`'s comment calls that
 * out as "exactly the kind of half-fix this flag must not be", so the tests below
 * do not stop at the reader: they search the OUTPUT BYTES for the rational values
 * the fixture was built from. A pass here means the numbers are gone, not hidden.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE TOUCHES R2, UPSTASH, THE NETWORK OR THE FILESYSTEM
 *
 * `strip-location.mjs` is pure by contract and every fixture is a Buffer built in
 * memory. The one file read is the module's own source, and only so it can be
 * mutated in memory for the mutation pass at the end.
 */

/* The app's reader, and the exporter's stripper. Two separately-written
   implementations of the same byte format, which is why one can check the other:
   a shared helper would make agreement meaningless. */
import { readCoords } from '../src/lib/us/exif.ts';
import {
  stripLocation,
  stripTiffLocation,
  blankXmpLocation,
  crc32 as crc32UnderTest,
} from './lib/strip-location.mjs';

import { readFileSync } from 'node:fs';

let pass = 0,
  fail = 0;
const is = (n: string, c: boolean, got?: unknown) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c ? '' : '  got ' + JSON.stringify(got)}`);
};
const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-6;

/* WHY `Bytes` AND NOT `Buffer`.
   `Buffer` now means `Buffer<ArrayBuffer>`, but `Buffer.concat()` returns
   `Buffer<ArrayBufferLike>` — the wider type that also admits SharedArrayBuffer.
   Every builder below concatenates, so annotating them `Buffer` makes astro check
   reject the fixtures for a reason that has nothing to do with the test. The alias
   is the honest type of what these functions actually return. */
type Bytes = Buffer<ArrayBufferLike>;

/* ===========================================================================
   THE INVENTED PLACE

   `11.111` / `22.222` is the same pair `test-frames-key.mts` uses, for the same
   reason: this repository is public, and the recorded way private data reaches it
   is a future session copying the nearest real-looking value it can find. A
   number that is obviously synthetic cannot be copied forward into something that
   looks like a real record.
   =========================================================================== */
const LAT = 11.111;
const LON = 22.222;

/** Decimal degrees to the three RATIONALs EXIF stores, exactly. */
function toDms(v: number): Array<[number, number]> {
  const d = Math.floor(v);
  const remMin = (v - d) * 60;
  const m = Math.floor(remMin);
  /* Seconds at 1/10000, because (11.111 - 11) * 60 is 6.659999999999997 in
     binary floating point and a naive numerator would be 395999 rather than
     396000 — a fixture 0.0000003° off, which would pass and mean nothing, but
     would also make the "these exact bytes are gone" assertion below search for
     a byte pattern that is not what the builder wrote. */
  const s = Math.round((remMin - m) * 60 * 10000);
  return [
    [d, 1],
    [m, 1],
    [s, 10000],
  ];
}

const LAT_DMS = toDms(LAT);
const LON_DMS = toDms(LON);

/* ===========================================================================
   A CRC-32, WRITTEN AGAIN ON PURPOSE

   PNG chunks are checksummed, so building a PNG fixture needs a CRC and checking
   a re-sealed chunk needs one too. Using the module's own `crc32` for both would
   make "the CRC is correct" mean "the CRC matches itself". This one is
   independent and is checked against the standard vector before use, so a
   disagreement below is a real disagreement.
   =========================================================================== */
const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc(b: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < b.length; i += 1) c = TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ===========================================================================
   TIFF BUILDER

   Offsets are COMPUTED, not written down. A hand-tabulated layout is the classic
   way a fixture ends up subtly invalid, and `readCoords()` would then answer null
   for the boring reason and the strip would look like it worked.
   =========================================================================== */

const T_ASCII = 2,
  T_SHORT = 3,
  T_LONG = 4,
  T_RATIONAL = 5;

const TAG_MAKE = 0x010f;
const TAG_ORIENTATION = 0x0112;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_IMAGE_WIDTH = 0x0100;

const MAKE = 'TESTCAM\0';
const WHEN = '2026:01:01 00:00:00\0';

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Inline value (<= 4 bytes) or a Buffer placed elsewhere and pointed at. */
  inline?: number;
  data?: Bytes;
  /** Filled in by the writer: a pointer to another IFD. */
  pointsTo?: 'exif' | 'gps';
}

function rationals(pairs: Array<[number, number]>): Bytes {
  const b = Buffer.alloc(pairs.length * 8);
  pairs.forEach(([n, d], i) => {
    b.writeUInt32LE(n, i * 8);
    b.writeUInt32LE(d, i * 8 + 4);
  });
  return b;
}

interface TiffOpts {
  /** Point the GPS entry somewhere unparseable, to exercise the fail-safe. */
  breakGps?: boolean;
  /** Also hang a GPS pointer off ExifIFD, where the spec says it cannot be. */
  strayGpsInExif?: boolean;
  /** Leave GPS out entirely. */
  noGps?: boolean;
}

/**
 * A little-endian TIFF block with IFD0 -> IFD1, an ExifIFD and a GPS IFD.
 *
 * IFD1 exists specifically to test `removeIfdEntry()`. Deleting the GPS entry
 * shortens IFD0's entry array, which MOVES the next-IFD pointer — so if that
 * rewrite is wrong the thumbnail directory becomes unreachable, and nothing about
 * the coordinates would reveal it.
 */
function buildTiff(opts: TiffOpts = {}): Bytes {
  const gpsEntries: Entry[] = [
    { tag: 0x0001, type: T_ASCII, count: 2, data: Buffer.from('N\0', 'latin1') }, // inline
    { tag: 0x0002, type: T_RATIONAL, count: 3, data: rationals(LAT_DMS) },
    { tag: 0x0003, type: T_ASCII, count: 2, data: Buffer.from('E\0', 'latin1') }, // inline
    { tag: 0x0004, type: T_RATIONAL, count: 3, data: rationals(LON_DMS) },
  ];
  const exifEntries: Entry[] = [
    { tag: TAG_DATETIME_ORIGINAL, type: T_ASCII, count: WHEN.length, data: Buffer.from(WHEN, 'latin1') },
  ];
  if (opts.strayGpsInExif) exifEntries.push({ tag: TAG_GPS_IFD, type: T_LONG, count: 1, pointsTo: 'gps' });

  const ifd0: Entry[] = [
    { tag: TAG_IMAGE_WIDTH, type: T_SHORT, count: 1, inline: 64 },
    { tag: TAG_MAKE, type: T_ASCII, count: MAKE.length, data: Buffer.from(MAKE, 'latin1') },
    { tag: TAG_ORIENTATION, type: T_SHORT, count: 1, inline: 6 },
    { tag: TAG_DATETIME, type: T_ASCII, count: WHEN.length, data: Buffer.from(WHEN, 'latin1') },
    { tag: TAG_EXIF_IFD, type: T_LONG, count: 1, pointsTo: 'exif' },
  ];
  if (!opts.noGps) ifd0.push({ tag: TAG_GPS_IFD, type: T_LONG, count: 1, pointsTo: 'gps' });
  const ifd1: Entry[] = [{ tag: TAG_IMAGE_WIDTH, type: T_SHORT, count: 1, inline: 8 }];

  const sizeOf = (e: Entry) =>
    ([0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][e.type] ?? 0) * e.count;
  const ifdBytes = (es: Entry[]) => 2 + es.length * 12 + 4;

  /* ---- placement pass: every directory, then every external value ---- */
  let at = 8; // past the TIFF header
  const off = { ifd0: at };
  at += ifdBytes(ifd0);
  const offExif = at;
  at += ifdBytes(exifEntries);
  const offGps = at;
  at += ifdBytes(gpsEntries);
  const offIfd1 = at;
  at += ifdBytes(ifd1);

  const external = new Map<Entry, number>();
  for (const es of [ifd0, exifEntries, gpsEntries, ifd1]) {
    for (const e of es) {
      if (e.data && sizeOf(e) > 4) {
        external.set(e, at);
        at += sizeOf(e);
        if (at % 2) at += 1; // keep offsets even, as real writers do
      }
    }
  }
  const total = at;

  const buf = Buffer.alloc(total);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(off.ifd0, 4);

  const writeIfd = (es: Entry[], base: number, next: number) => {
    buf.writeUInt16LE(es.length, base);
    es.forEach((e, i) => {
      const p = base + 2 + i * 12;
      buf.writeUInt16LE(e.tag, p);
      buf.writeUInt16LE(e.type, p + 2);
      buf.writeUInt32LE(e.count, p + 4);
      if (e.pointsTo === 'exif') buf.writeUInt32LE(offExif, p + 8);
      else if (e.pointsTo === 'gps') buf.writeUInt32LE(opts.breakGps ? total + 4096 : offGps, p + 8);
      else if (e.inline !== undefined) buf.writeUInt16LE(e.inline, p + 8);
      else if (e.data && sizeOf(e) <= 4) e.data.copy(buf, p + 8);
      else if (e.data) buf.writeUInt32LE(external.get(e)!, p + 8);
    });
    buf.writeUInt32LE(next, base + 2 + es.length * 12);
  };

  writeIfd(ifd0, off.ifd0, offIfd1);
  writeIfd(exifEntries, offExif, 0);
  writeIfd(gpsEntries, offGps, 0);
  writeIfd(ifd1, offIfd1, 0);
  for (const [e, o] of external) e.data!.copy(buf, o);

  return buf;
}

/* ===========================================================================
   XMP, IPTC AND THE CONTAINERS
   =========================================================================== */

/* A packet holding location three ways — an attribute, a nested structure and a
   simple element — plus two things that MUST survive. The `é` is deliberate: it
   is two UTF-8 bytes and one latin1-decoded pair, and it is the case
   `blankXmpLocation()`'s header says the latin1 choice exists for. */
const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
    exif:GPSLatitude="11,6.66000N"
    exif:GPSLongitude="22,13.32000E"
    photoshop:DateCreated="2026-01-01">
   <Iptc4xmpExt:LocationCreated>
    <rdf:Bag><rdf:li>a place that is not real</rdf:li></rdf:Bag>
   </Iptc4xmpExt:LocationCreated>
   <photoshop:City>Nowhere</photoshop:City>
   <dc:creator><rdf:Seq><rdf:li>a caméra</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/** An IIM stream: 2:90 City and 2:101 Country go, 2:120 Caption stays. */
function iptcBlock(): Bytes {
  const ds = (record: number, dataset: number, value: string) => {
    const v = Buffer.from(value, 'latin1');
    const h = Buffer.alloc(5);
    h[0] = 0x1c;
    h[1] = record;
    h[2] = dataset;
    h.writeUInt16BE(v.length, 3);
    return Buffer.concat([h, v]);
  };
  return Buffer.concat([
    Buffer.from('Photoshop 3.0\0', 'latin1'),
    Buffer.from('8BIM', 'latin1'),
    ds(2, 90, 'Nowhere City'),
    ds(2, 101, 'Atlantis'),
    ds(2, 120, 'a caption that must survive'),
  ]);
}

const EXIF_PREFIX = Buffer.from('Exif\0\0', 'latin1');
const XMP_PREFIX = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');

/** Distinctive "compressed image data", so a pixel change is visible. */
const SCAN = Buffer.from('PIXELS-MUST-NOT-CHANGE'.repeat(8), 'latin1');

function app(marker: number, payload: Bytes): Bytes {
  const h = Buffer.alloc(4);
  h[0] = 0xff;
  h[1] = marker;
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}

function buildJpeg(opts: TiffOpts & { noXmp?: boolean; noIptc?: boolean } = {}): Bytes {
  const parts: Bytes[] = [Buffer.from([0xff, 0xd8])];
  parts.push(app(0xe1, Buffer.concat([EXIF_PREFIX, buildTiff(opts)])));
  if (!opts.noXmp) parts.push(app(0xe1, Buffer.concat([XMP_PREFIX, Buffer.from(XMP, 'utf8')])));
  if (!opts.noIptc) parts.push(app(0xed, iptcBlock()));
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02]), SCAN, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** A PNG text chunk payload: keyword, a NUL, then the text. */
function keyed(keyword: string, text: string): Bytes {
  return Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.alloc(1), Buffer.from(text, 'latin1')]);
}

function pngChunk(type: string, data: Bytes): Bytes {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, c]);
}

function buildPng(): Bytes {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  /* iTXt, uncompressed: keyword NUL, compressionFlag 0, compressionMethod 0,
     languageTag NUL, translatedKeyword NUL, then the packet. */
  const itxt = Buffer.concat([
    Buffer.from('XML:com.adobe.xmp\0', 'latin1'),
    Buffer.from([0, 0]),
    Buffer.from('\0\0', 'latin1'),
    Buffer.from(XMP, 'utf8'),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('eXIf', buildTiff()),
    pngChunk('iTXt', itxt),
    /* The keyword separator is a REAL NUL and it is load-bearing: without it
       the keyword parses as empty, PNG_LOCATION_KEYWORD never matches, and the
       chunk would survive for the wrong reason — a fixture that proves nothing.
       Written via keyed() rather than in the literal because a NUL escape
       followed by a DIGIT is a legacy octal escape, which node's type stripper
       refuses outright. That cost a run, so it is written down. */
    pngChunk('tEXt', keyed('GPSLatitude', '11.111')),
    pngChunk('tEXt', keyed('Author', 'somebody')),
    pngChunk('IDAT', SCAN),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function riffChunk(fourcc: string, data: Bytes): Bytes {
  const h = Buffer.alloc(8);
  h.write(fourcc, 0, 'latin1');
  h.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([h, data, pad]);
}

function buildWebp(): Bytes {
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    riffChunk('VP8 ', SCAN),
    riffChunk('EXIF', buildTiff()),
    riffChunk('XMP ', Buffer.from(XMP, 'utf8')),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/* ===========================================================================
   INDEPENDENT INSPECTORS

   Deliberately not the code under test. `stripTiffLocation()` deciding it removed
   the pointer is not evidence the pointer is gone.
   =========================================================================== */

/** Every tag in the IFD chain starting at IFD0, plus the IFD1 offset. */
function surveyTiff(tiff: Bytes): { tags: number[]; ifd0Count: number; ifd1At: number; ifd1Tags: number[] } {
  const le = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const walk = (off: number, into: number[]) => {
    if (!off || off + 2 > tiff.length) return 0;
    const n = u16(off);
    if (n > 512 || off + 2 + n * 12 + 4 > tiff.length) return 0;
    for (let i = 0; i < n; i += 1) into.push(u16(off + 2 + i * 12));
    return u32(off + 2 + n * 12);
  };
  const tags: number[] = [];
  const ifd0 = u32(4);
  const ifd1At = walk(ifd0, tags);
  const ifd1Tags: number[] = [];
  walk(ifd1At, ifd1Tags);
  return { tags, ifd0Count: u16(ifd0), ifd1At, ifd1Tags };
}

/** The TIFF payload of a JPEG's Exif APP1, located independently of the module. */
function jpegTiff(jpeg: Bytes): Bytes {
  let p = 2;
  while (p + 4 <= jpeg.length) {
    if (jpeg[p] !== 0xff) break;
    const m = jpeg[p + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = jpeg.readUInt16BE(p + 2);
    const payload = jpeg.subarray(p + 4, p + 2 + len);
    if (m === 0xe1 && payload.subarray(0, 6).equals(EXIF_PREFIX)) return payload.subarray(6);
    p += 2 + len;
  }
  return Buffer.alloc(0);
}

/** The scan data, so "pixels untouched" is a comparison and not a hope. */
function jpegScan(jpeg: Bytes): Bytes {
  const at = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  return at < 0 ? Buffer.alloc(0) : jpeg.subarray(at);
}

/** Do the coordinate bytes the fixture wrote still exist anywhere in here? */
const LAT_BYTES = rationals(LAT_DMS);
const LON_BYTES = rationals(LON_DMS);
const carriesCoordBytes = (b: Bytes) => b.includes(LAT_BYTES) || b.includes(LON_BYTES);

/* ===========================================================================
   1. THE FIXTURE IS REAL — checked by the parser the upload endpoint uses
   =========================================================================== */
console.log('\n  --- 1. the fixtures really carry GPS, per src/lib/us/exif.ts ---');
{
  is('the independent CRC matches the standard vector', crc(Buffer.from('123456789')) === 0xcbf43926);
  is('and agrees with the module under test', crc(Buffer.from('123456789')) === crc32UnderTest(Buffer.from('123456789')));

  const jpeg = buildJpeg();
  const c = readCoords(jpeg);
  is('JPEG: readCoords finds a point', c !== null, c);
  is('JPEG: latitude is 11.111', near(c?.lat, LAT), c?.lat);
  is('JPEG: longitude is 22.222', near(c?.lon, LON), c?.lon);

  const p = readCoords(buildPng());
  is('PNG eXIf: latitude is 11.111', near(p?.lat, LAT), p?.lat);
  is('PNG eXIf: longitude is 22.222', near(p?.lon, LON), p?.lon);

  const w = readCoords(buildWebp());
  is('WebP EXIF: latitude is 11.111', near(w?.lat, LAT), w?.lat);
  is('WebP EXIF: longitude is 22.222', near(w?.lon, LON), w?.lon);

  /* The bytes are findable, which is what makes the removal assertions mean
     something. If this ever failed, "the coordinates are gone" would be true of
     a file that never held them. */
  is('the raw rational bytes are present to begin with', carriesCoordBytes(jpeg));

  const survey = surveyTiff(jpegTiff(jpeg));
  is('IFD0 holds six entries including the GPS pointer', survey.ifd0Count === 6, survey.ifd0Count);
  is('the GPS pointer is one of them', survey.tags.includes(TAG_GPS_IFD), survey.tags.map((t) => t.toString(16)));
  is('IFD1 is reachable and has its tag', survey.ifd1Tags.includes(TAG_IMAGE_WIDTH), survey.ifd1Tags);

  /* A fixture with no GPS must read as null, or the reader is answering from
     something other than the GPS block. */
  is('a fixture built without GPS reads as null', readCoords(buildJpeg({ noGps: true })) === null);
}

/* ===========================================================================
   2. THE STRIP — JPEG
   =========================================================================== */
console.log('\n  --- 2. JPEG: location out, everything else byte-identical ---');
{
  const before = buildJpeg();
  const scanBefore = jpegScan(before);
  const r = stripLocation(before, 'jpg');
  const after = r.bytes;

  is('readCoords now answers null', readCoords(after) === null, readCoords(after));
  /* THE ASSERTION THIS WHOLE FILE IS FOR. Unlinking the pointer would satisfy
     the line above while leaving the coordinates in the bytes. */
  is('the rational bytes are GONE, not merely unreferenced', !carriesCoordBytes(after));
  is('length is preserved', after.length === before.length, `${after.length} vs ${before.length}`);
  is('pixels are untouched', jpegScan(after).equals(scanBefore));
  is('it says it removed EXIF GPS', r.removed.includes('jpeg:exif-gps'), r.removed);
  is('no warnings', r.warnings.length === 0, r.warnings);

  const survey = surveyTiff(jpegTiff(after));
  is('IFD0 is down to five entries', survey.ifd0Count === 5, survey.ifd0Count);
  is('the GPS pointer is gone from IFD0', !survey.tags.includes(TAG_GPS_IFD), survey.tags.map((t) => t.toString(16)));

  /* The two tags the exporter's header PROMISES to keep, because losing them is
     a visible bug rather than a privacy nicety. */
  is('Orientation survives', survey.tags.includes(TAG_ORIENTATION));
  is('DateTime survives', survey.tags.includes(TAG_DATETIME));
  is('Make survives', survey.tags.includes(TAG_MAKE));
  is('the ExifIFD pointer survives', survey.tags.includes(TAG_EXIF_IFD));
  is('DateTimeOriginal survives inside ExifIFD', after.includes(Buffer.from(WHEN, 'latin1')));
  is('the camera make is still readable', after.includes(Buffer.from('TESTCAM', 'latin1')));

  /* The subtle one: removing an entry moves the next-IFD pointer, so a wrong
     rewrite orphans the thumbnail directory and nothing about the coordinates
     would show it. */
  is('IFD1 is still reachable after the entry removal', survey.ifd1Tags.includes(TAG_IMAGE_WIDTH), survey.ifd1Tags);

  /* XMP carried the same location independently. A strip that cleaned EXIF and
     left this would be a fix that does not fix it. */
  const text = after.toString('latin1');
  is('XMP exif:GPSLatitude is blanked', !text.includes('exif:GPSLatitude'));
  is('XMP exif:GPSLongitude is blanked', !text.includes('exif:GPSLongitude'));
  is('XMP LocationCreated is blanked', !text.includes('LocationCreated'));
  is('XMP photoshop:City is blanked', !text.includes('photoshop:City'));
  is('the place name inside it is gone too', !text.includes('a place that is not real'));
  is('XMP dc:creator survives', text.includes('dc:creator'));
  is('a non-location date survives', text.includes('photoshop:DateCreated'));
  is('the multi-byte character survives intact', after.includes(Buffer.from('a caméra', 'utf8')));
  is('it says it blanked XMP location', r.removed.some((x: string) => x.startsWith('jpeg:xmp-location')), r.removed);

  is('IPTC City is blanked', !text.includes('Nowhere City'));
  is('IPTC Country is blanked', !text.includes('Atlantis'));
  is('IPTC Caption survives', text.includes('a caption that must survive'));
  is('it says it blanked IPTC location', r.removed.some((x: string) => x.startsWith('jpeg:iptc-location')), r.removed);

  /* Still a JPEG: SOI, one EOI at the end, marker chain intact enough that an
     independent walk finds the Exif APP1 it is supposed to. */
  is('still starts with SOI', after[0] === 0xff && after[1] === 0xd8);
  is('still ends with EOI', after[after.length - 2] === 0xff && after[after.length - 1] === 0xd9);
  is('the Exif APP1 is still locatable', jpegTiff(after).length > 8);
}

/* ===========================================================================
   3. THE STRIP — PNG and WebP
   =========================================================================== */
console.log('\n  --- 3. PNG and WebP ---');
{
  const before = buildPng();
  const r = stripLocation(before, 'png');
  const after = r.bytes;
  const text = after.toString('latin1');

  is('PNG: readCoords answers null', readCoords(after) === null, readCoords(after));
  is('PNG: the rational bytes are gone', !carriesCoordBytes(after));
  is('PNG: the GPS tEXt chunk is dropped whole', !text.includes('GPSLatitude'));
  is('PNG: a non-location tEXt survives', text.includes('Author'));
  is('PNG: XMP location is blanked', !text.includes('LocationCreated'));
  is('PNG: IDAT survives', after.includes(SCAN));
  /* The exporter's header calls this out: PNG is the one format whose output may
     be SHORTER, because a whole chunk can go. Asserting equality here would
     encode the opposite of the documented behaviour. */
  is('PNG: output is shorter, as documented', after.length < before.length, `${after.length} vs ${before.length}`);

  /* Every chunk must still be correctly sealed — a re-CRC'd eXIf and an
     untouched IDAT alike. This is checked with the independent CRC. */
  let p = 8,
    chunks = 0,
    badCrc = 0;
  while (p + 12 <= after.length) {
    const len = after.readUInt32BE(p);
    const body = after.subarray(p + 4, p + 8 + len);
    if (after.readUInt32BE(p + 8 + len) !== crc(body)) badCrc += 1;
    chunks += 1;
    if (after.toString('latin1', p + 4, p + 8) === 'IEND') break;
    p += 12 + len;
  }
  is('PNG: every chunk CRC is valid', badCrc === 0, `${badCrc} bad of ${chunks}`);
  is('PNG: the chunk walk reached IEND', chunks >= 5, chunks);

  const wBefore = buildWebp();
  const w = stripLocation(wBefore, 'webp');
  const wAfter = w.bytes;
  is('WebP: readCoords answers null', readCoords(wAfter) === null, readCoords(wAfter));
  is('WebP: the rational bytes are gone', !carriesCoordBytes(wAfter));
  is('WebP: length is preserved', wAfter.length === wBefore.length, `${wAfter.length} vs ${wBefore.length}`);
  is('WebP: the RIFF size field is still truthful', wAfter.readUInt32LE(4) === wAfter.length - 8);
  is('WebP: VP8 pixel data survives', wAfter.includes(SCAN));
  is('WebP: XMP location is blanked', !wAfter.toString('latin1').includes('LocationCreated'));
  is('WebP: it says it removed EXIF GPS', w.removed.includes('webp:exif-gps'), w.removed);
}

/* ===========================================================================
   4. FAIL-SAFE — the direction the surgery is allowed to fail in

   The section header in strip-location.mjs is explicit that a corrupted
   photograph is strictly worse than one that still knows where it was taken. So
   anything unfamiliar must leave the bytes alone AND say so.
   =========================================================================== */
console.log('\n  --- 4. when it cannot parse, it gives up and says so ---');
{
  const broken = buildJpeg({ breakGps: true });
  const r = stripLocation(broken, 'jpg');
  is('a GPS pointer into nowhere is refused', r.warnings.some((w: string) => /did not parse/.test(w)), r.warnings);
  is('and nothing is claimed as removed from EXIF', !r.removed.includes('jpeg:exif-gps'), r.removed);
  /* THE TIFF BLOCK is what must be untouched — not the whole file. The first
     version of this assertion demanded the entire JPEG come back byte-identical
     and failed, which looked like a bug in the strip and was a bug in the test:
     a refusal in the EXIF surgery does NOT abandon the XMP and IPTC passes, and
     it should not. Those are independent copies of the same location, and giving
     up on all three because one directory is malformed would leave location in a
     file that is about to be handed to a stranger. */
  is('the TIFF block itself is left exactly alone', jpegTiff(r.bytes).equals(jpegTiff(broken)));
  is('the coordinates therefore DO survive an unparseable IFD', carriesCoordBytes(r.bytes));
  is('but XMP location is still cleaned', !r.bytes.toString('latin1').includes('exif:GPSLatitude'));
  is('and IPTC location is still cleaned', !r.bytes.toString('latin1').includes('Nowhere City'));

  const gif = Buffer.from('GIF89a' + 'x'.repeat(64), 'latin1');
  const g = stripLocation(gif, 'gif');
  is('an unsupported extension warns rather than guessing', g.warnings.some((w: string) => /no strip support/.test(w)), g.warnings);
  is('and returns the bytes untouched', g.bytes.equals(gif));

  const notJpeg = Buffer.from('this is not an image at all', 'latin1');
  is('a non-JPEG under .jpg is left alone', stripLocation(notJpeg, 'jpg').bytes.equals(notJpeg));

  is('a truncated TIFF is refused', stripTiffLocation(Buffer.alloc(4)).changed === false);
  is('a TIFF with no byte-order mark is refused', stripTiffLocation(Buffer.from('XXXX0000', 'latin1')).changed === false);
  const badMagic = buildTiff();
  badMagic.writeUInt16LE(43, 2);
  is('a TIFF whose magic is not 42 is refused', stripTiffLocation(badMagic).changed === false);

  /* Idempotence. A folder can be re-exported, and a second strip of an already
     stripped file must be a no-op rather than a second round of surgery. */
  const once = stripLocation(buildJpeg(), 'jpg').bytes;
  const twice = stripLocation(once, 'jpg');
  is('stripping twice changes nothing the second time', twice.bytes.equals(once));
  is('the EXIF pass correctly finds nothing left to do', !twice.removed.includes('jpeg:exif-gps'), twice.removed);
  is('nor does XMP', !twice.removed.some((x: string) => x.startsWith('jpeg:xmp')), twice.removed);
  /* THE BYTES ARE IDEMPOTENT; THE REPORT IS NOT, and this asserts the imprecision
     rather than hiding it. `blankIptcLocation()` overwrites a location dataset's
     value with SPACES instead of removing the dataset (deliberately — a dataset's
     length is part of its header, so removing one would move every following
     byte). A second pass therefore still SEES 2:90 and 2:101, writes spaces over
     spaces, and reports a change it did not make.
     Harmless where it is used: the exporter always strips freshly-downloaded R2
     bytes, so a second pass over an already-stripped file never happens, and
     `removed` only feeds the manifest and the printed summary — never a decision.
     Written down because the summary IS read as meaningful ("3 of 12 ... correct
     rather than a bug"), so anyone who makes this reachable should make it
     truthful first: skip a dataset whose value is already all 0x20. */
  is('IPTC re-reports a blank it did not change (known, unreachable)', twice.removed.some((x: string) => x.startsWith('jpeg:iptc-location')), twice.removed);

  /* A file with no location at all is identical in both modes, which the
     exporter's resume logic depends on. */
  const clean = buildJpeg({ noGps: true, noXmp: true, noIptc: true });
  is('a file with no location is returned byte-identical', stripLocation(clean, 'jpg').bytes.equals(clean));

  /* The spec says a GPS pointer only appears in IFD0. strip-location descends
     into ExifIFD anyway, and this is the only thing that proves it. */
  const stray = buildJpeg({ strayGpsInExif: true });
  is('a stray GPS pointer in ExifIFD is found too', readCoords(stripLocation(stray, 'jpg').bytes) === null);
  is('and its bytes are gone as well', !carriesCoordBytes(stripLocation(stray, 'jpg').bytes));

  /* XMP blanking must never change length — the segment length around it is not
     recomputed, so a shrink would corrupt the container silently.

     `buf` and `hits` are checked for existence rather than assumed, and that is
     not defensive noise: blankXmpLocation's REFUSAL branch returns
     `{ changed: false, why }` with no `buf` at all, so a non-null check here is
     the difference between "it preserved the length" and "it declined and this
     assertion read undefined". astro check spotted it; the test was wrong. */
  const packet = Buffer.from(XMP, 'utf8');
  const x = blankXmpLocation(packet);
  is('XMP blanking did not refuse', x.why === null && x.buf !== undefined, x.why);
  is('XMP blanking preserves byte length exactly', x.buf?.length === packet.length, `${x.buf?.length} vs ${packet.length}`);
  is('XMP blanking reports what it hit', (x.hits?.length ?? 0) >= 4, x.hits?.length);
}

/* ===========================================================================
   5. MUTATION — does this file NOTICE when the strip is broken?

   `CLAUDE.md`: a checker that cannot fail is read as coverage. The other guards
   in this repo were mutation-checked by hand and the result written into a doc.
   That works once. Here the mutation is applied to the module's SOURCE in memory
   and loaded from a `data:` URL, so it re-runs on every invocation and cannot
   quietly stop being true — which is why `strip-location.mjs` imports `Buffer`
   explicitly instead of taking it off the global.

   Each mutant is a plausible way to get this wrong, not a random character edit.
   =========================================================================== */
console.log('\n  --- 5. mutation: the assertions above must fail when the strip is broken ---');
{
  const SRC = readFileSync(new URL('./lib/strip-location.mjs', import.meta.url), 'utf8');

  const load = async (src: string) =>
    (await import(`data:text/javascript,${encodeURIComponent(src)}`)) as {
      stripLocation: (b: Bytes, e: string) => { bytes: Bytes; removed: string[]; warnings: string[] };
    };

  const mutants: Array<{
    name: string;
    apply: (s: string) => string;
    /** What SHOULD go wrong. Returns true when the damage is detected. */
    caught: (out: Bytes, r: { removed: string[]; warnings: string[] }) => boolean;
  }> = [
    {
      /* The half-fix zeroIfd's comment warns about: unlink the pointer, leave the
         coordinates in the file. readCoords would say null and the file would
         still hold the place. */
      name: 'zeroIfd does nothing (pointer unlinked, coordinates left behind)',
      apply: (s) => s.replace('function zeroIfd(buf, off, io) {', 'function zeroIfd(buf, off, io) { return true;'),
      caught: (out) => carriesCoordBytes(out),
    },
    {
      /* Zero the GPS IFD but leave the pointer entry in IFD0. A normal reader
         then walks into a zeroed directory. */
      name: 'the GPS pointer entry is never removed from IFD0',
      apply: (s) => s.replace('removeIfdEntry(buf, off, i, io.u16(buf, off), io);', ''),
      caught: (out) => surveyTiff(jpegTiff(out)).tags.includes(TAG_GPS_IFD),
    },
    {
      /* Skip the external value data and zero only the entries. The rationals
         live outside the IFD, so this is the mutation that looks most correct. */
      name: 'zeroIfd skips the external value data the entries point at',
      apply: (s) => s.replace('if (size > 4) {', 'if (false) {'),
      caught: (out) => carriesCoordBytes(out),
    },
    {
      name: 'XMP location is left alone',
      apply: (s) => s.replace('function blankXmpLocation(buf) {', 'function blankXmpLocation(buf) { return { changed: false, buf, hits: [], why: null };'),
      caught: (out) => out.toString('latin1').includes('exif:GPSLatitude'),
    },
    {
      name: 'IPTC location is left alone',
      apply: (s) => s.replace('function blankIptcLocation(buf) {', 'function blankIptcLocation(buf) { return { changed: false, hits: [] };'),
      caught: (out) => out.toString('latin1').includes('Nowhere City'),
    },
    {
      /* removeIfdEntry rewriting the next-IFD pointer at the wrong place. This is
         the one no coordinate assertion could ever catch. */
      name: 'removeIfdEntry forgets to move the next-IFD pointer',
      apply: (s) => s.replace('io.w32(buf, newNext, nextVal);', ''),
      caught: (out) => !surveyTiff(jpegTiff(out)).ifd1Tags.includes(TAG_IMAGE_WIDTH),
    },
    {
      /* A re-encode instead of surgery: the thing the exporter must never do. */
      name: 'the scan data is disturbed',
      apply: (s) => s.replace('return { bytes: buf, removed, warnings };\n}\n\n/** PNG chunk CRC', 'buf[buf.length - 3] ^= 0xff;\n  return { bytes: buf, removed, warnings };\n}\n\n/** PNG chunk CRC'),
      caught: (out) => !jpegScan(out).equals(jpegScan(buildJpeg())),
    },
  ];

  for (const m of mutants) {
    const src = m.apply(SRC);
    if (src === SRC) {
      is(`MUTANT applied: ${m.name}`, false, 'the source pattern did not match — the mutation was a no-op');
      continue;
    }
    let out: Bytes, r: { removed: string[]; warnings: string[] };
    try {
      const mod = await load(src);
      const res = mod.stripLocation(buildJpeg(), 'jpg');
      out = res.bytes;
      r = res;
    } catch (e) {
      /* A mutant that cannot even load still counts as detected — the point is
         that a broken strip does not sail through. */
      is(`caught: ${m.name}`, true);
      continue;
    }
    is(`caught: ${m.name}`, m.caught(out, r), { removed: r.removed, warnings: r.warnings });
  }

  /* And the control: the UNMUTATED source, loaded the same way, must pass. If
     this fails the mutation harness is testing its own plumbing, not the strip. */
  const control = await load(SRC);
  const c = control.stripLocation(buildJpeg(), 'jpg');
  is('control: the unmutated module still strips cleanly', !carriesCoordBytes(c.bytes) && readCoords(c.bytes) === null);
}

console.log(`\n  ${fail ? 'FAILED' : 'all good'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
