/**
 * ratelimit.ts — the control that makes three questions a lock instead of a gag.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The answers are short, human and guessable by design — a day of the week, a
 * restaurant, a drink. Generous matching widens each target further. Without a
 * rate limit, a script could walk a wordlist through /api/gate and be inside in
 * minutes; the quiz would be decoration. This file is the difference.
 *
 * TWO BACKENDS, ON PURPOSE
 *
 * Upstash Redis when configured — shared across every serverless instance, which
 * is the only way to count correctly on a platform that runs N of them.
 *
 * An in-process Map when it is not. This is BEST-EFFORT and I want to be honest
 * about why: each serverless instance has its own Map, and Vercel may run many
 * or recycle them at will, so a determined attacker gets more attempts than the
 * stated limit. It still blunts the naive case (one client, one warm instance,
 * hammering) and it means Phase 1 ships without me having to create an Upstash
 * account first. Set the Upstash vars before this matters.
 *
 * FAILS OPEN, DELIBERATELY
 *
 * If the limiter itself errors, requests are ALLOWED. That is the uncomfortable
 * choice and it is the right one here: the answers are the primary control, and
 * an Upstash outage failing closed would lock her out of her own present with no
 * way for me to fix it from my phone. Every failure is logged loudly.
 * ---------------------------------------------------------------------------
 */

/* The ONE import this file has, and it is deliberate rather than an erosion of the
   rule above. The reason ratelimit.ts reads its own env is that config.ts and this file
   could disagree about whether Upstash exists; trace.ts holds no configuration, reads
   no environment and cannot throw, so importing it creates none of that coupling. It is
   here because this file spends three commands on EVERY write in the wing, which makes
   it a large share of a 50,000/month tier and the last place anyone would look. */
import { countCommands, timer } from './trace';

export interface Verdict {
  ok: boolean;
  /** Seconds until the caller may retry. 0 when ok. */
  retryAfter: number;
  /** Which backend answered — surfaced in dev only, for my own sanity. */
  backend: 'upstash' | 'memory' | 'failed-open';
}

/* Same lookup order as config.ts's env(), and that consistency is the point.
   This file used to read `process.env` ONLY. config.ts prefers
   `import.meta.env`, which is where `astro dev` puts a .env — so the two could
   disagree about whether Upstash is configured: hasKV() true (marks and songs
   go to Redis) while the rate limiter silently fell back to its per-instance
   in-memory bucket. Nothing errors; the limiter just quietly stops being the
   shared control it claims to be. Bracket access on a variable, not
   `import.meta.env.FOO`, so Vite cannot inline a build-time value. */
function env(name: string): string | undefined {
  const fromMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromNode = typeof process !== 'undefined' ? process.env : undefined;
  const value = fromMeta?.[name] ?? fromNode?.[name];
  return value && value.length > 0 ? value : undefined;
}

const UPSTASH_URL = () => env('UPSTASH_REDIS_REST_URL');
const UPSTASH_TOKEN = () => env('UPSTASH_REDIS_REST_TOKEN');

/* --------------------------------- memory --------------------------------- */

const buckets = new Map<string, { count: number; resetAt: number }>();

function hitMemory(key: string, limit: number, windowSec: number): Verdict {
  const now = Date.now();

  // Opportunistic sweep. Without it this Map is an unbounded memory leak on a
  // long-lived instance, since every distinct IP adds a key that nothing
  // removes. Cheap because it only runs when the map is already large.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { ok: true, retryAfter: 0, backend: 'memory' };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      backend: 'memory',
    };
  }
  return { ok: true, retryAfter: 0, backend: 'memory' };
}

/* -------------------------------- upstash --------------------------------- */

async function hitUpstash(
  url: string,
  token: string,
  key: string,
  limit: number,
  windowSec: number,
): Promise<Verdict> {
  // One round trip for both commands. `EXPIRE ... NX` sets the TTL only if the
  // key has none, which is what makes this a FIXED window: the countdown starts
  // at the first attempt and is not extended by later ones. An unconditional
  // EXPIRE would restart the window on every request, so a client that kept
  // hammering would never be let back in — including her, on a shared IP.
  const t = timer();
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, String(windowSec), 'NX'],
      ['TTL', key],
    ]),
    signal: AbortSignal.timeout(2000),
  });

  // Three, literally — the body above. A constant rather than a length because there is
  // no array to measure, and it must be corrected by hand if a command is ever added.
  countCommands('ratelimit', 3, res.status, t.total());

  if (!res.ok) throw new Error(`upstash ${res.status}`);

  const parsed = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  const count = Number(parsed?.[0]?.result ?? 0);
  const ttl = Number(parsed?.[2]?.result ?? windowSec);

  if (!Number.isFinite(count) || count <= 0) throw new Error('upstash: no count');

  if (count > limit) {
    return { ok: false, retryAfter: ttl > 0 ? ttl : windowSec, backend: 'upstash' };
  }
  return { ok: true, retryAfter: 0, backend: 'upstash' };
}

/* ---------------------------------- api ----------------------------------- */

/**
 * Count one attempt against `key`.
 *
 * @param key       caller identity, already namespaced (e.g. `gate:1.2.3.4`)
 * @param limit     attempts permitted per window
 * @param windowSec window length in seconds
 */
export async function hit(key: string, limit: number, windowSec: number): Promise<Verdict> {
  const url = UPSTASH_URL();
  const token = UPSTASH_TOKEN();

  if (url && token) {
    try {
      return await hitUpstash(url, token, `us:rl:${key}`, limit, windowSec);
    } catch (err) {
      console.error('[us] rate limiter unavailable, failing OPEN:', err);
      return { ok: true, retryAfter: 0, backend: 'failed-open' };
    }
  }

  return hitMemory(key, limit, windowSec);
}

/**
 * Best-available client identity.
 *
 * CORRECTION, from an adversarial review: an earlier version of this comment
 * claimed `clientAddress` was "the adapter's own view" and therefore a better
 * primary than `x-forwarded-for`. That is wrong. Under @astrojs/vercel,
 * `clientAddress` resolves to `getClientIpAddress(request)` in
 * @astrojs/internal-helpers, which reads the LEFTMOST `x-forwarded-for` entry.
 * They are the same source, so the ordering below buys nothing.
 *
 * It is not exploitable on Vercel, because Vercel's proxy overwrites
 * `x-forwarded-for` with the true peer before our code sees it — rotating the
 * header does not mint fresh buckets. But the false premise is worth deleting
 * rather than leaving for someone to lean on: behind ANY proxy that forwards a
 * client-supplied XFF, every identity here becomes attacker-chosen and the rate
 * limit stops existing. Combined with the in-memory fallback below, that would
 * remove the only real brake on guessing the answers.
 *
 * If this is ever deployed anywhere but Vercel, verify what the platform does to
 * `x-forwarded-for` BEFORE trusting either value.
 *
 * Falling back to a shared constant is intentional: an unidentifiable caller
 * should share one very small bucket rather than get a free pass.
 */
export function clientKey(request: Request, clientAddress?: string): string {
  if (clientAddress) return clientAddress;
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}
