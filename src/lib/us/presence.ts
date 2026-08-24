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
import { countCommands, timer } from './trace';
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

  const t = timer();
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map((c) => c.map(String))),
      // Short on purpose. This is the least important fact on the page, so it is
      // never allowed to be the reason the page is slow.
      signal: AbortSignal.timeout(1500),
    });
    /* THE COMMAND COUNT, and presence is the one worth watching most closely: it is
       written on EVERY authenticated render, so it is the per-page-view floor that
       everything else is added to. See countCommands in trace.ts. */
    countCommands('presence', cmds.length, res.status, t.total());
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
 * make the "he is here" line impossible to produce from his own visit — SO LONG AS
 * a browser is only ever one of them. It is not: /api/us/whoami switches identity
 * in place, and a stamp left under the abandoned identity is read straight back as
 * the other person. That is why switching calls forget(), and why the reasoning
 * lives there rather than here.
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
 *
 * IT OVERWRITES, AND THAT IS ALREADY TRUE. A plain `SET` replaces the value and
 * resets the TTL, so there is exactly one timestamp per person and it is always
 * the most recent one. Nothing here accumulates: no list, no counter, no history.
 * Worth stating because "should this overwrite rather than accumulate" is the
 * obvious question to ask of a per-identity key, and the answer is that the
 * accumulation this feature could have suffered from is not two stamps for one
 * person — it is one stamp left behind under the WRONG person. See forget().
 */
export async function touch(viewer: Who, nowMs: number = Date.now()): Promise<void> {
  await redis([['SET', KEY(viewer), nowMs, 'EX', TTL_SEC]]);
}

/**
 * Delete a presence stamp, because the person who left it is no longer that person.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS FOR, REPORTED FROM A PHONE
 *
 * touchAndRead() and touch() stamp `us:presence:<who>` for whoever the reader is
 * AT THAT MOMENT, and identity in this wing is a DECLARATION that can be changed
 * mid-session (see /api/us/whoami). Those two facts collide:
 *
 *   1. Sam browses the wing as HER — to see what she sees, which is the only way
 *      to check her copy. Every page render stamps `us:presence:her` with his
 *      clock. He cannot avoid it; the stamp is a side effect of looking.
 *   2. He taps "not Andrea?" and becomes Sam.
 *   3. The hub, as Sam, reads the OTHER key — `us:presence:her` — finds a
 *      timestamp five seconds old, and tells him "she is in here too, right now."
 *
 * It is his own footprint, in her shoes, read back to him as her. The comment on
 * touchAndRead() claims the write/read asymmetry makes that "impossible to produce
 * from his own visit". That was true for one identity per browser and stopped being
 * true the moment identity became switchable, which is exactly the mistake it
 * warned about — invisible in testing, because the tester is the person whose own
 * footprints are being reflected.
 *
 * ---------------------------------------------------------------------------
 * WHY DELETE RATHER THAN REASSIGN
 *
 * Moving the stamp to the new identity would be worse. It asserts a second true
 * thing to fix a false one, and the new identity is about to stamp itself anyway
 * on the very next page render — the 303 from the switch lands on the hub, which
 * calls touchAndRead(). So the reassignment is redundant, and a DEL is the only
 * operation whose failure mode is silence rather than a different wrong sentence.
 *
 * ---------------------------------------------------------------------------
 * IT CAN DELETE A TRUE STAMP, AND THAT IS THE RIGHT TRADE
 *
 * If she is genuinely reading the wing on her own phone at the moment he stops
 * being her, this throws her real stamp away. The store cannot tell her footprint
 * from his — they are the same key holding the same kind of number — so there is
 * no version of this that keeps hers and drops his.
 *
 * The cost of deleting hers is that he is not told she is here until her next page
 * render, which is at most a scroll away and is bounded by RIGHT_NOW_MS anyway. The
 * cost of keeping his is a sentence that is a lie about the person the whole wing
 * is for. A missed true positive here is a nicety arriving late; a false positive
 * is the feature not working.
 *
 * Only ever called for the identity being ABANDONED, never for the other one — the
 * two keys coexisting is not the bug, it is the feature.
 */
export async function forget(who: Who): Promise<void> {
  await redis([['DEL', KEY(who)]]);
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
