/**
 * Seeded pseudo-random number generator.
 *
 * `Math.random()` cannot be asked for the same sequence twice, which makes a
 * simulation impossible to test and impossible to compare against itself. The
 * whole point of Phase 4 — "run this decision three hundred times and show the
 * range" — depends on both options facing the *same* three hundred sequences
 * of events. Otherwise the comparison measures luck.
 *
 * mulberry32: 32-bit state, a handful of operations, good enough statistical
 * quality for a simulation of this kind. Not suitable for anything
 * cryptographic, which is not what this is for.
 *
 * The state is a single number and is readable, so a run can be saved,
 * resumed, or cloned — which is what the sandbox's snapshot/restore and Phase
 * 4's parallel worlds both need.
 */

export interface Rng {
  /** Next value in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /**
   * Whether an event with the given average rate occurs during `dt`.
   *
   * Takes a rate per unit of time rather than a probability per call, so the
   * result does not depend on how often the caller happens to run. Uses the
   * exponential survival function, so it stays correct for large `dt` instead
   * of exceeding 1 the way `rate * dt` would.
   */
  chance(ratePerUnit: number, dt: number): boolean;
  /** Current internal state, for snapshotting and resuming a run. */
  getState(): number;
  setState(state: number): void;
}

export function createRng(seed: number): Rng {
  // Mix the seed so that small, similar seeds (1, 2, 3…) still produce
  // unrelated sequences.
  let state = seed >>> 0 || 1;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    range: (min, max) => min + next() * (max - min),
    chance: (ratePerUnit, dt) => {
      if (ratePerUnit <= 0 || dt <= 0) return false;
      return next() < 1 - Math.exp(-ratePerUnit * dt);
    },
    getState: () => state,
    setState: (s) => {
      state = s >>> 0;
    },
  };
}
