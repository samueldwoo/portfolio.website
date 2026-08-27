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

    /**
     * @param {string} path    e.g. '/samdrea/vault/day'
     * @param {string} search  e.g. '?ok=posted', or '' for none
     * @param {string} hash    e.g. '#post', or '' for none
     */
    window.usLand = function (path, search, hash) {
        var sameDocument = location.pathname === path && location.search === (search || '');
        if (sameDocument) {
            /* Set the fragment first so the reload lands on the anchor, then force the
               fetch. The current page is always a GET, so reload() cannot re-post
               anything — none of these callers arrived by form navigation. */
            if (hash && location.hash !== hash) location.hash = hash;
            location.reload();
            return;
        }
        location.assign(path + (search || '') + (hash || ''));
    };
})();
