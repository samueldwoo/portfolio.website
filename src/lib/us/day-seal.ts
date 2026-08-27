/* ============================================================================
   THE SEAL ON THE DAILY QUESTION, AS A PURE FUNCTION

   Neither answer is visible until BOTH have been written. That rule was enforced
   in the middle of together.ts, which imports the Upstash config, the question
   list and a date library — so bare `node` could not load it and the single most
   security-relevant function in the wing had NO TEST AT ALL. Everything around it
   did: the R2 key, the rate limiter, the tracer's inability to print their words,
   the day-page slot picks. The seal itself was covered by reading it.

   So the seal lives here, with no imports but an erased type, and together.ts
   keeps `visibleDay()` as a three-line wrapper that supplies the two things this
   file deliberately cannot compute: the day's prompt (needs the question list)
   and its age (needs the DST-safe date arithmetic). Handing those in is what
   makes the rule testable — see scripts/test-day-seal.mts, and note that it
   checks BOTH viewers on every case, because a seal that leaks in one direction
   only is exactly the bug a one-sided test cannot see.

   WHAT THE SEAL IS, MECHANICALLY: `theirs` is ABSENT from the returned object
   until it is allowed out, not blanked at render time. There is no path from a
   DayRecord to a page that does not come through here, so there is no page that
   could accidentally read an unrevealed answer — it was never in the object.
   ========================================================================= */

import type { Who } from './together';

/**
 * How long a missed day stays answerable.
 *
 * Lives here rather than in together.ts because it is not a policy the store or
 * the endpoint owns — it is the window this function tests, and the two flags
 * that read it (`canAnswer`, `expired`) are the only places it means anything.
 * together.ts re-exports it so no call site had to change.
 */
export const LATE_ANSWER_DAYS = 7;

/** One day's exchange, as STORED. Never handed to a page — see `sealDay()`. */
export interface DayRecord {
  /** `YYYY-MM-DD` in WING_TZ. Also the primary key. */
  date: string;
  /** Her answer, or ''. */
  her: string;
  /** Epoch millis she answered. 0 when she has not. */
  herAt: number;
  him: string;
  himAt: number;
}

export function emptyDay(date: string): DayRecord {
  return { date, her: '', herAt: 0, him: '', himAt: 0 };
}

/**
 * One day as it is ALLOWED to reach the browser.
 *
 * THIS TYPE IS THE SEAL. Compare letters.ts's VisibleLetter: the field that must
 * not be sent is not blanked at render time, it is absent from the object.
 */
export interface VisibleDay {
  date: string;
  /** The question. Never secret; it is in a public repository. */
  prompt: string;
  /** MY answer. Always mine to read, revealed or not. '' when I have not answered. */
  mine: string;
  mineAt: number;
  /**
   * THEIR answer, and ONLY when both of us have answered. '' otherwise, and '' here
   * means ABSENT rather than empty: an unrevealed answer never enters this object.
   */
  theirs: string;
  theirsAt: number;
  /**
   * Have they answered yet?
   *
   * Safe to expose while sealed, and necessary: "she answered, yours is missing" is
   * the entire call to action, and it leaks nothing about WHAT she said. The same
   * judgement letters.ts makes about `teaser` — one fact is allowed out because its
   * whole contract is being safe to read early.
   */
  theyAnswered: boolean;
  /** Both answered. The only state in which `theirs` is populated. */
  revealed: boolean;
  /** May I still answer this one? False once it is past LATE_ANSWER_DAYS. */
  canAnswer: boolean;
  /** I never answered, and nobody can any more. */
  closed: boolean;
  /**
   * Is the window shut, regardless of who wrote what?
   *
   * ADDED BECAUSE THE HUB WAS ASSERTING THIS FROM `mine` ALONE AND GETTING IT WRONG.
   * Its archive picked a branch on `d.mine` after `d.revealed` and `d.canAnswer` had
   * both failed — and since `canAnswer` is false the moment `mine` exists, that
   * branch caught EVERY day where one side had answered and the other had not, at
   * any age. So yesterday, with his answer in and hers still to come, read "she
   * never answered this one, and it has closed." It had not closed; she had six days
   * left, and `editable` was simultaneously true on the same object.
   *
   * `closed` could not be reused for it: that flag means "*I* never answered", so it
   * is false in exactly the case the copy was about. Two different facts were sharing
   * one word, which is why the page could be confidently wrong.
   */
  expired: boolean;
  /**
   * May I REPLACE what I already wrote?
   *
   * ---------------------------------------------------------------------------
   * EDITABLE UNTIL THE REVEAL, FROZEN AFTER IT. THIS IS PART OF THE MECHANIC.
   *
   * Before both of us have answered there is nothing to react to, so changing my
   * answer is fixing a typo or finishing a sentence — and refusing that would mean a
   * mistyped answer is stuck on the page for a day. Harmless, so it is allowed.
   *
   * AFTER the reveal it is not harmless and it is not editing, it is rewriting. I
   * would be able to read what she said and then adjust what I "had" said to match,
   * agree with it, or be funnier about it. The whole value of the seal is that both
   * answers were written blind; an editable revealed answer hands that back on a
   * plate, and neither of us would ever be able to trust the coincidences again.
   *
   * So the freeze is not a storage constraint, it is the second half of the same
   * promise the seal makes. It lives on this object — rather than as a check inside
   * the endpoint — because the HUB needs the identical rule to decide whether to
   * render the form at all, and a rule enforced in one place and re-derived in the
   * other is a rule that eventually disagrees with itself.
   *
   * The window applies too. A day nobody can answer any more is not a day whose
   * answer can be swapped either.
   */
  editable: boolean;
  /**
   * Whole days from this record's date to today. 0 is today, 1 is yesterday.
   *
   * Passed in rather than computed, because the DST-safe UTC-anchored arithmetic
   * lives in together.ts and dragging it in here would cost this file the property
   * that makes it testable.
   */
  age: number;
}

/**
 * Seal one stored day for one reader.
 *
 * `who` is the VIEWER. Every field is relative to them, which is what lets the hub
 * render the same component for either of them and why the store never needs to
 * know who is looking.
 *
 * `age` and `prompt` are supplied by the caller — see the header.
 */
export function sealDay(rec: DayRecord, who: Who, age: number, prompt: string): VisibleDay {
  const them: Who = who === 'her' ? 'him' : 'her';
  const mine = rec[who];
  const theirs = rec[them];
  const revealed = mine.length > 0 && theirs.length > 0;
  /* A future date can only come from a hand-edited record. Treated as inside the
     window rather than expired: it should not be answer-blocked on top of being
     wrong, and `age <= LATE_ANSWER_DAYS` gives that for free. */
  const expired = age > LATE_ANSWER_DAYS;

  return {
    date: rec.date,
    prompt,
    mine,
    mineAt: rec[`${who}At` as 'herAt' | 'himAt'],
    /* THE SEAL, in one expression. `theirs` is only ever read when `revealed` is
       already true, so there is no version of this object that carries their words
       alongside `revealed: false`. */
    theirs: revealed ? theirs : '',
    theirsAt: revealed ? rec[`${them}At` as 'herAt' | 'himAt'] : 0,
    theyAnswered: theirs.length > 0,
    revealed,
    canAnswer: mine.length === 0 && !expired,
    closed: mine.length === 0 && expired,
    expired,
    // Mine is written, theirs is not, and the day is still in the window. See the
    // field comment — the `!revealed` half of this is the mechanic, not a detail.
    editable: mine.length > 0 && !revealed && !expired,
    age,
  };
}
