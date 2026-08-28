/* ===========================================================================
   strip-location.mjs — remove location metadata from image bytes, and nothing
   else. Lifted verbatim out of frames-export.mjs so that it can be TESTED.
   ===========================================================================

   ---------------------------------------------------------------------------
   WHY IT MOVED, WHICH IS THE ONLY THING THIS HEADER ADDS

   `PLAN.md` §6 listed GPS stripping as never verified, and the reason it had
   never been verified was structural rather than neglect: this code lived in the
   middle of `frames-export.mjs`, a straight-line script that reads `.env`, calls
   `assertLayout()` and ends in `process.exit()`. Importing it to test it would
   have RUN AN EXPORT. So there was no seam, and the only assurance was a runtime
   message printed during a real run against real photographs — which is the one
   thing this project must not do to check its own work.

   Moving it is the same move already made for `frame-keys.ts`, `day-seal.ts` and
   `who-words.ts`: the pure logic goes in a module with no I/O and no
   dependencies, and the script keeps the I/O. See `scripts/test-strip-location.mts`.

   THE REJECTED ALTERNATIVE was a `--self-test` flag on the exporter. It would
   have kept everything in one file, and it would have meant the test could only
   ever run the paths the exporter reaches, in the order it reaches them, with no
   way to feed a deliberately corrupt IFD or to mutate the implementation and
   confirm the assertions notice. A flag inside the thing under test also cannot
   fail loudly when the thing under test is what is broken.

   NOTHING ABOUT THE BEHAVIOUR CHANGED. The functions below are byte-for-byte the
   ones that were in the exporter; the argument for how they work — length
   preservation, zeroing before unlinking, what MakerNote means, why XMP is
   handled as latin1 — is in `frames-export.mjs`'s own header, which is still its
   only home. Do not restate it here.

   PURE BY CONTRACT: no fs, no network, no argv, no console. `Buffer` is the only
   dependency, imported explicitly rather than taken off the global so that this
   module also loads from a `data:` URL — which is how the mutation testing in
   the test works.
   =========================================================================== */

import { Buffer } from 'node:buffer';

/* ===========================================================================
   LOCATION SURGERY — only reached with --strip-location. See the header for the
   whole argument; this section is the mechanics.

   EVERY FUNCTION HERE IS FAIL-SAFE IN ONE DIRECTION: when anything looks
   unfamiliar it gives up and reports that it gave up, leaving the bytes alone.
   The failure mode of a bug in this code would be a corrupted photograph, which
   is strictly worse than a photograph that still knows where it was taken. So
   there is no "best effort" repair anywhere below — either the structure parses
   exactly as expected or the file is passed through and the run says so.
   =========================================================================== */

/** TIFF value sizes by type code. Index is the type; 0 means "unknown type". */
const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** The GPSInfo IFD pointer in IFD0. This one tag is the whole EXIF location story. */
const TAG_GPS_IFD = 0x8825;
/** The ExifIFD pointer, followed only so a stray GPS pointer inside it is caught too. */
const TAG_EXIF_IFD = 0x8769;

/** Endianness-aware accessors, chosen once from the TIFF header. */
function tiffIO(le) {
  return {
    u16: (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)),
    u32: (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o)),
    w16: (b, o, v) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o)),
    w32: (b, o, v) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o)),
  };
}

/**
 * Zero one IFD and everything it points at, in place.
 *
 * External value data is zeroed FIRST, because the offsets that say where it
 * lives are inside the entries this then overwrites. Get that order wrong and
 * the coordinates stay in the file with nothing left pointing at them — removed
 * from a parser's view but still sitting in the bytes, which is exactly the kind
 * of half-fix this flag must not be.
 */
function zeroIfd(buf, off, io) {
  if (off + 2 > buf.length) return false;
  const count = io.u16(buf, off);
  const end = off + 2 + count * 12 + 4;
  if (count === 0 || count > 512 || end > buf.length) return false;

  for (let i = 0; i < count; i += 1) {
    const e = off + 2 + i * 12;
    const type = io.u16(buf, e + 2);
    const n = io.u32(buf, e + 4);
    const size = (TIFF_TYPE_SIZE[type] ?? 0) * n;
    if (size > 4) {
      const vOff = io.u32(buf, e + 8);
      if (vOff + size > buf.length) return false;
      buf.fill(0, vOff, vOff + size);
    }
  }
  buf.fill(0, off, end);
  return true;
}

/**
 * Remove entry `idx` from the IFD at `off`, without moving any other byte.
 *
 * The trick, and the reason this is safe on files with MakerNote: an IFD is
 * [count][entry * count][nextIFD], and every VALUE lives at an absolute offset
 * somewhere else. Shrinking the entry array therefore moves only the next-IFD
 * pointer; it invalidates nothing. The twelve bytes freed at the end become
 * slack that no offset and no count reaches.
 */
function removeIfdEntry(buf, off, idx, count, io) {
  const first = off + 2 + idx * 12;
  const after = first + 12;
  const tail = count - 1 - idx;
  const oldNext = off + 2 + count * 12;
  const nextVal = io.u32(buf, oldNext);

  if (tail > 0) buf.copy(buf, first, after, after + tail * 12);
  io.w16(buf, off, count - 1);
  const newNext = off + 2 + (count - 1) * 12;
  io.w32(buf, newNext, nextVal);
  buf.fill(0, newNext + 4, oldNext + 4);
}

/**
 * Strip GPS from a raw TIFF block (the payload of an Exif APP1, a PNG eXIf
 * chunk, or a WebP EXIF chunk). Mutates `buf`. Length never changes.
 *
 * Walks the IFD0 chain and also descends into ExifIFD. By the specification a
 * GPS pointer only appears in IFD0, but a pointer costs four bytes to check and
 * "the spec says it cannot be there" is not a reason to leave location data in a
 * file whose whole purpose is to be handed to a stranger.
 */
function stripTiffLocation(buf) {
  if (buf.length < 8) return { changed: false, why: 'tiff shorter than its header' };
  const bom = buf.readUInt16BE(0);
  if (bom !== 0x4949 && bom !== 0x4d4d) return { changed: false, why: 'not a TIFF byte-order mark' };
  const io = tiffIO(bom === 0x4949);
  if (io.u16(buf, 2) !== 42) return { changed: false, why: 'TIFF magic is not 42' };

  let changed = false;
  const queue = [io.u32(buf, 4)];
  const seen = new Set();

  while (queue.length) {
    const off = queue.shift();
    if (!off || off + 2 > buf.length || seen.has(off)) continue;
    seen.add(off);
    const count = io.u16(buf, off);
    if (count === 0 || count > 512 || off + 2 + count * 12 + 4 > buf.length) continue;

    /* Scanned back to front. Removing an entry shifts the ones after it, so
       walking forwards would renumber the indices still to be visited. */
    for (let i = count - 1; i >= 0; i -= 1) {
      const e = off + 2 + i * 12;
      const tag = io.u16(buf, e);
      if (tag === TAG_EXIF_IFD) {
        queue.push(io.u32(buf, e + 8));
      } else if (tag === TAG_GPS_IFD) {
        const gpsOff = io.u32(buf, e + 8);
        // Zero the pointed-at IFD first; if that fails the pointer is left in
        // place, because a dangling pointer to live coordinates is worse than
        // an intact one that at least a normal tool will show you.
        if (!zeroIfd(buf, gpsOff, io)) return { changed, why: 'GPS IFD did not parse; left alone' };
        removeIfdEntry(buf, off, i, io.u16(buf, off), io);
        changed = true;
      }
    }
    // Chain to the next IFD (thumbnail directory), read AFTER any removal above
    // so the pointer is taken from its new position.
    const cnt = io.u16(buf, off);
    queue.push(io.u32(buf, off + 2 + cnt * 12));
  }
  return { changed, why: null };
}

/* ---------------------------------------------------------------------------
   XMP

   Location shows up in XMP completely independently of EXIF — `exif:GPSLatitude`
   as an attribute, `Iptc4xmpExt:LocationCreated` as a nested structure,
   `photoshop:City` as either. A strip that cleaned EXIF and left XMP would be a
   fix that does not fix it, so both are handled and by the same function, since
   the XMP packet is textually identical inside JPEG, PNG and WebP.
   --------------------------------------------------------------------------- */

/** Property local-names that carry location. Matched under ANY namespace prefix. */
const XMP_LOCATION_NAMES =
  'GPS[A-Za-z0-9]*|LocationCreated|LocationShown|Location|City|Sublocation|' +
  'ProvinceState|State|CountryName|CountryCode|Country|WorldRegion|' +
  'GPano:PoseHeadingDegrees';

/**
 * Blank every location property in an XMP packet, preserving byte length.
 *
 * OPERATES ON LATIN-1, WHICH IS THE ONLY DETAIL THAT MATTERS HERE. The packet is
 * UTF-8 and may contain multi-byte characters; decoding as UTF-8 would make one
 * character out of several bytes, so replacing a match with that many SPACES
 * would shrink the packet and desynchronise the segment length. Latin-1 makes
 * one character exactly one byte, so a space-for-character substitution is also
 * a byte-for-byte substitution.
 *
 * Whitespace is a legal XMP padding and legal XML between elements, so the
 * result still parses. Elements are blanked whole, including their tags, so a
 * nested structure like LocationCreated goes in one piece.
 */
function blankXmpLocation(buf) {
  let text = buf.toString('latin1');
  const hits = [];
  const blank = (m) => {
    hits.push(m.slice(0, 40));
    return ' '.repeat(m.length);
  };

  const N = XMP_LOCATION_NAMES;
  // Order matters: whole elements first, so attributes nested inside a location
  // element are consumed with it rather than left behind as orphans.
  text = text.replace(new RegExp(`<([A-Za-z][\\w.-]*):(${N})\\b[^>]*?/>`, 'g'), blank);
  text = text.replace(
    new RegExp(`<([A-Za-z][\\w.-]*):(${N})\\b[^>]*>[\\s\\S]*?</\\1:\\2>`, 'g'),
    blank,
  );
  text = text.replace(new RegExp(`\\s[A-Za-z][\\w.-]*:(${N})\\s*=\\s*"[^"]*"`, 'g'), blank);
  text = text.replace(new RegExp(`\\s[A-Za-z][\\w.-]*:(${N})\\s*=\\s*'[^']*'`, 'g'), blank);

  const out = Buffer.from(text, 'latin1');
  if (out.length !== buf.length) {
    // Cannot happen with latin1, and asserted anyway: a length change here would
    // silently corrupt whatever container the packet sits in.
    return { changed: false, why: 'XMP blanking changed length; refused' };
  }
  return { changed: hits.length > 0, buf: out, hits, why: null };
}

/* ---------------------------------------------------------------------------
   IPTC-IIM, inside a JPEG APP13 / Photoshop image resource block

   A third, older place location hides: IIM datasets 2:90 City, 2:92 Sublocation,
   2:95 State, 2:100/101 Country. Not in the original brief, but leaving it would
   be the same shape of half-fix as leaving XMP, so it is handled.

   Values are overwritten with SPACES rather than the dataset being removed,
   because a dataset's length is part of its header and rewriting it would move
   every following byte in the resource block. A City of three spaces carries no
   location; that is the goal, and it is length-preserving.
   --------------------------------------------------------------------------- */
const IPTC_LOCATION_DATASETS = new Set([5, 26, 27, 90, 92, 95, 100, 101]);

function blankIptcLocation(buf) {
  const hits = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    if (buf[i] !== 0x1c) {
      i += 1;
      continue;
    }
    const record = buf[i + 1];
    const dataset = buf[i + 2];
    const len = buf.readUInt16BE(i + 3);
    // The extended form (high bit set) is vanishingly rare and would need
    // different arithmetic, so it is skipped rather than guessed at.
    if (len & 0x8000) break;
    const vStart = i + 5;
    if (vStart + len > buf.length) break;
    if (record === 2 && IPTC_LOCATION_DATASETS.has(dataset)) {
      hits.push(`iptc 2:${dataset}`);
      buf.fill(0x20, vStart, vStart + len);
    }
    i = vStart + len;
  }
  return { changed: hits.length > 0, hits };
}

/* ---------------------------------------------------------------------------
   CONTAINERS
   --------------------------------------------------------------------------- */

const EXIF_PREFIX = Buffer.from('Exif\0\0', 'latin1');
const XMP_PREFIX = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');

/** A TIFF block that may or may not carry the `Exif\0\0` prefix. */
function stripExifBlock(block, removed, warnings, label) {
  const hasPrefix = block.length > 6 && block.subarray(0, 6).equals(EXIF_PREFIX);
  const tiff = hasPrefix ? block.subarray(6) : block;
  const r = stripTiffLocation(tiff);
  if (r.changed) removed.push(`${label}:exif-gps`);
  else if (r.why) warnings.push(`${label}: ${r.why}`);
  return r.changed;
}

/**
 * JPEG. Walks the marker segments and stops at SOS — everything past it is
 * entropy-coded image data with no metadata in it, and is copied untouched.
 */
function stripJpeg(input) {
  const buf = Buffer.from(input);
  const removed = [];
  const warnings = [];
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { bytes: buf, removed, warnings: ['not a JPEG SOI; left alone'] };
  }

  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) {
      warnings.push(`lost marker alignment at ${i}; stopped scanning`);
      break;
    }
    const marker = buf[i + 1];
    // Standalone markers carry no length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) {
      warnings.push(`segment ff${marker.toString(16)} has an impossible length; stopped scanning`);
      break;
    }
    const payload = buf.subarray(i + 4, i + 2 + len);

    if (marker === 0xe1) {
      if (payload.length > 6 && payload.subarray(0, 6).equals(EXIF_PREFIX)) {
        stripExifBlock(payload, removed, warnings, 'jpeg');
      } else if (payload.length > XMP_PREFIX.length && payload.subarray(0, XMP_PREFIX.length).equals(XMP_PREFIX)) {
        const body = payload.subarray(XMP_PREFIX.length);
        const r = blankXmpLocation(body);
        if (r.changed) {
          r.buf.copy(body);
          removed.push(`jpeg:xmp-location(${r.hits.length})`);
        } else if (r.why) warnings.push(`jpeg xmp: ${r.why}`);
      }
    } else if (marker === 0xed) {
      const r = blankIptcLocation(payload);
      if (r.changed) removed.push(`jpeg:iptc-location(${r.hits.length})`);
    }
    i += 2 + len;
  }
  return { bytes: buf, removed, warnings };
}

/** PNG chunk CRC is over the type AND the data. */
function pngCrc(type, data) {
  return crc32(Buffer.concat([type, data]));
}

/** Table-driven CRC-32, so a chunk can be re-sealed after its payload changes. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** PNG keywords whose whole chunk is location and can go entirely. */
const PNG_LOCATION_KEYWORD = /^(GPS|Location|Geo|Coordinates)/i;

/**
 * PNG. Rebuilt chunk by chunk, which is safe because PNG chunks are
 * position-independent — unlike the TIFF above, nothing here points at a byte
 * offset. This is therefore the one format where a chunk can simply be dropped,
 * and the only one whose output may be shorter than the R2 object.
 */
function stripPng(input) {
  const buf = Buffer.from(input);
  const removed = [];
  const warnings = [];
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    return { bytes: buf, removed, warnings: ['not a PNG signature; left alone'] };
  }

  const out = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8);
    if (i + 12 + len > buf.length) {
      warnings.push('truncated PNG chunk; stopped scanning');
      out.push(buf.subarray(i));
      i = buf.length;
      break;
    }
    const name = type.toString('latin1');
    const data = Buffer.from(buf.subarray(i + 8, i + 8 + len));
    let keep = true;
    let touched = false;

    if (name === 'eXIf') {
      touched = stripExifBlock(data, removed, warnings, 'png');
    } else if (name === 'tEXt' || name === 'zTXt' || name === 'iTXt') {
      const z = data.indexOf(0);
      const keyword = z > 0 ? data.subarray(0, z).toString('latin1') : '';
      if (keyword === 'XML:com.adobe.xmp' && name === 'iTXt') {
        /* iTXt layout after the keyword NUL: compressionFlag, compressionMethod,
           languageTag NUL, translatedKeyword NUL, then the text. A compressed
           packet cannot be edited length-preservingly, so it is dropped whole
           rather than inflated and re-deflated — re-deflating would change the
           length anyway and there is no reason to carry a compressed XMP packet
           into a print job. */
        if (data[z + 1] !== 0) {
          keep = false;
          removed.push('png:xmp-compressed-dropped');
        } else {
          const langEnd = data.indexOf(0, z + 3);
          const transEnd = langEnd >= 0 ? data.indexOf(0, langEnd + 1) : -1;
          if (transEnd < 0) {
            warnings.push('png iTXt XMP header did not parse; left alone');
          } else {
            const body = data.subarray(transEnd + 1);
            const r = blankXmpLocation(body);
            if (r.changed) {
              r.buf.copy(body);
              removed.push(`png:xmp-location(${r.hits.length})`);
              touched = true;
            } else if (r.why) warnings.push(`png xmp: ${r.why}`);
          }
        }
      } else if (PNG_LOCATION_KEYWORD.test(keyword)) {
        keep = false;
        removed.push(`png:${name}-${keyword}-dropped`);
      }
    }

    if (keep) {
      const crc = touched ? pngCrc(type, data) : buf.readUInt32BE(i + 8 + len);
      const head = Buffer.alloc(4);
      head.writeUInt32BE(len, 0);
      const tail = Buffer.alloc(4);
      tail.writeUInt32BE(crc, 0);
      out.push(head, type, data, tail);
    }
    i += 12 + len;
    if (name === 'IEND') break;
  }
  if (i < buf.length) out.push(buf.subarray(i));
  return { bytes: Buffer.concat(out), removed, warnings };
}

/**
 * WebP. A RIFF container; the EXIF and XMP chunks are edited in place, and
 * because both edits are length-preserving the outer RIFF size stays correct and
 * the VP8X feature flags stay truthful (the chunks are still there, just blank).
 */
function stripWebp(input) {
  const buf = Buffer.from(input);
  const removed = [];
  const warnings = [];
  if (buf.length < 12 || buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WEBP') {
    return { bytes: buf, removed, warnings: ['not a RIFF/WEBP header; left alone'] };
  }

  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.subarray(i, i + 4).toString('latin1');
    const size = buf.readUInt32LE(i + 4);
    if (i + 8 + size > buf.length) {
      warnings.push('truncated WebP chunk; stopped scanning');
      break;
    }
    const data = buf.subarray(i + 8, i + 8 + size);
    if (fourcc === 'EXIF') {
      stripExifBlock(data, removed, warnings, 'webp');
    } else if (fourcc === 'XMP ') {
      const r = blankXmpLocation(data);
      if (r.changed) {
        r.buf.copy(data);
        removed.push(`webp:xmp-location(${r.hits.length})`);
      } else if (r.why) warnings.push(`webp xmp: ${r.why}`);
    }
    i += 8 + size + (size % 2);
  }
  return { bytes: buf, removed, warnings };
}

/** Dispatch on the extension, which is server-derived from a magic-number sniff. */
function stripLocation(bytes, ext) {
  if (ext === 'jpg') return stripJpeg(bytes);
  if (ext === 'png') return stripPng(bytes);
  if (ext === 'webp') return stripWebp(bytes);
  return { bytes: Buffer.from(bytes), removed: [], warnings: [`no strip support for .${ext}`] };
}

export {
  stripLocation,
  stripJpeg,
  stripPng,
  stripWebp,
  stripTiffLocation,
  blankXmpLocation,
  blankIptcLocation,
  zeroIfd,
  removeIfdEntry,
  crc32,
  pngCrc,
};
