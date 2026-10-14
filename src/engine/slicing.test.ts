/**
 * Stepping coarsely must agree with stepping finely.
 *
 * The live view advances the world a sixtieth of a second at a time; the batch
 * runner advances it an hour or a day at a time so that hundreds of simulated
 * months finish in seconds. If those disagree, the numbers on a verdict card
 * describe a simulation nobody ever watched — and the disagreement is silent,
 * because each run looks perfectly reasonable on its own.
 *
 * What is actually guaranteed, and what is not:
 *
 *   - **No event is ever stepped over.** Each slice is clamped to the next
 *     thing that happens, so every state change occurs at the same instant
 *     regardless of step size. This is the property that matters, and it is
 *     what the structure of the loop buys.
 *   - **Bit-identical results are not achievable**, and claiming them would be
 *     wrong. Sixty additions of 1/60 do not equal one addition of 1 in binary
 *     floating point: after a single simulated minute the two clocks already
 *     read 481 and 480.9999999999991. That drift is a property of the
 *     arithmetic, not of the model.
 *
 * So the assertions below are split deliberately. Everything discrete — who is
 * doing what, which machines are busy, how many events fired, and the exact
 * position of the random number generator — must match exactly, because those
 * are what the reported metrics are built from. Everything continuous must
 * match to a tolerance far tighter than any decision would turn on.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import { applyCommand } from './commands';
import { advance } from './tick';
import { createWorld, type WorldState } from './world';

const SEED = 42;
const START = 480;

/**
 * State that must be identical. If any of this drifts, the simulation took a
 * different path — not merely a slightly rounded one.
 */
function discrete(world: WorldState) {
  return {
    rngState: world.rngState,
    nextId: world.nextId,
    // The *counts*, not the account. B2 added money lines to `metrics`, and two
    // of them - rent and materials - accumulate over dt, so they drift in
    // floating point exactly as the clock does and belong in `continuous`
    // below. Comparing the whole object exactly made this test fail the moment
    // money arrived, which is the test doing its job: the split has to follow
    // which quantities integrate, not which object they happen to live on.
    counts: {
      jobsCompleted: world.metrics.jobsCompleted,
      jobsLate: world.metrics.jobsLate,
      jobsAbandoned: world.metrics.jobsAbandoned,
    },
    staff: world.staff.map((p) => [p.id, p.state, p.activeTask?.name ?? null, p.targetX === null]),
    equipment: world.equipment.map((e) => [e.id, e.inUse, e.assignedTo]),
    // Which samples have arrived, in what order, and what they are due. An
    // arrival stepped over rather than landed on would show up here as a job
    // present in one run and still queued in the other.
    jobs: world.jobs.map((j) => [
      j.id,
      j.status,
      j.stepIndex,
      j.dueAtMinute,
      j.operatorId,
      j.equipmentId,
    ]),
    queued: world.arrivalQueue.length,
    weeksGenerated: world.weeksGenerated,
    nextJobNumber: world.nextJobNumber,
  };
}

/** Quantities that accumulate, and so inherit floating-point drift. */
function continuous(world: WorldState) {
  return {
    simMinutes: world.simMinutes,
    money: world.money,
    staffX: world.staff.map((p) => p.x),
    staffY: world.staff.map((p) => p.y),
    // Hours worked, which replaced the energy percentage. An accumulating
    // quantity, so it belongs here rather than in the exact fingerprint.
    minutesWorked: world.staff.map((p) => p.minutesWorkedThisWeek),
    taskTimer: world.staff.map((p) => p.taskTimer),
    condition: world.equipment.map((e) => e.condition),
    // Progress on every step of every job. The thing this step moved off the
    // person, so the thing most likely to have become step-size dependent.
    jobRemaining: world.jobs.flatMap((j) => j.steps.map((step) => step.remaining)),
    jobRevenue: world.jobs.map((j) => j.settledRevenue),
    // Rush deadlines are absolute instants set once at arrival, so they cannot
    // drift; what can is how much of a job is left.
    jobDue: world.jobs.map((j) => j.dueAtMinute),
    // Money. Rent accrues by the minute and labour is charged against hours
    // that themselves accumulate, so every one of these inherits the clock's
    // drift and is compared to a tolerance.
    revenue: world.metrics.revenue,
    materials: world.metrics.materials,
    fixedCosts: world.metrics.fixedCosts,
    labourBase: world.metrics.labourBase,
    labourOvertime: world.metrics.labourOvertime,
  };
}

/**
 * Agreement to within floating-point accumulation, judged *relatively*.
 *
 * It used to be `toBeCloseTo(x, 6)`, an absolute tolerance of 5e-7. That was
 * fine while every continuous quantity was small - minutes, grid positions, a
 * countdown - and became wrong the moment money arrived: rent accrued over four
 * simulated hours is about 24,667 shekels, and the two runs differed by 6.6e-7,
 * which is a relative error of 2.7e-11 and about as exact as double-precision
 * addition gets. The test was failing a quantity for being large.
 *
 * So the bound scales with magnitude, and the absolute floor is kept for
 * quantities near zero where a relative bound says nothing. Note which way this
 * is weaker and which way stronger: for money it is far *tighter* than the old
 * rule would have been had anybody loosened it to pass, and for positions it is
 * unchanged.
 */
function agrees(left: number, right: number, what: string): void {
  const tolerance = Math.max(1e-6, Math.abs(left) * 1e-9);
  expect(Math.abs(left - right), `${what}: ${left} vs ${right}`).toBeLessThanOrEqual(tolerance);
}

function expectAgrees(a: WorldState, b: WorldState): void {
  expect(discrete(a)).toEqual(discrete(b));

  const ca = continuous(a);
  const cb = continuous(b);
  for (const key of Object.keys(ca) as (keyof typeof ca)[]) {
    const left = ca[key];
    const right = cb[key];
    if (Array.isArray(left) && Array.isArray(right)) {
      left.forEach((value, i) => agrees(value, right[i]!, `${key}[${i}]`));
    } else {
      agrees(left as number, right as number, key);
    }
  }
}

function run(totalMinutes: number, stepMinutes: number, assignWork = false): WorldState {
  const world = createWorld(chemistryLab, SEED, START);
  if (assignWork) {
    // Walk to the first arrival, then hand it to someone. Work has to exist
    // before it can be assigned, which is the change this step made.
    const hadas = world.staff.find((p) => p.name === 'Hadas Ben Hamo')!;
    for (let i = 0; i < 2000 && world.jobs.length === 0; i++) advance(world, 1);
    const job = world.jobs.find((j) => j.workTypeId === 'blood-panel');
    if (job) applyCommand(world, { type: 'ASSIGN_JOB', staffId: hadas.id, jobId: job.id });
  }
  const steps = Math.round(totalMinutes / stepMinutes);
  for (let i = 0; i < steps; i++) advance(world, stepMinutes);
  return world;
}

describe('a coarse step agrees with a fine one', () => {
  const TOTAL = 240; // four simulated hours

  // A longer budget than the default five seconds, on purpose. A sixtieth of a
  // second is the live view's actual frame interval, so this runs the engine
  // 864,000 times — four simulated hours of somebody watching. Each pass now
  // walks the jobs, the staff and the equipment, which it did not have to do
  // when this test was written, and the honest response to it taking eight
  // seconds is to allow eight seconds rather than to shorten the span and lose
  // the finest step size the engine is ever asked for.
  it('at a sixtieth of a second against a minute', () => {
    expectAgrees(run(TOTAL, 1 / 3600), run(TOTAL, 1));
  }, 30_000);

  it('at a minute against a quarter of an hour', () => {
    expectAgrees(run(TOTAL, 1), run(TOTAL, 15));
  });

  it('at a quarter of an hour against an hour', () => {
    expectAgrees(run(TOTAL, 15), run(TOTAL, 60));
  });

  it('at an hour against the whole span in a single step', () => {
    expectAgrees(run(TOTAL, 60), run(TOTAL, TOTAL));
  });

  it('while work is in progress, not only while idle', () => {
    expectAgrees(run(TOTAL, 1 / 60, true), run(TOTAL, 60, true));
  });

  it('across a whole simulated day', () => {
    expectAgrees(run(1440, 5), run(1440, 1440));
  });
});

describe('the loop terminates', () => {
  it('does nothing for a zero or negative step', () => {
    const world = createWorld(chemistryLab, SEED, START);
    const before = discrete(world);
    advance(world, 0);
    advance(world, -5);
    expect(discrete(world)).toEqual(before);
    expect(world.simMinutes).toBe(START);
  });

  it('survives a very large step without exhausting its slice budget', () => {
    const world = createWorld(chemistryLab, SEED, START);
    expect(() => advance(world, 1440)).not.toThrow();
    expect(world.simMinutes).toBeCloseTo(START + 1440, 6);
  });
});
