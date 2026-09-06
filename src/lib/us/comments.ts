/* ===========================================================================
   comments.ts — the store for the conversation under a photograph.
   ===========================================================================

   All the reasoning about WHAT a comment is, who may change it and how a thread
   is ordered lives in `comment-thread.ts`, which imports nothing and is tested.
   This file is the I/O and nothing else. Do not restate that argument here.

   ---------------------------------------------------------------------------
   TWO TIERS, MIRRORING frames.ts AND NOT together.ts

   `together.ts` has three (Upstash, R2, memory) because the daily question and
   the list have to survive with R2 alone. Comments are FRAME metadata: they hang
   off a photograph, and if there is no Upstash there is no frame metadata either,
   so a third tier would let a comment outlive the thing it is about. Two tiers,
   the same two `framesTier()` picks, for the same reason.

   THE MEMORY TIER IS WHY LOCAL DEVELOPMENT WORKS AT ALL — `.env` keeps
   UPSTASH_REDIS_* commented out on purpose (see CLAUDE.md), and every read path
   in this file is guarded so the page renders with no credentials.

   ---------------------------------------------------------------------------
   ONE HASH PER PHOTOGRAPH

     us:frame:comments:<date>:<whose>

   A hash keyed by comment id, exactly like `us:together:list`, so a thread is one
   HGETALL and a write is one HSET. `<whose>` is the person whose PHOTOGRAPH it is
   and never who is commenting — both of them write into the same hash, which is
   the point of a conversation.

   Deliberately NOT fields on `us:frame:<date>`: that hash is read on every render
   of the day page and the week strip, and putting eighty comments in it would make
   every one of those reads carry a conversation nobody asked for.

   TWO PHOTOGRAPHS PER PAGE, so a day page costs ONE pipeline of two HGETALLs on
   top of what it already did. The threads for the week strip are never read,
   because the strip does not render them.

   ---------------------------------------------------------------------------
   WRITES FAIL LOUD, READS FAIL SOFT

   The same policy `together.ts` states and for the same reason: a comment that
   failed to save must be a 502 she can retry, and a thread that could not be read
   must cost the thread and never the photograph above it. `getThreadsSafe` is the
   read the page uses.
   =========================================================================== */

import { hasKV, kvConfig } from './config';
import { countCommands, timer } from './trace';
import {
  addRefusal,
  isCommentId,
  mayChange,
  normalizeComment,
  parseComment,
  type AddRefusal,
  type Comment,
  type ThreadRef,
} from './comment-thread';
import type { Who } from './together';

export class CommentsError extends Error {}

const TIMEOUT_MS = 4000;

/** `us:frame:comments:` — distinct from `us:frame:<date>`, which is the metadata. */
const THREAD_KEY = (date: string, whose: Who) => `us:frame:comments:${date}:${whose}`;

export type Tier = 'upstash' | 'memory';

export function commentsTier(): Tier {
  return hasKV() ? 'upstash' : 'memory';
}

/** Are comments readable at all? The page renders the thread only when true. */
export function commentsAvailable(): boolean {
  return true; // the memory tier is always available; see the header
}

/** Dev-only and per-instance, exactly like frames.ts's. Keyed by THREAD_KEY. */
const memory = new Map<string, Record<string, Comment>>();

/** Test seam. Not called in production. */
export function __resetComments(): void {
  memory.clear();
}

async function redis(cmds: (string | number)[][]): Promise<unknown[]> {
  const { url, token } = kvConfig();
  if (!url || !token) throw new CommentsError('upstash is not configured');
  const t = timer();
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    /* Deliberately NOT counted: a request that never landed costs no commands, and
       counting it would make `cmds` stop meaning "the bill" — trace.ts's own rule. */
    throw new CommentsError(`upstash unreachable: ${err instanceof Error ? err.message : err}`);
  }
  countCommands('comments', cmds.length, res.status, t.total());
  if (!res.ok) throw new CommentsError(`upstash answered ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new CommentsError('upstash returned a malformed pipeline response');
  return body.map((r) => (r && typeof r === 'object' && 'result' in r ? (r as { result: unknown }).result : null));
}

/**
 * Upstash returns a hash as a FLAT ARRAY, not an object.
 *
 * The same fold frames.ts and together.ts both need. Kept local rather than shared
 * because the three files' pipelines are already independent and a shared helper
 * would be the only coupling between them.
 */
function foldHash(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
    return out;
  }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  }
  return out;
}

/** Every parseable comment in one stored hash, keyed by id. Unparseable ones drop. */
function fromHash(h: Record<string, string>): Record<string, Comment> {
  const out: Record<string, Comment> = {};
  for (const raw of Object.values(h)) {
    const parsed = parseComment(raw);
    // Keyed by the comment's OWN id, so a field renamed by hand cannot produce a
    // record whose key and id disagree. Same rule as itemsFromHash.
    if (parsed) out[parsed.id] = parsed;
  }
  return out;
}

/* ============================================================================
   READ
   ========================================================================= */

/**
 * The threads for several photographs, in ONE pipeline.
 *
 * Takes a list because the day page always wants two and two sequential round
 * trips is twice the latency for no reason. Absent threads come back as `{}`, which
 * is a state the markup renders (nothing).
 */
export async function getThreads(refs: readonly ThreadRef[]): Promise<Record<string, Record<string, Comment>>> {
  const out: Record<string, Record<string, Comment>> = {};
  if (refs.length === 0) return out;

  if (commentsTier() === 'memory') {
    for (const r of refs) out[keyOf(r)] = { ...(memory.get(THREAD_KEY(r.date, r.whose)) ?? {}) };
    return out;
  }
  const results = await redis(refs.map((r) => ['HGETALL', THREAD_KEY(r.date, r.whose)]));
  refs.forEach((r, i) => {
    out[keyOf(r)] = fromHash(foldHash(results[i]));
  });
  return out;
}

/** The key the PAGE uses to look a thread up in the map above. */
export function keyOf(ref: ThreadRef): string {
  return `${ref.date}:${ref.whose}`;
}

/**
 * Reads fail soft.
 *
 * The photograph must render even when the conversation under it cannot be read, and
 * `reachable: false` is carried out separately so the page can say "I could not ask"
 * rather than "nobody has said anything" — the distinction the hub learned to make
 * (see `storeReachable` in vault/index.astro). An empty thread and an unreadable one
 * look identical otherwise, and only one of them is a fact.
 */
export async function getThreadsSafe(
  refs: readonly ThreadRef[],
): Promise<{ threads: Record<string, Record<string, Comment>>; reachable: boolean }> {
  try {
    return { threads: await getThreads(refs), reachable: true };
  } catch (err) {
    console.error('[us] could not read the comments; rendering the photographs without them.', err);
    const empty: Record<string, Record<string, Comment>> = {};
    for (const r of refs) empty[keyOf(r)] = {};
    return { threads: empty, reachable: false };
  }
}

/* ============================================================================
   WRITE — all three throw, so the endpoint can answer 502 and she can retry
   ========================================================================= */

/**
 * Add one comment, or report why not.
 *
 * READ-THEN-DECIDE for the cap, which is not atomic and does not need to be: with
 * two people the worst case is an 81st comment, and the cap exists to stop a page
 * becoming slow rather than to be an invariant. Same argument as `addItem`.
 */
export async function addComment(
  ref: ThreadRef,
  by: Who,
  raw: unknown,
  nowMs: number = Date.now(),
): Promise<{ comment: Comment } | { refused: AddRefusal }> {
  /* HLEN, NOT HGETALL, and that is the whole of this optimisation. The cap needs a
     COUNT; the previous version fetched the entire conversation to take `.length` of
     it — every word both of them had written under that photograph, across the wire,
     on every comment, to compare one number against 80. One command, one integer.
     `addRefusal` takes a number now so this is the only shape the caller can pass. */
  const refusal = addRefusal(await countComments(ref), raw);
  if (refusal) return { refused: refusal };

  const comment: Comment = {
    id: crypto.randomUUID(),
    by,
    text: normalizeComment(raw),
    at: nowMs,
    editedAt: 0,
  };
  await put(ref, comment);
  return { comment };
}

/**
 * Edit one, or null if the id selected nothing or is not this person's.
 *
 * The author check is `mayChange()` from the pure module, so the rule is the same
 * one the tests cover and the same one delete uses. An id that selects nothing and
 * an id belonging to the other person are the SAME answer on purpose: distinguishing
 * them would tell each of them which ids exist in the other's name.
 */
export async function editComment(
  ref: ThreadRef,
  id: string,
  by: Who,
  raw: unknown,
  nowMs: number = Date.now(),
): Promise<Comment | null> {
  if (!isCommentId(id)) return null;
  const existing = await getOne(ref);
  const found = existing[id];
  if (!mayChange(found, by)) return null;

  const text = normalizeComment(raw);
  // An edit to nothing is a delete wearing a disguise, and it would leave a comment
  // with no text that parseComment then drops on the next read — a silent delete
  // through a path that does not say it deletes. Refused as "not an edit".
  if (!text) return null;

  const next: Comment = { ...found, text, editedAt: nowMs };
  await put(ref, next);
  return next;
}

/** Remove one. False when the id selected nothing or is not this person's. */
export async function deleteComment(ref: ThreadRef, id: string, by: Who): Promise<boolean> {
  if (!isCommentId(id)) return false;
  const existing = await getOne(ref);
  if (!mayChange(existing[id], by)) return false;

  if (commentsTier() === 'memory') {
    const key = THREAD_KEY(ref.date, ref.whose);
    const held = memory.get(key);
    if (held) {
      delete held[id];
      memory.set(key, held);
    }
    return true;
  }
  await redis([['HDEL', THREAD_KEY(ref.date, ref.whose), id]]);
  return true;
}

/**
 * How many comments are on one photograph. One command, one integer.
 *
 * COUNTS STORED FIELDS, WHICH IS NOT QUITE THE SAME AS PARSEABLE COMMENTS, and the
 * difference is worth naming rather than hiding: `HLEN` includes a field that
 * `parseComment` would drop (a hand-edit that broke the JSON), so the cap can refuse
 * one comment earlier than the rendered thread suggests. That is the RIGHT direction
 * — the cap exists to bound what the store holds, and an unparseable field still
 * occupies it. The alternative, fetching and parsing everything to count what
 * renders, is the over-fetch this replaced.
 */
async function countComments(ref: ThreadRef): Promise<number> {
  if (commentsTier() === 'memory') {
    return Object.keys(memory.get(THREAD_KEY(ref.date, ref.whose)) ?? {}).length;
  }
  const [raw] = await redis([['HLEN', THREAD_KEY(ref.date, ref.whose)]]);
  const n = Math.floor(Number(raw));
  // A malformed answer must not read as "empty" and let the cap through: treat an
  // unreadable count as full, which refuses rather than over-fills.
  return Number.isFinite(n) && n >= 0 ? n : Number.MAX_SAFE_INTEGER;
}

/** One thread, for the two mutations that must look a comment up by id. */
async function getOne(ref: ThreadRef): Promise<Record<string, Comment>> {
  const all = await getThreads([ref]);
  return all[keyOf(ref)] ?? {};
}

/** One comment written, whether new or edited. HSET is an upsert either way. */
async function put(ref: ThreadRef, comment: Comment): Promise<void> {
  if (commentsTier() === 'memory') {
    const key = THREAD_KEY(ref.date, ref.whose);
    const held = memory.get(key) ?? {};
    held[comment.id] = comment;
    memory.set(key, held);
    return;
  }
  await redis([['HSET', THREAD_KEY(ref.date, ref.whose), comment.id, JSON.stringify(comment)]]);
}
