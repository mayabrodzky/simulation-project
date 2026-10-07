import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Multi-page build.
 *
 * The HTML entry points stay at the repository root on purpose. Vite emits each
 * input at its path relative to the project root, so `dist/lab-simulation.html`
 * exists and every bare cross-page link (`href="lab-simulation.html"`) keeps
 * working in dev, in `vite preview`, and in production with no rewrites.
 *
 * `check.html` is deliberately not an input — it is an abandoned fork of the
 * simulation and is removed later in Phase 1.
 */
export default defineConfig({
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        lab: resolve(import.meta.dirname, 'lab-simulation.html'),
        login: resolve(import.meta.dirname, 'login.html'),
        onboarding: resolve(import.meta.dirname, 'onboarding.html'),
      },
    },
  },
  server: {
    port: 5173,
    // The pages call same-origin `/api/*`. While the legacy Flask backend is
    // still the API, run it on :5000 and let the dev server proxy to it.
    // Phase 3 points this at `vercel dev` instead.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
      },
    },
  },
});
