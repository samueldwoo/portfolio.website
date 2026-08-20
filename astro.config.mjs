import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  // Pure static output — no adapter needed, Vercel serves dist/ directly.
  output: 'static',

  build: {
    // 'file' (not the default 'directory') so pages emit as index.html,
    // projects.html, travel.html at the root. That keeps every existing
    // relative link ("projects.html", "index.html#work") resolving exactly
    // as it did on the hand-written static site — no redirects, no rewrites.
    format: 'file',
  },

  integrations: [react()],
});
