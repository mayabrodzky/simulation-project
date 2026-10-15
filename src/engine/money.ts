/**
 * What the lab earns and what it costs.
 *
 * Four cost lines, chosen because they are the four a lab manager would
 * recognise on a statement: labour, materials, fixed costs, and repairs. Two
 * revenue lines, because lateness has to have a price rather than being an
 * absence.
 *
 * The one structural decision worth stating:
 *
 * **Labour is charged against contracted hours, not against minutes worked.**
 * Somebody employed for forty hours costs forty hours whether the queue is full
 * or empty. Charging worked minutes would make an idle hire free, and decision
 * A — hire a technician at ₪16,000 a month — would then appear to cost nothing
 * and improve everything. That is not a rounding error in the comparison; it is
 * the comparison inverted. Overtime is charged *on top*, and only the premium,
 * because the ordinary hour inside it is already paid for by the contract.
 *
 * Everything accrues to `world.metrics`, which is cumulative and never reset. A
 * measurement window is a separate idea: `snapshot` copies the account and
 * `since` subtracts, so the warm-up exclusion the batch runner needs costs
 * nothing in the hot loop and the live view's counters keep running.
 */
import type { Metrics, Staff } from '../domain/types';
import { MINUTES_PER_DAY } from './calendar';
import { EPSILON } from './geometry';
import type { WorldState } from './world';

/** Days in a month, for turning a monthly fixed cost into a daily accrual. */
const DAYS_PER_MONTH = 30;

/**
 * A person's loaded hourly rate, which depends on their contract.
 *
 * "Full-time" is derived from the lab's own week rather than from a constant.
 * The first version compared against `DAYS_PER_WEEK * 8`, which is 56 hours —
 * so every forty-hour full-timer fell below it and was billed at the
 * part-timer's rate. A ten percent error on the largest cost line in the model,
 * and invisible in any total.
 */
export function ratePerHour(world: WorldState, person: Staff): number {
  const shift = world.calendar.shift;
  const fullWeekHours = (shift.days.length * (shift.endMinute - shift.startMinute)) / 60;
  const full = person.weeklyHours >= fullWeekHours - EPSILON;
  return full ? world.tuning.ratePerHourFullTime : world.tuning.ratePerHourPartTime;
}

/**
 * Charges a slice of fixed costs.
 *
 * Accrued by the minute rather than billed monthly, so a four-week window and a
 * calendar month differ by the right amount instead of by a whole month's rent.
 * Identical in every option being compared, which is exactly why it must be
 * present: a comparison that omits it overstates the *proportional* effect of
 * every decision.
 */
export function accrueFixedCosts(world: WorldState, dtMinutes: number): void {
  const perMinute = world.tuning.fixedCostsPerMonth / (DAYS_PER_MONTH * MINUTES_PER_DAY);
  const amount = perMinute * dtMinutes;
  world.money -= amount;
  world.metrics.fixedCosts += amount;
}

/**
 * Charges a week of contracted labour, and the premium on overtime worked.
 *
 * Called by the week hook, for the week just ended. Contracted hours are
 * charged in full; overtime adds only the premium above the ordinary rate,
 * banded as the specification describes — the first two hours a day at 125%,
 * everything beyond at 150%.
 *
 * The banding is applied to the week's overtime as though it were spread evenly
 * across the days actually worked, which is an approximation and is recorded as
 * one: tracking overtime per day would be exact and would mean another ledger,
 * and the difference only matters for somebody who concentrates all their
 * overtime into one day.
 */
export function chargeWeeklyLabour(world: WorldState): void {
  const t = world.tuning;

  for (const person of world.staff) {
    if (!person.rostered) continue;

    const rate = ratePerHour(world, person);
    const base = person.weeklyHours * rate;
    world.money -= base;
    world.metrics.labourBase += base;

    const overtimeHours = person.overtimeMinutesThisWeek / 60;
    if (overtimeHours <= 0) continue;

    const workingDays = world.calendar.shift.days.length || 1;
    const firstBandCapacity = t.overtimeFirstBandHours * workingDays;
    const inFirstBand = Math.min(overtimeHours, firstBandCapacity);
    const beyond = Math.max(0, overtimeHours - firstBandCapacity);

    // Only the premium: the hour itself is already inside the contract charge.
    const premium =
      inFirstBand * rate * (t.overtimeFirstBandMultiplier - 1) +
      beyond * rate * (t.overtimeBeyondMultiplier - 1);

    world.money -= premium;
    world.metrics.labourOvertime += premium;
  }
}

/**
 * Charges materials for a job, once, when its first step begins.
 *
 * At the start rather than on settlement, and never refunded, because that is
 * what makes a missed rush order expensive: the reagents are gone whatever the
 * client ends up paying. A ₪900 rush spends ₪225 of materials and may settle at
 * ₪630.
 */
export function chargeMaterials(world: WorldState, basePrice: number): void {
  const amount = basePrice * world.tuning.materialsFraction;
  world.money -= amount;
  world.metrics.materials += amount;
}

/** A copy of the account, for excluding a warm-up from a measurement. */
export function snapshot(metrics: Metrics): Metrics {
  return { ...metrics };
}

/** The account for the period between a snapshot and now. */
export function since(before: Metrics, now: Metrics): Metrics {
  const out = {} as Metrics;
  for (const key of Object.keys(now) as (keyof Metrics)[]) {
    out[key] = now[key] - before[key];
  }
  return out;
}

export interface ProfitAndLoss {
  revenue: number;
  revenueLostToLateness: number;
  labourBase: number;
  labourOvertime: number;
  materials: number;
  fixedCosts: number;
  repairs: number;
  training: number;
  equipment: number;
  totalCosts: number;
  profit: number;
  /** Scaled to a calendar month, so a four-week window is not read as one. */
  profitPerMonth: number;
}

/**
 * The account for a period, as a statement.
 *
 * `profitPerMonth` exists because a four-week window is 93% of a month, and
 * reporting four weeks' profit as monthly profit is a silent 7% error — which
 * is exactly how a verdict card goes wrong without anybody noticing.
 */
export function profitAndLoss(metrics: Metrics, overMinutes: number): ProfitAndLoss {
  const totalCosts =
    metrics.labourBase +
    metrics.labourOvertime +
    metrics.materials +
    metrics.fixedCosts +
    metrics.repairs +
    metrics.trainingSpend +
    metrics.equipmentSpend;

  const profit = metrics.revenue - totalCosts;
  const months = overMinutes / (DAYS_PER_MONTH * MINUTES_PER_DAY);

  return {
    revenue: metrics.revenue,
    revenueLostToLateness: metrics.revenueIfAllOnTime - metrics.revenue,
    labourBase: metrics.labourBase,
    labourOvertime: metrics.labourOvertime,
    materials: metrics.materials,
    fixedCosts: metrics.fixedCosts,
    repairs: metrics.repairs,
    training: metrics.trainingSpend,
    equipment: metrics.equipmentSpend,
    totalCosts,
    profit,
    profitPerMonth: months > 0 ? profit / months : 0,
  };
}
