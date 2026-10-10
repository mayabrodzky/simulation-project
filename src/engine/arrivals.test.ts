/**
 * Tests for where work comes from.
 *
 * Three groups, in order of how badly a failure would matter:
 *
 *   1. **Fairness** — demand must not depend on the lab. This is the property
 *      Phase 4's comparison rests on, and a failure here is invisible in the
 *      output.
 *   2. **Shape** — the right volume, at business hours, with deadlines that
 *      mean what a client means by "two working days".
 *   3. **Independence of how you got there** — week 7 is week 7 whether it was
 *      generated up front or walked to over six simulated weeks.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import type { Job, Scenario } from '../domain/types';
import {
  addWorkingDays,
  DAYS_PER_WEEK,
  dayOfWeek,
  dayStart,
  MINUTES_PER_DAY,
  minuteOfDay,
  weekIndex,
} from './calendar';
import { generateWeekArrivals } from './arrivals';
import { advance } from './tick';
import { createWorld, ensureArrivalsThrough, type WorldState } from './world';

const SEED = 42;
const SUNDAY_0800 = 480;
const { shift } = chemistryLab.calendar;

/**
 * Walks a world forward a day at a time.
 *
 * Deliberately not one long call. Demand for a whole span is generated at the
 * top of `advance`, so a single fortnight-long call would generate every week
 * before the lab had done anything — and a test built that way cannot see a
 * regression where demand starts depending on the lab's own generator. Walking
 * is also what the live view actually does.
 */
function walkDays(world: WorldState, days: number): void {
  for (let i = 0; i < days; i++) advance(world, MINUTES_PER_DAY);
}

/** Everything that has arrived or will, so a whole run can be compared. */
function demandFingerprint(world: WorldState): string[] {
  return [...world.jobs, ...world.arrivalQueue].map(
    (j) => `${j.id}:${j.workTypeId}@${j.arrivedAtMinute.toFixed(4)}/due${j.dueAtMinute}`,
  );
}

/**
 * The baseline with everyone rostered.
 *
 * An off-duty person makes no draws at all, and the scenario rosters only six
 * of eight — so an appended hire would change nothing during a run and the
 * fairness tests below would pass for the wrong reason. The same trap caught
 * fairness.test.ts; it is worth stating twice.
 */
function fullShift(): Scenario {
  return {
    ...chemistryLab,
    tuning: { ...chemistryLab.tuning, staffOnShiftCount: chemistryLab.staff.length },
  };
}

function week(n: number, scenario: Scenario = chemistryLab, seed = SEED): Job[] {
  return generateWeekArrivals(scenario.workTypes, scenario.calendar, seed, n, 1);
}

describe('demand does not depend on the lab', () => {
  it('is unchanged by hiring someone', () => {
    const roster = fullShift();
    const base = createWorld(roster, SEED, SUNDAY_0800);
    const hired = createWorld(
      {
        ...roster,
        staff: [...roster.staff, { name: 'New Hire', role: 'Technician', skills: ['Microscopy'] }],
        tuning: { ...roster.tuning, staffOnShiftCount: roster.staff.length + 1 },
      },
      SEED,
      SUNDAY_0800,
    );

    // A fortnight, so any drift has thousands of draws to accumulate over.
    walkDays(base, 14);
    walkDays(hired, 14);

    expect(demandFingerprint(hired)).toEqual(demandFingerprint(base));
  });

  it('is unchanged by leasing another instrument', () => {
    const roster = fullShift();
    const first = roster.equipment[0]!;
    const base = createWorld(roster, SEED, SUNDAY_0800);
    const leased = createWorld(
      { ...roster, equipment: [...roster.equipment, { ...first, name: 'Extra' }] },
      SEED,
      SUNDAY_0800,
    );

    walkDays(base, 14);
    walkDays(leased, 14);

    expect(demandFingerprint(leased)).toEqual(demandFingerprint(base));
  });

  it('is unchanged by how long the lab has been running', () => {
    // The direct statement of the keying property: generating week 5 from a
    // standing start must match generating it after four other weeks.
    const direct = week(5).map((j) => j.arrivedAtMinute);
    for (let i = 0; i < 5; i++) week(i);
    const afterOthers = week(5).map((j) => j.arrivedAtMinute);

    expect(afterOthers).toEqual(direct);
  });

  it('gives a world that skipped ahead the same arrivals as one that walked', () => {
    const walked = createWorld(chemistryLab, SEED, SUNDAY_0800);
    for (let i = 0; i < 21; i++) advance(walked, MINUTES_PER_DAY);

    const jumped = createWorld(chemistryLab, SEED, SUNDAY_0800);
    advance(jumped, 21 * MINUTES_PER_DAY);

    expect(demandFingerprint(jumped)).toEqual(demandFingerprint(walked));
  });
});

describe('the volume matches the scenario', () => {
  it('averages the declared weekly count over eight weeks', () => {
    const weeks = 8;
    const counted = new Map<string, number>();
    for (let w = 0; w < weeks; w++) {
      for (const job of week(w)) {
        counted.set(job.workTypeId, (counted.get(job.workTypeId) ?? 0) + 1);
      }
    }

    for (const workType of chemistryLab.workTypes) {
      const mean = (counted.get(workType.id) ?? 0) / weeks;
      // The weekly count is uniform across +/- `variation`, so the mean of
      // eight weeks sits well inside that band. A tolerance of the full band
      // would pass even if the mean were systematically at one edge.
      expect(mean).toBeGreaterThan(workType.perWeek * (1 - workType.variation * 0.6));
      expect(mean).toBeLessThan(workType.perWeek * (1 + workType.variation * 0.6));
    }
  });

  it('never produces a week outside the declared band', () => {
    for (let w = 0; w < 20; w++) {
      const counts = new Map<string, number>();
      for (const job of week(w)) counts.set(job.workTypeId, (counts.get(job.workTypeId) ?? 0) + 1);

      for (const workType of chemistryLab.workTypes) {
        const n = counts.get(workType.id) ?? 0;
        const spread = workType.perWeek * workType.variation;
        expect(n).toBeGreaterThanOrEqual(Math.round(workType.perWeek - spread));
        expect(n).toBeLessThanOrEqual(Math.round(workType.perWeek + spread));
      }
    }
  });

  it('varies week to week rather than delivering the mean every time', () => {
    // A generator that ignored its draw would pass every other test here.
    const counts = new Set<number>();
    for (let w = 0; w < 10; w++) {
      counts.add(week(w).filter((j) => j.workTypeId === 'blood-panel').length);
    }
    expect(counts.size).toBeGreaterThan(3);
  });

  it('offers the 186 hands-on hours a week the specification states', () => {
    // The specification arrives at 186 h/wk independently, from the lab
    // manager's own volumes. Reproducing it from the step table is the
    // strongest available check that the calibration was transcribed rather
    // than invented: a wrong duration anywhere shows up here.
    const minutes = chemistryLab.workTypes.reduce(
      (total, w) => total + w.perWeek * w.steps.reduce((t, step) => t + step.duration, 0),
      0,
    );
    expect(minutes / 60).toBeCloseTo(186, 1);
  });

  it('asks for the mass spectrometer, which no work used to', () => {
    // Phase 1 recorded that bought equipment could never relieve a bottleneck,
    // because no task named a machine the shop sold. This is the fix.
    const names = chemistryLab.workTypes.flatMap((w) => w.steps.map((s) => s.name));
    expect(names).toContain('Mass Spectrometer');
  });
});

describe('samples arrive while the lab is open', () => {
  const sample = Array.from({ length: 6 }, (_, w) => week(w)).flat();

  it('never arrives on a day the lab is closed', () => {
    for (const job of sample) {
      expect(shift.days).toContain(dayOfWeek(job.arrivedAtMinute));
    }
  });

  it('never arrives before opening or after closing', () => {
    for (const job of sample) {
      const atMinute = minuteOfDay(job.arrivedAtMinute);
      expect(atMinute).toBeGreaterThanOrEqual(shift.startMinute);
      expect(atMinute).toBeLessThan(shift.endMinute);
    }
  });

  it('spreads across the week rather than clustering on one day', () => {
    const days = new Set(sample.map((j) => dayOfWeek(j.arrivedAtMinute)));
    expect(days.size).toBe(shift.days.length);
  });

  it('stays inside the week it belongs to', () => {
    for (let w = 0; w < 6; w++) {
      for (const job of week(w)) expect(weekIndex(job.arrivedAtMinute)).toBe(w);
    }
  });
});

describe('deadlines are absolute instants, set once at arrival', () => {
  it('falls at close of business', () => {
    for (const job of week(0)) {
      expect(minuteOfDay(job.dueAtMinute)).toBe(shift.endMinute);
    }
  });

  it('sets every deadline from its own arrival instant', () => {
    // Two working days from *this* job's arrival, not from the start of the
    // week or the time the world was created. Checked against the calendar,
    // which has its own tests, so this asserts the wiring rather than
    // re-deriving the arithmetic.
    for (const job of week(0)) {
      const workType = chemistryLab.workTypes.find((w) => w.id === job.workTypeId)!;
      expect(job.dueAtMinute).toBe(
        addWorkingDays(chemistryLab.calendar, job.arrivedAtMinute, workType.dueWorkingDays),
      );
    }
  });

  it('skips the weekend', () => {
    // Thursday is day 4 and the lab is shut Friday and Saturday, so two
    // working days from Thursday is Monday — day 8, not day 6.
    const thursday = dayStart(4) + 900;
    const job = generateWeekArrivals(
      [
        {
          id: 'probe',
          name: 'Probe',
          perWeek: 400,
          variation: 0,
          basePrice: 1,
          dueWorkingDays: 2,
          steps: [],
        },
      ],
      chemistryLab.calendar,
      SEED,
      0,
      1,
    ).find((j) => j.arrivedAtMinute >= thursday);

    expect(job).toBeDefined();
    expect(Math.floor(job!.dueAtMinute / MINUTES_PER_DAY)).toBe(8);
    expect(minuteOfDay(job!.dueAtMinute)).toBe(shift.endMinute);
  });

  it('gives a longer allowance a later deadline', () => {
    const [short] = week(0, {
      ...chemistryLab,
      workTypes: [{ ...chemistryLab.workTypes[0]!, perWeek: 1, variation: 0, dueWorkingDays: 2 }],
    });
    const [long] = week(0, {
      ...chemistryLab,
      workTypes: [{ ...chemistryLab.workTypes[0]!, perWeek: 1, variation: 0, dueWorkingDays: 7 }],
    });

    expect(short!.arrivedAtMinute).toBe(long!.arrivedAtMinute);
    expect(long!.dueAtMinute).toBeGreaterThan(short!.dueAtMinute);
  });
});

describe('arriving is an instant the clock lands on', () => {
  it('admits a job exactly when it is due to arrive, and not before', () => {
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    const firstArrival = world.arrivalQueue[0]!.arrivedAtMinute;

    advance(world, firstArrival - world.simMinutes - 1);
    expect(world.jobs).toHaveLength(0);

    advance(world, 1);
    expect(world.jobs).toHaveLength(1);
    expect(world.jobs[0]!.arrivedAtMinute).toBe(firstArrival);
  });

  it('reports each arrival as an event carrying facts, not a sentence', () => {
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    const events = advance(world, MINUTES_PER_DAY);
    const arrivals = events.filter((e) => e.type === 'job-arrived');

    expect(arrivals.length).toBe(world.jobs.length);
    expect(arrivals.length).toBeGreaterThan(0);
    for (const event of arrivals) {
      expect(event.jobId).toMatch(/^J\d+$/);
      // A name and an instant, not a formatted sentence — the view decides how
      // to say it, which is what lets the same event feed a log and a counter.
      expect(typeof event.name).toBe('string');
      expect(Number.isFinite(event.dueAtMinute)).toBe(true);
      expect(event.dueAtMinute).toBeGreaterThan(world.simMinutes - MINUTES_PER_DAY);
    }
  });

  it('never admits a sample from before the run started', () => {
    // A world opening on Wednesday must not inherit Sunday's post.
    const wednesday = dayStart(3) + SUNDAY_0800;
    const world = createWorld(chemistryLab, SEED, wednesday);
    advance(world, 2 * MINUTES_PER_DAY);

    for (const job of world.jobs) {
      expect(job.arrivedAtMinute).toBeGreaterThanOrEqual(wednesday);
    }
  });

  it('keeps generating demand indefinitely rather than stopping at a horizon', () => {
    // The live lab runs open-ended, so there must be no edge past which no work
    // arrives. Six weeks in, arrivals are still coming.
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    advance(world, 5 * DAYS_PER_WEEK * MINUTES_PER_DAY);
    const beforeLastWeek = world.jobs.length;
    advance(world, DAYS_PER_WEEK * MINUTES_PER_DAY);

    expect(world.jobs.length).toBeGreaterThan(beforeLastWeek);
    expect(world.arrivalQueue.length).toBeGreaterThan(0);
  });

  it('stops arriving when the lab is shut for the weekend', () => {
    // Nothing is delivered on Friday or Saturday, so the queue is flat across
    // them. Visible proof that the calendar reaches demand, not only deadlines.
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    walkDays(world, 5); // Sunday through Thursday
    const byThursdayClose = world.jobs.length;
    walkDays(world, 2); // Friday and Saturday
    expect(world.jobs.length).toBe(byThursdayClose);

    walkDays(world, 1); // the next Sunday
    expect(world.jobs.length).toBeGreaterThan(byThursdayClose);
  });

  it('gives every job a unique id, in arrival order', () => {
    const world = createWorld(chemistryLab, SEED, SUNDAY_0800);
    advance(world, 21 * MINUTES_PER_DAY);

    const ids = world.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);

    const times = world.jobs.map((j) => j.arrivedAtMinute);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('the same seed gives the same demand', () => {
  it('reproduces a run exactly', () => {
    const a = createWorld(chemistryLab, SEED, SUNDAY_0800);
    const b = createWorld(chemistryLab, SEED, SUNDAY_0800);
    walkDays(a, 10);
    walkDays(b, 10);

    expect(demandFingerprint(b)).toEqual(demandFingerprint(a));
  });

  it('gives a different seed different demand', () => {
    const a = createWorld(chemistryLab, 42, SUNDAY_0800);
    const b = createWorld(chemistryLab, 43, SUNDAY_0800);
    ensureArrivalsThrough(a, SUNDAY_0800);
    ensureArrivalsThrough(b, SUNDAY_0800);

    expect(demandFingerprint(b)).not.toEqual(demandFingerprint(a));
  });
});
