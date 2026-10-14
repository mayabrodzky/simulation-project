import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The engine is headless by design, and the html helper is a pure string
    // function, so neither needs a browser environment. If a test ever does,
    // that is a signal that something has leaked across the boundary.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * Twenty seconds rather than the default five.
     *
     * Several tests now simulate whole weeks — the capacity breakdown, the
     * scenario audit's agreement check, and the batch runner's fairness
     * properties. Each is comfortably under five seconds alone and can exceed
     * it when workers compete for the processor, which produced a failure that
     * disappeared when the file was run on its own: the worst kind, because it
     * looks like flakiness in the thing being tested.
     *
     * The real fix is B3. Until the dispatcher lives inside the slice loop the
     * runner has to step a minute at a time, so a simulated week costs ten
     * thousand engine calls; coarse stepping becomes safe then and this can go
     * back down. The step-size stress test keeps its own larger budget.
     */
    testTimeout: 20_000,
  },
});
