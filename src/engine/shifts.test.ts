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
  it('lets somebody stay to finish the step they are on', () => {
    // The behaviour B1 introduced, and the only reason overtime can exist at
    // all. Before it, everybody was sent home the instant their shift ended, so
    // the specification's overtime bands priced a quantity that was always
    // zero and the lab manager's actual complaint was unmodellable.
    //
    // The rule is the narrowest one that produces overtime: finish the step you
    // are on, then go. Nobody starts new work after hours.
    const world = newWorld(SUNDAY_0800);
    const { job, operator } = workingOnBloodPanel(world);
    const step = job.steps[job.stepIndex]!;
    expect(step.remaining).toBeGreaterThan(5);

    advance(world, SUNDAY_1600 - world.simMinutes + 1);

    expect(isLabOpen(world)).toBe(false);
    expect(operator.state).toBe('working');
    expect(operator.overtimeMinutesThisWeek).toBeGreaterThan(0);
  });

  it('sends them home at the step boundary, not before and not later', () => {
    const world = newWorld(SUNDAY_0800);
    const { job, operator } = workingOnBloodPanel(world);
    const step = job.steps[job.stepIndex]!;
    const overtimeNeeded = step.remaining;

    advance(world, SUNDAY_1600 - world.simMinutes);
    advance(world, overtimeNeeded + 1);

    expect(operator.state).toBe('off');
    expect(operator.jobId).toBeNull();
    // The step they stayed for is finished; the next one waits for morning.
    expect(step.remaining).toBe(0);
    expect(job.status).toBe('waiting');
    expect(job.stepIndex).toBeGreaterThan(0);
  });

  it('starts no new work after hours', () => {
    const world = newWorld(SUNDAY_0800);
    const job = waitForJob(world, 'blood-panel');
    advance(world, SUNDAY_1600 - world.simMinutes + 60); // 17:00

    const hadas = person(world, 'Hadas Ben Hamo');
    const events = applyCommand(world, { type: 'ASSIGN_JOB', staffId: hadas.id, jobId: job.id });

    expect(events).toEqual([{ type: 'rejected', reason: 'not-idle', detail: hadas.name }]);
    expect(job.status).toBe('waiting');
  });

  it('counts minutes after the shift as overtime, and ordinary minutes as not', () => {
    const world = newWorld(SUNDAY_0800);
    const { operator } = workingOnBloodPanel(world);

    advance(world, SUNDAY_1600 - world.simMinutes);
    const beforeClose = operator.minutesWorkedThisWeek;
    expect(operator.overtimeMinutesThisWeek).toBe(0);

    advance(world, 10);

    expect(operator.minutesWorkedThisWeek).toBeGreaterThan(beforeClose);
    expect(operator.overtimeMinutesThisWeek).toBeCloseTo(
      operator.minutesWorkedThisWeek - beforeClose,
      6,
    );
  });

  it('sends somebody home mid-step when they hit the daily cap', () => {
    // The cap is what stops "finish what you started" becoming "stay all
    // night". It is also the one thing that can interrupt a step, so the job
    // has to survive it with its counters intact like any other interruption.
    const world = newWorld(SUNDAY_0800);
    const { job, operator } = workingOnBloodPanel(world);
    const cap = world.tuning.maxHoursPerDay * 60;
    operator.minutesWorkedToday = cap - 5;

    const events = advance(world, 10);

    expect(operator.state).toBe('off');
    expect(operator.minutesWorkedToday).toBeGreaterThanOrEqual(cap);
    expect(job.status).toBe('waiting');
    expect(job.steps[job.stepIndex]!.remaining).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'hours-cap-reached')).toBe(true);
    expect(world.equipment.every((e) => !e.inUse)).toBe(true);
  });

  it('never lets anybody exceed the daily cap, whatever the step size', () => {
    for (const step of [1, 60, 480]) {
      const world = newWorld(SUNDAY_0800);
      const { operator } = workingOnBloodPanel(world);
      operator.minutesWorkedToday = world.tuning.maxHoursPerDay * 60 - 3;

      const target = world.simMinutes + 240;
      while (world.simMinutes < target - 1e-9) {
        advance(world, Math.min(step, target - world.simMinutes));
      }

      expect(operator.minutesWorkedToday, `step ${step}`).toBeLessThanOrEqual(
        world.tuning.maxHoursPerDay * 60 + 1e-6,
      );
    }
  });

  it('gives the machine back when the person finally leaves', () => {
    // The consequence that matters for decision C. Held overnight, utilisation
    // would read 100% with nobody in the building and an evening shift would
    // add no capacity at all.
    const world = newWorld(SUNDAY_0800);
    const { job } = workingOnBloodPanel(world);
    const machine = world.equipment.find((e) => e.id === job.equipmentId)!;
    expect(machine.inUse).toBe(true);

    advance(world, SUNDAY_1600 - world.simMinutes + 120);

    expect(world.staff.every((p) => p.state === 'off')).toBe(true);
    expect(world.equipment.every((e) => !e.inUse)).toBe(true);
  });

  it('does not advance attended work once everybody has gone', () => {
    const world = newWorld(SUNDAY_0800);
    const { job } = workingOnBloodPanel(world);
    advance(world, SUNDAY_1600 - world.simMinutes + 120);
    expect(world.staff.every((p) => p.state === 'off')).toBe(true);

    const left = job.steps.reduce((sum, s) => sum + s.remaining, 0);
    advance(world, 14 * 60);

    expect(job.steps.reduce((sum, s) => sum + s.remaining, 0)).toBe(left);
  });

  it('lets the work be picked up again next morning and finished', () => {
    const world = newWorld(SUNDAY_0800);
    const { job, operator } = workingOnBloodPanel(world);
    advance(world, SUNDAY_1600 - world.simMinutes + 120);
    const leftOvernight = job.steps.reduce((total, step) => total + step.remaining, 0);
    expect(leftOvernight).toBeGreaterThan(0);

    // To nine the next morning. Advancing a flat day from 18:00 would land at
    // the *next* closing time, when she is already going home again.
    advance(world, MINUTES_PER_DAY + 9 * 60 - (world.simMinutes % MINUTES_PER_DAY));
    expect(operator.state).toBe('idle');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: operator.id, jobId: job.id });
    for (let i = 0; i < 5000 && job.completedAtMinute === null; i++) advance(world, 0.5);

    expect(job.status).not.toBe('waiting');
    expect(job.steps.every((step) => step.remaining === 0)).toBe(true);
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

  it('puts someone back on the rota and brings them in, if the lab is open', () => {
    // Every one of the eight is employed under the spec roster, so being off
    // the rota now has to be arranged rather than found.
    const world = newWorld(SUNDAY_0800);
    const alex = person(world, 'Alex Tom');
    applyCommand(world, { type: 'TOGGLE_SHIFT', staffId: alex.id });
    expect(alex.rostered).toBe(false);
    expect(alex.state).toBe('off');

    applyCommand(world, { type: 'TOGGLE_SHIFT', staffId: alex.id });

    expect(alex.rostered).toBe(true);
    expect(alex.state).toBe('idle');
  });

  it('leaves a roster addition at home until morning', () => {
    const world = newWorld(2 * 60); // 02:00
    const alex = person(world, 'Alex Tom');
    applyCommand(world, { type: 'TOGGLE_SHIFT', staffId: alex.id });

    applyCommand(world, { type: 'TOGGLE_SHIFT', staffId: alex.id });

    expect(alex.rostered).toBe(true);
    expect(alex.state).toBe('off');

    advance(world, shift.startMinute - world.simMinutes);
    expect(alex.state).toBe('idle');
  });

  it('sends a part-timer home at the end of their own shorter shift', () => {
    // Nina is contracted for twenty hours, which is 08:00 to 12:00. The lab
    // stays open until four, and this is exactly the case a single lab-wide
    // shift could not express.
    const world = newWorld(SUNDAY_0800);
    const nina = person(world, 'Nina Zur');
    const hadas = person(world, 'Hadas Ben Hamo');
    expect(nina.weeklyHours).toBe(20);

    advance(world, 12 * 60 - world.simMinutes - 1);
    expect(nina.state).not.toBe('off');

    advance(world, 1);
    expect(world.simMinutes).toBeCloseTo(12 * 60, 6);
    expect(nina.state).toBe('off');
    // And the full-timers are still working.
    expect(hadas.state).not.toBe('off');
    expect(isLabOpen(world)).toBe(true);
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
    const alex = person(world, 'Alex Tom');
    applyCommand(world, { type: 'TOGGLE_SHIFT', staffId: alex.id });
    expect(alex.rostered).toBe(false);

    for (let day = 0; day < 3; day++) {
      advance(world, MINUTES_PER_DAY);
      expect(alex.state).toBe('off');
    }
  });
});

describe('a closing time is an instant the loop lands on', () => {
  it('does the same amount of work however coarsely time is stepped', () => {
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
    // The same amount of work whichever step size. The bound on *how much* went
    // with B1 — she now stays past four to finish the step she is on, so the
    // figure is the whole step rather than the twenty minutes before closing.
    // The invariance is the claim, and it survived the change.
    for (const done of values) expect(done).toBeCloseTo(values[0]!, 6);
    expect(values[0]!).toBeGreaterThan(0);
  });
});
