import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The engine is headless by design, and the html helper is a pure string
    // function, so neither needs a browser environment. If a test ever does,
    // that is a signal that something has leaked across the boundary.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
