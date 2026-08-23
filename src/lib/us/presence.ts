/**
 * presence.ts — "he is in here too, right now."
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THE WING COULD NOT DO
 *
 * Every other feature here is a message: a song, a tap, an answer, a letter.
 * They all share a shape — one of them does something, and the other finds it
 * later. That gap is the whole medium, and it is usually the right one.
 *
 * But there is a moment no message can produce, and anyone who has been ten time
 * zones from someone knows it: the two of you happen to be in the same place at
 * the same time, without arranging it. It is the closest thing to walking into a
 * room and finding them already there. On a phone it usually takes a "you up?"
 * and a wait, and by then it is not that thing any more.
 *
 * So: one line on the hub, and nothing else.
 *
 *     he is in here too, right now
 *     he was here twenty minutes ago
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO R2 TIER, AND WHY THAT IS NOT A COMPROMISE
 *
 * kv.ts, marks.ts, letters.ts and together.ts all carry three tiers — Upstash,
 * then a signed JSON document in R2, then memory — because everything they hold
 * is a thing somebody wrote and would be upset to lose.
 *
 * This holds a timestamp that is worthless in four minutes. Expiry is not a
 * detail of the storage, it IS the feature, and Redis's `EX` is the mechanism. An
 * R2 fallback would mean read-modify-write on a signed document to record
 * something that stops being true before the write settles, and worse, it would
 * mean a presence record that never expires — so a stale object would say "right
 * now" forever, which is not a degraded version of this feature, it is a lie.
 *
 * Therefore, with no Upstash configured, presence is UNAVAILABLE and the line
 * does not render. Nothing is broken, nothing is lost, and nothing false is
 * shown. That is the correct behaviour for a fact whose whole value is that it
 * is fresh.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER BREAKS A PAGE
 *
 * Every function here resolves to null on any failure — unreachable store, bad
 * response, missing config, malformed value. A hub that 500s because it could not
 * find out whether somebody was recently online has traded the whole front door
 * for a nicety. Callers render the line when they get one and render nothing when
 * they do not; there is no error state to design because there is no error worth
 * showing her.
 */

import { kvConfig, hasKV } from './config';
import type { Who } from './together';

/** `us:presence:` — distinct from us:song:, us:mark:, us:letter:, us:together:. */
const KEY = (who: Who) => `us:presence:${who}`;

/**
 * How long a stamp survives in the store.
 *
 * An hour, matching WAS_HERE_MS below: past that the line renders nothing, so
 * keeping the key would be storing a value no reader can ever see. The TTL is
 * therefore the retention policy and the display rule at once, which is why they
 * are defined next to each other — changing one without the other produces either
 * a key that outlives its usefulness or a line that asks for a key already gone.
 */
const TTL_SEC = 60 * 60;

/**
 * Inside this, they are here TOGETHER and the line says so in the present tense.
 *
 * Two minutes rather than thirty seconds: she may be reading a letter, or typing
 * an answer, and a person who is mid-sentence has not left the room. Rather than
 * a heartbeat — which would mean a timer, a fetch loop and a decision about what
 * to do when it fails — a page render stamps the clock and two minutes of credit
 * covers the reading in between. It is a worse mechanism than a socket and about
 * a hundredth of the cost of one.
 */
export const RIGHT_NOW_MS = 2 * 60 * 1000;

/** Beyond this, nothing renders at all. Matches TTL_SEC. */
export const WAS_HERE_MS = 60 * 60 * 1000;

/** How long ago, and whether that counts as together. */
export interface Presence {
  /** Epoch ms of their last page render. */
  atMs: number;
  /** Whole minutes since. Zero inside the first minute. */
  agoMin: number;
  /** True inside RIGHT_NOW_MS — the present-tense case. */
  together: boolean;
}

/** One pipelined Upstash call. Returns null rather than throwing, always. */
async function redis(cmds: (string | number)[][]): Promise<unknown[] | null> {
  const { url, token } = kvConfig();
  if (!hasKV() || !url || !token) return null;

  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map((c) => c.map(String))),
      // Short on purpose. This is the least important fact on the page, so it is
      // never allowed to be the reason the page is slow.
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as Array<{ result?: unknown; error?: string }>;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((e) => (e?.error ? null : e?.result ?? null));
  } catch {
    // Unreachable, timed out, or not JSON. All three mean the same thing here.
    return null;
  }
}

function read(raw: unknown, nowMs: number): Presence | null {
  const atMs = Number(raw);
  if (!Number.isFinite(atMs) || atMs <= 0) return null;

  const delta = nowMs - atMs;
  // A stamp from the future is a clock-skew artefact, not a fact. Clamp rather
  // than reject: somebody IS here, the arithmetic is just briefly nonsense.
  const ago = Math.max(0, delta);
  if (ago > WAS_HERE_MS) return null;

  return {
    atMs,
    agoMin: Math.floor(ago / 60000),
    together: ago <= RIGHT_NOW_MS,
  };
}

/**
 * Stamp the reader's clock and read the other one's, in ONE round trip.
 *
 * Both halves belong to the same page render, so they are one pipeline rather
 * than two awaits — presence costs the hub a single request, not two, and the
 * two facts describe the same instant.
 *
 * The write is unconditional and the read is of the OTHER key, which together
 * make the "he is here" line impossible to produce from his own visit. That
 * mistake would be invisible in testing, because the person testing it is
 * exactly the person whose own footprints would be reflected back at them.
 */
export async function touchAndRead(
  viewer: Who,
  nowMs: number = Date.now(),
): Promise<Presence | null> {
  const them: Who = viewer === 'her' ? 'him' : 'her';
  const out = await redis([
    ['SET', KEY(viewer), nowMs, 'EX', TTL_SEC],
    ['GET', KEY(them)],
  ]);
  if (!out || out.length !== 2) return null;
  return read(out[1], nowMs);
}

/**
 * Stamp only, for the pages that are not the hub.
 *
 * The studio and the letters page do not show presence — a line about somebody
 * else arriving would pull her out of the thing she came to read. But time spent
 * there is still time spent here, so they stamp without reading. Without this,
 * twenty minutes in the studio would look like twenty minutes away.
 */
export async function touch(viewer: Who, nowMs: number = Date.now()): Promise<void> {
  await redis([['SET', KEY(viewer), nowMs, 'EX', TTL_SEC]]);
}

/**
 * The line, from the reader's side.
 *
 * Returns '' when there is nothing worth saying, so the caller's test is
 * `{line && ...}` and there is no empty element and no placeholder. Absence is
 * the common case and it should occupy no space at all.
 *
 * Note what this never says: a time. "he was here at 14:20" would need her to
 * know which 14:20, and the two clocks at the top of the hub are already the
 * place where that question is answered properly. Recency is relative or it is
 * not worth printing.
 */
export function presenceLine(p: Presence | null, viewer: Who): string {
  if (!p) return '';
  const them = viewer === 'her' ? 'he' : 'she';

  if (p.together) return `${them} is in here too, right now`;
  if (p.agoMin < 2) return `${them} was here a minute ago`;
  if (p.agoMin < 60) return `${them} was here ${p.agoMin} minutes ago`;
  return '';
}
