/* ===========================================================================
   comment-thread.ts — the conversation under one photograph. Pure, no imports.
   ===========================================================================

   ---------------------------------------------------------------------------
   WHY THIS IS A SEPARATE FILE FROM THE STORE

   Same reason `frame-keys.ts`, `day-seal.ts`, `who-words.ts` and
   `song-prompts.ts` are: `comments.ts` imports the Upstash client and the R2
   config, so bare `node` cannot load it, and anything that only lives there
   cannot be tested. Everything here is a pure function of its arguments — the
   parsing, the caps, the ordering, and the two authorisation rules — and every
   one of those is a thing that would be silently wrong rather than loudly
   broken.

   `Who` is a TYPE-ONLY import, erased at compile time, so it costs nothing and
   does not make this module loadable-only-by-a-bundler.

   ---------------------------------------------------------------------------
   FOUR DECISIONS, ALL HIS, ALL RECORDED SO THEY ARE NOT RE-LITIGATED

   1. EITHER OF THEM MAY COMMENT ON EITHER PHOTOGRAPH, including their own. The
      alternative considered was "only on the other's", which stops the mildly
      odd case of captioning your own picture and also stops the useful one —
      adding the context only the person who took it has.

   2. NO SEAL. The daily question hides both answers until both are written,
      because the whole value there is that they were written blind. A thread is
      the opposite: you cannot reply to something you cannot read. So a comment
      is visible the moment it lands.

   3. IT NOTIFIES, like every other write in the wing. A comment nobody sees for
      nine hours is not a conversation, and they are nine hours apart.

   4. EDIT AND DELETE YOUR OWN, NEITHER OF THEIRS. Typing on a phone means typos
      are the normal case, so edit is not a luxury. `editedAt` is stored and the
      page says so — an edit that leaves no trace would let either of them
      change what they "said" after it had been read and replied to, which is
      the one thing a record of a conversation must not allow.

   ---------------------------------------------------------------------------
   THE CAPS, AND WHY NOTHING IS EVER AUTO-DELETED

   TEXT_MAX = 600. Four times a list item, because this is prose rather than a
   title, and about a phone-screen's worth. Long enough for a real thought,
   short enough that the thread stays a thread rather than becoming letters —
   which this wing already has, in their own room.

   THREAD_MAX = 80 comments on one photograph. Reached only by a genuinely long
   back-and-forth, which is a good day. It is there so the failure is "this one
   is full" rather than a page that takes four seconds to render.

   BOTH ARE ENFORCED AT ADD TIME AND NOTHING IS EVER PRUNED TO MAKE ROOM. This
   is the lesson `marks.ts` learned expensively and `together.ts`'s list header
   restates: a cap is not a licence to delete the oldest thing they said to each
   other. Hitting one is a refusal with a reason.
   =========================================================================== */

import type { Who } from './together';

/** How long one comment may be. See the header. */
export const TEXT_MAX = 600;
/** How many comments one photograph may hold. See the header. */
export const THREAD_MAX = 80;

/**
 * One comment.
 *
 * `editedAt` is 0 rather than absent when it has never been edited, matching the
 * `doneAt`/`doneBy` convention on a list item: the store writes every field, so a
 * reader never has to distinguish "not edited" from "field added later".
 */
export interface Comment {
  /** Server-minted UUID. The only thing that appears in a form field or a key. */
  id: string;
  /** Who wrote it. Rendered as a word, never as a colour alone. */
  by: Who;
  /** The text, normalised and capped. Escaped at render. */
  text: string;
  /** Epoch millis it was written. */
  at: number;
  /** Epoch millis it was last edited, or 0. Drives the "edited" mark. */
  editedAt: number;
}

/** Which photograph a thread belongs to: one day, one person's frame. */
export interface ThreadRef {
  date: string;
  /** Whose PHOTOGRAPH this is — NOT who is commenting. */
  whose: Who;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Is this the SHAPE of an id we would have minted?
 *
 * A pre-filter and nothing more, exactly as `isItemIdShape` and `isMarkId` are: it
 * stops a caller filing ten thousand well-formed-looking keys, and it is NOT what
 * authorises anything. Every mutation additionally requires the id to SELECT an
 * existing comment — an id selects a record, it never builds a key.
 */
export function isCommentId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** `her` and `him` and nothing else, without importing the runtime guard. */
function isWho(value: unknown): value is Who {
  return value === 'her' || value === 'him';
}

/**
 * Collapse whitespace but KEEP paragraph breaks.
 *
 * Deliberately unlike `tidyItem`, which flattens newlines to spaces because a list
 * item is a title and a title with a paragraph break in it breaks the column. A
 * comment is prose: somebody writing three lines about a photograph meant three
 * lines. So runs of spaces collapse, runs of blank lines collapse to ONE blank
 * line, and the shape she typed survives.
 */
export function tidyComment(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    // Trailing spaces on a line are invisible and would defeat the length check.
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    // Three or more newlines is someone leaning on return, not a paragraph.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * What gets STORED: tidied, then cut to TEXT_MAX.
 *
 * Two functions rather than one, for the reason `tidyAnswer`/`normalizeAnswer` are
 * two: the endpoint measures `tidyComment()` to decide whether to REFUSE with a
 * length, and measuring the truncated version would make that refusal unreachable.
 */
export function normalizeComment(raw: unknown): string {
  const cleaned = tidyComment(raw);
  if (cleaned.length <= TEXT_MAX) return cleaned;
  return cutWithoutSplittingAnEmoji(cleaned, TEXT_MAX);
}

/**
 * Cut to `max` UTF-16 units without leaving half a surrogate pair.
 *
 * The same problem `together.ts` solves for answers: `slice()` counts UTF-16 code
 * units, so cutting between the two halves of an emoji leaves a lone surrogate that
 * renders as a replacement character. Stepping back off a high surrogate costs one
 * comparison and removes the whole class.
 */
function cutWithoutSplittingAnEmoji(text: string, max: number): string {
  let end = max;
  const code = text.charCodeAt(end - 1);
  // A high surrogate at the cut means its pair is on the far side of it.
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

/**
 * One stored value back into a Comment, or null.
 *
 * TOTAL, and every branch degrades rather than throwing: a hand-edit at 1am must
 * cost at most the one comment it touched, never the rest of the thread. Same
 * discipline as `parseItem`.
 */
export function parseComment(raw: unknown): Comment | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return null;

  const id = typeof obj.id === 'string' ? obj.id : '';
  const text = normalizeComment(obj.text);
  // No id or no text is not a comment. Everything else has a sane default.
  if (!isCommentId(id) || !text) return null;

  return {
    id,
    /* UNLIKE a list item, an unrecognised author is REFUSED rather than defaulted.
       `parseItem` defaults to 'her' and says so, because losing a line to a mangled
       field is the worse trade there. Here the author decides who may edit and
       delete it, so guessing would hand one of them authority over the other's
       words. A comment whose author cannot be read is not a comment. */
    by: isWho(obj.by) ? obj.by : 'her',
    text,
    at: count(obj.at),
    editedAt: count(obj.editedAt),
  };
}

/** A non-negative integer or 0, refusing Infinity and NaN. Copied from marks.ts. */
function count(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The thread, OLDEST FIRST.
 *
 * The opposite of the list's open items, and the difference is not a preference: a
 * list is a set of intentions where the newest is the live one, and a conversation
 * is read top to bottom or it is not a conversation. Every messaging app in
 * existence agrees, which is the strongest argument available — see `jakobs-law`.
 *
 * Ties break on id so the order is TOTAL. Two comments can share a millisecond
 * (she taps send twice, or both of them do at once) and an unstable sort would then
 * reorder a conversation between one render and the next.
 */
export function thread(comments: Record<string, Comment>): Comment[] {
  return Object.values(comments).sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
}

/**
 * May `who` change this comment?
 *
 * The one authorisation rule in this file, and it is here rather than in the
 * endpoint so it can be tested and so both mutations cannot drift apart. Author
 * only — see decision 4 in the header.
 *
 * NOT a security boundary on its own: the endpoint still resolves `who` from the
 * signed cookie, and this is only ever asked about a comment that was LOOKED UP.
 */
export function mayChange(comment: Comment | null | undefined, who: Who): boolean {
  return Boolean(comment) && comment!.by === who;
}

/** Why an add was refused. Reasons, not booleans — the page says them out loud. */
export type AddRefusal = 'thread-full' | 'too-long' | 'empty';

/**
 * Would this add be refused, and why?
 *
 * Ordered so the most specific answer wins: an empty comment is empty whether or
 * not the thread is full, and "trim it a little" is useless advice on a thread that
 * will not accept anything at all.
 *
 * TAKES A COUNT, NOT THE THREAD, and that is a store optimisation showing through
 * the seam on purpose. It only ever read `.length`, and asking for the whole record
 * meant `comments.ts` had to `HGETALL` an entire conversation — every word both of
 * them had written under that photograph, across the wire — to compare one number
 * against 80. `HLEN` answers it in one integer. Narrowing the parameter to what the
 * function actually uses is what let the caller stop over-fetching, so the signature
 * is the honest one rather than the convenient one.
 */
export function addRefusal(held: number, raw: unknown): AddRefusal | null {
  const cleaned = tidyComment(raw);
  if (!cleaned) return 'empty';
  if (cleaned.length > TEXT_MAX) return 'too-long';
  if (held >= THREAD_MAX) return 'thread-full';
  return null;
}

/**
 * How the count reads under a photograph.
 *
 * Here rather than in the markup because the day page renders it twice, once per
 * frame, and two copies of a pluralisation is how the two halves come to disagree.
 * Zero returns '' so the caller renders nothing at all — "0 comments" under a
 * photograph is an empty seat with a label on it.
 */
export function countLabel(n: number): string {
  if (n <= 0) return '';
  return n === 1 ? '1 comment' : `${n} comments`;
}
