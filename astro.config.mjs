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

  integrations: [react()],
});
