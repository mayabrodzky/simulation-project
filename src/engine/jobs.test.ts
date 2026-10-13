/**
 * Tests for the life of a job.
 *
 * The claim this step makes is narrow and worth stating precisely: because
 * progress is held as `remaining` on the job, an interruption costs nothing and
 * needs no code. Most of what follows is an attempt to break that — stop a job
 * halfway, take the person away, give it to someone else — and check that the
 * total work done comes out the same.
 *
 * The rest covers the lifecycle the queue needs in order to be meaningful: a
 * machine can only be used by one job at a time, a job finished after its
 * deadline knows it was late, and a job nobody ever does is eventually
 * abandoned rather than waiting forever.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import type { Job, Staff } from '../domain/types';
import { applyCommand } from './commands';
import { MINUTES_PER_DAY } from './calendar';
import { canOperate } from './jobs';
import { listAssignableJobs } from './queries';
import { advance } from './tick';
import { createWorld, type WorldState } from './world';

const SEED = 42;
const SUNDAY_0800 = 480;

function newWorld(startMinutes = SUNDAY_0800): WorldState {
  const world = createWorld(chemistryLab, SEED, startMinutes);
  return world;
}

const person = (world: WorldState, name: string): Staff =>
  world.staff.find((p) => p.name === name)!;

/**
 * Someone who can actually be given work.
 *
 * The scenario rosters only the first `staffOnShiftCount` of eight, so picking
 * a name from the list is not enough — an off-duty person silently refuses
 * every assignment and the test passes for the wrong reason. That has now
 * caught me out three times in three files, so it throws with the reason
 * instead of failing with a mystery.
 */
function available(world: WorldState, name: string): Staff {
  const found = person(world, name);
  if (found.state !== 'idle') {
    throw new Error(
      `${name} is "${found.state}", not available: the scenario rosters only ` +
        `the first ${world.tuning.staffOnShiftCount} of ${world.staff.length}`,
    );
  }
  return found;
}

/** Walks the clock until a job of this kind has arrived, then returns it. */
function waitForJob(world: WorldState, workTypeId: string): Job {
  for (let i = 0; i < 5000; i++) {
    const found = world.jobs.find((j) => j.workTypeId === workTypeId && j.status === 'waiting');
    if (found) return found;
    advance(world, 1);
  }
  throw new Error(`waitForJob: no ${workTypeId} arrived`);
}

/** Hands a blood panel to Hadas, who holds both skills it needs. */
function assignBloodPanel(world: WorldState, to = 'Hadas Ben Hamo') {
  const job = waitForJob(world, 'blood-panel');
  const operator = available(world, to);
  const events = applyCommand(world, {
    type: 'ASSIGN_JOB',
    staffId: operator.id,
    jobId: job.id,
  });
  return { job, operator, events };
}

/** Hands-on minutes still to do across every remaining step. */
const workLeft = (job: Job): number =>
  job.steps.slice(job.stepIndex).reduce((total, step) => total + step.remaining, 0);

const totalWork = (job: Job): number => job.steps.reduce((total, step) => total + step.total, 0);

describe('taking a job on', () => {
  it('attaches both sides of the pairing, and only one of them', () => {
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);

    expect(job.status).toBe('in-progress');
    expect(job.operatorId).toBe(operator.id);
    expect(operator.jobId).toBe(job.id);
    // Pinned, because a person chose it. B3's dispatcher must not override it.
    expect(job.pinnedStaffId).toBe(operator.id);
    expect(world.jobs.filter((j) => j.operatorId === operator.id)).toHaveLength(1);
  });

  it('sends them walking rather than starting work where they stand', () => {
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);
    const centrifuge = world.equipment.find((e) => e.name === 'Centrifuge')!;

    expect(operator.state).toBe('idle');
    expect(operator.targetX).toBe(centrifuge.x);
    expect(workLeft(job)).toBe(totalWork(job));
  });

  it('starts the work on arrival, and not before', () => {
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);
    const centrifuge = world.equipment.find((e) => e.name === 'Centrifuge')!;

    for (let i = 0; i < 500 && operator.state !== 'working'; i++) advance(world, 0.5);

    expect(operator.state).toBe('working');
    expect(job.equipmentId).toBe(centrifuge.id);
    expect(centrifuge.inUse).toBe(true);
    expect(centrifuge.assignedTo).toBe(operator.id);
  });

  it('refuses a job to someone who cannot do it, with a reason not a sentence', () => {
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    // Alex holds Spectrophotometry alone; a blood panel starts on a centrifuge.
    const alex = available(world, 'Alex Tom');

    const events = applyCommand(world, { type: 'ASSIGN_JOB', staffId: alex.id, jobId: job.id });

    expect(events).toEqual([{ type: 'rejected', reason: 'unqualified', detail: alex.name }]);
    expect(job.status).toBe('waiting');
    expect(alex.jobId).toBeNull();
  });

  it('refuses a second job to someone already working', () => {
    const world = newWorld();
    const { operator } = assignBloodPanel(world);
    const another = waitForJob(world, 'blood-panel');

    const events = applyCommand(world, {
      type: 'ASSIGN_JOB',
      staffId: operator.id,
      jobId: another.id,
    });

    expect(events).toEqual([{ type: 'rejected', reason: 'not-idle', detail: operator.name }]);
  });

  it('refuses a job that is no longer open', () => {
    const world = newWorld();
    const { job } = assignBloodPanel(world);
    const nina = person(world, 'Nina Zur');

    const events = applyCommand(world, { type: 'ASSIGN_JOB', staffId: nina.id, jobId: job.id });

    expect(events).toEqual([{ type: 'rejected', reason: 'job-not-open', detail: job.name }]);
  });
});

describe('an interruption costs nothing', () => {
  it('leaves the remaining counters exactly where they were', () => {
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);

    for (let i = 0; i < 500 && operator.state !== 'working'; i++) advance(world, 0.5);
    advance(world, 10);
    const leftWhenInterrupted = workLeft(job);
    // Partway through the first step, which is the interesting moment.
    expect(leftWhenInterrupted).toBeLessThan(totalWork(job));
    expect(leftWhenInterrupted).toBeGreaterThan(0);

    applyCommand(world, { type: 'SET_STATUS', staffId: operator.id, sick: true });

    expect(job.status).toBe('waiting');
    expect(job.operatorId).toBeNull();
    expect(operator.jobId).toBeNull();
    expect(workLeft(job)).toBe(leftWhenInterrupted);
  });

  it('gives the machine back, so nothing is held by a person who has gone', () => {
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);
    for (let i = 0; i < 500 && operator.state !== 'working'; i++) advance(world, 0.5);
    const centrifuge = world.equipment.find((e) => e.id === job.equipmentId)!;
    expect(centrifuge.inUse).toBe(true);

    applyCommand(world, { type: 'SET_STATUS', staffId: operator.id, sick: true });

    expect(centrifuge.inUse).toBe(false);
    expect(centrifuge.assignedTo).toBeNull();
    expect(job.equipmentId).toBeNull();
  });

  it('lets someone else finish it, with no work lost or repeated', () => {
    // The whole argument for remaining counters, stated as a sum: however many
    // times a job changes hands, the hands-on minutes spent on it add up to
    // what the recipe asked for.
    //
    // Handed over partway through the *second* step, because only Hadas holds
    // both of this job's skills — so a handover during the centrifuge step has
    // nobody to hand to. Which is itself the point: who can take a job depends
    // on how far through it is.
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);
    const expected = totalWork(job);

    for (let i = 0; i < 5000 && job.stepIndex < 1; i++) advance(world, 0.5);
    for (let i = 0; i < 500 && operator.state !== 'working'; i++) advance(world, 0.5);
    advance(world, 5);

    const doneBeforeHandover = expected - workLeft(job);
    expect(doneBeforeHandover).toBeGreaterThan(job.steps[0]!.total);

    applyCommand(world, { type: 'SET_STATUS', staffId: operator.id, sick: true });
    expect(expected - workLeft(job)).toBe(doneBeforeHandover);

    const finisher = available(world, 'Dr. Amit Katz');
    expect(canOperate(finisher, job)).toBe(true);
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: finisher.id, jobId: job.id });

    for (let i = 0; i < 5000 && job.completedAtMinute === null; i++) advance(world, 0.5);

    expect(job.completedAtMinute).not.toBeNull();
    expect(workLeft(job)).toBe(0);
    expect(job.steps.every((step) => step.remaining === 0)).toBe(true);
    // The microscope step was finished by someone who cannot use a centrifuge.
    expect(finisher.skills).not.toContain('Centrifuge Usage');
  });

  it('hands a job on when the next step needs a different specialist', () => {
    // Amir holds Centrifuge Usage alone. A blood panel is centrifuge then
    // microscopy, so he can *start* it and cannot finish it — and when his step
    // is done the job goes back to the queue part-finished rather than stalling
    // on him. (This was Dana until the roster was aligned with the spec, which
    // gave her Microscopy as well.)
    //
    // This is the behaviour that makes the scenario's work reachable at all.
    // Requiring one person to hold every skill a job needs left 96 of the 186
    // offered hours a week impossible, because nobody rostered holds both PCR
    // Operation and Spectrophotometry, or all three skills a cell culture
    // needs.
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    const starter = available(world, 'Amir Barzilay');
    expect(starter.skills).toContain('Centrifuge Usage');
    expect(starter.skills).not.toContain('Microscopy');

    expect(applyCommand(world, { type: 'ASSIGN_JOB', staffId: starter.id, jobId: job.id })).toEqual(
      [expect.objectContaining({ type: 'job-assigned' })],
    );

    const events = [];
    for (let i = 0; i < 5000 && job.stepIndex < 1; i++) events.push(...advance(world, 0.5));

    expect(job.stepIndex).toBe(1);
    expect(job.status).toBe('waiting');
    expect(job.operatorId).toBeNull();
    expect(starter.jobId).toBeNull();
    expect(job.steps[0]!.remaining).toBe(0);
    expect(job.steps[1]!.remaining).toBe(job.steps[1]!.total);

    const handover = events.find((e) => e.type === 'job-handed-over');
    expect(handover).toMatchObject({ jobId: job.id, nextStep: 'microscopy' });

    // And someone who cannot use a centrifuge finishes it.
    const finisher = available(world, 'Dr. Amit Katz');
    expect(finisher.skills).not.toContain('Centrifuge Usage');
    expect(canOperate(finisher, job)).toBe(true);
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: finisher.id, jobId: job.id });
    for (let i = 0; i < 5000 && job.completedAtMinute === null; i++) advance(world, 0.5);
    expect(job.status).toBe('done-on-time');
  });

  it('keeps the operator when they can do the next step too', () => {
    // Hadas holds both of a blood panel's skills, so no handover happens and
    // she walks straight from the centrifuge to the microscope.
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);

    const events = [];
    for (let i = 0; i < 5000 && job.stepIndex < 1; i++) events.push(...advance(world, 0.5));

    expect(job.stepIndex).toBe(1);
    expect(job.status).toBe('in-progress');
    expect(job.operatorId).toBe(operator.id);
    expect(events.some((e) => e.type === 'job-handed-over')).toBe(false);
  });
});

describe('every kind of work the lab sells can actually be done', () => {
  it('has a rostered person able to start, and to finish, each work type', () => {
    // The regression guard on the modelling error above: if qualification ever
    // goes back to requiring one person per whole job, three of these four fail
    // and the lab silently becomes limited by one technician's skills instead
    // of by an instrument.
    const world = newWorld();
    const rostered = world.staff.filter((p) => p.state !== 'off');

    for (const workType of world.workTypes) {
      for (const step of workType.steps) {
        const canDo = rostered.filter(
          (p) => step.skillRequired === null || p.skills.includes(step.skillRequired),
        );
        expect(
          canDo.length,
          `${workType.name} / ${step.capability} (${step.skillRequired})`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe('finishing', () => {
  it('pays, frees the person and the machine, and reports the facts', () => {
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);
    const moneyBefore = world.money;

    const events = [];
    for (let i = 0; i < 5000 && job.completedAtMinute === null; i++) {
      events.push(...advance(world, 0.5));
    }

    expect(job.status).toBe('done-on-time');
    expect(job.settledRevenue).toBe(job.basePrice);
    expect(world.money).toBe(moneyBefore + job.basePrice);
    expect(world.metrics.tasksCompleted).toBe(1);

    expect(job.operatorId).toBeNull();
    expect(operator.jobId).toBeNull();
    expect(operator.state).toBe('idle');
    expect(job.equipmentId).toBeNull();
    expect(world.equipment.every((e) => !e.inUse)).toBe(true);

    const completed = events.find((e) => e.type === 'job-completed');
    expect(completed).toMatchObject({ jobId: job.id, onTime: true, minutesLate: 0 });
  });

  it('works through every step in order', () => {
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);
    const visited: string[] = [];

    for (let i = 0; i < 5000 && job.completedAtMinute === null; i++) {
      advance(world, 0.5);
      const step = job.steps[job.stepIndex];
      if (operator.state === 'working' && step && visited.at(-1) !== step.capability) {
        visited.push(step.capability);
      }
    }

    expect(visited).toEqual(['centrifuge', 'microscopy']);
  });

  it('knows it was late when it finishes past its deadline', () => {
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);

    // Push the deadline into the past rather than waiting two working days,
    // which the engine cannot tell apart from a genuinely late finish.
    job.dueAtMinute = world.simMinutes - 1;

    for (let i = 0; i < 5000 && job.completedAtMinute === null; i++) advance(world, 0.5);

    expect(job.status).toBe('done-late');
    expect(operator.jobId).toBeNull();
    // Four fifths of the price. This asserted full payment while partial credit
    // was still to come; settlement.test.ts now owns the arithmetic.
    expect(job.settledRevenue).toBeCloseTo(job.basePrice * 0.8, 6);
  });
});

describe('a machine serves one job at a time', () => {
  it('makes the second job wait rather than sharing the instrument', () => {
    const world = newWorld();
    const first = waitForJob(world, 'mass-spec');
    const amit = available(world, 'Dr. Amit Katz');
    const lihi = available(world, 'Dr. Lihi Dayan');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: amit.id, jobId: first.id });

    const second = world.jobs.find(
      (j) => j.workTypeId === 'mass-spec' && j.status === 'waiting' && j.id !== first.id,
    );
    if (!second) return; // only one mass-spec job in the queue this early

    applyCommand(world, { type: 'ASSIGN_JOB', staffId: lihi.id, jobId: second.id });
    for (let i = 0; i < 400; i++) advance(world, 0.5);

    const spectrometer = world.equipment.find((e) => e.name === 'Mass Spectrometer')!;
    // One of them holds it; the other is standing next to it, waiting.
    expect(spectrometer.inUse).toBe(true);
    const holders = [first, second].filter((j) => j.equipmentId === spectrometer.id);
    expect(holders).toHaveLength(1);
    expect([amit, lihi].filter((p) => p.state === 'working')).toHaveLength(1);
  });
});

describe('a job nobody does is eventually abandoned', () => {
  it('expires a fixed number of working days past the deadline', () => {
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    expect(job.expiresAtMinute).toBeGreaterThan(job.dueAtMinute);

    advance(world, job.expiresAtMinute - world.simMinutes - 1);
    expect(job.status).toBe('waiting');

    advance(world, 1);
    expect(job.status).toBe('expired');
    // Close rather than exact: the clock accumulates float drift over
    // thousands of additions, which is why hasReached exists at all.
    expect(job.completedAtMinute).toBeCloseTo(job.expiresAtMinute, 6);
  });

  it('pays nothing for it, and does not charge for it either', () => {
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    const moneyBefore = world.money;

    advance(world, job.expiresAtMinute - world.simMinutes);

    expect(job.settledRevenue).toBe(0);
    expect(world.money).toBe(moneyBefore);
    expect(world.metrics.tasksFailed).toBeGreaterThan(0);
  });

  it('reports it as an event carrying facts', () => {
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    const events = advance(world, job.expiresAtMinute - world.simMinutes);

    const expired = events.find((e) => e.type === 'job-expired' && e.jobId === job.id);
    expect(expired).toMatchObject({ name: job.name, workingDaysLate: 3 });
  });

  it('never abandons work someone is doing', () => {
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);
    job.expiresAtMinute = world.simMinutes + 1;

    for (let i = 0; i < 200 && operator.state !== 'working'; i++) advance(world, 0.5);
    advance(world, 5);

    expect(job.status).not.toBe('expired');
  });

  it('stops the queue growing without limit', () => {
    // Nothing picks work up on its own yet, so every job eventually expires.
    // Without that the backlog would grow forever and no run could be measured.
    const world = newWorld();
    advance(world, 28 * MINUTES_PER_DAY);

    const open = world.jobs.filter((j) => j.status === 'waiting' || j.status === 'blocked');
    const expired = world.jobs.filter((j) => j.status === 'expired');
    expect(expired.length).toBeGreaterThan(0);
    // The open queue holds only recent arrivals, not a month of them.
    expect(open.length).toBeLessThan(world.jobs.length / 2);
  });
});

describe('a scheduled instant is never missed by a hair', () => {
  it('abandons a job whether or not the clock lands on the instant exactly', () => {
    // A real bug, found by a test that changed nothing but the slice pattern.
    // The loop clamps a slice to end exactly on a scheduled instant, but
    // simMinutes + slice is not bit-identical to that instant after thousands
    // of additions: the clock reached 11,039.999999999998 for a job due to be
    // abandoned at 11,040, so it was never abandoned.
    //
    // The failure depends on the history of slice lengths, which means the same
    // scheduled event fires in one run and is skipped in another. That is the
    // step-size dependence the whole slice loop exists to remove, reappearing
    // two ulps below the threshold.
    //
    // Originally exposed by silencing the old emergencies, which changed the
    // slice pattern. Emergencies are gone, so the pattern is varied directly:
    // the same instant reached in one step and in many.
    for (const step of [1, 37, 1440]) {
      const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
      const job = waitForJob(world, 'blood-panel');

      const target = job.expiresAtMinute;
      while (world.simMinutes < target - 1e-9) {
        advance(world, Math.min(step, target - world.simMinutes));
      }

      expect(job.status, `step ${step}`).toBe('expired');
    }
  });

  it('treats finishing exactly on the deadline as on time', () => {
    const world = newWorld();
    const { job, operator } = assignBloodPanel(world);
    for (let i = 0; i < 5000 && job.completedAtMinute === null; i++) advance(world, 0.5);

    // The boundary belongs to the client: due at 16:00 means 16:00 is fine.
    expect(job.status).toBe('done-on-time');
    expect(operator.jobId).toBeNull();
  });
});

describe('a part-finished job says so', () => {
  it('marks a single-step job that was started and put down', () => {
    // Review read a part-finished mass-spec job as having lost its progress,
    // because the dialogue showed no "part-finished" tag. The progress was
    // there — the tag was lying.
    //
    // `partlyDone` was `stepIndex > 0`, which detects progress only across a
    // step *boundary*. Mass spectrometry has one step, so a job 86% finished
    // reported itself as untouched. The one signal available for "has anyone
    // worked on this?" was wrong for a quarter of the work the lab sells.
    // Opened on Thursday morning and walked to twenty minutes before closing,
    // rather than created at 15:40 — a fresh world has no arrivals yet, and
    // `waitForJob` would then advance past four o'clock looking for one, which
    // made the later advance negative and silently did nothing.
    //
    // Twenty minutes is deliberate: mass-spec preparation is a full hour, so it
    // cannot finish. Given longer it would hand over to the instrument and keep
    // running overnight, which is a different thing with its own tests.
    const closing = 4 * MINUTES_PER_DAY + 16 * 60;
    const world = newWorld(4 * MINUTES_PER_DAY + 8 * 60);
    advance(world, closing - 20 - world.simMinutes);

    const job = world.jobs.find((j) => j.workTypeId === 'mass-spec' && j.status === 'waiting');
    expect(job, 'no mass-spec job waiting by Thursday afternoon').toBeDefined();
    const amit = available(world, 'Dr. Amit Katz');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: amit.id, jobId: job!.id });

    // Up to closing time, which sets the job down mid-step.
    advance(world, closing - world.simMinutes);

    expect(job!.stepIndex).toBe(0);
    expect(job!.status).toBe('waiting');
    const step = job!.steps[0]!;
    expect(step.remaining).toBeGreaterThan(0);
    expect(step.remaining).toBeLessThan(step.total);

    const lihi = world.staff.find((p) => p.name === 'Dr. Lihi Dayan')!;
    const row = listAssignableJobs(world, lihi).find((r) => r.id === job!.id)!;
    expect(row.minutesOfWork).toBeCloseTo(step.remaining, 6);
    expect(row.partlyDone).toBe(true);
  });

  it('does not mark a job nobody has touched', () => {
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    const hadas = available(world, 'Hadas Ben Hamo');

    const row = listAssignableJobs(world, hadas).find((r) => r.id === job.id)!;
    expect(row.partlyDone).toBe(false);
  });

  it('marks a job whose first step is complete', () => {
    // Given to Amir, who can centrifuge but not use a microscope, so the job
    // is handed back to the queue after step one and is visible there.
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    const starter = available(world, 'Amir Barzilay');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: starter.id, jobId: job.id });
    for (let i = 0; i < 5000 && job.stepIndex < 1; i++) advance(world, 0.5);

    expect(job.stepIndex).toBe(1);
    expect(job.status).toBe('waiting');
    const row = listAssignableJobs(world, starter).find((r) => r.id === job.id)!;
    expect(row.partlyDone).toBe(true);
  });
});
