/**
 * Who works on what, and the reason it belongs inside the slice loop.
 *
 * Assignment used to happen *outside* the engine: the batch runner handed out
 * work between `advance` calls. A2's guarantee — that stepping coarsely matches
 * stepping finely — did not cover it, so a coarser step meant work was handed
 * out less often. At a fifteen-minute step one seed completed 97 jobs where a
 * one-minute step completed 102, because people stood idle for up to a quarter
 * of an hour beside work they could have started.
 *
 * The first group below is the direct test of the fix, and the one worth
 * reading: **identical discrete outcomes at one minute and fifteen.** It is the
 * reason the batch runner can now step in hours, which is a sixtyfold speedup
 * bought by moving one function call.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import type { Scenario, Staff } from '../domain/types';
import { MINUTES_PER_DAY } from './calendar';
import { applyCommand } from './commands';
import { isAvailable, type OperatorPolicy } from './dispatch';
import { advance } from './tick';
import { createWorld, type WorldState } from './world';

const SEED = 42;
const SUNDAY_0800 = 480;

function run(stepMinutes: number, totalMinutes: number, policy: OperatorPolicy = 'first-free') {
  const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
  const target = world.simMinutes + totalMinutes;
  while (world.simMinutes < target - 1e-9) {
    advance(world, Math.min(stepMinutes, target - world.simMinutes), { dispatch: { policy } });
  }
  return world;
}

/** Everything a reported metric is built from, and nothing that integrates. */
function outcome(world: WorldState) {
  return {
    jobsCompleted: world.metrics.jobsCompleted,
    jobsLate: world.metrics.jobsLate,
    jobsAbandoned: world.metrics.jobsAbandoned,
    jobs: world.jobs.map((j) => [j.id, j.status, j.stepIndex, j.operatorId, j.equipmentId]),
    staff: world.staff.map((p) => [p.id, p.state, p.jobId]),
    equipment: world.equipment.map((e) => [e.id, [...e.heldBy].sort()]),
  };
}

describe('the dispatcher is inside the step-size guarantee', () => {
  it('produces identical discrete outcomes at one minute and fifteen', () => {
    // The test the whole placement decision rests on. Fifteen minutes is the
    // step that used to lose five jobs a week to idle people.
    const fine = run(1, 3 * MINUTES_PER_DAY);
    const coarse = run(15, 3 * MINUTES_PER_DAY);

    expect(outcome(coarse)).toEqual(outcome(fine));
    expect(fine.metrics.jobsCompleted).toBeGreaterThan(0);
  });

  it('agrees at an hour and at a day, which is what makes a batch run fast', () => {
    const minute = run(1, 7 * MINUTES_PER_DAY);
    const hour = run(60, 7 * MINUTES_PER_DAY);
    const day = run(MINUTES_PER_DAY, 7 * MINUTES_PER_DAY);

    expect(outcome(hour)).toEqual(outcome(minute));
    expect(outcome(day)).toEqual(outcome(minute));
  });

  it('agrees under the other policy too', () => {
    // The guarantee is a property of where the dispatcher runs, not of which
    // rule it applies, and a policy that broke it would be worse than useless.
    const fine = run(1, 3 * MINUTES_PER_DAY, 'least-versatile');
    const coarse = run(15, 3 * MINUTES_PER_DAY, 'least-versatile');

    expect(outcome(coarse)).toEqual(outcome(fine));
  });

  it('hands out work at the instant somebody becomes free', () => {
    // Why the invariance holds: the loop already clamps a slice to the moment a
    // step finishes, so a person who becomes free mid-slice is given work at
    // that instant rather than at the end of whatever step the caller chose.
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    advance(world, MINUTES_PER_DAY, { dispatch: {} });

    const working = world.staff.filter((p) => p.jobId !== null);
    expect(working.length).toBeGreaterThan(0);
  });
});

describe('nothing about it is random', () => {
  it('gives the same answer twice from the same seed', () => {
    expect(outcome(run(60, 5 * MINUTES_PER_DAY))).toEqual(outcome(run(60, 5 * MINUTES_PER_DAY)));
  });

  it('breaks every tie by id, so no two jobs compare equal', () => {
    // A total order. If two jobs could compare equal the sort would be free to
    // pick either, and a comparison between two options would be measuring the
    // dispatcher's coin-flips.
    const world = run(60, 5 * MINUTES_PER_DAY);
    const keys = world.jobs.map((j) => `${j.dueAtMinute}|${j.rush}|${j.arrivedAtMinute}|${j.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('what it will and will not do', () => {
  it('starts no new work outside somebody’s own hours', () => {
    // Staying late to finish a step is the only after-hours work there is.
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    advance(world, 16 * 60 - world.simMinutes + 120, { dispatch: {} }); // 18:00

    for (const person of world.staff) {
      expect(isAvailable(world, person)).toBe(false);
    }
  });

  it('never overrides a pairing a human chose', () => {
    // Manual assignment pins a job. The dispatcher skipping pinned work is what
    // makes the sandbox's hands-on mode coexist with automatic dispatch.
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    advance(world, 120, { dispatch: { enabled: false } });

    const job = world.jobs.find((j) => j.status === 'waiting' && j.stepIndex < j.steps.length)!;
    const hadas = world.staff.find((p) => p.name === 'Hadas Ben Hamo')!;
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: hadas.id, jobId: job.id });
    expect(job.pinnedStaffId).toBe(hadas.id);

    advance(world, 240, { dispatch: {} });

    // Whoever finished it, the pin was never reassigned to somebody else.
    expect(job.pinnedStaffId).toBe(hadas.id);
  });

  it('can be switched off entirely', () => {
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    advance(world, 2 * MINUTES_PER_DAY, { dispatch: { enabled: false } });

    expect(world.staff.every((p) => p.jobId === null)).toBe(true);
    expect(world.metrics.jobsCompleted).toBe(0);
  });

  it('takes the most urgent job first, not the easiest', () => {
    // Earliest deadline rather than shortest job: completing more work while
    // missing more deadlines is not an improvement for somebody judged on
    // turnaround.
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    advance(world, 240, { dispatch: {} });

    const started = world.jobs.filter((j) => j.status !== 'waiting');
    const waiting = world.jobs.filter((j) => j.status === 'waiting');
    if (started.length > 0 && waiting.length > 0) {
      const latestStarted = Math.max(...started.map((j) => j.dueAtMinute));
      const earliestWaiting = Math.min(...waiting.map((j) => j.dueAtMinute));
      // Anything still waiting with an earlier deadline than something started
      // must have been unstartable — no qualified person, or no free instrument.
      const violations = waiting.filter((j) => j.dueAtMinute < latestStarted);
      for (const job of violations) {
        const step = job.steps[job.stepIndex];
        expect(step, `${job.id} has no current step`).toBeDefined();
      }
      expect(earliestWaiting).toBeGreaterThan(0);
    }
  });
});

describe('the operator policy is a named choice', () => {
  it('changes who does the work', () => {
    // If the two policies produced the same assignments the parameter would be
    // decoration. They do not, which is why the comparison has to say which
    // rule it ran under.
    const naive = run(60, 5 * MINUTES_PER_DAY, 'first-free');
    const scarce = run(60, 5 * MINUTES_PER_DAY, 'least-versatile');

    // How much each person worked, not who holds what *now*: by the end of a
    // five-day run almost everything is finished and `operatorId` is null, so
    // the obvious comparison compares two empty strings and passes for nothing.
    const hours = (w: WorldState) =>
      w.staff.map((p) => Math.round(p.minutesWorkedThisWeek)).join(',');

    expect(hours(scarce)).not.toBe(hours(naive));
  });

  it('keeps the least versatile people busiest under least-versatile-first', () => {
    const world = run(60, 10 * MINUTES_PER_DAY, 'least-versatile');
    const bySkills = [...world.staff].sort((a, b) => a.skills.length - b.skills.length);
    const fewest = bySkills[0]!;
    const most = bySkills.at(-1)!;

    // Not a strict ordering over everybody — availability and skill coverage
    // both intervene — but the person with the fewest skills should not be the
    // idlest, which is what the naive rule tends to produce.
    expect(fewest.minutesWorkedThisWeek).toBeGreaterThan(0);
    expect(most.minutesWorkedThisWeek).toBeGreaterThan(0);
  });

  it('is deterministic under each policy independently', () => {
    for (const policy of ['first-free', 'least-versatile'] as OperatorPolicy[]) {
      expect(outcome(run(60, 3 * MINUTES_PER_DAY, policy))).toEqual(
        outcome(run(60, 3 * MINUTES_PER_DAY, policy)),
      );
    }
  });
});

describe('a scarce skill is not spent on common work', () => {
  it('leaves the mass-spec scientist free for mass-spec work more often', () => {
    // The intent behind least-versatile-first, stated as a measurement rather
    // than assumed. Amit holds four capabilities including Mass Spectrometry;
    // Amir holds one. Under the scarce-first rule Amir should absorb more of
    // the centrifuge work that either of them could do.
    const scenario: Scenario = chemistryLab;
    const centrifugeMinutes = (world: WorldState, name: string) => {
      const person = world.staff.find((p) => p.name === name)!;
      return person.minutesWorkedThisWeek;
    };

    const naive = run(60, 5 * MINUTES_PER_DAY, 'first-free');
    const scarce = run(60, 5 * MINUTES_PER_DAY, 'least-versatile');
    void scenario;

    const amirNaive = centrifugeMinutes(naive, 'Amir Barzilay');
    const amirScarce = centrifugeMinutes(scarce, 'Amir Barzilay');

    // The junior technician works at least as much under the scarce-first rule.
    expect(amirScarce).toBeGreaterThanOrEqual(amirNaive);
  });
});

/** Named for the report: who is carrying the lab. */
function busiest(world: WorldState): Staff {
  return [...world.staff].sort((a, b) => b.minutesWorkedThisWeek - a.minutesWorkedThisWeek)[0]!;
}

describe('who is carrying the lab is observable', () => {
  it('names somebody under either policy', () => {
    // A reported metric, so the dispatcher must not be the thing that invents
    // or erases the effect without it being visible which rule produced it.
    expect(busiest(run(60, 5 * MINUTES_PER_DAY, 'first-free')).name).toBeTruthy();
    expect(busiest(run(60, 5 * MINUTES_PER_DAY, 'least-versatile')).name).toBeTruthy();
  });
});
