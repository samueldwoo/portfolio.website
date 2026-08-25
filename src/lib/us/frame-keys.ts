/**
 * frame-keys.ts — where a photograph's bytes live, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE
 *
 * It was three functions inside frames.ts, which is the natural place for them and
 * the wrong one. frames.ts imports the R2 client, the Upstash config and the
 * geocoder, so anything that wanted to check the key arithmetic had to load all of
 * that first — and on 2026-08-24 the way this project checked the key arithmetic
 * was to perform a real upload, which destroyed the only copy of a real photograph.
 *
 * So the rule this file encodes is: THE PART THAT DECIDES WHICH OBJECT GETS
 * WRITTEN MUST BE PROVABLE WITHOUT A CREDENTIAL. Everything here is pure. There is
 * no import that can reach a network, a bucket or an environment variable — the one
 * import is a type, which the compiler erases. `npm run test:frames-key` therefore
 * cannot write a byte no matter how wrong it is, which is the property the incident
 * showed was missing.
 *
 * frames.ts re-exports all three, so callers are unaffected.
 *
 * ---------------------------------------------------------------------------
 * THE LAYOUT, AND THE ONE THAT CAME BEFORE IT
 *
 *   now     frames/<date>/<who>-<atMs>.<ext>
 *   before  frames/<date>/<who>.<ext>
 *
 * The old one is a pure function of the day and the person, so a second upload for
 * a day computed the same string as the first and R2 — which has no versioning —
 * replaced the object. The millisecond removes the collision instead of documenting
 * it. Both layouts are still READ, because the photographs written before the
 * change are at the old one and are not worth breaking for tidiness.
 */
import type { Who } from './together';

/** Shared by both builders, so the two layouts cannot drift on their guards. */
function guardKeyParts(date: string, who: Who, ext: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`frames: refusing to build a key from a non-date: ${JSON.stringify(date)}`);
  }
  if (who !== 'her' && who !== 'him') {
    throw new Error(`frames: refusing to build a key for: ${JSON.stringify(who)}`);
  }
  if (!/^(jpg|png|webp)$/.test(ext)) {
    throw new Error(`frames: refusing to build a key with extension: ${JSON.stringify(ext)}`);
  }
}

/**
 * THE LEGACY KEY — no longer written, still read.
 *
 * Nothing calls this to WRITE any more; frameKeyAt() does that. It stays because
 * the records written before `<who>Key` existed have no stored key and their bytes
 * are at this layout. Deleting it would make real photographs unreachable in order
 * to tidy up, which is the wrong trade in a feature whose whole subject is not
 * losing them. keyFromHash() is the only caller.
 *
 * Every component is server-derived: `date` comes from wingDate(), `who` from the
 * session cookie, `ext` from sniff(). None can carry a `/`, a `.` or a `%`, so this
 * cannot be walked out of its prefix — asserted rather than assumed, because the
 * whole safety of this feature rests on it.
 */
export function frameKey(date: string, who: Who, ext: string): string {
  guardKeyParts(date, who, ext);
  return `frames/${date}/${who}.${ext}`;
}

/**
 * THE KEY EVERY NEW UPLOAD GETS — unique, so an overwrite cannot be expressed.
 *
 * The millisecond is what makes it safe: two uploads cannot share one, so a second
 * photograph on a day lands BESIDE the first instead of on top of it. The old
 * object stops being referenced and keeps existing, which is the entire point —
 * "swap the photo" becomes a pointer move rather than a destruction, and there is
 * no input any caller can supply that reaches somebody else's bytes.
 *
 * WHY THE TIMESTAMP AND NOT A RANDOM SUFFIX. `atMs` is already stored on the hash
 * as `<who>At`, so it needs no new field, and it sorts: a listing of a day's prefix
 * reads in the order the photographs were taken, which a random suffix would
 * scramble at exactly the moment somebody is recovering one by hand.
 *
 * THE ORPHANS ARE DELIBERATE AND ARE NOT A LEAK. A superseded object is a
 * photograph one of them chose to send, and it now survives a swap. frames-export
 * lists and exports them, so they are recoverable rather than merely present. At
 * two frames a day against R2's 10GB free tier, the cost of keeping every version
 * is not a number worth computing.
 */
export function frameKeyAt(date: string, who: Who, ext: string, atMs: number): string {
  guardKeyParts(date, who, ext);
  /* A non-positive or fractional atMs would put a `-0`, a bare `-` or a second dot
     in the suffix — and `-0` is deterministic again, which is the bug this function
     exists to remove. frame.ts passes Date.now(), so a throw here means a real
     defect upstream rather than a reachable user path. The upper bound keeps the
     suffix at most 13 digits (through the year 2286) so keyFromHash()'s pattern can
     stay exact rather than open-ended. */
  if (!Number.isInteger(atMs) || atMs <= 0 || atMs > 9_999_999_999_999) {
    throw new Error(`frames: refusing to build a key at: ${JSON.stringify(atMs)}`);
  }
  return `frames/${date}/${who}-${atMs}.${ext}`;
}

/**
 * WHICH OBJECT A STORED RECORD POINTS AT — and the read path's security boundary.
 *
 * ---------------------------------------------------------------------------
 * A KEY OUT OF THE STORE IS UNTRUSTED INPUT, EVEN THOUGH WE PUT IT THERE
 *
 * The result is handed to presignedUrl(), so whatever this returns gets signed with
 * the bucket credential and given to a browser. A stored key used verbatim would
 * therefore be an arbitrary-object-read against a private bucket, gated only on the
 * store never being wrong — and frameFrom() already refuses to make that assumption
 * for coordinates and for `ext`, on the stated grounds that the store is not a
 * validation boundary. A key is the sharpest version of that.
 *
 * So the pattern is built from the date and person the CALLER asked for, and the
 * stored value has to match it. Parsing the stored string and trusting what it
 * claims about itself would defeat the purpose. A key for another day, another
 * person, another prefix, or with a `..` in it is not repaired — it is discarded,
 * and the legacy fallback answers instead.
 *
 * ---------------------------------------------------------------------------
 * THE FALLBACK IS WHAT MAKES THIS CHANGE FREE OF A MIGRATION
 *
 * A record with no `<who>Key` was written before this existed, so its bytes are at
 * the legacy layout and that is what it resolves to — byte-identical to what the
 * old code computed. The photographs already in the bucket keep rendering with no
 * rename, no copy and no write of any kind against R2, which for a bucket that has
 * already lost a photograph is the only acceptable way to migrate: don't.
 */
export function keyFromHash(
  h: Record<string, string>,
  who: Who,
  date: string,
  ext: string,
): string {
  const stored = h[`${who}Key`] ?? '';
  if (stored) {
    const expected = new RegExp(`^frames/${date}/${who}(-\\d{1,13})?\\.(jpg|png|webp)$`);
    if (expected.test(stored)) return stored;
    /* Loud, because the only ways to get here are a corrupted hash and a bug, and
       both want a human. Not fatal: the fallback still shows a photograph, and a
       blank frame would be a worse answer to "something is off with the metadata".
       The key itself is not printed — it is the untrusted value, and a log line is
       outside the gate that protects everything else here. */
    console.error(`[us] ignoring an out-of-shape stored key for ${who} on ${date}`);
  }
  return frameKey(date, who, ext);
}
