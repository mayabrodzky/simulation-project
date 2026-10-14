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
import { applyCommand } from './commands';
import { listAssignableJobs } from './queries';
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

  it('agrees on the attended load the lab actually performed', () => {
    // The identity worth having: hands-on minutes spent must equal hands-on
    // minutes the finished work called for. Not an estimate — the two are
    // computed from different places and must come out the same.
    const STEP = 0.5;
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    let workedMinutes = 0;
    let stepStarts = 0;
    const wasWorking = new Map<number, boolean>();

    for (let t = 0; t < 7 * MINUTES_PER_DAY; t += STEP) {
      advance(world, STEP);
      for (const person of world.staff) {
        const working = person.state === 'working';
        if (working) {
          workedMinutes += STEP;
          if (!wasWorking.get(person.id)) stepStarts += 1;
        }
        wasWorking.set(person.id, working);
      }
      for (const person of world.staff) {
        if (person.state !== 'idle' || person.jobId !== null || person.activeTask) continue;
        const pick = listAssignableJobs(world, person).filter((r) => r.qualified)[0];
        if (pick) applyCommand(world, { type: 'ASSIGN_JOB', staffId: person.id, jobId: pick.id });
      }
    }

    // Attended minutes accounted for by progress on every job, finished or not.
    const accounted = world.jobs.reduce(
      (total, job) =>
        total + job.steps.reduce((sum, step) => sum + (step.total - step.remaining), 0),
      0,
    );

    // Minutes *spent* are never fewer than minutes of work *delivered*, and can
    // be more for one reason: fatigue. Past forty-five hours in a week a person
    // spends 1.1 minutes of presence per minute of work done, so the two
    // quantities are deliberately not equal — the gap is the cost of tiredness,
    // measured rather than assumed.
    //
    // The sampling slop goes the same way: state is read once per STEP *after*
    // advancing, so somebody beginning a step part-way through a sample is
    // credited with the whole of it, at most one STEP per step started.
    const samplingSlop = stepStarts * STEP;
    expect(workedMinutes).toBeGreaterThan(accounted - samplingSlop);

    // And the gap stays within what fatigue alone can explain. Ten percent is
    // the pace multiplier itself: nobody can be slower than the slowest rate.
    const gap = (workedMinutes - accounted) / accounted;
    expect(gap).toBeLessThan(chemistryLab.tuning.fatiguePaceMultiplier - 1);
    expect(gap).toBeGreaterThan(-0.01);
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
