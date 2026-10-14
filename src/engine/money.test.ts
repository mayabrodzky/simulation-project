/**
 * The account.
 *
 * The property that matters most is the one that is easiest to get wrong and
 * hardest to notice: **labour is charged against contracted hours, not against
 * minutes worked.** Charge worked minutes and an idle hire costs nothing, so
 * decision A — hire a technician — appears to improve everything for free, and
 * the comparison the product exists to make comes out backwards. Several of
 * these tests exist only to pin that down.
 *
 * The second is that lateness has a *price* rather than an absence. A late job
 * appears as less revenue, which is what actually happens; keeping
 * `revenueIfAllOnTime` beside it is what lets the difference be named.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import type { Scenario, Staff } from '../domain/types';
import { DAYS_PER_WEEK, MINUTES_PER_DAY } from './calendar';
import { applyCommand } from './commands';
import {
  chargeMaterials,
  chargeWeeklyLabour,
  profitAndLoss,
  ratePerHour,
  since,
  snapshot,
} from './money';
import { advance } from './tick';
import { createWorld, type WorldState } from './world';

const SEED = 42;
const SUNDAY_0800 = 480;
const t = chemistryLab.tuning;

const newWorld = (startMinutes = SUNDAY_0800) => createWorld(chemistryLab, SEED, startMinutes);
const person = (world: WorldState, name: string): Staff =>
  world.staff.find((p) => p.name === name)!;

describe('labour is charged on the contract, not on the work', () => {
  it('charges a full week for somebody who never lifts a finger', () => {
    // The whole point. If this were zero, hiring somebody would be free and
    // every staffing comparison would be wrong in the same direction.
    const world = newWorld();
    chargeWeeklyLabour(world);

    const expected = world.staff
      .filter((p) => p.rostered)
      .reduce((sum, p) => sum + p.weeklyHours * ratePerHour(world, p), 0);

    expect(world.metrics.labourBase).toBeCloseTo(expected, 6);
    expect(world.metrics.labourBase).toBeGreaterThan(0);
    expect(world.metrics.labourOvertime).toBe(0);
  });

  it('costs more to employ one more person, before they do anything', () => {
    // Decision A, priced. The hire has done no work and must still cost.
    const hired: Scenario = {
      ...chemistryLab,
      staff: [
        ...chemistryLab.staff,
        { name: 'New Hire', role: 'Technician', weeklyHours: 40, skills: ['Microscopy'] },
      ],
      tuning: { ...t, staffOnShiftCount: chemistryLab.staff.length + 1 },
    };

    const base = newWorld();
    const extra = createWorld(hired, SEED, SUNDAY_0800);
    chargeWeeklyLabour(base);
    chargeWeeklyLabour(extra);

    expect(extra.metrics.labourBase - base.metrics.labourBase).toBeCloseTo(
      40 * t.ratePerHourFullTime,
      6,
    );
  });

  it('charges a part-timer their own hours at their own rate', () => {
    const world = newWorld();
    const nina = person(world, 'Nina Zur');
    expect(nina.weeklyHours).toBe(20);
    expect(ratePerHour(world, nina)).toBe(t.ratePerHourPartTime);
    expect(ratePerHour(world, person(world, 'Hadas Ben Hamo'))).toBe(t.ratePerHourFullTime);
  });

  it('charges nothing for somebody taken off the rota', () => {
    const world = newWorld();
    const alex = person(world, 'Alex Tom');
    applyCommand(world, { type: 'TOGGLE_SHIFT', staffId: alex.id });

    chargeWeeklyLabour(world);
    const withoutAlex = world.metrics.labourBase;

    const full = newWorld();
    chargeWeeklyLabour(full);

    expect(full.metrics.labourBase - withoutAlex).toBeCloseTo(20 * t.ratePerHourPartTime, 6);
  });
});

describe('overtime adds only its premium', () => {
  it('charges the premium above the ordinary rate, not the whole hour', () => {
    // The hour itself is already inside the contract charge. Charging it again
    // would bill the first forty hours twice for anybody who stayed late.
    const world = newWorld();
    const hadas = person(world, 'Hadas Ben Hamo');
    hadas.overtimeMinutesThisWeek = 60;

    chargeWeeklyLabour(world);

    const premiumOnly = t.ratePerHourFullTime * (t.overtimeFirstBandMultiplier - 1);
    const contracted = world.staff
      .filter((p) => p.rostered)
      .reduce((sum, p) => sum + p.weeklyHours * ratePerHour(world, p), 0);

    expect(world.metrics.labourOvertime).toBeCloseTo(premiumOnly, 6);
    expect(world.metrics.labourBase).toBeCloseTo(contracted, 6);
  });

  it('charges the higher band past the daily allowance', () => {
    const world = newWorld();
    const hadas = person(world, 'Hadas Ben Hamo');
    const workingDays = chemistryLab.calendar.shift.days.length;
    const firstBandHours = t.overtimeFirstBandHours * workingDays;
    hadas.overtimeMinutesThisWeek = (firstBandHours + 3) * 60;

    chargeWeeklyLabour(world);

    const expected =
      firstBandHours * t.ratePerHourFullTime * (t.overtimeFirstBandMultiplier - 1) +
      3 * t.ratePerHourFullTime * (t.overtimeBeyondMultiplier - 1);
    expect(world.metrics.labourOvertime).toBeCloseTo(expected, 6);
  });

  it('is charged for the week just ended, before the counters clear', () => {
    // Order matters. Clearing first would bill every week as though nobody had
    // worked a minute of overtime.
    const world = newWorld();
    const hadas = person(world, 'Hadas Ben Hamo');
    hadas.overtimeMinutesThisWeek = 120;

    // Past Saturday midnight, which is where the week hook fires.
    advance(world, DAYS_PER_WEEK * MINUTES_PER_DAY);

    expect(world.metrics.labourOvertime).toBeGreaterThan(0);
    expect(hadas.overtimeMinutesThisWeek).toBe(0);
  });
});

describe('materials are spent once and never returned', () => {
  it('charges a share of the price', () => {
    const world = newWorld();
    chargeMaterials(world, 900);
    expect(world.metrics.materials).toBeCloseTo(900 * t.materialsFraction, 6);
  });

  it('charges once for a job that is started, set down and resumed', () => {
    // A job interrupted at closing time and picked up next morning has not
    // bought two sets of reagents. A flag rather than a derivation, because
    // "has any work been done" is true in both cases.
    const world = newWorld();
    for (let i = 0; i < 400; i++) {
      advance(world, 1);
      for (const p of world.staff) {
        if (p.state !== 'idle' || p.jobId !== null || p.activeTask) continue;
        const job = world.jobs.find((j) => j.status === 'waiting' && j.stepIndex < j.steps.length);
        if (job) applyCommand(world, { type: 'ASSIGN_JOB', staffId: p.id, jobId: job.id });
      }
    }
    const started = world.jobs.filter((j) => j.materialsCharged);
    expect(started.length).toBeGreaterThan(0);

    const expected = started.reduce((sum, j) => sum + j.basePrice * t.materialsFraction, 0);
    expect(world.metrics.materials).toBeCloseTo(expected, 6);
  });

  it('is not refunded when a job is abandoned', () => {
    // What makes an abandoned job expensive rather than merely unpaid.
    const world = newWorld();
    chargeMaterials(world, 1000);
    const spent = world.metrics.materials;

    advance(world, 40 * MINUTES_PER_DAY);

    expect(world.metrics.jobsAbandoned).toBeGreaterThan(0);
    expect(world.metrics.materials).toBeGreaterThanOrEqual(spent);
  });
});

describe('fixed costs accrue by the minute', () => {
  it('charges a month of rent over a month', () => {
    const world = newWorld();
    advance(world, 30 * MINUTES_PER_DAY);
    expect(world.metrics.fixedCosts).toBeCloseTo(t.fixedCostsPerMonth, 0);
  });

  it('charges a four-week window less than a month, by the right amount', () => {
    // 28 days against 30. Billing a whole month for four weeks would be a
    // silent 7% error in every profit figure.
    const world = newWorld();
    advance(world, 28 * MINUTES_PER_DAY);
    expect(world.metrics.fixedCosts).toBeCloseTo((t.fixedCostsPerMonth * 28) / 30, 0);
  });
});

describe('lateness has a price rather than an absence', () => {
  it('records what the work would have earned on time', () => {
    const world = newWorld();
    advance(world, 14 * MINUTES_PER_DAY);

    // Nothing is assigned in this run, so everything is abandoned unpaid — and
    // the foregone revenue is still recorded.
    expect(world.metrics.revenue).toBe(0);
    expect(world.metrics.revenueIfAllOnTime).toBeGreaterThan(0);

    const account = profitAndLoss(world.metrics, 14 * MINUTES_PER_DAY);
    expect(account.revenueLostToLateness).toBeCloseTo(world.metrics.revenueIfAllOnTime, 6);
  });

  it('starts with nothing completed and nothing late', () => {
    const world = newWorld();
    expect(world.metrics.jobsCompleted).toBe(0);
    expect(world.metrics.jobsLate).toBe(0);
  });
});

describe('a measurement window is a snapshot and a subtraction', () => {
  it('reports only the period after the warm-up', () => {
    // The warm-up exclusion the batch runner needs, kept out of the hot loop:
    // the account is cumulative and never reset, so the live view's counters
    // keep running while a report can still be scoped.
    const world = newWorld();
    advance(world, 7 * MINUTES_PER_DAY);
    const warmUp = snapshot(world.metrics);
    expect(warmUp.fixedCosts).toBeGreaterThan(0);

    advance(world, 7 * MINUTES_PER_DAY);
    const measured = since(warmUp, world.metrics);

    expect(measured.fixedCosts).toBeCloseTo(world.metrics.fixedCosts - warmUp.fixedCosts, 6);
    expect(measured.fixedCosts).toBeLessThan(world.metrics.fixedCosts);
  });

  it('scales a four-week profit to a month rather than reporting it as one', () => {
    const fourWeeks = 28 * MINUTES_PER_DAY;
    const account = profitAndLoss({ ...newWorld().metrics, revenue: 28000 }, fourWeeks);
    // 28 days is 93% of a 30-day month, so the monthly figure is larger.
    expect(account.profitPerMonth).toBeCloseTo(account.profit * (30 / 28), 6);
  });
});

describe('the account adds up', () => {
  it('matches every cost line against the budget actually spent', () => {
    // A conservation law for money, the same shape as the one for minutes: if a
    // charge can reach the budget without reaching a cost line, or the reverse,
    // every profit figure is wrong and nothing else would notice.
    const world = newWorld();
    const opening = world.money;
    advance(world, 14 * MINUTES_PER_DAY);
    chargeWeeklyLabour(world);

    const m = world.metrics;
    const costs =
      m.labourBase +
      m.labourOvertime +
      m.materials +
      m.fixedCosts +
      m.repairs +
      m.trainingSpend +
      m.equipmentSpend;

    expect(opening + m.revenue - costs).toBeCloseTo(world.money, 4);
  });
});
