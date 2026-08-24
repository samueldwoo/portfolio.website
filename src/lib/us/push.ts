/**
 * push.ts — "something happened", and never what.
 *
 * ---------------------------------------------------------------------------
 * WHAT A NOTIFICATION IN THIS WING IS ALLOWED TO BE
 *
 * A lock screen is a public surface. It is readable by whoever is next to her on
 * a train, whoever walks past her desk, whoever picks the phone up off a table.
 * The entire design of this wing is that private things live behind the gate, and
 * a notification is the one thing here that goes in front of it.
 *
 * So a notification says WHAT HAPPENED and never WHAT WAS SAID:
 *
 *     "Sam picked a song"        yes
 *     the title, the artist      no
 *     the note he wrote with it  no
 *     either answer to the day's question  no
 *     a photo caption            no
 *     one word of a letter       no
 *
 * A leak here is the same class of defect as leaking a sealed letter, and it is
 * WORSE in one respect: a sealed letter leaks to the person it was for, and this
 * would leak to a stranger over her shoulder.
 *
 * ---------------------------------------------------------------------------
 * THE RULE IS STRUCTURAL, NOT CAREFUL
 *
 * `notify()` takes exactly two arguments — who acted, and which of five events it
 * was — and there is no third. It never receives a record, a title, a note, a
 * date or an id, so there is nothing in scope for a mistake to reach for. The
 * body it puts on the wire is built by payload() below and is always, exactly:
 *
 *     {"e":"<one of five keys>","a":"her"|"him"}
 *
 * Both values are validated against frozen vocabularies before they are written,
 * and the SENTENCES do not live here at all — public/sw.js resolves the key into
 * copy on the device. So the wire carries an enum and the phone carries the
 * words, and there is no field a song title could travel in even if somebody
 * tried to put one there.
 *
 * If you are here to add `{ title }` or `{ body }` to the payload: that is the
 * change this file is shaped to refuse. The copy is in public/sw.js.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER COSTS A WRITE. THIS IS THE OTHER HARD RULE.
 *
 * Every write endpoint in this wing fails loud or soft by an explicit policy.
 * This one is strictly SOFT, and unusually so: `notify()` cannot throw, cannot
 * reject, and returns void. Not "is unlikely to" — cannot. Every await inside is
 * inside a try, the whole body is inside a try, and the outermost catch swallows.
 *
 * The reason is a ranking, not squeamishness. A song that failed to save is a
 * real loss and must be reported. A song that saved but whose notification did
 * not send costs a few hours of her not knowing, which she then finds the next
 * time she opens the app — the wing worked perfectly well for months with no
 * notifications at all. Trading a saved song for a failed notification would be
 * getting that ranking exactly backwards, so the call sites put this AFTER the
 * write has succeeded and treat its result as nothing.
 *
 * ---------------------------------------------------------------------------
 * AND IT IS AWAITED, NOT FIRED AND FORGOTTEN
 *
 * src/pages/samdrea/vault/letters.astro carries the same warning about its read
 * receipt, and it applies verbatim: a serverless function that returns before its
 * work lands does not finish it. Vercel may freeze or reclaim the instance the
 * moment the response is flushed, so a floating promise here is a notification
 * that sometimes sends and sometimes silently does not, depending on how quickly
 * the platform tidied up. Every call site writes `await notify(...)`.
 *
 * Which is why the timeouts below are short and deliberate. Awaiting means this
 * is on her critical path — the tap does not finish until this does — so the
 * whole thing is bounded, and a push service that has stopped answering costs a
 * couple of seconds rather than the request.
 */

import type { WebPushModule } from 'web-push';
import { hasKV, hasPush, kvConfig, pushConfig } from './config';
import { otherOne, type Who } from './together';
import { timer, trace } from './trace';

/* ============================================================================
   THE VOCABULARY

   Five events, and the list is closed. public/sw.js has the SAME five keys and
   the sentence for each; the two files are a pair, and adding an event means
   editing both — the worker falls back to a content-free "Something new in [us]"
   for a key it does not recognise, so a half-applied change is quiet and wrong
   rather than loud and wrong.
   ========================================================================= */

/**
 * Every event that notifies. One event produces AT MOST ONE notification, which
 * is enforced in two independent places for two different failure modes:
 *
 *   here      — each call site calls notify() exactly once, after its write, and
 *               only when the write actually changed something. A debounced tap
 *               and a re-tapped reaction both already-happened, so neither sends.
 *   sw.js     — `tag: 'us-<event>'` makes a second notification of the same kind
 *               REPLACE an undismissed one instead of stacking under it.
 */
export const PUSH_EVENTS = ['thinking', 'song', 'photo', 'reaction', 'revealed'] as const;

export type PushEvent = (typeof PUSH_EVENTS)[number];

/** Frozen so a caller cannot append a sixth key at runtime and get it sent. */
const EVENT_SET: ReadonlySet<string> = new Set<string>(PUSH_EVENTS);

export function isPushEvent(value: unknown): value is PushEvent {
  return typeof value === 'string' && EVENT_SET.has(value);
}

/**
 * The bytes that go on the wire, and the ONLY function that builds them.
 *
 * Exported so it can be asserted against directly rather than inferred from a
 * captured request — the no-content rule is the most important property in this
 * feature and it deserves a test that reads the exact string.
 *
 * Note what this cannot do: it takes two enums and returns a two-field object,
 * built field by field with literal keys. There is no spread, no `...extra`, no
 * optional third argument. Adding content to a notification would mean changing
 * this signature, which is a change a reviewer cannot miss.
 */
export function payload(event: PushEvent, actor: Who): string {
  return JSON.stringify({ e: event, a: actor });
}

/* ============================================================================
   THE STORE

   `us:push:<who>` — a NEW key space. Deliberately not folded into us:presence:,
   us:mark: or the together document: this holds a device credential rather than
   a thing somebody wrote, it has a completely different lifetime (it dies when
   she deletes the home-screen tile), and it is the one record here whose loss
   costs nothing at all.

   A HASH, NOT A STRING OR A LIST, and that choice is what makes several
   requirements fall out for free:

     one person, several devices   one field per device. Her phone, her laptop
                                   and his phone are three fields under two keys.
     dedupe on the endpoint        the field NAME is the endpoint URL, so HSET of
                                   an endpoint that is already there overwrites
                                   it. A list would accumulate duplicates every
                                   time the hub re-synced, and a string could
                                   only ever hold one device.
     pruning a dead one            HDEL of one field. No read-modify-write, so no
                                   race that could resurrect a subscription the
                                   push service has already told us is gone.

   THERE IS NO R2 TIER AND NO MEMORY TIER, for exactly presence.ts's reason: this
   is not a thing somebody wrote. Without Upstash there is nowhere to keep a
   subscription, so the feature is UNAVAILABLE and the hub says so, rather than
   accepting a subscription into a per-instance Map that the next cold start
   throws away — which would look like it worked and then never notify her again.
   ========================================================================= */

const KEY = (who: Who) => `us:push:${who}`;

/**
 * A cap, because the field count is not otherwise bounded by anything.
 *
 * A subscription endpoint is minted per browser profile per installation, so
 * deleting the tile and adding it again produces a NEW field rather than
 * replacing the old one — the old endpoint is already dead but nothing has told
 * us yet, and nothing will until we try to push to it and get a 410. So the
 * honest steady state is a handful of live devices plus some tombstones, and the
 * cap is what stops the tombstones being unbounded.
 *
 * Eight is generous for two people: a phone, a tablet and a laptop each, with
 * room for two reinstalls in flight. When it is hit, the OLDEST field goes —
 * `at` is the store's own clock at the time it was written, and the oldest
 * device is overwhelmingly the likeliest to be the dead one.
 */
export const MAX_DEVICES = 8;

/** Longer than any real push endpoint and short enough to bound a store field. */
const MAX_ENDPOINT_CHARS = 1024;

/** One device. Exactly what web-push needs and not one field more. */
export interface Device {
  /** The push service URL. ALSO the hash field name — see the section header. */
  endpoint: string;
  /** The device's ECDH public key, base64url. */
  p256dh: string;
  /** The device's auth secret, base64url. */
  auth: string;
  /** Server clock when it was stored. Only used to pick an eviction victim. */
  at: number;
}

/**
 * One pipelined Upstash call that resolves to null rather than throwing, ever.
 *
 * Lifted from presence.ts, which explains the shape at length. Same policy for
 * the same reason: nothing in this file is important enough to break a page or a
 * write, so there is no error to propagate — only a thing that did not happen.
 */
async function redis(cmds: (string | number)[][]): Promise<unknown[] | null> {
  const { url, token } = kvConfig();
  if (!hasKV() || !url || !token) return null;

  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map((c) => c.map(String))),
      /* Longer than presence.ts's 1500ms because this one is on a WRITE path and
         a subscription that silently failed to save means she taps the button,
         is told it worked, and is never notified again. Still short: it is
         awaited inside a request. */
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      console.error(`[us] push store returned ${res.status}.`);
      return null;
    }
    const parsed = (await res.json()) as Array<{ result?: unknown; error?: string }>;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((e) => (e?.error ? null : e?.result ?? null));
  } catch (err) {
    console.error('[us] push store unreachable:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Validate a subscription that came out of a browser.
 *
 * The caller has already proved they are one of the two people, so this is not
 * standing between the store and an attacker so much as between the store and a
 * malformed object. It still refuses everything it does not recognise, because a
 * field that is not a string is a field that becomes `"undefined"` in a hash and
 * then a permanently unpushable device nothing ever cleans up.
 *
 * ---------------------------------------------------------------------------
 * ON THE SERVER FETCHING A URL THE CLIENT CHOSE
 *
 * `endpoint` is where we will later make an outbound HTTPS request, so it is
 * worth being explicit about what is and is not checked, and why.
 *
 * CHECKED: the scheme is `https:` and the length is bounded. Both are cheap and
 * both remove a whole class of nonsense (`file:`, `javascript:`, a megabyte of
 * junk in a hash field).
 *
 * NOT CHECKED: whether the host is public. A host allowlist was considered and
 * rejected — the list of real push services is Google's, Apple's, Mozilla's and
 * Microsoft's, it changes without notice, and getting it wrong means her phone
 * quietly stops being notifiable with nothing on screen to explain it. That is a
 * worse failure than the one it prevents.
 *
 * THE RESIDUAL RISK, STATED PLAINLY: someone who already holds a session can
 * make this server issue a blind HTTPS POST to a host of their choosing. It is
 * blind — the response body is never returned to the caller and never logged;
 * only "was it 404/410" reaches any decision. It is https-only, which rules out
 * the http-only cloud metadata endpoints that make blind SSRF interesting. And
 * the two people who can reach it are the two people the wing is for. That is an
 * accepted risk rather than an unnoticed one.
 */
export function readDevice(raw: unknown, atMs: number): Device | null {
  if (!raw || typeof raw !== 'object') return null;
  const sub = raw as Record<string, unknown>;

  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
  if (!endpoint || endpoint.length > MAX_ENDPOINT_CHARS) return null;
  try {
    if (new URL(endpoint).protocol !== 'https:') return null;
  } catch {
    return null;
  }

  /* `keys` is where the browser puts them (PushSubscription.toJSON()), but a
     flat shape is accepted too so a caller is not obliged to nest. */
  const keys = (sub.keys && typeof sub.keys === 'object' ? sub.keys : sub) as Record<string, unknown>;
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  /* Bounded and shape-checked. These are base64url of a 65-byte point and a
     16-byte secret, so anything with a character outside that alphabet is not a
     key and would only fail later, inside the encryption, as a stack trace. */
  const b64url = /^[A-Za-z0-9_-]+$/;
  if (!p256dh || p256dh.length > 200 || !b64url.test(p256dh)) return null;
  if (!auth || auth.length > 64 || !b64url.test(auth)) return null;

  return { endpoint, p256dh, auth, at: atMs };
}

function parseDevice(raw: unknown): Device | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const device = readDevice(parsed, Number(parsed.at) || 0);
    if (!device) return null;
    // Keep the STORED clock rather than readDevice's argument, so eviction order
    // survives a read.
    return { ...device, at: Number(parsed.at) || 0 };
  } catch {
    return null;
  }
}

/** Every device one person has registered. Empty on any failure. */
export async function devicesFor(who: Who): Promise<Device[]> {
  const out = await redis([['HGETALL', KEY(who)]]);
  const flat = out?.[0];
  if (!Array.isArray(flat)) return [];

  const devices: Device[] = [];
  // Upstash returns a flat [field, value, field, value, ...] array for HGETALL.
  for (let i = 1; i < flat.length; i += 2) {
    const device = parseDevice(flat[i]);
    if (device) devices.push(device);
  }
  return devices;
}

/**
 * Register one device for one person. Idempotent on the endpoint.
 *
 * Returns true when the store accepted it. This is the ONE function in the file
 * whose outcome the caller reports, because it is the only one she is watching:
 * the button says "on" or it says it could not, and saying "on" over a
 * subscription that did not save is the failure mode of the whole control.
 */
export async function subscribeDevice(who: Who, raw: unknown, atMs: number): Promise<boolean> {
  const device = readDevice(raw, atMs);
  if (!device) return false;

  /* THE CAP, CHECKED BEFORE THE WRITE and only when the endpoint is new — the
     same shape react.ts uses for its per-day reaction ceiling. Re-registering a
     device that is already there can never push the count up, so it must never
     be able to evict anything. */
  const existing = await devicesFor(who);
  const known = existing.some((d) => d.endpoint === device.endpoint);
  if (!known && existing.length >= MAX_DEVICES) {
    const oldest = existing.reduce((a, b) => (a.at <= b.at ? a : b));
    await redis([['HDEL', KEY(who), oldest.endpoint]]);
  }

  const out = await redis([
    ['HSET', KEY(who), device.endpoint, JSON.stringify(device)],
  ]);
  return out !== null;
}

/**
 * Drop EVERY device registered to one identity.
 *
 * ---------------------------------------------------------------------------
 * THIS EXISTS FOR THE IDENTITY SWITCH, AND IT IS THE SAME BUG PRESENCE HAD
 *
 * Subscribing is keyed on whoever `identify()` says the reader is at that
 * moment. So browsing as her on HIS phone — which is the only way to check her
 * copy of the wing — registers his phone under `us:push:her`. Nothing about the
 * subscription is wrong at the time it is written; it becomes wrong the instant
 * he says "actually I am Sam", and no later event can tell the store that the
 * row is now about the wrong person.
 *
 * Presence had exactly this shape and the visible symptom was the hub telling him
 * "she is in here too, right now" about himself. The push version is louder: he
 * gets a notification about his own action, and — worse — HER notification lands
 * on HIS phone, which means she silently stops being told anything while a device
 * she does not hold answers for her.
 *
 * It self-heals on her next hub load, because the page re-syncs its subscription
 * on every open. But "next time she opens the app" is not a bound, and until then
 * the notifications she asked for go to the wrong continent.
 *
 * WHY THE WHOLE HASH AND NOT ONE FIELD: the switch does not know which endpoint
 * belongs to the device in hand, and cannot — the server never sees the
 * subscription of a device that is merely reading. Every row under the abandoned
 * identity is suspect, and a wrongly-dropped row costs one re-subscribe on next
 * open, which is the cheap direction to be wrong in.
 *
 * Never throws and returns nothing: a store that is down must not turn a
 * successful identity switch into an error. The stale row then survives until she
 * next opens the app, which is where it would have healed anyway.
 */
export async function dropDevices(who: Who): Promise<void> {
  try {
    await redis([['DEL', KEY(who)]]);
  } catch (err) {
    console.error('[us] could not drop push devices on identity switch.', err);
  }
}

/**
 * Forget one device.
 *
 * True when the store answered, whether or not the field was there. "It is not
 * registered any more" is the same outcome either way, and reporting a failure
 * because the row had already gone would tell her the off switch is broken.
 */
export async function unsubscribeDevice(who: Who, endpoint: unknown): Promise<boolean> {
  const clean = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (!clean || clean.length > MAX_ENDPOINT_CHARS) return false;
  const out = await redis([['HDEL', KEY(who), clean]]);
  return out !== null;
}

/**
 * Drop subscriptions the push service says are gone.
 *
 * ONE HDEL WITH EVERY FIELD, not a field at a time: the reason to prune is that
 * a device is dead, and a dead device does not care how promptly it is forgotten
 * — but the request she is waiting on does.
 */
async function pruneDevices(who: Who, endpoints: string[]): Promise<void> {
  if (endpoints.length === 0) return;
  await redis([['HDEL', KEY(who), ...endpoints]]);
  console.warn(`[us] pruned ${endpoints.length} dead push subscription(s) for ${who}.`);
}

/* ============================================================================
   THE SEND
   ========================================================================= */

/** Per-request ceiling handed to web-push, so one unresponsive service is bounded. */
const SEND_TIMEOUT_MS = 4000;

/**
 * How long a push service should hold an undelivered notification.
 *
 * Six hours, against web-push's four-week default. Everything here is an
 * ephemeral "this just happened": a tap that arrives four weeks late is not a
 * late notification, it is a wrong one, and she would open the app to find the
 * thing it announced sitting a month down the page. Six hours covers a phone
 * that was in a bag or on a plane and expires anything staler.
 */
const TTL_SEC = 6 * 60 * 60;

/**
 * The status codes that mean "that subscription no longer exists".
 *
 * 410 Gone is the specification's answer and what every push service sends when
 * she deletes the home-screen tile or clears site data. 404 is what some of them
 * send instead for the same condition. Both are terminal, so they prune.
 *
 * NOTHING ELSE PRUNES, and that is the important half. 429, 500, 502 and a
 * timeout are all "not now" — deleting a live subscription because a push service
 * had a bad minute would mean her notifications silently stop and the only way
 * back is noticing and pressing the button again.
 */
function isGone(status: unknown): boolean {
  return status === 404 || status === 410;
}

/** Never log a whole endpoint: it is a capability URL. The host is enough. */
function safeLabel(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unparseable';
  }
}

/**
 * IMPORTED LAZILY, INSIDE THE TRY.
 *
 * `web-push` pulls in five transitive CommonJS dependencies and needs none of
 * them until something is actually being sent. Two things fall out of loading it
 * here rather than at the top of the file:
 *
 *   1. A module-resolution failure — a bad deploy, a pruned dependency — becomes
 *      a caught error and a missing notification, instead of an import that
 *      throws while the endpoint module is still being evaluated and takes the
 *      whole route down with it. Which is the same rule as everything else here:
 *      this feature is never allowed to be the reason a write fails.
 *   2. Every page and endpoint that only reads or writes SUBSCRIPTIONS — the hub,
 *      /api/us/push — never loads the encryption stack at all.
 */
async function loadWebPush(): Promise<WebPushModule | null> {
  try {
    /* A STRING LITERAL, NOT A VARIABLE. It is tempting to write
       `import(spec)` to dodge the missing types — that is how this was first
       drafted — and it would break the DEPLOY rather than the build: Vercel's
       adapter traces the function's dependencies statically, so a specifier it
       cannot read means `web-push` is never copied into the bundle and every
       notification fails with a resolution error in production only. The types
       are handled properly in src/lib/us/web-push.d.ts instead. */
    const mod = await import('web-push');
    /* CommonJS, so the exports object arrives as `default` — confirmed, because
       `sendNotification` is exported as a `.bind()` call and Node's named-export
       detection cannot see through that. The fallback covers a future ESM
       release rather than today's shape. */
    return mod.default ?? (mod as unknown as WebPushModule);
  } catch (err) {
    console.error('[us] web-push could not be loaded:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Tell the OTHER one that something happened.
 *
 * @param actor who did the thing. From identify(), never from a request body.
 * @param event which of the five. A literal at every call site.
 *
 * NEVER RESOLVES TO ANYTHING AND NEVER REJECTS. Await it and carry on.
 *
 * ---------------------------------------------------------------------------
 * A PERSON IS NEVER NOTIFIED OF THEIR OWN ACTION, AND THAT IS ARITHMETIC HERE
 *
 * The recipient is `otherOne(actor)` and there is no branch, no flag and no
 * argument that could make it anything else. Only the recipient's key is read,
 * so the actor's own devices are not merely skipped — they are never fetched,
 * which means there is no list for a filter to get wrong.
 *
 * The one thing that WOULD break it is the two of them sharing a browser
 * profile, because identity in this wing is a declaration (see whoami.ts) and a
 * single profile holds one subscription. If Sam browses as her on his own phone
 * and subscribes, that endpoint is filed under `her` and her notifications go to
 * his phone. presence.ts hit the same edge and solved it with forget(); the
 * difference is that this one is visible the instant it happens — he gets a
 * notification about something he just did — rather than silently wrong.
 */
export async function notify(actor: Who, event: PushEvent): Promise<void> {
  /* Notifications fail SILENTLY by design — a failed push must never cost a write —
     which also made them impossible to debug. "She says she got nothing" had no
     evidence either way. Now there is a line per attempt: how many devices were
     tried, how many were pruned as dead, and how long Apple took. */
  const t = timer();
  try {
    if (!isPushEvent(event)) {
      // A caller passing something outside the vocabulary is a bug in the caller,
      // and sending an unrecognised key would make the worker show its generic
      // "something new" line. Refuse rather than notify vaguely.
      console.error(`[us] notify called with an unknown event: ${String(event)}`);
      return;
    }

    if (!hasPush()) {
      // Not an error. The wing ran without notifications for months and the hub
      // says so; this is the same "optional backing service" contract kvConfig
      // and r2Config have.
      return;
    }
    if (!hasKV()) return;

    const to = otherOne(actor);
    const devices = await devicesFor(to);
    if (devices.length === 0) return;

    const webpush = await loadWebPush();
    if (!webpush) return;

    const { publicKey, privateKey, subject } = pushConfig();
    if (!publicKey || !privateKey || !subject) return;

    /* THE BODY. Two enums, built by payload(), and nothing from any record has
       ever been in scope in this function. */
    const body = payload(event, actor);

    const dead: string[] = [];

    /* allSettled, not all: one device failing must not stop the others, and
       there is nothing to propagate anyway. Awaited as a whole so the function
       does not return before the sends have landed — see the header on why a
       floating promise here would be a notification that sometimes arrives. */
    await Promise.allSettled(
      devices.map(async (device) => {
        try {
          await webpush.sendNotification(
            { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
            body,
            {
              vapidDetails: { subject, publicKey, privateKey },
              TTL: TTL_SEC,
              timeout: SEND_TIMEOUT_MS,
              /* `Topic` lets the push service itself collapse an undelivered
                 notification with a newer one of the same kind, so a phone that
                 was off for an afternoon gets one "Sam picked a song" rather
                 than three. sw.js's `tag` does the same job once they have
                 arrived; this does it before they do. Must be <=32 URL-safe
                 base64 characters, which every event key is. */
              topic: `us-${event}`,
              /* Not 'high'. Nothing here needs to wake a sleeping phone ahead of
                 its next wake-up: it is a song, a photo, a tap. 'normal' is the
                 gentler setting and it is the one this feature wants. */
              urgency: 'normal',
            },
          );
        } catch (err) {
          const status = (err as { statusCode?: unknown })?.statusCode;
          if (isGone(status)) {
            /* HOW A DELETED HOME-SCREEN TILE SURFACES. There is no event for it
               — the browser is gone and cannot tell us — so the first push after
               it is the only way we ever find out, and this is that moment. */
            dead.push(device.endpoint);
            return;
          }
          /* Everything else is transient and is NOT pruned. The endpoint is
             reduced to its host: the full URL is a capability, and a log line
             holding one would let anyone who can read logs push to her phone. */
          console.warn(
            `[us] push to ${safeLabel(device.endpoint)} failed (${String(status ?? 'no status')}).`,
          );
        }
      }),
    );

    /* Awaited too, for the letters.astro reason: this is a store write, and a
       serverless function that returns before its writes land does not finish
       them. A prune that did not happen means the same dead endpoint is retried
       forever, which is precisely what pruning exists to stop. */
    await pruneDevices(to, dead);

    /* ONE LINE PER NOTIFICATION ATTEMPT, and it exists because this whole file
       fails silently on purpose. A push that never arrives was previously
       indistinguishable from a push that was never sent — "she says she got
       nothing" had no evidence on either side.
    
       `event` and `to` are enums and pass trace()'s filter. There is no payload to
       leak here regardless, since the wire only ever carries two enums. `dead` is
       the useful one: a device count that keeps shrinking is tiles being deleted,
       which is the only way this system ever learns that. */
    trace('push.send', {
        event,
        to,
        devices: devices.length,
        dead: dead.length,
        ms: t.total(),
    });
  } catch (err) {
    /* THE OUTERMOST CATCH, AND THE POINT OF THE WHOLE FILE. Whatever went wrong
       — the store, the network, a bad key, a bug in here — the write that
       triggered this has already succeeded and must stay succeeded. */
    console.error('[us] notify failed, and the write it followed did not:',
      err instanceof Error ? err.message : err);
  }
}
