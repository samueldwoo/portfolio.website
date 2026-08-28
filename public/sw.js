/* ===========================================================================
   sw.js — the only service worker in this wing, and it is a NOTIFIER, not a cache.
   ===========================================================================

   ---------------------------------------------------------------------------
   THERE IS NO `fetch` HANDLER IN THIS FILE. DO NOT ADD ONE. NOT EVER.
   ---------------------------------------------------------------------------

   src/pages/samdrea/vault/index.astro used to carry a comment that said
   DELIBERATELY NO SERVICE WORKER, and the reason it gave was exactly right:

       "Every page here is behind a session and several are per-day; a worker
        that cached the wrong response would serve her a stale room, or worse,
        hand a cached authorised page to whoever opened the app next."

   That objection is about CACHING AND INTERCEPTION. It is not about the
   ServiceWorkerGlobalScope as such. A worker only sees a request if it registers
   a `fetch` listener, and a worker only holds a response if it opens a `Cache`.
   This file does neither, so there is nothing in it that could serve a stale
   room and nothing in it that could hand one person's page to the other.

   That is not a promise about intent, it is a property of the code:

     * NO `self.addEventListener('fetch', ...)`. Every request in this origin
       goes straight to the network, exactly as it did before this file existed.
       Browsers even short-circuit a fetch-handler-less worker entirely on
       navigation, so it is not on the request path at all.
     * NO `caches`, no `Cache`, no `CacheStorage`, no `cache.put`, no
       `cache.match`. Nothing is stored, so nothing can go stale.
     * NO `clients.matchAll` result is ever read for anything but focus, and no
       response body is ever constructed here.

   THE ONE REASON THIS FILE EXISTS: iOS will not deliver a Web Push without a
   service worker. `PushManager` lives on `ServiceWorkerRegistration` and the
   `push` event is only dispatched into a worker. There is no page-level API for
   it and there is no way around it. So the choice was "no notifications" or
   "a worker that does nothing but notifications", and this is the second one.

   IF SOMEBODY LATER WANTS OFFLINE SUPPORT: the answer is no, and the reason is
   the paragraph at the top. Adding a `fetch` handler here re-opens the exact
   hole the original decision closed, and it would do it inside a file whose
   whole justification is that it cannot.

   ---------------------------------------------------------------------------
   THE PAYLOAD IS AN ENUM. THE SENTENCES LIVE HERE.
   ---------------------------------------------------------------------------

   A notification lands on a lock screen, which is readable by anybody standing
   next to her — on a train, on a desk, over her shoulder. So a notification in
   this wing says WHAT HAPPENED and never WHAT WAS SAID: never a song title,
   never an artist, never a note, never an answer, never a caption, never a line
   of a letter.

   The way that rule is kept is structural rather than careful. The server sends
   two short enum values and nothing else:

       { "e": "song", "a": "him" }

   `e` is one of five event keys, `a` is one of two people. There is no field a
   sentence could travel in, so no bug in an endpoint can put one on a lock
   screen — not by passing the wrong variable, not by spreading a record into
   the payload, not by "temporarily" adding a body for debugging. The copy is
   resolved HERE, from the frozen tables below, against keys this file validates
   against its own vocabulary before it uses them.

   The cost is real and worth naming: changing the wording means shipping a new
   worker, and a browser holding the old one keeps the old words until it
   updates. `skipWaiting` + `clients.claim` below make that one app open rather
   than a mystery, and wording that is a day stale is a far smaller problem than
   a song title on a lock screen.

   HER NAME IS NOT IN THIS FILE, on purpose. This is a world-readable static
   asset in a public repository — src/middleware.ts does not run for `public/`
   and says so at length. So the copy names Sam (his own site) and uses "she"
   for her, which is the same device presence.ts and the hub already use.
   =========================================================================== */

/* --------------------------------------------------------------------------
   WHAT EACH EVENT IS ALLOWED TO SAY.

   Keyed by event, then by WHO ACTED — never by who is reading, because a worker
   cannot know which of the two people installed it and must not guess. The
   recipient is always the other one; src/lib/us/push.ts guarantees that on the
   way out, which is the only place it can be guaranteed.

   Every string here is a complete sentence with no object in it. Read the whole
   column and check that: if any entry ever needs a variable to make sense, the
   change being attempted is the one this design exists to refuse.

   ESCAPED APOSTROPHE, NOT A LITERAL ONE. This file is a static asset and the
   Content-Type it is served with is the host's decision, not ours — if the
   charset is ever omitted or wrong, a literal U+2019 becomes two mojibake
   characters in the middle of a sentence on her lock screen. `’` is plain
   ASCII on the wire and cannot be mis-decoded.
   -------------------------------------------------------------------------- */
var TITLE = {
    thinking: { him: 'Sam is thinking of you',   her: 'She\u2019s thinking of you' },
    song:     { him: 'Sam picked a song',        her: 'She picked a song' },
    photo:    { him: 'Sam put a picture up',     her: 'She put a picture up' },
    reaction: { him: 'Sam reacted to your song', her: 'She reacted to your song' },
    /* Symmetric on purpose. A reveal is the one event that is not one person
       doing something to the other, so naming an actor would be wrong. */
    revealed: { him: 'you both answered',        her: 'you both answered' }
};

/* Where a tap lands. Same-origin paths, hard-coded — never taken from the
   payload, so a push cannot be used to open an arbitrary URL from inside the
   installed app. `notificationclick` re-checks that what it got out of here is
   a same-origin path before handing it to openWindow(). */
var ROOM = {
    thinking: '/samdrea/vault#thinking',
    song:     '/samdrea/vault/today',
    photo:    '/samdrea/vault/day',
    reaction: '/samdrea/vault/today',
    revealed: '/samdrea/vault#question'
};

/* The hub. Where an unrecognised event goes, and where a tap goes when the
   event key did not survive whatever mangled it. */
var HUB = '/samdrea/vault';

/* The app icon, from the same set as manifest.webmanifest. Android draws it;
   iOS uses the home-screen icon and ignores this, which is why there is no
   second icon here for it. */
var ICON = '/assets/us/icons/icon-192.png';

/* --------------------------------------------------------------------------
   TAKE OVER IMMEDIATELY.

   Without these two, a new worker sits in `waiting` until every window in the
   scope is closed — and an installed app on a phone is essentially never
   closed, so a copy fix could hang unshipped for weeks with nothing to look at
   that would explain why.

   This is safe here in a way it would NOT be for a caching worker: there is no
   cache to version, no in-flight response to strand, and no request path to
   swap out underneath a running page. The worst case of claiming a client early
   is that the client is now controlled by a worker that ignores it.
   -------------------------------------------------------------------------- */
/* No `event` parameter: skipWaiting() needs nothing from it, and there is no
   waitUntil() here on purpose — this worker caches nothing at install, so there is
   no work to keep the install alive for. */
self.addEventListener('install', function () {
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
});

/**
 * Read the payload without trusting one byte of it.
 *
 * Returns a resolved { title, url, tag } every single time, including for an
 * absent body, a body that is not JSON, an unknown event key and an unknown
 * actor. That totality is not defensive habit, it is a requirement: see the
 * `push` handler for why a push that shows nothing is worse than a push that
 * shows something vague.
 */
function resolve(event) {
    var raw = null;
    try {
        /* `event.data` is null for a push with no payload, which is a legitimate
           thing for a push service to deliver. */
        raw = event.data ? event.data.json() : null;
    } catch (err) {
        /* Not JSON. Nothing to learn from it and nothing to log to — a worker's
           console is nobody's console. Fall through to the generic notice. */
        raw = null;
    }

    var e = raw && typeof raw.e === 'string' ? raw.e : '';
    var a = raw && typeof raw.a === 'string' ? raw.a : '';

    /* VALIDATED AGAINST THIS FILE'S OWN VOCABULARY, with hasOwnProperty rather
       than a bare `TITLE[e]` truthiness test, so a payload of `{"e":"constructor"}`
       cannot reach an inherited property and become a title. */
    var known = Object.prototype.hasOwnProperty.call(TITLE, e);
    if (!known) {
        return {
            /* Deliberately vague, and deliberately not silent. It says the app
               has something in it and nothing about what. */
            title: 'Something new in [us]',
            url: HUB,
            tag: 'us-generic'
        };
    }

    var byActor = TITLE[e];
    var title = Object.prototype.hasOwnProperty.call(byActor, a)
        ? byActor[a]
        /* An event we know from an actor we do not. Rather than guess a pronoun
           and get it backwards — telling her that she picked the song — fall
           back to the same content-free sentence as an unknown event. */
        : 'Something new in [us]';

    return {
        title: title,
        url: ROOM[e],
        /* ONE NOTIFICATION PER KIND. `tag` makes a second push of the same kind
           REPLACE an undismissed one instead of stacking beside it, which is
           what stops a quiet day of taps becoming a column of identical rows on
           her lock screen. Paired with renotify:false below, a replacement is
           also silent, so a coalesced event buzzes once and not twice. */
        tag: 'us-' + e
    };
}

/* --------------------------------------------------------------------------
   PUSH.

   `event.waitUntil` is not optional. The push event's lifetime ends when the
   handler returns, and showNotification() is async — without waitUntil the
   worker can be killed with the notification half-created, which on iOS counts
   as a push that displayed nothing.

   AND IT ALWAYS SHOWS SOMETHING. Both iOS and Chrome treat "received a push and
   displayed no notification" as a budget violation; do it a few times and the
   platform either shows its own "this site was updated in the background"
   notice or revokes the permission outright. So there is no early return in
   here and no branch that resolves without a notification. resolve() is total
   for the same reason.
   -------------------------------------------------------------------------- */
self.addEventListener('push', function (event) {
    var n = resolve(event);

    event.waitUntil(self.registration.showNotification(n.title, {
        /* NO BODY. The title is the whole message, and a second line would be
           either a restatement or a place for content to creep into later.
           There is nothing to say under "Sam picked a song" that is not either
           the song — which must never be here — or software talking about
           itself. */
        icon: ICON,
        badge: ICON,
        tag: n.tag,
        /* A replacement does not buzz again. See `tag` in resolve(). */
        renotify: false,
        /* She dismisses it, or she taps it. It never sits on the screen
           demanding to be dealt with. */
        requireInteraction: false,
        silent: false,
        /* The ONLY thing carried through to the click handler, and it came out
           of ROOM above rather than off the wire. */
        data: { url: n.url }
    }));
});

/* --------------------------------------------------------------------------
   TAP.

   Focus a window that is already open, otherwise open one. Both branches go to
   the room the event belongs to, because a notification that lands her on the
   hub to hunt for the thing it just told her about has done half a job.

   Everything is inside waitUntil for the same reason as above: the handler
   returning does not keep the worker alive, and clients.matchAll() plus focus()
   are both async.
   -------------------------------------------------------------------------- */
self.addEventListener('notificationclick', function (event) {
    /* First, so the row disappears the instant she taps it rather than after
       the app has finished opening. */
    event.notification.close();

    var data = event.notification.data || {};
    var wanted = typeof data.url === 'string' ? data.url : HUB;

    /* Re-checked even though it can only have come from ROOM. `data` survives
       in the platform's notification store between the push and the tap, and
       the cost of not trusting it is one comparison. A value that is not a
       same-origin absolute path becomes the hub. */
    var url = wanted.charAt(0) === '/' && wanted.charAt(1) !== '/' ? wanted : HUB;

    event.waitUntil((async function () {
        var open = await self.clients.matchAll({
            type: 'window',
            /* Needed, not cosmetic: a window loaded before this worker ever
               activated is UNCONTROLLED, and without this flag matchAll() would
               not return it — so the very first tap after installing would open
               a second copy of an app that was already on screen. */
            includeUncontrolled: true
        });

        for (var i = 0; i < open.length; i++) {
            var client = open[i];
            var sameOrigin = false;
            try {
                sameOrigin = new URL(client.url).origin === self.location.origin;
            } catch (err) {
                sameOrigin = false;
            }
            if (!sameOrigin) continue;

            /* Focus FIRST and unconditionally. It is the part that always works
               and the part that was asked for. */
            try {
                await client.focus();
            } catch (err) {
                /* A client that refuses focus is not a reason to open a second
                   window on top of it. Nothing else to do here. */
            }

            /* Then try to move it to the right room. `navigate()` rejects on an
               uncontrolled client and is absent on older implementations, so it
               is strictly a bonus on top of focus — never the thing the tap
               depends on. */
            if (typeof client.navigate === 'function') {
                try {
                    await client.navigate(url);
                } catch (err) {
                    /* Focused but not navigated. She is in the app, one tap from
                       the room, which is a fine place to end up. */
                }
            }
            return;
        }

        /* Nothing open. `openWindow` is only allowed to be called from a
           notification click — which is exactly where we are. */
        await self.clients.openWindow(url);
    })());
});
