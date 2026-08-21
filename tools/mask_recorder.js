/* ============================================================================
 * mask_recorder.js — catches the REAL SplitText line masks while they exist.
 *
 * Why this is needed: `.srline-mask` elements are transient. SplitText builds
 * them at trigger time and revert() deletes them when the tween completes, so
 * by the time any audit runs there are zero of them in the DOM. A probe that
 * only inspects a synthetic replica can say "overflow-clip-margin works in this
 * engine" but cannot say "the masks this site actually creates got the clip
 * margin". This closes that gap by recording each mask as it is inserted.
 *
 * Installed BEFORE the scroll that triggers the headings, then read back after.
 *
 *   install : driver.execute_script("return (" + SRC + ")()")
 *   read    : driver.execute_script("return window.__ovMasks || []")
 *
 * Idempotent — installing twice is a no-op, so re-running against a live page
 * cannot double-count.
 * ==========================================================================*/
(function () {
  if (window.__ovMaskRec) return "already-installed";
  window.__ovMaskRec = true;
  window.__ovMasks = [];
  window.__ovMaskStats = { inserted: 0, recorded: 0, vanishedBeforeRaf: 0 };

  var MAX = 60;

  function sample(el, phase) {
    var cs = getComputedStyle(el);
    var rect = el.getBoundingClientRect();
    var inner = el.firstElementChild;
    var irect = inner ? inner.getBoundingClientRect() : null;
    return {
      phase: phase,
      overflow: cs.overflow,
      overflowX: cs.overflowX,
      /* The value under investigation. Empty or 0px here means the shipped
         stylesheet's `overflow-clip-margin: 0.2em` did not take effect on the
         real mask, which is exactly the Safari < 16.4 failure mode. */
      overflowClipMargin: cs.overflowClipMargin ||
        cs.getPropertyValue("overflow-clip-margin") || null,
      clipMarginPx: (function () {
        var n = parseFloat(cs.overflowClipMargin ||
          cs.getPropertyValue("overflow-clip-margin") || "");
        return isNaN(n) ? null : Math.round(n * 1000) / 1000;
      })(),
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      /* Mask height vs. inner line height: if the inner line is taller than the
         mask, the difference is what the clip margin has to cover. */
      maskHeight: Math.round(rect.height * 100) / 100,
      innerHeight: irect ? Math.round(irect.height * 100) / 100 : null,
      /* SplitText writes `overflow: clip` inline; capturing the inline style
         separates "the stylesheet rule missed" from "the library changed". */
      inlineStyle: (el.getAttribute("style") || "").slice(0, 200),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40)
    };
  }

  function record(el) {
    if (window.__ovMasks.length >= MAX) return;
    var atInsert;
    try { atInsert = sample(el, "insert"); }
    catch (e) { return; }

    /* Read again on the next frame. SplitText may set its inline styles after
       insertion, so the insert-time computed value can be a false negative.
       Both samples are kept: disagreement between them is itself diagnostic. */
    requestAnimationFrame(function () {
      var entry = { atInsert: atInsert, atRaf: null, stillConnected: !!el.isConnected };
      if (el.isConnected) {
        try { entry.atRaf = sample(el, "raf"); } catch (e) {}
      } else {
        window.__ovMaskStats.vanishedBeforeRaf++;
      }
      window.__ovMasks.push(entry);
      window.__ovMaskStats.recorded++;
    });
  }

  var mo = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (!n || n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains("srline-mask")) {
          window.__ovMaskStats.inserted++;
          record(n);
        }
        if (n.querySelectorAll) {
          var q = n.querySelectorAll(".srline-mask");
          for (var k = 0; k < q.length; k++) {
            window.__ovMaskStats.inserted++;
            record(q[k]);
          }
        }
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  window.__ovMaskObserver = mo;

  /* Any masks already present when the recorder lands (a heading above the fold
     may have triggered during page load) are captured too. */
  var existing = document.querySelectorAll(".srline-mask");
  for (var e = 0; e < existing.length; e++) {
    window.__ovMaskStats.inserted++;
    record(existing[e]);
  }

  return "installed";
});
