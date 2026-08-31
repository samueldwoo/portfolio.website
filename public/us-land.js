/* ===========================================================================
   us-land.js — go somewhere and actually get a server render.
   ===========================================================================

   ---------------------------------------------------------------------------
   THE BUG THIS EXISTS TO MAKE UNREPEATABLE

   `location.assign()` DOES NOT RELOAD when the target differs from the current URL
   only in the fragment, or not at all. It is a same-document navigation: the browser
   scrolls to the anchor and nothing is re-fetched. Verified in Chrome — a marker set
   on `window` survived the call and the server saw no second request, while
   `location.reload()` cleared it. MDN's assign() page does not document the case.

   Every write in this wing ends the same way: hand control back to the server and let
   it re-render, because painting the card from the response would mean a second
   renderer in JavaScript that can disagree with the Astro one. So every one of those
   hand-backs was an assign() to a URL built from the outcome — and four of them could
   target the URL she was already on:

     the photograph   ?ok=posted        posting a second photo the same day
     the song         ?sent=<date>      fixing a wrong link the same day
     a letter         ?read=<id>&sent=1 replying to the same letter again
     the question     ?ok=answered      answering again

   In every case the write SUCCEEDS and the page does nothing: no new render, the old
   content still on screen, and a confirmation line that was already there. The upload
   looked broken for a week because of exactly this, and re-posting is not an edge case
   in any of the four — it is how you fix a mistake from a phone.

   ---------------------------------------------------------------------------
   WHY A FILE RATHER THAN THE FUNCTION IN FOUR PAGES

   Inline scripts cannot import, so the alternative was the same ten lines copied into
   four `.astro` files, which is the drift this codebase argues against everywhere else
   — and a partial fix here is invisible until somebody re-posts on the one page that
   was missed. One implementation, loaded the way us-pull.js already is.

   LOADED WITHOUT `defer`, deliberately. A deferred script runs after the document is
   parsed, and while every caller here fires from an async callback long after that, a
   plain script is defined before the inline scripts even run and removes the question.
   Callers still guard with `window.usLand || fallback`, because a navigation that
   silently does nothing is the failure being fixed and it must not come back as "the
   helper 404ed".
   =========================================================================== */
(function () {
    'use strict';

    /* ---------------------------------------------------------------------------
       KEEPING HER PLACE, WHICH IS THE SECOND BUG THIS FILE NOW OWNS

       Measured in real Chrome on 2026-08-28, not reasoned about: scrolled to 400px,
       upload, and the page came back at 1086px on a 1555px document. Both the first
       upload (assign, a new URL) and the second (reload, same URL) did it, so it was
       never about which branch ran.

       The cause is the `#post` fragment. Every hand-back targets an anchor, so the
       browser jumps there on arrival — and `#post` is the POST FORM, roughly a
       screen and a half down. On a phone that reads as the page throwing you
       somewhere, right at the moment you were told the thing worked.

       IT IS ALSO GRATUITOUS, WHICH IS WHY THIS IS A FIX AND NOT A PREFERENCE. She
       reached the form by scrolling to it and then used it. She is BY CONSTRUCTION
       already looking at the thing the anchor points at. The jump cannot take her
       anywhere more relevant than where she already was; it can only move her.

       The fragment stays in the URL — `frame.ts` puts it in its no-JavaScript 303 as
       well, and a page with no script must still land somewhere sensible.

       THE REJECTED ALTERNATIVE was dropping `#post` from the hand-backs. It fixes the
       jump by removing the fallback: with JavaScript off there is then nothing at all
       aiming the browser at the form, on the path this wing guarantees.

       ---------------------------------------------------------------------------
       AND THE PIXEL OFFSET WAS THE WRONG THING TO KEEP — the second measurement

       The first version of this saved `scrollY` and put it back. It did that
       perfectly and she was still thrown about on her phone, which is the useful
       kind of failure: the mechanism worked and the promise was wrong.

       Measured on 2026-08-31 with a harness that finally had IMAGES in it:
       scrollY 400 -> 400, and `#post` moved from 365px down the viewport to 1098px.
       733 pixels, with the offset restored exactly.

       Because a successful upload ADDS A PHOTOGRAPH ABOVE THE FORM. Her slot was
       empty and now it holds a frame, so the form has genuinely moved further down
       the document — and holding scrollY constant therefore GUARANTEES she is looking
       at something else. On the real page it is worse than the harness: frames render
       `<img width={f.w || undefined}>`, her three existing photographs have no stored
       dimensions, so they reserve no box and grow from zero height when the bytes land,
       long after load on a phone on cellular.

       So what is preserved is the ELEMENT'S POSITION ON SCREEN, not the scroll offset.
       The fragment already names the element that matters; instead of slamming it to
       the top of the viewport we keep it exactly where she had it. Content appearing
       above it then moves the page under her rather than moving her.

       AND IT IS RE-APPLIED AS THE PAGE SETTLES, because one pass cannot work when the
       thing that moves the form is an image that has not downloaded yet. It stops at a
       deadline, and it stops INSTANTLY if she touches the screen — a correction that
       fights a real finger is worse than the drift it is fixing.
       --------------------------------------------------------------------------- */

    var KEY = 'us:land:scroll';
    /* A stale offset must never apply to a navigation she made herself by tapping a
       link. The key is written only by usLand and cleared the moment it is read, and
       it carries a timestamp so a hand-back that never completed cannot ambush some
       later load. 10s is far longer than any of these navigations and far shorter
       than a browsing session. */
    var FRESH_MS = 10000;
    /* How long to keep correcting after load. Long enough for an unsized photograph to
       arrive on a phone on cellular; short enough that it is over before she could have
       read anything and decided to move. */
    var SETTLE_MS = 2500;

    function save(hash) {
        try {
            /* THE ELEMENT FIRST. `hash` is the fragment the caller was going to jump
               to, which is by definition the thing on the page that matters. */
            var el = hash ? document.querySelector(hash) : null;
            if (el && el.getBoundingClientRect) {
                sessionStorage.setItem(KEY, JSON.stringify({
                    sel: hash,
                    top: Math.round(el.getBoundingClientRect().top),
                    at: Date.now(),
                }));
                return;
            }
            /* No such element — the caller named a fragment this page does not have.
               Fall back to the offset, which is still better than an anchor jump. */
            var y = window.scrollY || window.pageYOffset || 0;
            if (y <= 0) return;
            sessionStorage.setItem(KEY, JSON.stringify({ y: Math.round(y), at: Date.now() }));
        } catch (err) {
            /* Private mode, a full quota, a disabled store. Nothing is written, so
               `pending()` on the next load is false, so native restoration is left
               alone and she gets the old anchor jump — the behaviour that shipped for
               weeks. Never worth an exception on the success path of an upload. */
        }
    }

    function restore() {
        var saved = null;
        try {
            var raw = sessionStorage.getItem(KEY);
            if (!raw) return;
            sessionStorage.removeItem(KEY);   // read once, whatever happens next
            saved = JSON.parse(raw);
        } catch (err) {
            return;
        }
        if (!saved || typeof saved.at !== 'number') return;
        if (Date.now() - saved.at > FRESH_MS) return;

        var hasElement = typeof saved.sel === 'string' && typeof saved.top === 'number';
        if (!hasElement && typeof saved.y !== 'number') return;

        function go() {
            if (hasElement) {
                var el = document.querySelector(saved.sel);
                /* The element can be absent on the page we landed on — a refusal that
                   removed the section, a different route. Nothing sensible to do, and
                   scrolling somewhere arbitrary is worse than leaving her at the top. */
                if (!el) return;
                var delta = el.getBoundingClientRect().top - saved.top;
                /* Sub-pixel deltas are layout noise and scrolling by them causes a
                   visible twitch on iOS without moving anything. */
                if (Math.abs(delta) < 1) return;
                window.scrollBy(0, delta);
                return;
            }
            /* The document can be SHORTER than it was, so the offset is clamped rather
               than trusted. An unclamped scrollTo past the end is silently ignored and
               she would land at the top, which is its own reset. */
            var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
            window.scrollTo(0, Math.min(saved.y, max));
        }

        go();

        /* ---- keep correcting until the page stops moving ----------------------

           ONE PASS IS NOT ENOUGH and that is the whole lesson of the second
           measurement: the thing that displaces the form is an image still in flight.
           So this re-applies on anything that changes layout, and gives up on a
           deadline.

           SHE INTERRUPTS IT INSTANTLY. `touchstart` rather than `scroll`, deliberately:
           our own scrollBy fires `scroll`, so listening for that would make the fix
           cancel itself on its first correction. A finger, a wheel or a key is
           unambiguous intent; a scroll event is not. */
        var done = false;
        function stop() {
            if (done) return;
            done = true;
            if (window.removeEventListener) {
                window.removeEventListener('load', tick, true);
                window.removeEventListener('touchstart', stop, true);
                window.removeEventListener('wheel', stop, true);
                window.removeEventListener('keydown', stop, true);
                window.removeEventListener('pointerdown', stop, true);
            }
            if (observer && observer.disconnect) observer.disconnect();
            if (timer) clearInterval(timer);
        }
        function tick() {
            if (done) return;
            go();
        }

        var observer = null;
        try {
            if (window.ResizeObserver) {
                /* Watching the DOCUMENT's height rather than each image: it catches a
                   late stylesheet and a web font too, and it needs no knowledge of what
                   is on the page. Supported on iOS 13.4+, which is well below anything
                   either phone runs. */
                observer = new ResizeObserver(tick);
                observer.observe(document.documentElement);
            }
        } catch (err) {
            observer = null;
        }
        /* A backstop for browsers without ResizeObserver, and for a growth it somehow
           does not report. 120ms is imperceptible and the whole thing is over in
           SETTLE_MS. */
        var timer = setInterval(tick, 120);

        if (window.addEventListener) {
            window.addEventListener('load', tick, true);
            window.addEventListener('touchstart', stop, true);
            window.addEventListener('wheel', stop, true);
            window.addEventListener('keydown', stop, true);
            window.addEventListener('pointerdown', stop, true);
        }
        setTimeout(stop, SETTLE_MS);
    }

    /* Is there an offset waiting for us? Read here, at parse time, because the two
       decisions below both depend on it and both have to be made before the browser
       does its own scroll. Peeked rather than consumed — restore() is what clears it. */
    function pending() {
        try {
            var raw = sessionStorage.getItem(KEY);
            if (!raw) return false;
            var s = JSON.parse(raw);
            return Boolean(s) && typeof s.at === 'number' && Date.now() - s.at <= FRESH_MS;
        } catch (err) {
            return false;
        }
    }

    /* ONLY WHEN WE HAVE SOMETHING TO PUT BACK, and this condition is the whole point.

       The first version set `manual` unconditionally, and a mutation test caught what
       that costs. With `manual` set and the restore not running — private mode, a full
       quota, any browser where sessionStorage throws — the reload branch landed her at
       0 instead of at the anchor: `manual` suppresses the fragment scroll on a reload
       too. So a defensive `catch` that claimed to "keep the old jump" had in fact
       replaced a jump-to-the-form with a jump-to-the-top, which is a worse reset, on
       exactly the browsers least able to report it.

       Reading sessionStorage FIRST and only then opting out of native restoration
       means the degraded path is now bit-for-bit the old behaviour. */
    var incoming = pending();
    if (incoming) {
        try {
            if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
        } catch (err) { /* the browser may also have a go; restore() still runs */ }
    }

    /* AS SOON AS THE ELEMENT EXISTS, WHICH IS NOT THE SAME AS WHEN THE PAGE IS DONE.

       This used to wait for `pageshow`, and a mutation test is what showed the cost:
       removing the whole settle-correction loop below changed nothing, because
       `pageshow` fires AFTER `load`, and `load` already waits for every image. So the
       first correction was always happening on a fully settled page — the loop was
       untested, and worse, the restore itself was LATE. On a phone on cellular that
       means she watches the page sit at the top or at the anchor for a second or two
       and then get yanked into place, which is the same disorientation wearing a
       different hat.

       So the first pass runs at DOMContentLoaded, when the form exists and the
       photographs almost certainly do not, and the loop above corrects it as they
       land. That makes the loop load-bearing, which makes it testable.

       This file is loaded WITHOUT defer, so `loading` is the normal state here. */
    if (incoming) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', restore, { once: true });
        } else {
            restore();
        }
    }

    /**
     * @param {string} path    e.g. '/samdrea/vault/day'
     * @param {string} search  e.g. '?ok=posted', or '' for none
     * @param {string} hash    e.g. '#post', or '' for none
     */
    window.usLand = function (path, search, hash) {
        /* ONLY WHEN THERE IS A FRAGMENT TO DEFEAT US, which keeps this change to the
           one page that has the problem.

           The fragment jump IS the bug. Of the four callers only the photograph passes
           one (`#post`); the song, the letter and the daily question all pass ''. With
           no fragment the browser's own scroll restoration already keeps her place on
           the reload branch, and it has been doing so correctly since those pages
           shipped. Saving unconditionally would replace three working native
           behaviours with this code — a strictly larger blast radius for no gain, on
           pages nobody reported a problem with.
           So: no hash, no interference. */
        if (hash) save(hash);
        var sameDocument = location.pathname === path && location.search === (search || '');
        if (sameDocument) {
            /* The fragment is set first so a browser that ignores the restore above
               still lands on the anchor rather than wherever the reload leaves it.
               The current page is always a GET, so reload() cannot re-post
               anything — none of these callers arrived by form navigation. */
            if (hash && location.hash !== hash) location.hash = hash;
            location.reload();
            return;
        }
        location.assign(path + (search || '') + (hash || ''));
    };
})();
