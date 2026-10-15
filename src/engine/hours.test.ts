/**
 * Hours worked, overtime, and fatigue.
 *
 * These three numbers replace `energy` — a percentage that drained, refilled,
 * sent people on breaks, was grounded in nothing measurable and gated nothing.
 * The replacement is deliberately smaller: a ledger of minutes, overtime
 * counted against each person's own contract, and fatigue as a pace multiplier
 * read at the point work is consumed.
 *
 * **Fatigue is not stored anywhere.** No flag, no "tired" state, no
 * recomputation when the threshold is crossed mid-step. It is read from the
 * ledger each time attended work is consumed, so there is no second place that
 * could disagree about whether somebody is tired — which is exactly the failure
 * mode `energy` had, where a drained bar and a person's state could describe
 * different people.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import type { Job, Staff } from '../domain/types';
import { MINUTES_PER_DAY } from './calendar';
import { applyCommand } from './commands';
import { staffLoadPercent } from './queries';
import { creditWork, fatiguePace } from './shifts';
import { advance } from './tick';
import { createWorld, type WorldState } from './world';

const SEED = 42;
const SUNDAY_0800 = 480;

/**
 * Runs with the dispatcher off.
 *
 * These tests build a precise situation by hand — this person, that job, this
 * many minutes — and then assert about it. With dispatch on, which is the
 * default the live lab wants, the engine assigns work the moment somebody is
 * free, so the subject of the test would be given something else before the
 * test could give it anything. Off is the only setting under which a
 * hand-built setup survives contact with the clock.
 */
const QUIET = { dispatch: { enabled: false } } as const;
const t = chemistryLab.tuning;

const newWorld = (startMinutes = SUNDAY_0800) => createWorld(chemistryLab, SEED, startMinutes);
const person = (world: WorldState, name: string): Staff =>
  world.staff.find((p) => p.name === name)!;

function waitForJob(world: WorldState, workTypeId: string): Job {
  for (let i = 0; i < 5000; i++) {
    const found = world.jobs.find((j) => j.workTypeId === workTypeId && j.status === 'waiting');
    if (found) return found;
    advance(world, 1, QUIET);
  }
  throw new Error(`waitForJob: no ${workTypeId} arrived`);
}

describe('the ledger counts what actually happened', () => {
  it('starts everybody at zero', () => {
    const world = newWorld();
    for (const p of world.staff) {
      expect(p.minutesWorkedToday).toBe(0);
      expect(p.minutesWorkedThisWeek).toBe(0);
      expect(p.overtimeMinutesThisWeek).toBe(0);
    }
  });

  it('counts only minutes actually spent working, not minutes present', () => {
    // Being on shift is not working. Walking to an instrument and standing
    // beside a busy one are both time the lab pays for and neither is work
    // done, which is precisely the distinction the capacity breakdown needed
    // and `energy` could not express.
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    const hadas = person(world, 'Hadas Ben Hamo');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: hadas.id, jobId: job.id });

    const before = world.simMinutes;
    for (let i = 0; i < 200 && hadas.state !== 'working'; i++) advance(world, 0.5, QUIET);
    const walked = world.simMinutes - before;

    expect(walked).toBeGreaterThan(0);
    // Under one sampling step: the loop exits after the slice in which she
    // started, so a fraction of that slice is legitimately credited. The claim
    // is that the walk itself bought nothing.
    expect(hadas.minutesWorkedToday).toBeLessThan(0.5);

    const atStart = hadas.minutesWorkedToday;
    advance(world, 10, QUIET);
    expect(hadas.minutesWorkedToday - atStart).toBeCloseTo(10, 6);
  });

  it('agrees with the work the job records as done', () => {
    // Two independent accountings of the same minutes. The ledger is credited
    // in `tickStaff` and the step is decremented in `tickJobs`, so a mismatch
    // would mean the loop charged a slice twice or not at all.
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    const hadas = person(world, 'Hadas Ben Hamo');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: hadas.id, jobId: job.id });
    for (let i = 0; i < 200 && hadas.state !== 'working'; i++) advance(world, 0.5, QUIET);

    advance(world, 15, QUIET);

    const done = job.steps.reduce((sum, s) => sum + (s.total - s.remaining), 0);
    expect(done).toBeCloseTo(hadas.minutesWorkedToday, 6);
  });

  it('resets the daily count at midnight and keeps the weekly one', () => {
    const world = newWorld();
    const hadas = person(world, 'Hadas Ben Hamo');
    const job = waitForJob(world, 'blood-panel');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: hadas.id, jobId: job.id });
    for (let i = 0; i < 200 && hadas.state !== 'working'; i++) advance(world, 0.5, QUIET);
    advance(world, 20, QUIET);

    const workedDayOne = hadas.minutesWorkedThisWeek;
    expect(workedDayOne).toBeGreaterThan(0);

    advance(world, MINUTES_PER_DAY, QUIET);

    expect(hadas.minutesWorkedToday).toBe(0);
    expect(hadas.minutesWorkedThisWeek).toBeGreaterThanOrEqual(workedDayOne);
  });

  it('resets the weekly count at the turn of the week', () => {
    const world = newWorld();
    const hadas = person(world, 'Hadas Ben Hamo');
    const job = waitForJob(world, 'blood-panel');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: hadas.id, jobId: job.id });
    for (let i = 0; i < 200 && hadas.state !== 'working'; i++) advance(world, 0.5, QUIET);
    advance(world, 20, QUIET);

    advance(world, 3 * MINUTES_PER_DAY, QUIET);
    const worked = world.staff.map((p) => p.minutesWorkedThisWeek);
    expect(worked.some((m) => m > 0)).toBe(true);

    // Past Saturday midnight into the next week.
    advance(world, 4 * MINUTES_PER_DAY, QUIET);

    for (const p of world.staff) {
      expect(p.minutesWorkedThisWeek).toBe(0);
      expect(p.overtimeMinutesThisWeek).toBe(0);
    }
  });
});

describe('overtime is minutes outside a person’s own contract', () => {
  it('counts nothing as overtime inside the shift', () => {
    const world = newWorld();
    const hadas = person(world, 'Hadas Ben Hamo');
    creditWork(world, hadas, 0); // the clock is 08:00, squarely inside
    advance(world, 60, QUIET);
    expect(hadas.overtimeMinutesThisWeek).toBe(0);
  });

  it('judges a part-timer against their own shorter day, not against forty hours', () => {
    // Nina is contracted 08:00–12:00. An hour of her Tuesday afternoon is
    // overtime even though she is nowhere near forty hours in the week; using a
    // weekly threshold would have called her ordinary Tuesday ordinary and her
    // overtime free.
    const world = newWorld();
    const nina = person(world, 'Nina Zur');
    expect(nina.weeklyHours).toBe(20);

    advance(world, 13 * 60 - world.simMinutes, QUIET); // 13:00
    creditWork(world, nina, 30);

    expect(nina.overtimeMinutesThisWeek).toBe(30);
  });

  it('does not count the slice that ends exactly at closing time', () => {
    // Credit is judged at the *start* of the slice being paid for, not at the
    // clock's current value. The clock has already advanced by then, so a slice
    // ending at 16:00 was briefly recorded as overtime — a quarter of an hour
    // of ordinary afternoon charged at a premium.
    const world = newWorld();
    const hadas = person(world, 'Hadas Ben Hamo');
    advance(world, 16 * 60 - world.simMinutes, QUIET); // exactly 16:00
    creditWork(world, hadas, 15);

    expect(hadas.overtimeMinutesThisWeek).toBe(0);
    expect(hadas.minutesWorkedThisWeek).toBe(15);
  });

  it('arises in a running lab, which it could not before', () => {
    // The whole justification for letting people stay late. Without it the
    // specification's overtime bands would price a quantity that is always
    // zero.
    const world = newWorld();
    // Assigned every simulated minute, so somebody is genuinely mid-step when
    // four o'clock arrives. Assigning once a day would never catch anybody.
    for (let i = 0; i < 2 * MINUTES_PER_DAY; i++) {
      advance(world, 1, QUIET);
      for (const p of world.staff) {
        if (p.state !== 'idle' || p.jobId !== null || p.activeTask) continue;
        const job = world.jobs.find(
          (j) =>
            j.status === 'waiting' &&
            j.stepIndex < j.steps.length &&
            (j.steps[j.stepIndex]!.skillRequired === null ||
              p.skills.includes(j.steps[j.stepIndex]!.skillRequired ?? '')),
        );
        if (job) applyCommand(world, { type: 'ASSIGN_JOB', staffId: p.id, jobId: job.id });
      }
    }

    expect(world.staff.some((p) => p.overtimeMinutesThisWeek > 0)).toBe(true);
  });
});

describe('fatigue is a pace, not a flag', () => {
  it('is one for somebody who has barely started', () => {
    const world = newWorld();
    expect(fatiguePace(world, person(world, 'Hadas Ben Hamo'))).toBe(1);
  });

  it('slows work past the weekly threshold', () => {
    const world = newWorld();
    const hadas = person(world, 'Hadas Ben Hamo');
    hadas.minutesWorkedThisWeek = t.fatigueAfterWeeklyHours * 60 + 1;
    expect(fatiguePace(world, hadas)).toBe(t.fatiguePaceMultiplier);
  });

  it('makes the same minute of presence buy less work done', () => {
    // What "tasks take 10% longer" means, expressed as a rate. Ten minutes of
    // presence consumes ten minutes of work when fresh and about nine when
    // tired, which is the same statement from the other side.
    function workDoneInTenMinutes(alreadyWorkedThisWeek: number): number {
      const world = newWorld();
      const job = waitForJob(world, 'blood-panel');
      const hadas = person(world, 'Hadas Ben Hamo');
      applyCommand(world, { type: 'ASSIGN_JOB', staffId: hadas.id, jobId: job.id });
      for (let i = 0; i < 200 && hadas.state !== 'working'; i++) advance(world, 0.5, QUIET);

      hadas.minutesWorkedThisWeek = alreadyWorkedThisWeek;
      const before = job.steps.reduce((sum, s) => sum + s.remaining, 0);
      advance(world, 10, QUIET);
      return before - job.steps.reduce((sum, s) => sum + s.remaining, 0);
    }

    const fresh = workDoneInTenMinutes(0);
    const tired = workDoneInTenMinutes(t.fatigueAfterWeeklyHours * 60 + 60);

    expect(fresh).toBeCloseTo(10, 6);
    expect(tired).toBeCloseTo(10 / t.fatiguePaceMultiplier, 6);
    expect(tired).toBeLessThan(fresh);
  });

  it('needs no recomputation when the threshold is crossed mid-step', () => {
    // The reason it is a pace and not a state. Nothing observes the crossing,
    // nothing is recalculated, and a step that begins fresh and ends tired is
    // simply consumed at two different rates.
    const world = newWorld();
    const job = waitForJob(world, 'blood-panel');
    const hadas = person(world, 'Hadas Ben Hamo');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: hadas.id, jobId: job.id });
    for (let i = 0; i < 200 && hadas.state !== 'working'; i++) advance(world, 0.5, QUIET);

    hadas.minutesWorkedThisWeek = t.fatigueAfterWeeklyHours * 60 - 5;
    const before = job.steps.reduce((sum, s) => sum + s.remaining, 0);
    advance(world, 10, QUIET);
    const done = before - job.steps.reduce((sum, s) => sum + s.remaining, 0);

    // Five minutes fresh and five tired: strictly between the two rates.
    expect(done).toBeLessThan(10);
    expect(done).toBeGreaterThan(10 / t.fatiguePaceMultiplier);
  });
});

describe('the load bar reads hours instead of an invented percentage', () => {
  it('is zero before anybody has worked', () => {
    const world = newWorld();
    expect(staffLoadPercent(world, person(world, 'Hadas Ben Hamo'))).toBe(0);
  });

  it('reads contracted hours worked, so a part-timer is judged fairly', () => {
    const world = newWorld();
    const nina = person(world, 'Nina Zur');
    const hadas = person(world, 'Hadas Ben Hamo');
    nina.minutesWorkedThisWeek = 10 * 60;
    hadas.minutesWorkedThisWeek = 10 * 60;

    // The same ten hours is half of Nina's contract and a quarter of Hadas's.
    expect(staffLoadPercent(world, nina)).toBe(50);
    expect(staffLoadPercent(world, hadas)).toBe(25);
  });

  it('goes above a hundred, which is the point', () => {
    // Over 100 means overtime. Clamping it would hide exactly the thing the
    // lab manager says is invisible until payroll, which is what the energy
    // bar did by being a percentage of nothing in particular.
    const world = newWorld();
    const hadas = person(world, 'Hadas Ben Hamo');
    hadas.minutesWorkedThisWeek = 48 * 60;
    expect(staffLoadPercent(world, hadas)).toBe(120);
  });
});

describe('energy is gone', () => {
  it('has no energy on a person and no break state', () => {
    const world = newWorld();
    for (const p of world.staff) {
      expect('energy' in p).toBe(false);
      expect(p.state).not.toBe('break');
    }
  });

  it('never puts anybody in a break state over a simulated week', () => {
    const world = newWorld();
    for (let day = 0; day < 7; day++) {
      advance(world, MINUTES_PER_DAY, QUIET);
      for (const p of world.staff) expect(p.state).not.toBe('break');
    }
  });
});
