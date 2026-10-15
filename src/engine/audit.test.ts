/**
 * Tests for the scenario audit.
 *
 * Two jobs. The first is catching a scenario that cannot work before a batch
 * run is spent on it. The second is the strongest check available on the engine
 * itself: the audit computes load in closed form from the scenario, the
 * simulation computes it by running, and the two should agree. When they do
 * not, one of them is wrong in a way neither could reveal alone — which is the
 * shape of all three aggregate-only defects this phase has produced.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import type { Scenario } from '../domain/types';
import { assertScenarioIsPossible, auditScenario } from './audit';
import { MINUTES_PER_DAY } from './calendar';
import { instrumentsFor } from './resources';
import { advance } from './tick';
import { createWorld } from './world';

const SEED = 42;
const SUNDAY_0800 = 480;

describe('the shipped scenario', () => {
  const audit = auditScenario(chemistryLab);

  it('is possible', () => {
    expect(audit.errors).toEqual([]);
    expect(() => assertScenarioIsPossible(chemistryLab)).not.toThrow();
  });

  it('offers the specification 186 hands-on hours against 280 contracted', () => {
    expect(audit.offeredAttendedMinutes / 60).toBeCloseTo(186, 1);
    expect(audit.contractedMinutes / 60).toBeCloseTo(280, 1);
  });

  it('is not limited by people', () => {
    // The roster drift made it look as though it were. Every skill now sits
    // comfortably inside the hours of the people who hold it.
    expect(audit.bindingSkill).toBeDefined();
    expect(audit.bindingSkill!.utilisation).toBeLessThan(0.5);
    for (const load of audit.bySkill) expect(load.utilisation).toBeLessThan(1);
  });

  it('makes microscopy the tightest thing a person has to stand next to', () => {
    // Three capabilities read above 100% of the working week, and all three are
    // feasible because most of their time is unattended and runs overnight.
    // Among the attended-only ones, microscopy binds first: 80 blood panels at
    // 20 minutes plus 12 cell cultures at 45 is 35.7 hours against roughly 40.
    const attendedOnly = audit.byCapability.filter(
      (c) => c.attendedMinutesPerWeek === c.minutesPerWeek,
    );
    expect(attendedOnly[0]!.capability).toBe('microscopy');
    expect(attendedOnly[0]!.utilisationInWorkingHours).toBeGreaterThan(0.85);
    expect(attendedOnly[0]!.utilisationInWorkingHours).toBeLessThan(1);
  });

  it('shows why the specification can call the mass spectrometer the bottleneck', () => {
    // 45 instrument-hours a week: 112% of a working week, 27% of a calendar
    // week. The spec's claim is true under one denominator and false under the
    // other, which is exactly why both are reported rather than one chosen.
    const massSpec = audit.byCapability.find((c) => c.capability === 'mass-spec')!;
    expect(massSpec.minutesPerWeek / 60).toBeCloseTo(45, 1);
    expect(massSpec.utilisationInWorkingHours).toBeGreaterThan(1);
    expect(massSpec.utilisationInCalendarHours).toBeLessThan(0.3);
  });

  it('notices instruments no work type asks for', () => {
    // Not an error: they are on the floor of the real lab and the renderer
    // draws them. Reporting them beats treating silence as approval.
    expect(audit.warnings.join(' ')).toContain('Flow Cytometer');
    expect(audit.warnings.join(' ')).toContain('Freezer');
  });
});

describe('refusing a scenario that cannot work', () => {
  it('catches work needing an instrument the lab does not own', () => {
    const scenario: Scenario = {
      ...chemistryLab,
      equipment: chemistryLab.equipment.filter((e) => !e.capabilities.includes('mass-spec')),
    };
    const audit = auditScenario(scenario);
    expect(audit.errors.join(' ')).toContain('mass-spec');
    expect(() => assertScenarioIsPossible(scenario)).toThrow(/cannot work/);
  });

  it('catches work needing a skill nobody holds', () => {
    const scenario: Scenario = {
      ...chemistryLab,
      staff: chemistryLab.staff.map((p) => ({
        ...p,
        skills: p.skills.filter((s) => s !== 'Mass Spectrometry'),
      })),
    };
    expect(auditScenario(scenario).errors.join(' ')).toContain('Mass Spectrometry');
  });

  it('catches more hands-on work than the lab is contracted for', () => {
    const scenario: Scenario = {
      ...chemistryLab,
      workTypes: chemistryLab.workTypes.map((w) => ({ ...w, perWeek: w.perWeek * 3 })),
    };
    const audit = auditScenario(scenario);
    expect(audit.errors.join(' ')).toContain('No assignment can keep up');
  });

  it('catches an instrument that could not keep up running continuously', () => {
    // The case capacity exists to prevent. One shelf instead of eight, and
    // 579 instrument-hours a week becomes impossible rather than merely tight.
    const scenario: Scenario = {
      ...chemistryLab,
      equipment: chemistryLab.equipment.map((e) =>
        e.capabilities.includes('incubator') ? { ...e, capacity: 1 } : e,
      ),
    };
    const audit = auditScenario(scenario);
    expect(audit.errors.join(' ')).toContain('incubator');
    expect(audit.errors.join(' ')).toContain('continuously');
  });

  it('separates a tight scenario from an impossible one', () => {
    // 89% of the working week is a warning. It has to be, or the shipped
    // scenario would be refused and the whole audit would be useless.
    const audit = auditScenario(chemistryLab);
    expect(audit.errors).toEqual([]);
    expect(audit.warnings.length).toBeGreaterThan(0);
  });
});

describe('the arithmetic agrees with the simulation', () => {
  it('never uses an instrument for longer than the work demands', () => {
    // The audit's figures are an upper bound on what a run can consume: a week
    // of demand cannot occupy an instrument for more than a week of demand.
    // Exceeding it would mean the engine double-charges somewhere.
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    const WEEKS = 2;

    for (let t = 0; t < WEEKS * 7 * MINUTES_PER_DAY; t += 1) {
      advance(world, 1);
      // No hand-rolled assignment any more: B3 moved the dispatcher inside the
      // loop, so running one out here as well would have two of them competing
      // and would measure neither.
      for (const person of world.staff) {
        void person;
      }
    }

    const audit = auditScenario(chemistryLab);
    for (const load of audit.byCapability) {
      const busy = instrumentsFor(world, load.capability).reduce(
        (total, r) => total + r.totalWorkTime,
        0,
      );
      // Ten percent of headroom: a job can hold an instrument slightly longer
      // than its own step, because an operator on a break keeps hold of it.
      // That is the invented energy metric, which B1 deletes.
      expect(busy / WEEKS, load.capability).toBeLessThanOrEqual(load.minutesPerWeek * 1.1);
    }
  });

  /**
   * Minutes of presence against minutes of work, exactly.
   *
   * Two accountings that never speak to each other: `minutesWorkedThisWeek` is a
   * per-person ledger written once per slice by the shift code, and
   * `step.total - step.remaining` is read off the jobs themselves. They must
   * agree, and the only thing allowed to come between them is fatigue, whose
   * price is a known multiplier.
   *
   * This assertion was weakened once, to "spent is never less than delivered and
   * the gap is within the pace multiplier", because the exact form had started
   * failing. The gap was real and fatigue was not causing it: a prepped
   * mass-spec sample whose instrument was busy was being handed to a qualified
   * person every cadence, who stood over finished preparation for one slice and
   * was released again. The lab was paying for presence that produced no work.
   * The loosened bound was wide enough to swallow it, which is how a defect
   * survives a passing test suite — so the exactness is the point, not the
   * tidiness.
   *
   * Six days rather than seven: the weekly ledger clears at Saturday midnight,
   * and a counter that resets mid-measurement cannot be compared against a total.
   */
  it('spends exactly the presence the work it delivered called for', () => {
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    for (let day = 0; day < 6; day++) advance(world, MINUTES_PER_DAY);

    const presence = world.staff.reduce((sum, p) => sum + p.minutesWorkedThisWeek, 0);
    const delivered = world.jobs.reduce(
      (total, job) =>
        total + job.steps.reduce((sum, step) => sum + (step.total - step.remaining), 0),
      0,
    );

    expect(delivered).toBeGreaterThan(0);

    // Nobody is tired in this run, so the pace multiplier is one throughout and
    // the two quantities are the same number. Asserted rather than assumed: if
    // the roster ever changed enough for somebody to pass the threshold, this
    // test would be comparing quantities that are *meant* to differ, and would
    // start failing for a reason that is not a bug.
    const threshold = chemistryLab.tuning.fatigueAfterWeeklyHours * 60;
    for (const p of world.staff) {
      expect(
        p.minutesWorkedThisWeek,
        `${p.name} crossed the fatigue threshold`,
      ).toBeLessThanOrEqual(threshold);
    }

    expect(presence).toBeCloseTo(delivered, 6);
  });

  it('spends the pace multiplier more when everybody is tired', () => {
    // The other regime, with the multiplier pinned exactly rather than bounded.
    // Fatigue from the first minute, so every delivered minute costs the same
    // 1.1 minutes of presence and the reconstruction is a single multiplication.
    //
    // Together with the test above this fixes the multiplier from both sides: at
    // a pace of one the quantities are equal, and at 1.1 they differ by exactly
    // 1.1. A sign error or a multiplier applied in the wrong direction fails one
    // or the other.
    const tired: Scenario = {
      ...chemistryLab,
      tuning: { ...chemistryLab.tuning, fatigueAfterWeeklyHours: 0 },
    };
    const world = createWorld(tired, SEED, SUNDAY_0800);
    for (let day = 0; day < 6; day++) advance(world, MINUTES_PER_DAY);

    const presence = world.staff.reduce((sum, p) => sum + p.minutesWorkedThisWeek, 0);
    const delivered = world.jobs.reduce(
      (total, job) =>
        total + job.steps.reduce((sum, step) => sum + (step.total - step.remaining), 0),
      0,
    );

    expect(delivered).toBeGreaterThan(0);
    expect(presence).toBeCloseTo(delivered * tired.tuning.fatiguePaceMultiplier, 6);
  });
});

describe('the occupancy assumptions are consequential', () => {
  it('judges feasibility against the calendar week when a run frees its instrument', () => {
    const audit = auditScenario(chemistryLab);
    expect(chemistryLab.tuning.instrumentFreedWhenRunEnds).toBe(true);
    expect(audit.errors).toEqual([]);
  });

  it('makes the same scenario impossible in three places under the strict reading', () => {
    // The two readings are not a matter of taste. If a sample sits in an
    // instrument until somebody unloads it, availability is the working week —
    // and the incubator needs 579 instrument-hours a week against 240.
    //
    // This is the strongest argument for putting the question to the lab
    // manager: the answer decides whether the lab as described can function.
    const strict: Scenario = {
      ...chemistryLab,
      tuning: { ...chemistryLab.tuning, instrumentFreedWhenRunEnds: false },
    };
    const audit = auditScenario(strict);

    expect(audit.errors).toHaveLength(3);
    expect(audit.errors.join(' ')).toContain('incubator');
    expect(audit.errors.join(' ')).toContain('pcr');
    expect(audit.errors.join(' ')).toContain('mass-spec');
    expect(audit.errors.join(' ')).toContain('inside working hours');
  });

  it('refuses to simulate the reading it does not implement', () => {
    // The audit responds to the flag; the engine does not. Rather than let a
    // run silently behave as though the flag were true, creating the world
    // throws. A parameter that governs half a system is worse than none.
    const strict: Scenario = {
      ...chemistryLab,
      tuning: { ...chemistryLab.tuning, instrumentFreedWhenRunEnds: false },
    };
    expect(() => createWorld(strict, SEED, SUNDAY_0800)).toThrow(/not implemented/);
  });

  it('turns the incubator capacity into the thing that decides possibility', () => {
    const oneShelf: Scenario = {
      ...chemistryLab,
      tuning: { ...chemistryLab.tuning, incubatorCapacity: 1 },
      equipment: chemistryLab.equipment.map((e) =>
        e.capabilities.includes('incubator') ? { ...e, capacity: 1 } : e,
      ),
    };
    expect(auditScenario(oneShelf).errors.join(' ')).toContain('incubator');
    expect(auditScenario(chemistryLab).errors).toEqual([]);
  });
});
