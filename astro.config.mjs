import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  // Still 'static': every page prerenders BY DEFAULT and the public site
  // (index / projects / travel) emits exactly the same flat .html it always
  // has. The adapter below is not a switch to SSR — it exists so that the
  // handful of private routes under src/pages/samdrea/** can individually
  // opt out with `export const prerender = false`.
  //
  // Astro's own config docs are explicit that this is supported:
  //   "'static' - Prerender all your pages by default"
  //   "These features only exist for pages rendered on demand (SSR) using
  //    `server` mode or pages that opt out of prerendering in `static` mode."
  //   — node_modules/astro/dist/types/public/config.d.ts:304,588
  //
  // Why on-demand at all: the private wing needs a real server-side lock.
  // Answers are verified against HMAC digests that must never reach the
  // browser, and the session cookie must be httpOnly, which means a response
  // header — neither is possible from a static file.
  output: 'static',

  /* CSRF, and a fragility worth knowing about.
     Astro's `security.checkOrigin` defaults to true and DOES protect the
     form-encoded POSTs under /api/us/* here. Verified twice: a cross-origin
     form post to /api/us/react returns 403 on the dev server, and the built
     manifest in .vercel/output carries `checkOrigin: true`.

     But look at how Astro computes it (plugin-manifest.js:275):
         checkOrigin: (security?.checkOrigin && buildOutput === "server") ?? false
     `buildOutput` is "server" for this project ONLY because some routes set
     `prerender = false`. Delete the last on-demand route and buildOutput flips
     to "static", checkOrigin silently becomes false, and every form endpoint
     loses its origin check with nothing failing and no warning.

     It also never covers `application/json` at all — confirmed, a cross-origin
     JSON post is not blocked — which is exactly why every handler verifies its
     own session cookie rather than leaning on this. `sameSite: 'lax'` on the
     cookies is the control that actually stops a browser sending credentials
     cross-site; checkOrigin is the belt, not the braces. */
  /* ASTRO'S OWN checkOrigin IS OFF, and this is a bug fix rather than a
     loosening — every endpoint that changes anything now performs a STRICTER
     check of its own.
  
     WHAT WENT WRONG. Astro's origin-check middleware
     (node_modules/astro/dist/core/app/origin-check.js) is, in full:
  
         const isSameOrigin = request.headers.get("origin") === url.origin;
         if (hasContentType) return formLikeHeader && !isSameOrigin;
         return !isSameOrigin;
  
     Two problems, and both bit in production:
  
       1. A MISSING Origin header fails `null === "https://..."`, so it counts as
          cross-site. iOS Safari does not send Origin on a SAME-ORIGIN form
          submission, so every plain <form> in the wing returned
          "Cross-site POST form submissions are forbidden" on her phone.
          Reproduced against the live deployment: identical request, 303 with an
          Origin header and 403 without one.
  
       2. It compares the FULL ORIGIN, which means it is betting on the protocol.
          Behind a proxy that hands the function `http://` while the browser used
          `https://`, that comparison fails on every write — a security control
          turning into an outage.
  
     It also ignores Sec-Fetch-Site entirely, which is the one signal here a
     script cannot forge.
  
     WHAT REPLACES IT: crossSite() in src/lib/us/together.ts, on all twelve
     endpoints under /api/us (verified one by one, including gate, admin and out,
     which were added for exactly this change). It reads Sec-Fetch-Site FIRST,
     falls back to comparing HOST rather than full origin so a proxy hop cannot
     break it, and refuses only on a POSITIVE mismatch — never on absence.
  
     So a real forgery is still caught (a cross-site POST carries either
     Sec-Fetch-Site: cross-site or a mismatched Origin, and modern browsers send
     both), while a legitimate same-origin form submission from a browser that
     omits Origin now works. `sameSite: 'lax'` on every cookie remains the control
     that actually stops credentials being sent cross-site.
  
     ONE CONSEQUENCE TO KNOW: the comment below about buildOutput no longer
     matters, because nothing now depends on Astro computing this flag at all. */
  security: { checkOrigin: false },

  adapter: vercel({
    // Astro's own middleware (src/middleware.ts) runs inside the serverless
    // function. We deliberately do NOT hoist it to a Vercel Edge Middleware:
    // the guard needs node:crypto's timingSafeEqual, and keeping one runtime
    // means one place where auth can be wrong.
    edgeMiddleware: false,
  }),

  // ---------------------------------------------------------------------------
  // `build.format` is deliberately ABSENT.
  //
  // It used to be 'file', so pages emitted as projects.html / travel.html and
  // every hand-written relative link resolved with no redirects. That is no
  // longer achievable: @astrojs/vercel hard-codes `build.format: "directory"`
  // through updateConfig() in its astro:config:setup hook
  // (node_modules/@astrojs/vercel/dist/index.js:134) and exposes no option to
  // opt out. Setting 'file' here does not fail loudly — it is silently
  // overwritten, which is worse. So it is gone, and the redirects below carry
  // the compatibility instead.
  // ---------------------------------------------------------------------------

  // Legacy URL compatibility, so NOT ONE LINE of the public site had to change.
  //
  // Pages now build to /projects and /travel, but every existing link still
  // says "projects.html" and — critically — public/script.js:563 keys its
  // cross-page anchor handling off the literal string "index.html#". Rewriting
  // those links would mean editing the four most carefully calibrated files in
  // the repo to ship a feature that has nothing to do with them. These
  // redirects mean the old URLs keep working verbatim, for the existing markup
  // and for anything already bookmarked or indexed.
  //
  // Fragments survive a redirect: the browser re-applies #work to the new
  // location because the redirect target carries no fragment of its own, so
  // index.html#work still lands in the right band.
  redirects: {
    '/index.html': '/',
    '/projects.html': '/projects',
    '/travel.html': '/travel',
  },

  /* THE DEV TOOLBAR IS OFF.
  
     It is dev-only and never ships, so this is purely about being able to LOOK at
     the thing. The wing's whole front door is a question centred on a white screen
     with one line of small print pinned to the bottom — and the toolbar sits in
     exactly that spot, so the page could not be judged at all on the surface it is
     designed for. It also overlaps the bottom-anchored spot the box jumps to after
     the second answer.
  
     Nothing is lost that matters here: the toolbar's audits are about the public
     marketing site, and this project checks accessibility, contrast and layout with
     `astro check` plus measured passes instead. */
  devToolbar: { enabled: false },

  integrations: [react()],
});
