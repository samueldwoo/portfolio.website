/* ===========================================================================
   trace.ts — one structured line per important operation.
   ===========================================================================

   ---------------------------------------------------------------------------
   WHY, AND WHAT IT COULD NOT ANSWER BEFORE

   She said an upload "seemed to be taking a long time", and there was no way to
   find out whether that was the 615KB crossing a Paris mobile connection, the R2
   write, or a cold function boot before a single byte was read. The endpoints
   logged only failures, so a slow success left no trace at all.

   Vercel captures stdout per invocation, so one line per operation is enough
   infrastructure for a two-person site. No log drain, no metrics service, no
   dashboards to maintain — `grep` on the deployment logs.

   ---------------------------------------------------------------------------
   IT IS STRUCTURALLY UNABLE TO LOG THEIR CONTENT

   This is the part that matters. Logs are the classic accidental leak: somebody
   adds `note` to a debug line, it ships, and now two people's private messages sit
   in a third party's log retention forever. The gate is the security boundary for
   the pages; a log file is outside it.

   Numbers and booleans pass freely. Strings must clear TWO independent tests, and
   the second one is the one that matters:

     1. SHAPE — at most 24 characters of letters, digits, dot, dash, underscore. That
        refuses a note, a caption, a song title, a place name or an answer, because
        all of those contain spaces or run long.

     2. THE KEY — strings are printed only under keys where this wing actually has an
        enumeration (`op`, `code`, `who`, `event`, `ext`, …). Everything else is
        reduced to its length.

   Test 2 exists because test 1 was not enough, and a test caught it: a real first
   name passed the shape check perfectly, being short and alphanumeric.
   Nothing about the SHAPE of a value distinguishes an outcome code from a person's
   name — and her name is deliberately absent from this repository so that it does
   not end up in exactly this kind of place.

   A refused value becomes `key=len:87`, which is usually the interesting part.

   None of this is a convention or a review rule. A future caller cannot leak content
   through here without first editing this file.

   ---------------------------------------------------------------------------
   AND IT CANNOT BREAK A REQUEST

   Every function is total. A logger that throws is worse than no logger: it turns
   an observation into an outage, on the exact code paths that were already
   struggling enough to be worth observing.
   =========================================================================== */

/** What a field is allowed to be. */
export type Field = string | number | boolean | null | undefined;

/**
 * Strings that are safe to print verbatim.
 *
 * Deliberately narrow: no spaces, so no sentence can pass. 24 characters, so no
 * URL, digest or base64 fragment can either.
 */
const SAFE = /^[A-Za-z0-9._-]{1,24}$/;

/**
 * THE KEYS THAT MAY CARRY A STRING AT ALL — and this allowlist exists because the
 * shape test alone was not enough.
 *
 * A test that tried to leak everything got a real first name straight through under
 * a `name` key: a first name is short and alphanumeric, so it satisfies SAFE
 * perfectly. Nothing about the SHAPE of a value distinguishes an outcome code from a
 * person's name — and hers is kept out of this source tree entirely (US_HER_NAME)
 * precisely so it cannot end up somewhere like a third party's log retention.
 *
 * Which it nearly did: the first draft of this comment named her, in a public repo,
 * inside the file arguing that her name must not be written down.
 *
 * So strings are permitted only under keys where this wing actually has an
 * enumeration. Every other key is reduced to its length, which is the honest
 * default: a field nobody designed to be printed probably should not be.
 */
const STRING_KEYS = new Set([
  'op',
  'code',
  'who',
  'to',
  'actor',
  'event',
  'ext',
  'kind',
  'reason',
  'tier',
  'status',
  'backend',
]);

function render(value: Field, key = ''): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    /* Rounded: sub-millisecond precision on a network timing is noise, and a long
       float is harder to read than the extra digits are worth.

       It has a second effect worth naming, because it is load-bearing rather than
       incidental: a latitude logged by mistake comes out at ~1km precision (48.84,
       not 48.839725). Nothing in the wing logs coordinates — the upload records
       `coords=1`, a boolean — but if something ever did, this blunts it. */
    return String(Math.round(value * 1000) / 1000);
  }
  if (typeof value === 'string') {
    /* BOTH tests, and the key one first: the shape says this COULD be printed, the
       key says whether it SHOULD be. Only the second stops a name. */
    if (SAFE.test(value) && STRING_KEYS.has(key)) return value;
    /* REFUSED, and its length substituted. A caller that logs `note` gets
       `note=len:87` rather than her sentence — which is the interesting part anyway,
       and is all that survives. */
    return `len:${value.length}`;
  }
  return null;
}

/**
 * One line, `[us] op=frame.post who=her ok=1 bytes=629730 totalMs=1190`.
 *
 * Key=value rather than JSON so it reads at a glance in Vercel's log viewer and
 * greps without a parser. `[us]` matches the prefix every other log in the wing
 * already uses, so one filter finds all of them.
 */
export function trace(op: string, data: Record<string, Field> = {}): void {
  try {
    const parts: string[] = [`op=${render(op, 'op') ?? 'unknown'}`];
    for (const [k, v] of Object.entries(data)) {
      const r = render(v, k);
      if (r !== null && SAFE.test(k)) parts.push(`${k}=${r}`);
    }
    console.log(`[us] ${parts.join(' ')}`);
  } catch {
    // A logger must never be the reason a request fails.
  }
}

/**
 * Start a stopwatch. `t.lap()` for a leg, `t.total()` for the whole thing.
 *
 * `lap()` resets the mark, so a sequence of legs sums to roughly the total without
 * the caller tracking timestamps. Both return whole milliseconds.
 *
 * Uses Date.now() rather than performance.now(): this measures network and storage
 * work in the hundreds of milliseconds, where the difference is irrelevant, and
 * Date.now() exists in every runtime the wing might be deployed to without a
 * feature check.
 */
export function timer(): { lap: () => number; total: () => number } {
  const started = Date.now();
  let mark = started;
  return {
    lap() {
      const now = Date.now();
      const d = now - mark;
      mark = now;
      return d;
    },
    total() {
      return Date.now() - started;
    },
  };
}
