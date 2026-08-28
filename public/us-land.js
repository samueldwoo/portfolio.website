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

       So the offset is carried across the navigation and put back. The fragment stays
       in the URL — `frame.ts` puts it in its no-JavaScript 303 as well, and a page
       with no script must still land somewhere sensible.

       THE REJECTED ALTERNATIVE was dropping `#post` from the hand-backs. It fixes the
       jump by removing the fallback: with JavaScript off there is then nothing at all
       aiming the browser at the form, on the path this wing guarantees.
       --------------------------------------------------------------------------- */

    var KEY = 'us:land:scroll';
    /* A stale offset must never apply to a navigation she made herself by tapping a
       link. The key is written only by usLand and cleared the moment it is read, and
       it carries a timestamp so a hand-back that never completed cannot ambush some
       later load. 10s is far longer than any of these navigations and far shorter
       than a browsing session. */
    var FRESH_MS = 10000;

    function save() {
        try {
            var y = window.scrollY || window.pageYOffset || 0;
            /* Zero is not worth restoring and writing it would mean a pointless
               scrollTo on arrival, plus it is the value a fresh page already has. */
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
        if (!saved || typeof saved.y !== 'number' || typeof saved.at !== 'number') return;
        if (Date.now() - saved.at > FRESH_MS) return;

        /* The document can be SHORTER than it was — a frame that expired out of the
           window, a refusal that removed a card — so the offset is clamped rather
           than trusted. An unclamped scrollTo past the end is silently ignored by the
           browser and she would land at the top, which is its own reset. */
        function go() {
            var max = Math.max(
                0,
                document.documentElement.scrollHeight - window.innerHeight
            );
            window.scrollTo(0, Math.min(saved.y, max));
        }

        /* AFTER the browser has done its own fragment jump, or it simply wins. Two
           passes on purpose: the first lands her immediately so there is no visible
           travel, and the second corrects for layout that settled a frame later —
           reserved image boxes are why that is usually a no-op now, but a web font
           or a late stylesheet can still move things. rAF rather than a timeout so
           it happens before paint. */
        go();
        if (window.requestAnimationFrame) {
            requestAnimationFrame(function () {
                requestAnimationFrame(go);
            });
        }
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

    /* This file is loaded WITHOUT defer, so the document is usually still parsing
       here and there is nothing to scroll yet. `pageshow` rather than `load` because
       it also fires for a back-forward-cache restore, which is the other way she
       arrives at a page she has already scrolled. */
    if (incoming) {
        if (document.readyState === 'complete') restore();
        else window.addEventListener('pageshow', restore);
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
        if (hash) save();
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
