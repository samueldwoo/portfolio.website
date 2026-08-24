/* ===========================================================================
   us-pull.js — pull down from the top to reload. Installed app only.
   ===========================================================================

   ---------------------------------------------------------------------------
   WHY THIS HAS TO EXIST AT ALL

   The manifest declares `display: standalone`, which removes Safari's chrome —
   and with it the URL bar, the reload button, and the native pull-to-refresh
   gesture. Confirmed from the device rather than assumed: "I don't have a refresh
   on the app, there's nothing native."

   So inside the installed app there was NO way to refresh a page. Not an
   inconvenient way, none: the only route to fresh content was navigating to
   another room and back.

   ---------------------------------------------------------------------------
   GESTURE ONLY, AND NO BUTTON

   A visible refresh control was considered and rejected. Instagram, Mail, and
   every native feed are pull-only, so this is about as universally understood as
   a gesture gets, and a button would be permanent furniture in an interface that
   was deliberately stripped back.

   WCAG 2.5.1 covers functionality reachable ONLY by a path-based gesture, and
   refreshing is not: every room links to every other, and arriving at any page
   re-renders it from the server. This is a shortcut over paths that already
   exist, not the sole route to the outcome.

   ---------------------------------------------------------------------------
   IT OWNS THE GESTURE, WHICH IS THE RISKY PART

   Reading iOS's rubber-band offset would be simpler, but it is undocumented and
   has changed between versions. So this tracks the touch itself and calls
   preventDefault once engaged — which means a wrong guard does not degrade the
   feature, it BREAKS SCROLLING. Every guard below exists for that reason, and
   each one bails BEFORE preventDefault is ever called:

     * installed app only — in a Safari tab the native gesture already works and
       two implementations would fight;
     * one finger only, so a pinch-zoom is never captured;
     * the document must already be at the top;
     * the touch must not have started inside a scrollable element that is itself
       scrolled down — the board has an `overflow-y: auto` container, and hijacking
       a drag inside it would freeze it;
     * the drag must be downward AND vertical-dominant, so a sideways swipe is left
       alone;
     * nothing focused, because a drag with the keyboard open is almost always a
       mis-touch while typing.

   ---------------------------------------------------------------------------
   ONE FILE, NO MARKUP

   The indicator and the stylesheet are both built here. That keeps this to a
   single `<script src>` per page instead of an element plus a rule in a shared
   sheet, and it means the whole feature can be removed by deleting one line.

   With JavaScript off there is no indicator and no gesture, which is the same
   state the app was already in.
   =========================================================================== */

(function () {
    'use strict';

    /* THE INSTALLED APP ONLY. `navigator.standalone` is Safari's own answer and the
       only reliable one on iOS; display-mode covers everywhere else. In a browser tab
       the native gesture exists and this must stay out of its way. */
    var standalone =
        window.navigator.standalone === true ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (!standalone) return;
    if (!('ontouchstart' in window)) return;

    /* How far the finger travels before a release will reload. 72px is far enough
       that it cannot be reached by the flick that ends a scroll, and near enough
       that it does not feel like work. */
    var THRESHOLD = 72;

    /* The indicator moves at HALF the finger's speed. Matching it 1:1 reads as
       dragging the page, which invites the expectation that letting go part-way
       leaves it there. Lagging behind says "this is a control being armed". */
    var DAMP = 0.5;

    /* Past this the indicator stops moving. Without a ceiling a long drag walks it
       down the whole screen and the gesture stops looking like a refresh. */
    var MAX = 96;

    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---- the indicator ---------------------------------------------------- */

    var style = document.createElement('style');
    style.textContent = [
        '.us-pull{position:fixed;top:0;left:50%;z-index:9999;display:flex;',
        'align-items:center;justify-content:center;width:34px;height:34px;',
        'margin-left:-17px;border-radius:50%;background:#1e2025;',
        'border:1px solid #6a6c72;color:#fff;pointer-events:none;',
        /* Starts fully above the top edge. `translate3d` rather than `top`, so the
           drag is composited and never triggers layout on a 60fps gesture. */
        'transform:translate3d(0,-56px,0);opacity:0;',
        '}',
        /* Safe area, so it does not sit under the notch on an iPhone. */
        '@supports(padding:max(0px)){.us-pull{top:max(10px,env(safe-area-inset-top))}}',
        '.us-pull-glyph{width:15px;height:15px;border-radius:50%;',
        'border:2px solid currentColor;border-top-color:transparent;}',
        /* ARMED IS A COLOUR CHANGE, NOT A SIZE CHANGE. Growing the dot would shift
           its optical centre mid-gesture; the border going blue is unmistakable and
           moves nothing. */
        '.us-pull[data-armed="1"]{border-color:#3e7bff;color:#3e7bff}',
        /* Spinning only while the reload is actually in flight. */
        reduce ? '' : '.us-pull[data-busy="1"] .us-pull-glyph{animation:us-pull-spin .7s linear infinite}',
        reduce ? '' : '@keyframes us-pull-spin{to{transform:rotate(360deg)}}',
    ].join('');
    document.head.appendChild(style);

    var el = document.createElement('div');
    el.className = 'us-pull';
    el.setAttribute('aria-hidden', 'true');
    var glyph = document.createElement('div');
    glyph.className = 'us-pull-glyph';
    el.appendChild(glyph);
    document.body.appendChild(el);

    function draw(dy, armed) {
        var y = Math.min(dy * DAMP, MAX);
        el.style.transform = 'translate3d(0,' + (y - 56) + 'px,0)';
        el.style.opacity = String(Math.min(1, dy / 40));
        el.setAttribute('data-armed', armed ? '1' : '0');
    }

    function reset(animate) {
        el.style.transition = animate && !reduce ? 'transform 220ms ease, opacity 220ms ease' : '';
        el.style.transform = 'translate3d(0,-56px,0)';
        el.style.opacity = '0';
        el.setAttribute('data-armed', '0');
        if (animate) {
            setTimeout(function () { el.style.transition = ''; }, 240);
        }
    }

    /* ---- the guards -------------------------------------------------------- */

    /* Did this touch begin inside something that scrolls and is not at its own top?
       The board's grid is `overflow-y: auto`, and capturing a drag inside it would
       leave it unscrollable. Walks up rather than testing one known selector, so a
       future scroll container is covered without this file knowing about it. */
    function insideScrolledChild(node) {
        for (var n = node; n && n !== document.body; n = n.parentElement) {
            if (n.scrollTop > 0) return true;
            var o = getComputedStyle(n).overflowY;
            if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) {
                // At its own top, so a downward drag is ours; otherwise it is theirs.
                if (n.scrollTop > 0) return true;
            }
        }
        return false;
    }

    function typing() {
        var a = document.activeElement;
        if (!a) return false;
        var t = (a.tagName || '').toLowerCase();
        return t === 'input' || t === 'textarea' || t === 'select' || a.isContentEditable === true;
    }

    /* ---- the gesture ------------------------------------------------------- */

    var startY = 0;
    var startX = 0;
    var tracking = false; // a candidate touch, not yet ours
    var engaged = false;  // ours, and preventDefault is being called
    var busy = false;     // a reload is in flight; ignore everything

    window.addEventListener('touchstart', function (e) {
        if (busy) return;
        tracking = false;
        engaged = false;

        if (e.touches.length !== 1) return;
        // The document must already be at the top. `<= 0` rather than `=== 0`
        // because iOS reports a negative offset mid-rubber-band.
        if ((window.scrollY || window.pageYOffset || 0) > 0) return;
        if (typing()) return;
        if (insideScrolledChild(e.target)) return;

        startY = e.touches[0].clientY;
        startX = e.touches[0].clientX;
        tracking = true;
    }, { passive: true });

    /* NON-PASSIVE, because preventDefault is the whole mechanism — but it returns
       on the first line for every touch that is not already a candidate, so the
       cost on an ordinary scroll is one boolean test. */
    window.addEventListener('touchmove', function (e) {
        if (!tracking || busy) return;
        if (e.touches.length !== 1) { tracking = false; reset(false); return; }

        var dy = e.touches[0].clientY - startY;
        var dx = Math.abs(e.touches[0].clientX - startX);

        // Upward, or sideways-dominant: not a pull. Release it for good, so a
        // scroll that begins at the top is never interrupted halfway.
        if (dy <= 0 || dx > Math.abs(dy)) {
            if (engaged) reset(true);
            tracking = false;
            engaged = false;
            return;
        }
        // A few pixels of slop before claiming the gesture, so a tap with a shaky
        // finger does not flash the indicator.
        if (dy < 6) return;

        engaged = true;
        e.preventDefault();
        draw(dy, dy >= THRESHOLD);
    }, { passive: false });

    window.addEventListener('touchend', function () {
        if (!engaged || busy) {
            tracking = false;
            engaged = false;
            return;
        }
        var armed = el.getAttribute('data-armed') === '1';
        tracking = false;
        engaged = false;

        if (!armed) {
            reset(true);
            return;
        }

        /* COMMITTED. The indicator stays put and starts spinning rather than
           springing back: the page is about to be replaced, and animating it away
           first would read as the gesture having failed. */
        busy = true;
        el.setAttribute('data-busy', '1');
        el.style.transform = 'translate3d(0,' + (THRESHOLD * DAMP - 56) + 'px,0)';
        el.style.opacity = '1';

        /* `true` is deliberate where it is still honoured, and harmless where it is
           not: this exists to defeat a cached copy, and there is no service-worker
           fetch handler to defeat — sw.js is a notifier and registers none. */
        try {
            window.location.reload(true);
        } catch (err) {
            window.location.reload();
        }
    }, { passive: true });

    window.addEventListener('touchcancel', function () {
        if (busy) return;
        tracking = false;
        engaged = false;
        reset(true);
    }, { passive: true });

    /* Restored from the page cache after a reload, or after being backgrounded: the
       spinner would otherwise still be there, spinning, on a page that is done. */
    window.addEventListener('pageshow', function () {
        busy = false;
        el.removeAttribute('data-busy');
        reset(false);
    });
})();
