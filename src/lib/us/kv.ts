/**
 * kv.ts — the store behind "song of the day".
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS, AND WHY IT IS MORE THAN A CLIENT
 *
 * Four things belong together and are therefore all here:
 *
 *   1. THE INTERFACE — putSong / getSong / getSongs / putReaction / getReactions.
 *   2. THREE BACKENDS behind it, chosen from whatever credentials exist.
 *   3. THE KEY LAYOUT — the exact strings a song and a reaction live under.
 *   4. THE CALENDAR — the day-string those keys are built from.
 *
 * They are one module because they are one decision. Every song is stored under
 * `<YYYY-MM-DD>`, so the rule that turns "now" into that date string is not a
 * formatting detail — it IS the primary key. If the endpoint that writes and the
 * page that reads ever disagree about what day it is, the write lands in a key
 * nobody looks at and the page shows "nothing today" with no error anywhere.
 * Same failure mode answers.mjs guards against, same fix: exactly one
 * implementation, imported by everyone.
 *
 * For the same reason the REACTIONS vocabulary lives here. Those keys are
 * persisted forever; renaming one silently orphans every reaction she ever gave.
 * A list that gets written into a database is a schema, not a UI constant.
 *
 * Callers NEVER branch on the backend. That is the whole point of the Store
 * interface below: the pages and endpoints are written once, and which tier is
 * live is a deployment fact, not a code path they know about.
 *
 * ---------------------------------------------------------------------------
 * THE THREE TIERS, AND WHAT EACH ONE COSTS
 *
 * 1. UPSTASH REDIS  (hasKV())  — the best of the three, and the only one with
 *    real atomic operations. A reaction is one HSET/HDEL; a post is a SET plus a
 *    ZADD. Two people tapping at once cannot lose each other's write.
 *
 * 2. CLOUDFLARE R2  (hasR2())  — the pragmatic default here, because R2 is
 *    already required for the photos and a second account for two people's song
 *    history is not a trade worth making. Everything lives in ONE JSON object at
 *    `data/songs.json`, read and written whole with signed S3 requests.
 *
 *    BE HONEST ABOUT THE COST: R2 has no atomic increment and no
 *    compare-and-set that we use here, so every write is a READ-MODIFY-WRITE and
 *    it CAN RACE. Two writes that overlap — I post a song in the same second she
 *    taps a reaction — mean the second PUT overwrites the first one's change, and
 *    nothing anywhere reports it. This is not a transaction and must not be
 *    described as one. With exactly two humans, one of whom writes roughly once a
 *    morning, the race is theoretical; that is the entire reason it is
 *    acceptable, and it stops being acceptable the moment a third person or an
 *    automated writer appears. Writes are therefore kept small and whole-object,
 *    and never partial.
 *
 * 3. IN-PROCESS MAP (neither) — so the feature is buildable, clickable and
 *    reviewable before any account exists. PER INSTANCE and NON DURABLE: Vercel
 *    runs many functions, a song written by one is invisible to the next request
 *    that lands elsewhere, and a cold start is an empty archive. Development
 *    only. If this tier is ever live in production the feature is not broken
 *    loudly — it is broken in the quiet way where songs "sometimes disappear".
 *    storeTier() exists so pages can say so out loud instead of pretending.
 *
 * ---------------------------------------------------------------------------
 * FAILURE POLICY: READS AND WRITES THROW
 *
 * Unlike ratelimit.ts — which fails OPEN, because locking her out of her own
 * present is worse than a few extra guesses — this file fails LOUD. A song that
 * silently did not save is the worst outcome available: I would think I posted
 * it, she would see yesterday's, and nothing would ever tell either of us. So a
 * transport error is a thrown StoreError and every caller decides what to say.
 * `null` from a read means "that key does not exist", never "the network ate it".
 * ---------------------------------------------------------------------------
 */

import { AwsClient } from 'aws4fetch';
import { hasKV, hasR2, kvConfig, r2Config, r2Endpoint } from './config';

/** Thrown for transport problems only. A missing record is `null`, not an error. */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
  }
}

export type Tier = 'upstash' | 'r2' | 'memory';

/**
 * 2s on every network call.
 *
 * Chosen against the platform, not against the database: these calls happen
 * inside a serverless function that is itself on a request budget, and a hung
 * fetch with no signal would burn the whole thing before failing. Upstash from a
 * Vercel function is single-digit milliseconds; the R2 blob is kilobytes. 2s is
 * already two orders of magnitude past the expected case — anything slower is
 * not slow, it is broken, and the error is more useful than the wait.
 */
const TIMEOUT_MS = 2000;

/* ============================================================================
   THE WING'S CALENDAR

   One fixed timezone, on purpose. The alternative — UTC — breaks in the most
   embarrassing possible way: I post at 9pm Eastern, UTC has already rolled over,
   the song is filed under tomorrow, and her evening shows an empty page. A
   single declared zone means "today" is the same day for the phone that writes
   and the page that reads, whatever timezone either device is sitting in.
   ========================================================================= */

/** Change this one line to move the wing's midnight. Everything keys off it. */
export const WING_TZ = 'America/New_York';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Today, in the wing's timezone, as `YYYY-MM-DD`.
 *
 * `en-CA` is not a stylistic choice — it is the locale whose numeric date format
 * IS `YYYY-MM-DD`, which lets Intl do the timezone arithmetic (including the DST
 * transitions) and hand back a string that also sorts correctly. Doing this with
 * getUTCDate() and a fixed hour offset would be wrong twice a year.
 */
export function wingDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: WING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Is this a real calendar day in `YYYY-MM-DD` form?
 *
 * The round-trip through Date is what rejects `2026-02-31`: the shape test alone
 * would pass it and it would become a permanent, unreachable key. Anything that
 * becomes part of a primary key gets validated, never trusted.
 */
export function isWingDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const asUtc = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(asUtc.getTime()) && asUtc.toISOString().slice(0, 10) === value;
}

/** Human label for a stored date, e.g. `Fri 21 Aug`. Presentation only. */
export function wingDateLabel(date: string, opts: { withYear?: boolean } = {}): string {
  if (!isWingDate(date)) return date;
  // Parsed as UTC and formatted in UTC: the string is already a wing-local
  // calendar day, so re-interpreting it in WING_TZ would shift it back a day.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(opts.withYear ? { year: 'numeric' } : {}),
  }).format(new Date(`${date}T00:00:00Z`));
}

/** Sortable integer score for the Redis index: `2026-08-21` -> `20260821`. */
function dateScore(date: string): number {
  return Number(date.replace(/-/g, ''));
}

/* ============================================================================
   REACTION VOCABULARY

   Persisted keys, so treat this list as a migration surface: add freely, never
   rename or reuse a key. Unknown keys read back from the store are simply not
   rendered, which is what makes retiring one safe.

   The multi-codepoint emoji are written as escapes so this file stays pure
   ASCII. Same reasoning as answers.mjs: a literal U+1F501 is invisible in a diff
   and one editor or terminal mangling it turns it into a different string.
   ========================================================================= */

export interface Reaction {
  /** Stored verbatim. Never change one of these. */
  key: string;
  emoji: string;
  /** What a screen reader reads, and what sits under the emoji. */
  label: string;
}

export const REACTIONS: readonly Reaction[] = [
  { key: 'heart', emoji: '❤️', label: 'this one' },
  { key: 'loop', emoji: '\u{1F501}', label: 'on repeat' },
  { key: 'cry', emoji: '\u{1F62D}', label: 'okay, ow' },
  { key: 'move', emoji: '\u{1F57A}', label: 'made me move' },
  { key: 'pin', emoji: '\u{1F4CC}', label: "that's us" },
] as const;

const REACTION_KEYS = new Set(REACTIONS.map((r) => r.key));

export function isReactionKey(value: unknown): value is string {
  return typeof value === 'string' && REACTION_KEYS.has(value);
}

/* ============================================================================
   THE RECORD
   ========================================================================= */

export interface SongRecord {
  /** `YYYY-MM-DD` in WING_TZ. Also the primary key. */
  date: string;
  /** Spotify track id, always 22 base62 chars. Validated before it gets here. */
  id: string;
  title: string;
  /** May be empty: Spotify's credential-free oEmbed does not return an artist. */
  artist: string;
  /** Album art URL, or empty when the metadata call failed or was rejected. */
  art: string;
  /** My note. The actual point of the feature. */
  note: string;
  /** Epoch millis, for "posted this morning" copy and for debugging. */
  postedAt: number;
}

/**
 * Validate a record read back out of a store.
 *
 * We are the only writer, so this is not about hostile input — it is about SCHEMA
 * DRIFT. Adding a field, or hand-editing a value in the Upstash console at 1am,
 * must degrade to "that day has no song" rather than throwing inside a page
 * render and 500ing her whole vault.
 */
function parseSong(raw: unknown): SongRecord | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error('[us] a stored song is not JSON — ignoring it.');
      return null;
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return null;

  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (!isWingDate(obj.date) || !/^[A-Za-z0-9]{22}$/.test(str(obj.id))) return null;

  return {
    date: obj.date,
    id: str(obj.id),
    title: str(obj.title),
    artist: str(obj.artist),
    art: str(obj.art),
    note: str(obj.note),
    postedAt: Number(obj.postedAt) || 0,
  };
}

/**
 * Validate, drop the unusable, order newest-first, cap.
 *
 * ALL THREE TIERS go through this for their list read, and that is the point:
 * an earlier version had the memory tier return its Map's values directly, which
 * meant a malformed record was filtered out in production and rendered locally.
 * A validation rule that only some backends apply is worse than none, because it
 * turns a schema bug into "works on my laptop".
 *
 * Accepts raw values (JSON strings from Redis, plain objects from R2 or the Map)
 * because parseSong handles both, so no tier has to pre-normalize.
 */
function parseAndOrder(raws: unknown[], limit: number): SongRecord[] {
  return raws
    .map(parseSong)
    .filter((s): s is SongRecord => s !== null)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

/* ============================================================================
   THE INTERFACE

   Five operations. Everything the feature needs and nothing it does not, because
   each one has to be implemented three times and a sixth would have to justify
   itself three times over.
   ========================================================================= */

export interface Store {
  readonly tier: Tier;
  /** Write (or overwrite) one day's song. */
  putSong(song: SongRecord): Promise<void>;
  /** One day's song, or null when nothing was posted that day. */
  getSong(date: string): Promise<SongRecord | null>;
  /** The `limit` most recent songs, newest first. */
  getSongs(limit: number): Promise<SongRecord[]>;
  /** Set or clear one reaction for one day. */
  putReaction(date: string, key: string, on: boolean): Promise<void>;
  /** Which reactions exist, per date. Every date asked for gets an entry. */
  getReactions(dates: string[]): Promise<Record<string, string[]>>;
}

/** An empty result for every date asked, so callers never check for undefined. */
function emptyReactions(dates: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of dates) out[d] = [];
  return out;
}

/* ============================================================================
   TIER 1 — UPSTASH REDIS over REST
   ========================================================================= */

/** `us:` prefix matches ratelimit.ts's `us:rl:` so one Redis can hold both. */
const SONG_KEY = (date: string) => `us:song:${date}`;
const REACT_KEY = (date: string) => `us:react:${date}`;
/** Sorted set of every date that has a song, scored by dateScore(). */
const INDEX_KEY = 'us:song:index';

/** One Redis command as an argv array, e.g. `['GET', 'us:song:2026-08-21']`. */
type Command = (string | number)[];

/**
 * One HTTP round trip for N commands.
 *
 * `/pipeline` rather than N single-command calls because the cost here is
 * entirely round trips. Note this is a pipeline, NOT a transaction
 * (`/multi-exec`): nothing needs atomicity ACROSS commands, and the worst
 * interleaving is an index entry pointing at a blob written a millisecond later,
 * which getSongs() already tolerates.
 */
async function redis(url: string, token: string, cmds: Command[]): Promise<unknown[]> {
  if (cmds.length === 0) return [];

  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // Every argument stringified: the REST protocol is textual anyway, and
      // normalizing here means a number vs a numeric string never becomes a
      // difference in behaviour between the tiers.
      body: JSON.stringify(cmds.map((c) => c.map(String))),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout arrives as an AbortError, indistinguishable from a network
    // failure to every caller, so both are normalized into one error type.
    throw new StoreError('upstash unreachable', { cause: err });
  }

  if (!res.ok) throw new StoreError(`upstash HTTP ${res.status}`);

  const parsed = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  if (!Array.isArray(parsed) || parsed.length !== cmds.length) {
    throw new StoreError('upstash returned a malformed pipeline response');
  }

  return parsed.map((entry, i) => {
    // A per-command error (wrong type, bad syntax) is a bug in this file rather
    // than a runtime condition, so it is fatal. Only the command NAME is logged:
    // the arguments contain her reactions and my notes.
    if (entry?.error) throw new StoreError(`upstash ${String(cmds[i][0])} failed: ${entry.error}`);
    return entry?.result ?? null;
  });
}

function upstashStore(url: string, token: string): Store {
  const run = (cmds: Command[]) => redis(url, token, cmds);

  return {
    tier: 'upstash',

    async putSong(song) {
      // Overwriting is a feature: the realistic mistake is a typo in the note and
      // the fix has to be "post it again from my phone". ZADD on an existing
      // member updates its score instead of duplicating it, so re-posting the
      // same day never doubles up in the archive.
      await run([
        ['SET', SONG_KEY(song.date), JSON.stringify(song)],
        ['ZADD', INDEX_KEY, dateScore(song.date), song.date],
      ]);
    },

    async getSong(date) {
      const [raw] = await run([['GET', SONG_KEY(date)]]);
      return parseSong(raw);
    },

    async getSongs(limit) {
      // Two round trips, and deliberately not one: the index is read first so
      // that MGET only fetches the newest `limit` blobs. The alternative — one
      // hash holding every song ever — would drag the entire history across the
      // wire to render a single card, and would grow without bound.
      const [rawDates] = await run([['ZRANGE', INDEX_KEY, 0, limit - 1, 'REV']]);
      const dates = (Array.isArray(rawDates) ? rawDates : []).filter(isWingDate);
      if (dates.length === 0) return [];

      const [rawBlobs] = await run([['MGET', ...dates.map(SONG_KEY)]]);
      const blobs = Array.isArray(rawBlobs) ? rawBlobs : [];
      // A date in the index with no blob behind it is dropped silently and on
      // purpose: it means a half-completed write or a manually deleted key, and
      // the right behaviour for an archive is "that row is not there". The
      // re-sort inside parseAndOrder is redundant given ZRANGE ... REV, and kept
      // anyway so this tier cannot drift from the other two.
      return parseAndOrder(blobs, limit);
    },

    async putReaction(date, key, on) {
      // The one place a tier difference is visible in the outcome rather than
      // just the code: this is a single atomic field write. No read, no race.
      await run([
        on ? ['HSET', REACT_KEY(date), key, String(Date.now())] : ['HDEL', REACT_KEY(date), key],
      ]);
    },

    async getReactions(dates) {
      const out = emptyReactions(dates);
      if (dates.length === 0) return out;
      // HKEYS, not HGETALL: only the field names are rendered, so asking for the
      // values would drag the timestamps over the wire on every page load.
      const results = await run(dates.map((d) => ['HKEYS', REACT_KEY(d)]));
      dates.forEach((d, i) => {
        const raw = results[i];
        out[d] = Array.isArray(raw) ? raw.filter(isReactionKey) : [];
      });
      return out;
    },
  };
}

/* ============================================================================
   TIER 2 — CLOUDFLARE R2, one JSON object

   Read the whole document, change one field, write the whole document back.
   Everything about this tier follows from that sentence, including its race
   (see the header). The document is deliberately boring and self-describing so
   that opening it in the Cloudflare dashboard at 2am is a useful thing to do.
   ========================================================================= */

/**
 * The object key. `data/` rather than the bucket root because Phase 3's photos
 * live in the same bucket and mixing bytes with bookkeeping at the top level is
 * how you eventually delete the wrong thing.
 */
const R2_DOC_KEY = 'data/songs.json';

interface SongDoc {
  /** Schema version. Present from day one so a future migration has a hinge. */
  v: 1;
  /** date -> song */
  songs: Record<string, SongRecord>;
  /** date -> reaction key -> epoch millis of the tap */
  reactions: Record<string, Record<string, number>>;
}

const EMPTY_DOC: SongDoc = { v: 1, songs: {}, reactions: {} };

/**
 * A client per process, not per call.
 *
 * `retries: 1` is a deliberate override of the library's default of 10. Those
 * retries use exponential backoff and would happily spend far more than this
 * function's entire time budget on a bucket that is down. One retry absorbs a
 * blip; ten absorb an outage by hanging.
 *
 * NOTE for integration: photos.ts constructs its own AwsClient for presigning.
 * That duplication is known and intentional for now — these are different
 * operations (signed request vs presigned URL) with different lifetimes, and
 * sharing a client across the two would couple the song store to the photo
 * pipeline for the sake of four lines.
 */
let r2Client: AwsClient | null = null;
function r2(): { client: AwsClient; base: string } {
  const { accessKeyId, secretAccessKey, bucket } = r2Config();
  const endpoint = r2Endpoint();
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) {
    throw new StoreError('r2 selected but not fully configured');
  }
  r2Client ??= new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    // R2 has no regions but SigV4 requires one in the credential scope, and
    // 'auto' is the value Cloudflare documents for the S3 API.
    region: 'auto',
    retries: 1,
  });
  // Path-style addressing: R2's S3 endpoint is per-account, and the bucket is
  // the first path segment. Virtual-host style would need a different hostname.
  return { client: r2Client, base: `${endpoint}/${encodeURIComponent(bucket)}` };
}

/** Shape-check a document read from the bucket. Returns null when unusable. */
function parseDoc(text: string): SongDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<SongDoc>;
  const songs = obj.songs && typeof obj.songs === 'object' ? obj.songs : null;
  const reactions = obj.reactions && typeof obj.reactions === 'object' ? obj.reactions : {};
  if (!songs) return null;
  return { v: 1, songs: songs as SongDoc['songs'], reactions: reactions as SongDoc['reactions'] };
}

async function readDoc(): Promise<{ doc: SongDoc; existed: boolean; corrupt: boolean }> {
  const { client, base } = r2();
  let res: Response;
  try {
    res = await client.fetch(`${base}/${R2_DOC_KEY}`, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new StoreError('r2 unreachable', { cause: err });
  }

  // 404 is the normal first-run state, not an error: nobody has posted yet.
  if (res.status === 404) return { doc: structuredClone(EMPTY_DOC), existed: false, corrupt: false };
  if (!res.ok) throw new StoreError(`r2 GET HTTP ${res.status}`);

  const parsed = parseDoc(await res.text());
  if (!parsed) {
    // Reads degrade to empty so her page still renders. Writes do NOT (below):
    // overwriting an object we could not understand is how a bad deploy turns
    // into a deleted year of songs.
    console.error(`[us] ${R2_DOC_KEY} exists but is not a song document — reading as empty.`);
    return { doc: structuredClone(EMPTY_DOC), existed: true, corrupt: true };
  }
  return { doc: parsed, existed: true, corrupt: false };
}

async function writeDoc(doc: SongDoc): Promise<void> {
  const { client, base } = r2();
  const body = JSON.stringify(doc);
  let res: Response;
  try {
    res = await client.fetch(`${base}/${R2_DOC_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new StoreError('r2 unreachable', { cause: err });
  }
  if (!res.ok) throw new StoreError(`r2 PUT HTTP ${res.status}`);
}

/** Read, apply, write. The race is documented in the file header. */
async function mutateDoc(apply: (doc: SongDoc) => void): Promise<void> {
  const { doc, corrupt } = await readDoc();
  if (corrupt) {
    throw new StoreError(
      `refusing to overwrite ${R2_DOC_KEY}: it exists but is not a valid song document`,
    );
  }
  apply(doc);
  await writeDoc(doc);
}

function r2Store(): Store {
  return {
    tier: 'r2',

    async putSong(song) {
      await mutateDoc((doc) => {
        doc.songs[song.date] = song;
      });
    },

    async getSong(date) {
      const { doc } = await readDoc();
      return parseSong(doc.songs[date]);
    },

    async getSongs(limit) {
      const { doc } = await readDoc();
      return parseAndOrder(Object.values(doc.songs), limit);
    },

    async putReaction(date, key, on) {
      await mutateDoc((doc) => {
        const day = (doc.reactions[date] ??= {});
        if (on) day[key] = Date.now();
        else delete day[key];
        // Prune the empty day so the document does not accumulate `{}` entries
        // for every reaction she ever changed her mind about.
        if (Object.keys(day).length === 0) delete doc.reactions[date];
      });
    },

    async getReactions(dates) {
      const out = emptyReactions(dates);
      if (dates.length === 0) return out;
      const { doc } = await readDoc();
      for (const d of dates) {
        out[d] = Object.keys(doc.reactions[d] ?? {}).filter(isReactionKey);
      }
      return out;
    },
  };
}

/* ============================================================================
   TIER 3 — IN-PROCESS MAP

   Non durable, per instance. See the header. Implemented directly against Maps
   rather than by emulating Redis commands, because a fake Redis is a second
   thing that can be subtly wrong, and this tier's only job is to be obviously
   correct for one developer on one laptop.
   ========================================================================= */

const memory = {
  songs: new Map<string, SongRecord>(),
  /** date -> (reaction key -> epoch millis) */
  reactions: new Map<string, Map<string, number>>(),
};

function memoryStore(): Store {
  return {
    tier: 'memory',

    async putSong(song) {
      memory.songs.set(song.date, song);
    },

    async getSong(date) {
      return parseSong(memory.songs.get(date) ?? null);
    },

    async getSongs(limit) {
      return parseAndOrder([...memory.songs.values()], limit);
    },

    async putReaction(date, key, on) {
      const day = memory.reactions.get(date) ?? new Map<string, number>();
      memory.reactions.set(date, day);
      if (on) day.set(key, Date.now());
      else day.delete(key);
    },

    async getReactions(dates) {
      const out = emptyReactions(dates);
      for (const d of dates) {
        out[d] = [...(memory.reactions.get(d)?.keys() ?? [])].filter(isReactionKey);
      }
      return out;
    },
  };
}

/* ============================================================================
   SELECTION
   ========================================================================= */

/**
 * Which tier is live.
 *
 * Resolved per call rather than cached at module load, matching config.ts's
 * reasoning: `import.meta.env` is read at request time on Vercel, and a value
 * frozen during the build container's module evaluation would be the build
 * container's answer forever.
 */
export function storeTier(): Tier {
  if (hasKV()) return 'upstash';
  if (hasR2()) return 'r2';
  return 'memory';
}

/**
 * Announced ONCE per process, the first time the store is touched.
 *
 * Not decoration. The failure this prevents is the quiet one: a production
 * deploy that silently landed on the memory tier because an environment variable
 * was renamed, where every symptom is "songs sometimes vanish" and no log line
 * ever says why. One line at cold start makes that a five-second diagnosis.
 */
let announced = false;
function announce(tier: Tier): void {
  if (announced) return;
  announced = true;
  if (tier === 'memory') {
    console.warn(
      '[us] song store: IN-PROCESS MEMORY. Non-durable and per-instance — ' +
        'nothing posted here survives a restart. Set UPSTASH_REDIS_REST_URL/_TOKEN ' +
        'or the R2_* variables before this is real.',
    );
  } else {
    console.log(`[us] song store: ${tier}`);
  }
}

function store(): Store {
  const tier = storeTier();
  announce(tier);
  if (tier === 'upstash') {
    const { url, token } = kvConfig();
    return upstashStore(url!, token!);
  }
  if (tier === 'r2') return r2Store();
  return memoryStore();
}

/* ============================================================================
   THE PUBLIC SURFACE

   Free functions rather than "get the store, then call it", so that no caller
   ever holds a backend-specific object and none of them can accidentally grow a
   branch on which tier is live.
   ========================================================================= */

export function putSong(song: SongRecord): Promise<void> {
  return store().putSong(song);
}

export function getSong(date: string): Promise<SongRecord | null> {
  // Guarded here rather than in three implementations: an invalid date can never
  // have a record, so this is "not found" and not an error.
  if (!isWingDate(date)) return Promise.resolve(null);
  return store().getSong(date);
}

export function getSongs(limit: number): Promise<SongRecord[]> {
  // Clamped so a caller cannot ask for the entire history by passing Infinity —
  // on the Redis tier that becomes one enormous MGET.
  const capped = Math.max(0, Math.min(365, Math.floor(limit) || 0));
  if (capped === 0) return Promise.resolve([]);
  return store().getSongs(capped);
}

export function putReaction(date: string, key: string, on: boolean): Promise<void> {
  // Silently ignoring an unknown key would hide a typo in a caller; the caller
  // is expected to have validated already, so reaching here with garbage is a
  // bug worth a thrown error rather than a no-op write.
  if (!isWingDate(date)) throw new StoreError(`putReaction: ${date} is not a wing date`);
  if (!isReactionKey(key)) throw new StoreError('putReaction: unknown reaction key');
  return store().putReaction(date, key, on);
}

export function getReactions(dates: string[]): Promise<Record<string, string[]>> {
  const valid = dates.filter(isWingDate);
  if (valid.length === 0) return Promise.resolve(emptyReactions(valid));
  return store().getReactions(valid);
}
