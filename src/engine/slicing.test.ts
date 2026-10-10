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
    metrics: world.metrics,
    staff: world.staff.map((p) => [
      p.id,
      p.state,
      p.taskStep,
      p.activeTask?.name ?? null,
      p.targetX === null,
    ]),
    equipment: world.equipment.map((e) => [e.id, e.inUse, e.assignedTo]),
    emergencies: world.emergencies.map((e) => [e.id, e.status]),
    // Which samples have arrived, in what order, and what they are due. An
    // arrival stepped over rather than landed on would show up here as a job
    // present in one run and still queued in the other.
    jobs: world.jobs.map((j) => [j.id, j.status, j.stepIndex, j.dueAtMinute]),
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
    energy: world.staff.map((p) => p.energy),
    taskTimer: world.staff.map((p) => p.taskTimer),
    condition: world.equipment.map((e) => e.condition),
    deadlines: world.emergencies.map((e) => e.timeLimit),
  };
}

function expectAgrees(a: WorldState, b: WorldState): void {
  expect(discrete(a)).toEqual(discrete(b));

  const ca = continuous(a);
  const cb = continuous(b);
  for (const key of Object.keys(ca) as (keyof typeof ca)[]) {
    const left = ca[key];
    const right = cb[key];
    if (Array.isArray(left) && Array.isArray(right)) {
      left.forEach((value, i) => expect(value).toBeCloseTo(right[i]!, 6));
    } else {
      expect(left as number).toBeCloseTo(right as number, 6);
    }
  }
}

function run(totalMinutes: number, stepMinutes: number, assignWork = false): WorldState {
  const world = createWorld(chemistryLab, SEED, START);
  if (assignWork) {
    const hadas = world.staff.find((p) => p.name === 'Hadas Ben Hamo')!;
    const task = world.tasks.find((t) => t.name === 'Blood Sample Analysis')!;
    applyCommand(world, { type: 'ASSIGN_TASK', staffId: hadas.id, taskId: task.id });
  }
  const steps = Math.round(totalMinutes / stepMinutes);
  for (let i = 0; i < steps; i++) advance(world, stepMinutes);
  return world;
}

describe('a coarse step agrees with a fine one', () => {
  const TOTAL = 240; // four simulated hours

  it('at a sixtieth of a second against a minute', () => {
    expectAgrees(run(TOTAL, 1 / 3600), run(TOTAL, 1));
  });

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
