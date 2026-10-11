/**
 * Tests for the working day.
 *
 * The claim A1 made and did not deliver: work in progress at closing time
 * pauses, the operator goes home, and the machine is released. The third part
 * is the one with consequences — a machine held overnight reads as fully
 * utilised with nobody in the building, and an evening shift then adds no
 * capacity because the day shift never gives the instruments back. That is
 * decision C of the four the product exists to evaluate.
 *
 * The second group covers the untangling that made this possible: `rostered`
 * says whether someone is employed on this shift, and the clock says whether
 * they are in the building. Conflating them is why clearing "sick" used to put
 * an off-duty person back on the floor.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import type { Job, Staff } from '../domain/types';
import { MINUTES_PER_DAY } from './calendar';
import { applyCommand } from './commands';
import { isLabOpen } from './shifts';
import { advance } from './tick';
import { createWorld, type WorldState } from './world';

const SEED = 42;
const SUNDAY_0800 = 480;
const SUNDAY_1600 = 960;
const { shift } = chemistryLab.calendar;

function newWorld(startMinutes = SUNDAY_0800): WorldState {
  const world = createWorld(chemistryLab, SEED, startMinutes);
  // Emergencies are the pre-job path, deleted in A6; left running they bury
  // the figures being measured. See jobs.test.ts.
  world.tuning = { ...world.tuning, emergencyRatePerMinute: 0 };
  world.nextEmergencyAtMinute = Infinity;
  return world;
}

const person = (world: WorldState, name: string): Staff =>
  world.staff.find((p) => p.name === name)!;

function waitForJob(world: WorldState, workTypeId: string): Job {
  for (let i = 0; i < 5000; i++) {
    const found = world.jobs.find((j) => j.workTypeId === workTypeId && j.status === 'waiting');
    if (found) return found;
    advance(world, 1);
  }
  throw new Error(`waitForJob: no ${workTypeId} arrived`);
}

/**
 * Puts Hadas on a blood panel and runs until she is actually working.
 *
 * `atMinute` defaults to twenty minutes before closing, because a blood panel
 * takes 45 minutes and anything started in the morning finishes long before
 * 16:00 — so a test about closing time needs work that is genuinely still in
 * progress when the lab shuts.
 */
function workingOnBloodPanel(world: WorldState, atMinute = SUNDAY_1600 - 20) {
  if (atMinute > world.simMinutes) advance(world, atMinute - world.simMinutes);

  const job = waitForJob(world, 'blood-panel');
  const operator = person(world, 'Hadas Ben Hamo');
  applyCommand(world, { type: 'ASSIGN_JOB', staffId: operator.id, jobId: job.id });
  for (let i = 0; i < 100 && operator.state !== 'working'; i++) advance(world, 0.5);
  expect(operator.state).toBe('working');
  return { job, operator };
}

describe('the clock decides who is in the building', () => {
  it('opens with an empty floor outside working hours', () => {
    // A demo opened at two in the morning used to show a full lab, because
    // nothing had ever asked the calendar.
    const nightWorld = newWorld(2 * 60);
    expect(isLabOpen(nightWorld)).toBe(false);
    expect(nightWorld.staff.every((p) => p.state === 'off')).toBe(true);
  });

  it('opens with the rostered people in when the lab is open', () => {
    const world = newWorld(SUNDAY_0800);
    expect(isLabOpen(world)).toBe(true);
    expect(world.staff.filter((p) => p.state !== 'off')).toHaveLength(
      world.tuning.staffOnShiftCount,
    );
  });

  it('sends everybody home at closing time, to the minute', () => {
    const world = newWorld(SUNDAY_0800);
    advance(world, SUNDAY_1600 - world.simMinutes - 1);
    expect(world.staff.some((p) => p.state !== 'off')).toBe(true);

    advance(world, 1);
    expect(world.simMinutes).toBeCloseTo(SUNDAY_1600, 6);
    expect(world.staff.every((p) => p.state === 'off')).toBe(true);
  });

  it('brings them back the next morning', () => {
    const world = newWorld(SUNDAY_0800);
    advance(world, MINUTES_PER_DAY); // Monday 08:00
    expect(world.staff.filter((p) => p.state !== 'off')).toHaveLength(
      world.tuning.staffOnShiftCount,
    );
  });

  it('leaves the floor empty all weekend', () => {
    const world = newWorld(SUNDAY_0800);
    advance(world, 4 * MINUTES_PER_DAY + 9 * 60); // Thursday 17:00
    expect(world.staff.every((p) => p.state === 'off')).toBe(true);

    for (let hour = 0; hour < 48; hour++) {
      advance(world, 60);
      expect(world.staff.every((p) => p.state === 'off')).toBe(true);
    }
  });

  it('reports arriving and leaving as events', () => {
    const world = newWorld(SUNDAY_0800);
    const leaving = advance(world, SUNDAY_1600 - world.simMinutes).filter(
      (e) => e.type === 'shift-ended',
    );
    expect(leaving).toHaveLength(world.tuning.staffOnShiftCount);

    const arriving = advance(world, MINUTES_PER_DAY).filter((e) => e.type === 'shift-started');
    expect(arriving).toHaveLength(world.tuning.staffOnShiftCount);
  });
});

describe('closing time and work in progress', () => {
  it('sets the job down part-finished rather than losing or completing it', () => {
    const world = newWorld(SUNDAY_0800);
    const { job, operator } = workingOnBloodPanel(world);
    const step = job.steps[job.stepIndex]!;

    // Right up to the close. Every minute of the slice that ends at 16:00 is
    // inside working hours and must be credited — the bug this found was
    // sending people home before paying for the slice they worked.
    advance(world, SUNDAY_1600 - world.simMinutes);

    expect(operator.state).toBe('off');
    expect(operator.jobId).toBeNull();
    expect(job.status).toBe('waiting');
    expect(job.completedAtMinute).toBeNull();
    expect(step.remaining).toBeGreaterThan(0);
    expect(step.remaining).toBeLessThan(step.total);
  });

  it('credits the whole of the slice that ends at closing time', () => {
    // The ordering bug stated directly, and measured against a lab that never
    // closes. Up to 16:00 the two are the same lab, so the work done must be
    // identical — if the close discards the slice it lands on, it will not be.
    const closing = newWorld(SUNDAY_0800);
    const neverCloses = newWorld(SUNDAY_0800);
    neverCloses.calendar = {
      ...neverCloses.calendar,
      shift: { ...shift, endMinute: MINUTES_PER_DAY },
    };

    const a = workingOnBloodPanel(closing, SUNDAY_1600 - 20);
    const b = workingOnBloodPanel(neverCloses, SUNDAY_1600 - 20);
    expect(a.job.id).toBe(b.job.id);
    expect(closing.simMinutes).toBe(neverCloses.simMinutes);

    advance(closing, SUNDAY_1600 - closing.simMinutes);
    advance(neverCloses, SUNDAY_1600 - neverCloses.simMinutes);

    const left = (j: Job) => j.steps.reduce((sum, s) => sum + s.remaining, 0);
    expect(left(a.job)).toBe(left(b.job));

    // And from 16:00 they diverge, which is the point of a closing time.
    advance(closing, 60);
    advance(neverCloses, 60);
    expect(left(a.job)).toBeGreaterThan(left(b.job));
  });

  it('gives the machine back, which is what lets an evening shift help', () => {
    // The consequence that matters. Held overnight, utilisation reads 100% with
    // nobody in the building, and decision C adds no capacity at all.
    const world = newWorld(SUNDAY_0800);
    const { job } = workingOnBloodPanel(world);
    const machine = world.equipment.find((e) => e.id === job.equipmentId)!;
    expect(machine.inUse).toBe(true);

    advance(world, SUNDAY_1600 - world.simMinutes);

    expect(machine.inUse).toBe(false);
    expect(machine.assignedTo).toBeNull();
    expect(world.equipment.every((e) => !e.inUse)).toBe(true);
  });

  it('does not advance the work overnight', () => {
    const world = newWorld(SUNDAY_0800);
    const { job } = workingOnBloodPanel(world);
    advance(world, SUNDAY_1600 - world.simMinutes);
    const atClose = job.steps[job.stepIndex]!.remaining;

    advance(world, 16 * 60); // through to Monday 08:00

    expect(job.steps[job.stepIndex]!.remaining).toBe(atClose);
  });

  it('names the job that was put down, so carry-over can be counted', () => {
    const world = newWorld(SUNDAY_0800);
    const { job } = workingOnBloodPanel(world);
    const events = advance(world, SUNDAY_1600 - world.simMinutes);

    const setDown = events.filter((e) => e.type === 'shift-ended' && e.jobSetDown !== null);
    expect(setDown).toHaveLength(1);
    expect(setDown[0]).toMatchObject({ jobSetDown: job.id });
  });

  it('lets the work be picked up again next morning and finished', () => {
    const world = newWorld(SUNDAY_0800);
    const { job, operator } = workingOnBloodPanel(world);
    advance(world, SUNDAY_1600 - world.simMinutes);
    const leftOvernight = job.steps.reduce((total, step) => total + step.remaining, 0);

    advance(world, 16 * 60); // Monday 08:00
    expect(operator.state).toBe('idle');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: operator.id, jobId: job.id });
    for (let i = 0; i < 5000 && job.completedAtMinute === null; i++) advance(world, 0.5);

    expect(job.status).not.toBe('waiting');
    expect(job.steps.every((step) => step.remaining === 0)).toBe(true);
    // Only the work that was actually left got done: no day was lost and none
    // was repeated.
    expect(leftOvernight).toBeGreaterThan(0);
  });

  it('refuses to start work outside opening hours', () => {
    const world = newWorld(SUNDAY_0800);
    const job = waitForJob(world, 'blood-panel');
    const operator = person(world, 'Hadas Ben Hamo');
    advance(world, SUNDAY_1600 - world.simMinutes + 60); // 17:00

    const events = applyCommand(world, {
      type: 'ASSIGN_JOB',
      staffId: operator.id,
      jobId: job.id,
    });

    expect(events).toEqual([{ type: 'rejected', reason: 'not-idle', detail: operator.name }]);
    expect(job.status).toBe('waiting');
  });
});

describe('the roster and the clock are different things', () => {
  it('takes someone off the rota and sends them home now', () => {
    const world = newWorld(SUNDAY_0800);
    const operator = person(world, 'Hadas Ben Hamo');
    expect(operator.rostered).toBe(true);

    applyCommand(world, { type: 'TOGGLE_SHIFT', staffId: operator.id });

    expect(operator.rostered).toBe(false);
    expect(operator.state).toBe('off');
  });

  it('puts someone on the rota and brings them in, if the lab is open', () => {
    const world = newWorld(SUNDAY_0800);
    const nina = person(world, 'Nina Zur');
    expect(nina.rostered).toBe(false);
    expect(nina.state).toBe('off');

    applyCommand(world, { type: 'TOGGLE_SHIFT', staffId: nina.id });

    expect(nina.rostered).toBe(true);
    expect(nina.state).toBe('idle');
  });

  it('leaves a new roster addition at home until morning', () => {
    const world = newWorld(2 * 60); // 02:00
    const nina = person(world, 'Nina Zur');

    applyCommand(world, { type: 'TOGGLE_SHIFT', staffId: nina.id });

    expect(nina.rostered).toBe(true);
    expect(nina.state).toBe('off');

    advance(world, shift.startMinute - world.simMinutes);
    expect(nina.state).toBe('idle');
  });

  it('sets a job down when someone is taken off the rota', () => {
    const world = newWorld(SUNDAY_0800);
    const { job, operator } = workingOnBloodPanel(world);

    applyCommand(world, { type: 'TOGGLE_SHIFT', staffId: operator.id });

    expect(job.status).toBe('waiting');
    expect(job.operatorId).toBeNull();
    expect(world.equipment.every((e) => !e.inUse)).toBe(true);
  });

  it('keeps someone off sick off sick through a shift change', () => {
    // Being sick is about the person, not the hour. Letting the clock clear it
    // would mean an illness that ends at closing time.
    const world = newWorld(SUNDAY_0800);
    const operator = person(world, 'Hadas Ben Hamo');
    applyCommand(world, { type: 'SET_STATUS', staffId: operator.id, sick: true });
    expect(operator.state).toBe('sick');

    advance(world, MINUTES_PER_DAY); // through a close and an open
    expect(operator.state).toBe('sick');
  });

  it('does not put someone back on the floor when sickness is cleared at night', () => {
    // The Phase 1 regression, in its new form. `state` used to be written
    // directly by this command, so clearing sick at 02:00 produced a technician
    // alone in a closed building.
    const world = newWorld(SUNDAY_0800);
    const operator = person(world, 'Hadas Ben Hamo');
    applyCommand(world, { type: 'SET_STATUS', staffId: operator.id, sick: true });
    advance(world, SUNDAY_1600 - world.simMinutes + 120); // 18:00, lab shut

    applyCommand(world, { type: 'SET_STATUS', staffId: operator.id, sick: false });

    expect(operator.state).toBe('off');
    expect(operator.rostered).toBe(true);
  });

  it('never brings in someone who is not on the rota', () => {
    const world = newWorld(SUNDAY_0800);
    const notRostered = world.staff.filter((p) => !p.rostered);
    expect(notRostered.length).toBeGreaterThan(0);

    for (let day = 0; day < 3; day++) {
      advance(world, MINUTES_PER_DAY);
      for (const p of notRostered) expect(p.state).toBe('off');
    }
  });
});

describe('a closing time is an instant the loop lands on', () => {
  it('stops work at 16:00 however coarsely time is stepped', () => {
    // Stepping over a close means a shift that ends at 16:00 ends at midnight
    // in a batch run that steps a day at a time — eight hours of work nobody
    // did, which the run would then report as throughput.
    const results = new Map<number, number>();

    for (const step of [0.5, 1, 7, 60, 480, 1440]) {
      const world = newWorld(SUNDAY_0800);
      const { job } = workingOnBloodPanel(world);
      const before = job.steps.reduce((sum, s) => sum + s.remaining, 0);

      // Through closing time and well past it, in steps of the given size.
      const target = SUNDAY_1600 + 4 * 60;
      while (world.simMinutes < target - 1e-9) {
        advance(world, Math.min(step, target - world.simMinutes));
      }

      const after = job.steps.reduce((sum, s) => sum + s.remaining, 0);
      results.set(step, before - after);
    }

    const values = [...results.values()];
    // The same amount of work, whichever step size: she worked until 16:00 and
    // stopped. A step of a whole day would otherwise have let her finish.
    for (const done of values) expect(done).toBeCloseTo(values[0]!, 6);
    expect(values[0]!).toBeGreaterThan(0);
    expect(values[0]!).toBeLessThanOrEqual(20);
  });
});
