/* ===========================================================================
   fresh.ts — how long a photograph stays on the page.
   ===========================================================================

   ---------------------------------------------------------------------------
   IT CLEARS AT 07:00 IN THE POSTER'S OWN TIMEZONE, AND THE EMPTY SLOT IS THE POINT

   The rule this replaces was a window of wing DAYS: a frame showed while its New
   York calendar day was within two of today's. It worked, and it asked her to reason
   about a boundary she cannot see. To know whether posting counted as "today" she
   had to know where midnight in New York fell relative to her own morning — which
   is 06:00 for her, so the answer changed depending on how early she woke.

   Her own words for the fix were better than the mechanism they replaced: she should
   be able to LOOK. An empty slot means post; a full one means today is done. No
   arithmetic, no guessing, and the signal arrives exactly when she wakes.

   ---------------------------------------------------------------------------
   THE POSTER'S CLOCK, NOT THE READER'S, AND THAT ASYMMETRY IS THE FEATURE

   Each side expires on its own author's morning:

     HER photograph clears at 07:00 Paris. Posted at 00:02 her time, it is gone by
     her breakfast — so she wakes to an empty slot and knows to post. He has from
     15:02 until 22:00 his time to see it: his whole afternoon and evening.

     HIS photograph clears at 07:00 Los Angeles, which is 16:00 for her. Posted at
     20:37 his time it reaches her at 05:37, and she keeps it through her entire
     morning and afternoon rather than losing it to a boundary at 06:00.

   A single shared expiry cannot do this. Nine hours apart, any one instant is
   somebody's inconvenient hour, and the wing boundary happened to fall at 06:00
   hers — the worst possible moment, just as she woke.

   ---------------------------------------------------------------------------
   CLEARED MEANS HIDDEN. NOTHING IS DELETED.

   Worth stating loudly, because "wiped" is the natural word for it and the wrong
   one. Every frame stays in R2 and in the day hash exactly as posted. This decides
   what a page DRAWS. `npm run export:frames` still retrieves every photograph either
   of them has ever sent, which is the whole reason that script exists.

   ---------------------------------------------------------------------------
   07:00 IS NEVER AN AMBIGUOUS HOUR, WHICH IS LUCK WORTH RECORDING

   Local-wall-time arithmetic is where timezone code goes wrong, and the usual
   disaster is a DST transition that skips or repeats the target hour. Both zones
   here shift at 02:00–03:00 local, so 07:00 always exists exactly once in both. This
   file does not have to decide what "07:00 on a day with no 07:00" means, because
   for Europe/Paris and America/Los_Angeles there is no such day.

   That is a property of these two zones and not a general truth. A third timezone
   with a transition near 07:00 would need the ambiguity handled rather than assumed —
   which is why it is written down here rather than left as something the code
   happens to get away with.
   =========================================================================== */

/** When the page stops showing a frame: 07:00 local, in whoever posted it. */
export const CLEAR_HOUR = 7;

/**
 * The offset of a timezone at an instant, in minutes east of UTC.
 *
 * Derived by formatting the instant IN the zone and reading the wall-clock back,
 * because there is no API that just states an offset. `hour12: false` rather than
 * `hourCycle` — Intl reports midnight as hour 24 under some combinations, and the
 * `% 24` below is what makes that harmless instead of a once-a-day bug.
 */
function offsetMinutes(atMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(new Date(atMs))
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  // Seconds-floored, so a sub-second remainder cannot round the offset to 1 minute.
  return (asIfUtc - Math.floor(atMs / 1000) * 1000) / 60000;
}

/** The local calendar date and hour of an instant, in a timezone. */
function localParts(atMs: number, tz: string): { y: number; m: number; d: number; h: number } {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  })
    .formatToParts(new Date(atMs))
    .reduce<Record<string, string>>((acc, x) => {
      acc[x.type] = x.value;
      return acc;
    }, {});
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24 };
}

/**
 * The first 07:00 in `tz` strictly after `atMs`.
 *
 * TWO PASSES, and the second one is not redundant. Converting a local wall time to
 * an instant needs the offset that applies AT that instant — which is the thing being
 * solved for. So the first pass uses the offset at posting time as an estimate, and
 * the second re-solves using the offset where that estimate landed. One correction is
 * enough: the two differ only across a transition, and a transition moves the answer
 * by an hour, never by enough to cross another one.
 */
export function clearsAt(atMs: number, tz: string): number {
  const { y, m, d, h } = localParts(atMs, tz);

  // Already past 07:00 today, so it survives until tomorrow morning. UTC arithmetic
  // purely to roll the calendar date — month lengths and leap years for free, with no
  // timezone meaning attached to it.
  let year = y;
  let month = m;
  let day = d;
  if (h >= CLEAR_HOUR) {
    const rolled = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }

  const wall = Date.UTC(year, month - 1, day, CLEAR_HOUR, 0, 0);
  const firstPass = wall - offsetMinutes(atMs, tz) * 60_000;
  return wall - offsetMinutes(firstPass, tz) * 60_000;
}

/**
 * Is a frame still worth drawing?
 *
 * `atMs` of 0 means the store had no timestamp — a frame whose metadata is partly
 * lost. Shown rather than hidden: there is a photograph, and a missing clock reading
 * is not a reason to make it disappear.
 */
export function stillFresh(atMs: number, tz: string, nowMs: number = Date.now()): boolean {
  if (!atMs) return true;
  // A stamp from the future is clock skew, not a fact. Treat it as just-posted.
  if (atMs > nowMs) return true;
  return nowMs < clearsAt(atMs, tz);
}
