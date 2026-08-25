/* ===========================================================================
   slots.ts — which two photographs the day page puts in its big frames.
   ===========================================================================

   ITS OWN MODULE, AND DELIBERATELY IMPORT-FREE AT RUNTIME. Every import here is
   `import type`, which TypeScript erases, so this file has no dependency on the
   store, on config, or on anything that needs a network. That is what makes it
   testable on its own with `node --experimental-strip-types` — frames.ts pulls in
   config.ts for hasKV(), and one runtime import is enough to drag the whole
   configuration surface into a unit test that has no business knowing about it.

   The rule this file encodes is small and the reasoning behind it is not, so the
   reasoning lives on pickSlots below.
   =========================================================================== */

import type { VisibleDayFrames, VisibleFrame } from './frames';
import type { Who } from './together';

/**
 * How many wing days back the big slot on the day page will reach.
 *
 * Two: today and yesterday. See pickSlots for why not more.
 */
export const CARRY_DAYS = 2;

/**
 * The most recent day in a newest-first window that has something on `side`.
 *
 * THE RULE, EXTRACTED SO THE TWO PAGES CANNOT DRIFT. The photo page and the song
 * page face the identical problem — wing midnight lands at 21:00 his time, so
 * anything he posts in his evening is filed under a day that has already rolled by
 * the time she wakes — and the song page originally answered it the other way,
 * showing strictly today. That divergence is the thing this function exists to stop:
 * one implementation of "how far back may a slot reach", used by both.
 *
 * Returns the frame/track AND the day it came from, because the caller needs the
 * date for two separate reasons: to LABEL a carried item honestly, and — on the song
 * page — to address a reaction at the day the song actually lives on.
 *
 * Generic over the day shape and the side key, so `her`/`him` and `his`/`hers` both
 * work without either page reshaping its data.
 */
export function mostRecent<T>(
  days: Array<{ date: string }>,
  side: string,
  carryDays: number = CARRY_DAYS,
): { value: T | null; date: string | null; carried: boolean } {
  const window = days.slice(0, Math.max(1, carryDays));
  for (let i = 0; i < window.length; i += 1) {
    const day = window[i] as { date: string } & Record<string, unknown>;
    const value = day[side];
    if (value) return { value: value as T, date: day.date, carried: i > 0 };
  }
  return { value: null, date: null, carried: false };
}

/** What the day page's two big frames should show, and what is left for the strip. */
export type Slots = {
  mine: VisibleFrame | null;
  theirs: VisibleFrame | null;
  /** The wing day `mine` came from, or null when it is today's / absent. */
  mineFrom: string | null;
  theirsFrom: string | null;
  /** Days below the slot, with promoted frames removed so nothing appears twice. */
  earlier: VisibleDayFrames[];
};

/**
 * Choose the two headline frames from a newest-first window.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT SIMPLY `week[0]`
 *
 * It was, and for two people nine hours apart that quietly threw away most of his
 * evenings.
 *
 * THE ARITHMETIC, because it is the whole reason this function exists. Wing
 * midnight lands at 21:00 his time and 05:00–06:00 hers, every day of the year —
 * stable at 21:00 because Los Angeles and New York shift together, drifting an hour
 * on her side because the EU changes on different dates. So a photograph he posts
 * at 20:00 his time is filed under wing day D, and by the time she wakes at 07:30
 * Paris it is 01:30 in New York on day D+1. She opened the app to "Nothing from Sam
 * yet today", with his photograph demoted to a thumbnail in the strip below, having
 * never once seen it in the slot it was posted for.
 *
 * Worse, the rule that produced was backwards: posting at 22:00 his time WORKED,
 * because it was already tomorrow in New York and so lined up with her morning,
 * while posting at 20:00 FAILED. The three hours that feel most like "evening, send
 * her something" were the three that broke.
 *
 * So the slot holds each person's MOST RECENT frame instead. The window is
 * newest-first, so the first hit is today's when today has one and yesterday's
 * otherwise — which means posting today replaces a carried-forward frame for free,
 * with no branch and no special case.
 *
 * TWO DAYS AND NO MORE. Exactly wide enough to guarantee an evening photograph
 * survives into her morning, which was the whole complaint. Wider was tempting and
 * is wrong: a six-day-old photograph headlining a page called "one picture a day" is
 * not a photograph of the day, and leaving it up there drains the meaning of posting
 * a new one. Past the window the slot goes honestly empty — the frame is still in
 * the strip, un-promoted rather than deleted.
 *
 * THE STRIP CANNOT DROP WHOLE ROWS. A day carries both of them, so if he posted
 * yesterday and she did not, yesterday is promoted for him and must still appear for
 * her. It blanks the two specific promoted frames and then drops rows left with
 * nothing, which is why the filter runs after the map.
 */
/* VisibleFrame, NOT Frame — a correction, and one that only surfaced when the right
   checker was finally run. The only caller passes the output of withUrls(), whose
   sides carry a presigned `url` on top of Frame. Typed as Frame, `mine.url` worked
   perfectly at runtime while the type insisted the field did not exist — three
   errors sitting in plain sight that `tsc --noEmit` never reported, because tsc does
   not read .astro files. `npm run typecheck` (astro check) is the one that does.

   A generic over the frame shape was tried first and was worse: inference collapsed
   it to `{}` and turned three errors into thirty. Naming the concrete type the caller
   actually uses is the honest description of what this function is for. */
export function pickSlots(
  week: VisibleDayFrames[],
  today: string,
  viewer: Who,
  carryDays: number = CARRY_DAYS,
): Slots {
  const them: Who = viewer === 'her' ? 'him' : 'her';
  const carry = week.slice(0, Math.max(1, carryDays));

  const mineDay = carry.find((d) => d[viewer]) ?? null;
  const theirsDay = carry.find((d) => d[them]) ?? null;

  const earlier = week
    .slice(1)
    .map((d) => ({
      ...d,
      [viewer]: mineDay && d.date === mineDay.date ? null : d[viewer],
      [them]: theirsDay && d.date === theirsDay.date ? null : d[them],
    }))
    .filter((d) => d.her || d.him) as VisibleDayFrames[];

  return {
    mine: mineDay?.[viewer] ?? null,
    theirs: theirsDay?.[them] ?? null,
    mineFrom: mineDay && mineDay.date !== today ? mineDay.date : null,
    theirsFrom: theirsDay && theirsDay.date !== today ? theirsDay.date : null,
    earlier,
  };
}
