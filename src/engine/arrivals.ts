/**
 * Where work comes from.
 *
 * Before this, work did not exist until someone was told to do it, so the lab
 * could never be behind. Here samples arrive on their own, at business hours,
 * in the volumes the scenario declares — which is what creates a queue, and
 * therefore a bottleneck, and therefore something for a decision to fix.
 *
 * Two properties matter more than the generation itself, and both are the
 * reason this is its own module with its own stream:
 *
 * 1. **Demand is independent of the lab.** Adding a technician or leasing an
 *    instrument must not change which samples turn up. Otherwise comparing two
 *    decisions compares two different months of work, and reports the
 *    difference as the effect of the decision. Arrivals therefore draw from a
 *    `demand` stream that nothing else touches.
 *
 * 2. **Week 7 is week 7 however you got there.** Each week is generated from
 *    its own derived stream, keyed by week number, so a week's demand does not
 *    depend on how many weeks were generated before it, or whether they were
 *    generated at all. A batch run that jumps straight to week 7 and a live
 *    session that walks there over six simulated weeks see the same samples.
 *
 * The plan called for pre-generating a fixed horizon at world creation. That
 * was rejected once the live lab became open-ended: a horizon has an edge, and
 * past the edge demand silently stops. Keying each week independently gives the
 * same fairness guarantee with no edge.
 */
import type { Calendar, Job, WorkType } from '../domain/types';
import { addWorkingDays, dayOfWeekOf, dayStart, DAYS_PER_WEEK } from './calendar';
import { createRng, deriveSeed } from './rng';

/**
 * A week's arrivals, in order, from that week's own stream.
 *
 * `firstJobNumber` is where ids start, so ids stay unique and readable across
 * weeks without the generator needing to know what came before.
 */
export function generateWeekArrivals(
  workTypes: WorkType[],
  calendar: Calendar,
  seed: number,
  week: number,
  firstJobNumber: number,
): Job[] {
  const rng = createRng(deriveSeed(seed, `demand:week:${week}`));
  const jobs: Job[] = [];

  // Work types are walked in scenario order, and each draws a count before any
  // arrival instants, so adding a fifth work type cannot shift the first four.
  // Same reasoning as the per-entity streams, one level down.
  for (const workType of workTypes) {
    const count = drawWeeklyCount(rng.next(), workType);
    for (let i = 0; i < count; i++) {
      jobs.push(makeJob(workType, calendar, openingMinuteIn(calendar, week, rng.next())));
    }
  }

  jobs.sort((a, b) => a.arrivedAtMinute - b.arrivedAtMinute);
  // Numbered after sorting, so the ids read in arrival order.
  jobs.forEach((job, i) => {
    job.id = `J${firstJobNumber + i}`;
  });
  return jobs;
}

/**
 * How many of this work type arrive in a week.
 *
 * Uniform around the mean rather than Poisson. A Poisson count would be more
 * principled for independent arrivals, but the scenario's numbers come from a
 * lab manager describing a range — "about eighty blood panels, give or take
 * twenty percent" — and a uniform band is what that sentence means. Recorded
 * here because it is a modelling choice, not an oversight.
 */
function drawWeeklyCount(u: number, workType: WorkType): number {
  const spread = workType.perWeek * workType.variation;
  return Math.max(0, Math.round(workType.perWeek - spread + u * 2 * spread));
}

/**
 * An instant inside the given week's opening hours, from a draw in [0, 1).
 *
 * Samples are delivered by couriers and clients, so they arrive while the lab
 * is open — not at 03:00. Spreading them uniformly across *opening minutes*
 * rather than across the whole week is what makes "arrived Thursday 15:55" a
 * case the model can produce, which is the awkward case for a deadline.
 */
function openingMinuteIn(calendar: Calendar, week: number, u: number): number {
  const shift = calendar.shift;
  const workingDays: number[] = [];
  for (let d = 0; d < DAYS_PER_WEEK; d++) {
    const day = week * DAYS_PER_WEEK + d;
    if (shift.days.includes(dayOfWeekOf(day))) workingDays.push(day);
  }
  // A calendar with no working days would make demand undefined rather than
  // zero, so it is a scenario error rather than something to paper over.
  if (workingDays.length === 0) {
    throw new Error('arrivals: the calendar has no working days');
  }

  const openMinutesPerDay = shift.endMinute - shift.startMinute;
  const total = workingDays.length * openMinutesPerDay;
  const offset = u * total;
  const dayOffset = Math.min(workingDays.length - 1, Math.floor(offset / openMinutesPerDay));
  const withinDay = offset - dayOffset * openMinutesPerDay;

  return dayStart(workingDays[dayOffset]!) + shift.startMinute + withinDay;
}

/** A job is built once, at arrival, and its deadline never recomputed. */
function makeJob(workType: WorkType, calendar: Calendar, arrivedAtMinute: number): Job {
  return {
    // Replaced by the caller once the week is sorted.
    id: '',
    workTypeId: workType.id,
    name: workType.name,
    status: 'waiting',
    arrivedAtMinute,
    dueAtMinute: addWorkingDays(calendar, arrivedAtMinute, workType.dueWorkingDays),
    basePrice: workType.basePrice,
    steps: workType.steps.map((step) => ({
      name: step.name,
      skillRequired: step.skillRequired,
      remaining: step.duration,
      total: step.duration,
    })),
    stepIndex: 0,
    operatorId: null,
    equipmentId: null,
    pinnedStaffId: null,
    completedAtMinute: null,
    settledRevenue: 0,
    blockReason: null,
  };
}
