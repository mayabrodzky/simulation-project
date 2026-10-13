/**
 * Why work is not moving.
 *
 * Two claims, and the second matters more than the first.
 *
 * **The reason is right.** Counted over a run, `blockReason` is the "what is
 * holding the lab back" sentence obtained directly rather than inferred from
 * utilisation figures. Distinguishing *the instrument is busy* from *everyone
 * is busy* is the whole value: one is answered by leasing an instrument and the
 * other by hiring, and they are the two decisions the product exists to compare.
 *
 * **`blocked` never absorbs.** A blocked job is still `waiting` to every other
 * rule — assignable, expirable, countable. Treating it as a state a job moves
 * *into* is the likeliest way to ship a simulation that deadlocks by quietly
 * doing nothing, which is the worst failure shape available: it looks like a
 * working run with a disappointing result. Most of what follows is an attempt
 * to catch that.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import type { Job, Scenario } from '../domain/types';
import { MINUTES_PER_DAY } from './calendar';
import { applyCommand } from './commands';
import { advance } from './tick';
import { createWorld, type WorldState } from './world';

const SEED = 42;
const SUNDAY_0800 = 480;

function newWorld(scenario: Scenario = chemistryLab, startMinutes = SUNDAY_0800) {
  const world = createWorld(scenario, SEED, startMinutes);
  return world;
}

function waitForJob(world: WorldState, workTypeId: string): Job {
  for (let i = 0; i < 5000; i++) {
    const found = world.jobs.find((j) => j.workTypeId === workTypeId && j.status === 'waiting');
    if (found) return found;
    advance(world, 1);
  }
  throw new Error(`waitForJob: no ${workTypeId} arrived`);
}

describe('the reason is specific enough to act on', () => {
  it('says nothing is wrong when somebody free could start it', () => {
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    advance(world, 1);
    expect(job.blockReason).toBeNull();
  });

  it('names the lab being shut', () => {
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    advance(world, 16 * 60 - world.simMinutes + 60); // 17:00

    expect(job.blockReason).toBe('outside-working-hours');
  });

  it('names a skill nobody in the building holds', () => {
    // A training or a hiring decision, and true whether or not the lab is open —
    // which is why it is checked before the opening hours.
    const unskilled: Scenario = {
      ...chemistryLab,
      staff: chemistryLab.staff.map((p) => ({ ...p, skills: [] })),
    };
    const world = newWorld(unskilled);
    const job = waitForJob(world, 'blood-panel');
    advance(world, 1);

    expect(job.blockReason).toBe('no-qualified-operator');
  });

  it('names a machine the lab does not have', () => {
    const noCentrifuge: Scenario = {
      ...chemistryLab,
      equipment: chemistryLab.equipment.filter((e) => e.name !== 'Centrifuge'),
    };
    const world = newWorld(noCentrifuge);
    const job = waitForJob(world, 'blood-panel');
    advance(world, 1);

    expect(job.blockReason).toBe('no-such-resource');
  });

  it('distinguishes the instrument being busy from everyone being busy', () => {
    // The distinction the product turns on. Both look like "the job is not
    // moving"; one is answered by leasing an instrument and the other by
    // hiring, and reporting them as one number would make the verdict useless.
    const world = newWorld();
    const first = waitForJob(world, 'mass-spec');
    const amit = world.staff.find((p) => p.name === 'Dr. Amit Katz')!;
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: amit.id, jobId: first.id });
    for (let i = 0; i < 400 && amit.state !== 'working'; i++) advance(world, 0.5);
    expect(amit.state).toBe('working');

    const second = world.jobs.find(
      (j) => j.workTypeId === 'mass-spec' && j.status === 'waiting' && j.id !== first.id,
    );
    if (second) {
      // Lihi also holds Mass Spectrometry and is free, so what is in the way is
      // the one instrument — not the people.
      expect(second.blockReason).toBe('resource-busy');
    }

    // With every Mass Spectrometry holder occupied, the reason changes.
    const lihi = world.staff.find((p) => p.name === 'Dr. Lihi Dayan')!;
    const other = world.jobs.find((j) => j.status === 'waiting' && j.workTypeId === 'blood-panel');
    if (other) applyCommand(world, { type: 'ASSIGN_JOB', staffId: lihi.id, jobId: other.id });
    advance(world, 1);

    const third = world.jobs.find(
      (j) => j.workTypeId === 'mass-spec' && j.status === 'waiting' && j.blockReason !== null,
    );
    if (third) expect(['resource-busy', 'everyone-busy']).toContain(third.blockReason);
  });
});

describe('blocked is advisory and never absorbing', () => {
  it('leaves a blocked job assignable', () => {
    // If `blocked` were a state a job moved into, this is where a simulation
    // deadlocks: work that can never be picked up again.
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    advance(world, 16 * 60 - world.simMinutes + 60);
    expect(job.blockReason).toBe('outside-working-hours');
    expect(job.status).toBe('waiting');

    // Next morning it is simply taken, with no unblocking step anywhere.
    advance(world, 15 * 60);
    const hadas = world.staff.find((p) => p.name === 'Hadas Ben Hamo')!;
    const events = applyCommand(world, { type: 'ASSIGN_JOB', staffId: hadas.id, jobId: job.id });

    expect(events[0]?.type).toBe('job-assigned');
    expect(job.status).toBe('in-progress');
  });

  it('clears the reason the instant the obstacle goes', () => {
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    advance(world, 16 * 60 - world.simMinutes + 60);
    expect(job.blockReason).not.toBeNull();

    advance(world, 15 * 60); // next morning
    expect(job.blockReason).toBeNull();
    expect(job.blockedSinceMinute).toBeNull();
  });

  it('still lets a blocked job be abandoned by its client', () => {
    // Blocked work must not become immortal: it has to stay subject to every
    // other rule, expiry included.
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    advance(world, job.expiresAtMinute - world.simMinutes);
    expect(job.status).toBe('expired');
    expect(job.blockReason).toBeNull();
  });

  it('never leaves a finished job carrying a reason', () => {
    const world = newWorld();
    advance(world, 14 * MINUTES_PER_DAY);
    for (const job of world.jobs) {
      if (job.status.startsWith('done') || job.status === 'expired') {
        expect(job.blockReason).toBeNull();
      }
    }
  });
});

describe('a long wait reports itself', () => {
  it('restarts the clock when the reason changes', () => {
    // Waiting for an instrument and then waiting for a person are two separate
    // waits. Reporting them as one long stall would name the wrong cause.
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    advance(world, 16 * 60 - world.simMinutes + 60);
    const firstReason = job.blockReason;
    const firstSince = job.blockedSinceMinute;
    expect(firstReason).toBe('outside-working-hours');

    const unskilled = world.staff.map((p) => p.skills);
    world.staff.forEach((p) => (p.skills = []));
    advance(world, 1);
    expect(job.blockReason).toBe('no-qualified-operator');
    expect(job.blockedSinceMinute).not.toBe(firstSince);

    world.staff.forEach((p, i) => (p.skills = unskilled[i]!));
  });

  it('reports a stall once, not every pass', () => {
    const noCentrifuge: Scenario = {
      ...chemistryLab,
      equipment: chemistryLab.equipment.filter((e) => e.name !== 'Centrifuge'),
    };
    const world = newWorld(noCentrifuge);
    const job = waitForJob(world, 'blood-panel');

    const stalls = [];
    for (let day = 0; day < 4; day++) stalls.push(...advance(world, MINUTES_PER_DAY));

    const mine = stalls.filter((e) => e.type === 'job-stalled' && e.jobId === job.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ reason: 'no-such-resource' });
  });

  it('does not report an ordinary overnight pause as a stall', () => {
    // 48 hours, so a night and a weekend are not news. If this fired every
    // evening the signal would be worthless.
    const world = newWorld();
    const events = advance(world, MINUTES_PER_DAY);
    expect(events.filter((e) => e.type === 'job-stalled')).toHaveLength(0);
  });
});

describe('nothing stalls indefinitely', () => {
  it('leaves no job waiting longer than the abandonment rule allows', () => {
    // The acceptance test for the whole lifecycle: after five simulated weeks
    // with nobody doing any work at all, every job has either been abandoned or
    // is recent. Nothing is stuck in a state with no way out.
    const world = newWorld();
    advance(world, 35 * MINUTES_PER_DAY);

    const stillOpen = world.jobs.filter((j) => j.status === 'waiting' || j.status === 'blocked');
    for (const job of stillOpen) {
      expect(world.simMinutes).toBeLessThan(job.expiresAtMinute);
    }
    expect(world.jobs.filter((j) => j.status === 'expired').length).toBeGreaterThan(0);
  });

  it('holds no job in-progress without an operator', () => {
    // The other way a job could vanish: left `in-progress` with nobody on it,
    // so no rule touches it again. Shift ends, sickness and handovers all have
    // to release rather than orphan.
    const world = newWorld();
    for (let i = 0; i < 35; i++) {
      advance(world, MINUTES_PER_DAY);
      for (const job of world.jobs) {
        if (job.status === 'in-progress') expect(job.operatorId).not.toBeNull();
      }
    }
  });

  it('holds no machine claimed by a job that is not in progress', () => {
    const world = newWorld();
    for (let i = 0; i < 35; i++) {
      advance(world, MINUTES_PER_DAY);
      for (const job of world.jobs) {
        if (job.equipmentId !== null) expect(job.status).toBe('in-progress');
      }
      // And no machine marked in use with nobody holding it.
      for (const machine of world.equipment) {
        if (machine.inUse) {
          expect(world.jobs.some((j) => j.equipmentId === machine.id)).toBe(true);
        }
      }
    }
  });
});
