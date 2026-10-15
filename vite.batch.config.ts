/**
 * Builds the headless batch runner for Node.
 *
 * Separate from the app build because it has a different target: no browser, no
 * HTML entry, no asset hashing — one file that `node` can run. Using Vite
 * rather than adding a TypeScript runner keeps the dependency list as it is,
 * and the engine is plain TypeScript with no browser imports, so there is
 * nothing to bundle beyond itself.
 *
 * That the engine *can* be built this way is the return on the Phase 1 rule
 * that nothing under `src/engine` may touch `window`, `Date` or `Math.random`.
 * If that had been a convention rather than a lint error, this file would not
 * work and finding out why would be a day's work.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist-batch',
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: {
      input: 'src/batch/compare.ts',
      output: { entryFileNames: 'compare.js', format: 'esm' },
    },
  },
});
