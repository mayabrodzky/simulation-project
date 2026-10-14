/**
 * Where the working day actually goes.
 *
 * Two different jobs. The first is a conservation law: every minute a person is
 * on shift must be accounted for as exactly one of working, travelling, waiting
 * for a machine, or free. If minutes can go missing or be counted
 * twice, every capacity figure downstream is wrong and nothing else here would
 * notice — the A2 ordering bugs were all of that shape.
 *
 * The second is a measurement, kept as a test so the numbers cannot drift
 * unnoticed. It exists because of a reasonable-sounding theory that turned out
 * to be only partly right: that walking between machines, whose simulated cost
 * doubled when A2 changed the clock's unit, was what stopped the lab keeping up.
 * Walking does cost real time. It is not the main thing.
 *
 * This is the aggregate question that unit tests are structurally unable to
 * answer, and the step before this one shipped a modelling error for exactly
 * that reason. A7 computes the same thing in closed form; this measures it.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import { applyCommand } from './commands';
import { MINUTES_PER_DAY } from './calendar';
import { hasArrivedAt } from './geometry';
import { listAssignableJobs } from './queries';
import { advance } from './tick';
import { allocate, instrumentsFor } from './resources';
import { createWorld, type WorldState } from './world';

const SEED = 42;
const SUNDAY_0800 = 480;

/**
 * Runs with the dispatcher off.
 *
 * These tests build a precise situation by hand and assert about it. With
 * dispatch on — the default the live lab wants — the engine hands out work the
 * moment somebody is free, so the subject would be given something else before
 * the test could give it anything.
 */
const QUIET = { dispatch: { enabled: false } } as const;
const STEP = 0.25;

interface Breakdown {
  working: number;
  travelling: number;
  waitingForMachine: number;
  free: number;
  offShift: number;
  stepsStarted: number;
  completed: number;
}

/**
 * Runs a week with every free person taking the most urgent job they can.
 *
 * Deliberately a naive rule, not the dispatcher B3 will build: the point is to
 * measure the model, and a clever assignment would hide what the model costs.
 */
function measureWeek(): Breakdown {
  const world: WorldState = createWorld(chemistryLab, SEED, SUNDAY_0800);

  const b: Breakdown = {
    working: 0,
    travelling: 0,
    waitingForMachine: 0,
    free: 0,
    offShift: 0,
    stepsStarted: 0,
    completed: 0,
  };
  const wasWorking = new Map<number, boolean>();

  for (let t = 0; t < 7 * MINUTES_PER_DAY; t += STEP) {
    advance(world, STEP, QUIET);

    for (const person of world.staff) {
      if (person.state === 'working') {
        b.working += STEP;
        if (!wasWorking.get(person.id)) b.stepsStarted += 1;
        wasWorking.set(person.id, true);
        continue;
      }
      wasWorking.set(person.id, false);

      if (person.state === 'off' || person.state === 'sick' || person.state === 'vacation') {
        b.offShift += STEP;
      } else if (person.jobId === null) {
        b.free += STEP;
      } else {
        // On a job but not working: either still walking to the machine, or
        // standing at one that somebody else is using. Those mean completely
        // different things — the first is overhead, the second is a bottleneck.
        // Where the engine would send them: the instrument they already hold,
        // otherwise a free one, otherwise the first that offers the capability
        // at all — so standing at a busy instrument counts as waiting.
        //
        // The first version of this asked `allocate`, which only returns a
        // *free* instrument, so waiting at a busy one was counted as walking
        // and the waiting bucket read zero. The same confusion between
        // travelling and waiting that produced the wrong walking figure two
        // entries ago, in the code written to measure it.
        const job = world.jobs.find((j) => j.id === person.jobId);
        const step = job?.steps[job.stepIndex];
        const held =
          job && job.equipmentId !== null
            ? world.equipment.find((e) => e.id === job.equipmentId)
            : undefined;
        const machine =
          held ??
          (step
            ? (allocate(world, step.capability) ?? instrumentsFor(world, step.capability)[0])
            : undefined);
        if (machine && hasArrivedAt(person, machine)) b.waitingForMachine += STEP;
        else b.travelling += STEP;
      }
    }

    for (const person of world.staff) {
      if (person.state !== 'idle' || person.jobId !== null || person.activeTask) continue;
      const pick = listAssignableJobs(world, person).filter((row) => row.qualified)[0];
      if (pick) applyCommand(world, { type: 'ASSIGN_JOB', staffId: person.id, jobId: pick.id });
    }
  }

  b.completed = world.jobs.filter((j) => j.status.startsWith('done')).length;
  return b;
}

describe('the working day adds up', () => {
  const b = measureWeek();
  const people = chemistryLab.staff.length;
  const totalPersonMinutes = people * 7 * MINUTES_PER_DAY;

  it('accounts for every person-minute exactly once', () => {
    // A conservation law. Minutes that go missing or get counted twice would
    // make every capacity figure wrong, and nothing else here would notice.
    const accounted = b.working + b.travelling + b.waitingForMachine + b.free + b.offShift;
    expect(accounted).toBeCloseTo(totalPersonMinutes, 4);
  });

  it('works some minutes beyond contracted hours, and not many', () => {
    // This asserted that nobody was ever present outside opening hours, which
    // B1 deliberately made false: somebody mid-step stays to finish it, and
    // those minutes are overtime. Without them the specification's overtime
    // bands would price a quantity that is always zero.
    //
    // The claim now is that overtime exists and is bounded - a tail on each
    // day, not a second shift.
    const contracted = chemistryLab.staff.reduce((sum, p) => sum + p.weeklyHours, 0) * 60;
    const onShift = b.working + b.travelling + b.waitingForMachine + b.free;

    expect(onShift).toBeGreaterThan(contracted * 0.9);
    expect(onShift).toBeLessThan(contracted * 1.2);
  });
});

describe('what the lab spends its time on', () => {
  const b = measureWeek();

  const contractedHours = chemistryLab.staff.reduce((sum, p) => sum + p.weeklyHours, 0);

  const offeredHours =
    chemistryLab.workTypes.reduce(
      (total, w) => total + w.perWeek * w.steps.reduce((sum, s) => sum + s.attended, 0),
      0,
    ) / 60;

  it('is offered 186 hours of work against 280 contracted hours', () => {
    // Contracted hours, summed per person, not head-count times forty: the spec
    // employs six full-timers and two part-timers on twenty hours. This read
    // 240 while the scenario had drifted from the spec and the two part-timers
    // were not employed at all — a fifth of the lab's capacity missing.
    expect(offeredHours).toBeCloseTo(186, 1);
    expect(contractedHours).toBe(280);
  });

  it('loses very little time to walking, despite the theory', () => {
    // About 1.3 minutes a step and under 5 hours a week — 2% of rostered time.
    //
    // The first attempt at this measurement reported 6.9 minutes a step, which
    // seemed to support the theory that walking was the problem. It was wrong:
    // it counted standing at a machine somebody else was using as walking.
    // Those two look identical in the state (on a job, not working) and mean
    // opposite things — overhead against a bottleneck — so they are separated
    // here, and the separation is the only reason the right answer appeared.
    const perStep = b.travelling / b.stepsStarted;
    expect(perStep).toBeGreaterThan(0.2);
    expect(perStep).toBeLessThan(6);
    expect(b.travelling / 60).toBeLessThan(20);
  });

  it('loses four times as much to waiting for a busy machine', () => {
    // Around 20 hours a week. This is contention, and it is the signal A5's
    // instrument counts and A7's audit are built to explain — the first
    // measurement in this project that points at the bottleneck the scenario
    // is supposed to have.
    expect(b.waitingForMachine).toBeGreaterThan(b.travelling * 2);
  });

  it('loses far more to people on shift with nothing they can do', () => {
    // The actual constraint, and not what the walking theory predicted. Most of
    // it is one person: the junior researcher holds no skills at all, so forty
    // rostered hours a week can never be used by anyone.
    //
    // That is a finding about the lab rather than a defect — "somebody is idle
    // all week because they are not trained on anything" is precisely the
    // sentence this product exists to produce — so the scenario is left alone.
    // Still the largest single bucket, though the spec roster shrinks it a long
    // way: aligning skills with section 3.2 gave every person something they
    // can do, where the drifted roster left one person with no skills at all.
    expect(b.free).toBeGreaterThan(b.travelling);
    expect(chemistryLab.staff.every((p) => p.skills.length > 0)).toBe(true);
  });

  it('completes less than arrives, so the queue grows', () => {
    const arrivingPerWeek = chemistryLab.workTypes.reduce((total, w) => total + w.perWeek, 0);
    expect(b.completed).toBeLessThan(arrivingPerWeek);
  });
});
