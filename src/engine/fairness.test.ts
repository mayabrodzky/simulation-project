/**
 * Fairness of comparison: a decision must change only what it decides.
 *
 * Phase 4 answers "should I hire a technician?" by running the lab with and
 * without the hire and reporting the difference. That difference is only
 * meaningful if everything *else* about the two runs is identical — the same
 * machines starting in the same condition, the same incidents at the same
 * minutes. If one shared random sequence feeds everything, the extra person
 * shifts every draw after them, and the two runs are two different labs. The
 * verdict then reports luck as the effect of hiring, and reports it
 * confidently, with a plausible-looking range.
 *
 * These tests are the guard on that. They are written now, before jobs and
 * arrivals exist, because retrofitting stream isolation later means
 * re-deriving every seeded value in the project.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import type { Scenario } from '../domain/types';
import { advance } from './tick';
import { createRng, deriveSeed } from './rng';
import { createWorld } from './world';

const SEED = 42;
const MONDAY_0800 = 480;

/**
 * The baseline, with everyone rostered.
 *
 * `state` is assigned as "the first N in the list are on shift", so appending a
 * hire and raising N by one would actually roster an existing off-duty person
 * and leave the hire at home. Starting from a full roster means the hire is the
 * only person added to the floor — and an off-duty person draws nothing, so
 * without this the tests below would pass for the wrong reason.
 */
function fullShift(): Scenario {
  return {
    ...chemistryLab,
    tuning: { ...chemistryLab.tuning, staffOnShiftCount: chemistryLab.staff.length },
  };
}

/** Decision A from the spec: hire one more generalist technician. */
function withExtraStaff(): Scenario {
  const base = fullShift();
  return {
    ...base,
    staff: [...base.staff, { name: 'New Hire', role: 'Technician', skills: ['Microscopy'] }],
    tuning: { ...base.tuning, staffOnShiftCount: base.staff.length + 1 },
  };
}

/** Decision B from the spec: lease another instrument. */
function withExtraEquipment(): Scenario {
  const base = fullShift();
  const first = base.equipment[0];
  if (!first) throw new Error('the scenario has no equipment to duplicate');
  return {
    ...base,
    equipment: [...base.equipment, { ...first, name: `${first.name} II` }],
  };
}

describe('a decision does not disturb the rest of the lab', () => {
  it('hiring someone leaves every machine in the same starting condition', () => {
    const base = createWorld(fullShift(), SEED, MONDAY_0800);
    const hired = createWorld(withExtraStaff(), SEED, MONDAY_0800);

    expect(hired.equipment.map((e) => e.condition)).toEqual(base.equipment.map((e) => e.condition));
  });

  it('hiring someone leaves the first incident at the same minute', () => {
    const base = createWorld(fullShift(), SEED, MONDAY_0800);
    const hired = createWorld(withExtraStaff(), SEED, MONDAY_0800);

    expect(hired.nextEmergencyAtMinute).toBe(base.nextEmergencyAtMinute);
  });

  it('hiring someone leaves the incident schedule identical over a fortnight', () => {
    const base = createWorld(fullShift(), SEED, MONDAY_0800);
    const hired = createWorld(withExtraStaff(), SEED, MONDAY_0800);

    // Long enough that an unisolated stream would have drifted far apart: the
    // extra person wanders roughly once a minute, so thousands of draws.
    advance(base, 14 * 24 * 60);
    advance(hired, 14 * 24 * 60);

    expect(hired.nextEmergencyAtMinute).toBe(base.nextEmergencyAtMinute);
    expect(hired.rngState).toBe(base.rngState);
  });

  it('hiring someone leaves the people already there unchanged', () => {
    const base = createWorld(fullShift(), SEED, MONDAY_0800);
    const hired = createWorld(withExtraStaff(), SEED, MONDAY_0800);

    const fingerprint = (w: ReturnType<typeof createWorld>) =>
      w.staff.map((p) => [p.name, p.energy, p.nextWanderAtMinute, p.rngState]);

    // The new hire is appended, so the originals must match element for
    // element — the extra person is additive, not a reshuffle.
    expect(fingerprint(hired).slice(0, base.staff.length)).toEqual(fingerprint(base));
  });

  it('leasing another instrument leaves the people unchanged', () => {
    const base = createWorld(fullShift(), SEED, MONDAY_0800);
    const leased = createWorld(withExtraEquipment(), SEED, MONDAY_0800);

    expect(leased.staff.map((p) => [p.energy, p.nextWanderAtMinute])).toEqual(
      base.staff.map((p) => [p.energy, p.nextWanderAtMinute]),
    );
    expect(leased.nextEmergencyAtMinute).toBe(base.nextEmergencyAtMinute);
  });

  it('leasing another instrument leaves the existing machines unchanged', () => {
    const base = createWorld(fullShift(), SEED, MONDAY_0800);
    const leased = createWorld(withExtraEquipment(), SEED, MONDAY_0800);

    expect(leased.equipment.map((e) => e.condition).slice(0, base.equipment.length)).toEqual(
      base.equipment.map((e) => e.condition),
    );
  });
});

describe('the streams are still streams', () => {
  it('gives each person a different starting energy', () => {
    const world = createWorld(fullShift(), SEED, MONDAY_0800);
    const energies = new Set(world.staff.map((p) => p.energy));

    // A test that only asserts "nothing changed" would pass just as happily if
    // every stream had collapsed to the same sequence. This is the other half.
    expect(energies.size).toBe(world.staff.length);
  });

  it('gives each machine a different starting condition', () => {
    const world = createWorld(fullShift(), SEED, MONDAY_0800);
    const conditions = new Set(world.equipment.map((e) => e.condition));

    expect(conditions.size).toBe(world.equipment.length);
  });

  it('still produces a different lab for a different seed', () => {
    const a = createWorld(fullShift(), 42, MONDAY_0800);
    const b = createWorld(fullShift(), 43, MONDAY_0800);

    expect(b.staff.map((p) => p.energy)).not.toEqual(a.staff.map((p) => p.energy));
    expect(b.equipment.map((e) => e.condition)).not.toEqual(a.equipment.map((e) => e.condition));
    expect(b.nextEmergencyAtMinute).not.toBe(a.nextEmergencyAtMinute);
  });
});

/**
 * How well the labels are mixed.
 *
 * "Different" is a weak property. `deriveSeed` is FNV-1a, which is a fast hash
 * and not a strong one, and multiplication only propagates carries upward — so
 * the low bits of the hash are the worst-mixed part of it, and two seeds that
 * differ only in the low bits are exactly the case a batch run produces. If
 * seeds 1…300 turned out to be correlated, three hundred runs would be three
 * hundred near-copies and the reported P10–P90 range would be far too narrow.
 * Narrow and confident, which is the worst way for this to fail.
 *
 * These bounds are statistical, so they are set at roughly three standard
 * errors rather than fitted to the values that happen to come out. Nothing here
 * draws from the clock, so they are deterministic despite looking like
 * sampling.
 */
describe('the seed is mixed well enough for a batch run', () => {
  const SAMPLE = 1000;
  const seeds = Array.from({ length: SAMPLE }, (_, i) => i + 1);
  /** The 3σ band on a correlation of zero at this sample size is ±0.095. */
  const NOISE = 0.1;

  const firstDraw = (seed: number, label: string) => createRng(deriveSeed(seed, label)).next();

  function correlation(a: number[], b: number[]): number {
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const [ma, mb] = [mean(a), mean(b)];
    let covariance = 0;
    let varA = 0;
    let varB = 0;
    for (let i = 0; i < a.length; i++) {
      const [da, db] = [a[i]! - ma, b[i]! - mb];
      covariance += da * db;
      varA += da * da;
      varB += db * db;
    }
    return covariance / Math.sqrt(varA * varB);
  }

  it('gives every seed its own derived stream, with no collisions', () => {
    const derived = new Set(seeds.map((s) => deriveSeed(s, 'staff:0')));
    expect(derived.size).toBe(SAMPLE);
  });

  it('does not correlate one seed with the next', () => {
    const draws = seeds.map((s) => firstDraw(s, 'staff:0'));

    // Lag 1 and lag 2: consecutive seeds, which is how a batch run numbers its
    // runs, and every-other-seed, which would catch a low-bit parity effect.
    expect(Math.abs(correlation(draws.slice(0, -1), draws.slice(1)))).toBeLessThan(NOISE);
    expect(Math.abs(correlation(draws.slice(0, -2), draws.slice(2)))).toBeLessThan(NOISE);
  });

  it('does not correlate one stream with another at the same seed', () => {
    const a = seeds.map((s) => firstDraw(s, 'staff:0'));
    const b = seeds.map((s) => firstDraw(s, 'staff:1'));
    const c = seeds.map((s) => firstDraw(s, 'equipment:0'));

    // Adjacent labels differ by one character in the worst-mixed position, so
    // this is the weakest case for the hash, not a representative one.
    expect(Math.abs(correlation(a, b))).toBeLessThan(NOISE);
    expect(Math.abs(correlation(a, c))).toBeLessThan(NOISE);
  });

  it('spreads a thousand seeds evenly across the range', () => {
    const buckets = new Array<number>(10).fill(0);
    for (const u of seeds.map((s) => firstDraw(s, 'staff:0'))) buckets[Math.floor(u * 10)]!++;

    // 100 expected per decile; 3σ on a binomial(1000, 0.1) is ±28.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(70);
      expect(count).toBeLessThan(130);
    }
  });

  it('rarely puts two adjacent seeds close together', () => {
    const draws = seeds.map((s) => firstDraw(s, 'staff:0'));
    let close = 0;
    for (let i = 0; i + 1 < SAMPLE; i++) {
      if (Math.abs(draws[i + 1]! - draws[i]!) < 0.0005) close++;
    }

    // Two independent uniforms land within 0.0005 of each other about once per
    // thousand pairs. Seeds 42 and 43 are one such pair — their first draws
    // agree to three decimals, which looks alarming and is coincidence. This
    // test is what distinguishes the two readings: a systematic correlation
    // would produce dozens, not a handful.
    expect(close).toBeLessThan(8);
  });
});
