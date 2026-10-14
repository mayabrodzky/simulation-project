/**
 * Running the lab many times and reporting the spread.
 *
 * The first thing in this project that answers a question rather than
 * describing a state. Entirely headless: no browser, no canvas, no DOM. That is
 * the whole return on the Phase 1 rule that the engine may not touch
 * `window`, `Date` or `Math.random` — this file exists because that rule was
 * enforced by lint rather than remembered.
 *
 * **Why fifty runs and not one.** A single run of a lab this tight is mostly
 * luck: which day the rush orders land on, whether two cell cultures want the
 * microscope in the same hour. One run would answer "did it go well this time",
 * which is not a question anybody should act on. Fifty runs with the same fifty
 * demand seeds for both options answers "is this decision better, and by how
 * much, and how often" — and the median with a P10-P90 range says all three.
 *
 * **Why the seeds must match across options.** If option A faced seeds 1-50 and
 * option B faced 51-100, the difference between them would be partly the
 * decision and partly the weather, with no way to tell which. Every option here
 * runs the identical seed list, and the per-entity streams from entry 19 are
 * what make that actually hold: adding a technician cannot shift which samples
 * arrive.
 *
 * No money yet. B2 adds labour, materials and a profit line; this reports work.
 */
import type { Scenario } from '../domain/types';
import { assertScenarioIsPossible } from '../engine/audit';
import { MINUTES_PER_DAY } from '../engine/calendar';
import type { OperatorPolicy } from '../engine/dispatch';
import { chargeWeeklyLabour, profitAndLoss } from '../engine/money';
import { instrumentsFor } from '../engine/resources';
import { advance } from '../engine/tick';
import { createWorld } from '../engine/world';

/** One simulated run's outcome. */
export interface RunResult {
  seed: number;
  jobsCompleted: number;
  jobsLate: number;
  rushMissed: number;
  jobsAbandoned: number;
  /** Mean number of jobs waiting, sampled through the run. */
  averageBacklog: number;
  /** Mass spectrometer busy time as a share of the whole calendar period. */
  massSpecUtilisation: number;

  /* --- Money, over the measured period ----------------------------------- */

  revenue: number;
  /** What the same work would have earned delivered on time. */
  revenueIfAllOnTime: number;
  labour: number;
  /** The overtime premium alone, which is the invisible part. */
  labourOvertime: number;
  profit: number;
  /** Scaled to a calendar month, because four weeks is 93% of one. */
  profitPerMonth: number;
}

export interface BatchOptions {
  weeks?: number;
  /**
   * Which operator policy to run under.
   *
   * Exposed because it changes the answer. The lab manager's complaint is that
   * one senior person carries the lab, so a policy that spreads work differently
   * can move a verdict — and a comparison has to say which rule produced it.
   */
  policy?: OperatorPolicy;
}

/**
 * How coarsely the batch runner steps, in simulated minutes.
 *
 * An hour, where it used to be one minute. The reason is the whole point of
 * B3: assignment used to happen *between* `advance` calls, from out here, so a
 * coarser step also meant work was handed out less often. At a fifteen-minute
 * step the same seed completed 97 jobs where a one-minute step completed 102,
 * because people stood idle for up to a quarter of an hour beside work they
 * could have started. The only honest setting was the finest one, which made a
 * fast run exactly as slow as the live view per simulated minute.
 *
 * The dispatcher now runs inside the slice loop, at event boundaries like
 * everything else, so A2's guarantee covers assignment too. A test asserts that
 * one-minute and fifteen-minute steps produce identical discrete outcomes.
 *
 * An hour rather than a day only because the backlog is sampled from this loop
 * and an hourly mean is a more honest average than a daily one.
 */
const STEP_MINUTES = 60;

const SUNDAY_0800 = 480;

export function runOnce(scenario: Scenario, seed: number, options: BatchOptions = {}): RunResult {
  const weeks = options.weeks ?? 4;
  const policy = options.policy ?? 'first-free';
  const step = STEP_MINUTES;
  const totalMinutes = weeks * 7 * MINUTES_PER_DAY;

  const world = createWorld(scenario, seed, SUNDAY_0800);

  let backlogSamples = 0;
  let backlogTotal = 0;

  for (let elapsed = 0; elapsed < totalMinutes; elapsed += step) {
    // The dispatcher is inside the engine now, so this loop only advances time
    // and samples. Nothing it does can change the outcome, which is what lets
    // the step be an hour instead of a minute.
    advance(world, step, { dispatch: { policy } });

    // Sampled hourly rather than every step: the mean is the same and the cost
    // is not, and a step-size change must not alter a reported metric.
    if (Math.floor(elapsed / 60) !== Math.floor((elapsed - step) / 60)) {
      backlogSamples += 1;
      backlogTotal += world.jobs.filter(
        (job) => job.status === 'waiting' || job.status === 'blocked',
      ).length;
    }
  }

  // Payroll for the final, incomplete week. The week hook charges labour when
  // the week turns over, so a run ending mid-week would otherwise report four
  // weeks of revenue against three weeks of wages - a profit overstated by a
  // quarter of its largest cost.
  chargeWeeklyLabour(world);

  const account = profitAndLoss(world.metrics, totalMinutes);

  const massSpecBusy = instrumentsFor(world, 'mass-spec').reduce(
    (total, instrument) => total + instrument.totalWorkTime,
    0,
  );
  const massSpecSlots = instrumentsFor(world, 'mass-spec').reduce(
    (total, instrument) => total + instrument.capacity,
    0,
  );

  return {
    seed,
    jobsCompleted: world.jobs.filter((j) => j.status.startsWith('done')).length,
    jobsLate: world.jobs.filter((j) => j.status === 'done-late').length,
    rushMissed: world.jobs.filter(
      (j) => j.rush && (j.status === 'done-late' || j.status === 'expired'),
    ).length,
    jobsAbandoned: world.jobs.filter((j) => j.status === 'expired').length,
    averageBacklog: backlogSamples > 0 ? backlogTotal / backlogSamples : 0,
    massSpecUtilisation: massSpecSlots > 0 ? massSpecBusy / (massSpecSlots * totalMinutes) : 0,

    revenue: account.revenue,
    revenueIfAllOnTime: world.metrics.revenueIfAllOnTime,
    labour: account.labourBase + account.labourOvertime,
    labourOvertime: account.labourOvertime,
    profit: account.profit,
    profitPerMonth: account.profitPerMonth,
  };
}

export interface Spread {
  median: number;
  p10: number;
  p90: number;
}

export interface BatchResult {
  label: string;
  runs: RunResult[];
  jobsCompleted: Spread;
  jobsLate: Spread;
  rushMissed: Spread;
  jobsAbandoned: Spread;
  averageBacklog: Spread;
  massSpecUtilisation: Spread;
  revenue: Spread;
  labour: Spread;
  labourOvertime: Spread;
  profit: Spread;
  profitPerMonth: Spread;
}

export function runBatch(
  label: string,
  scenario: Scenario,
  seeds: number[],
  options: BatchOptions = {},
): BatchResult {
  // Refuse an impossible scenario rather than spending fifty runs discovering
  // it. This is what the audit is for.
  assertScenarioIsPossible(scenario);

  const runs = seeds.map((seed) => runOnce(scenario, seed, options));
  const of = (pick: (r: RunResult) => number): Spread => spreadOf(runs.map(pick));

  return {
    label,
    runs,
    jobsCompleted: of((r) => r.jobsCompleted),
    jobsLate: of((r) => r.jobsLate),
    rushMissed: of((r) => r.rushMissed),
    jobsAbandoned: of((r) => r.jobsAbandoned),
    averageBacklog: of((r) => r.averageBacklog),
    massSpecUtilisation: of((r) => r.massSpecUtilisation),
    revenue: of((r) => r.revenue),
    labour: of((r) => r.labour),
    labourOvertime: of((r) => r.labourOvertime),
    profit: of((r) => r.profit),
    profitPerMonth: of((r) => r.profitPerMonth),
  };
}

/** A decision's effect measured seed by seed, rather than between two spreads. */
export interface Paired {
  /** The per-seed differences, variant minus base, in seed order. */
  differences: number[];
  median: number;
  p10: number;
  p90: number;
  /** Seeds where the difference came out better, and how many were counted. */
  wins: number;
  /** Seeds where it came out worse. Reported beside `wins` so that a row
   * reading "better in 3 of 10" cannot be misread as "worse in 7": the rest
   * may all be ties, which is a different finding entirely. */
  losses: number;
  seeds: number;
  /** Seeds where it came out exactly the same. */
  ties: number;
}

/**
 * The difference a decision makes, measured within each seed and then summarised.
 *
 * This is a different and much sharper question than subtracting one median from
 * another, and it is the one the verdict card has to answer. Both options face
 * the same fifty months of demand, so most of the spread in either column is the
 * weather: a month with four rush orders in one week is a hard month whichever
 * option is running. Comparing medians leaves that variation in, which is why
 * the headline difference looked small against enormous overlapping ranges.
 * Subtracting within a seed cancels it, and what is left is the decision.
 *
 * The honest statement a manager can act on is not an average. It is "better in
 * X of 10 months, typically by Y, and in the worst tenth it still costs Z" — so
 * `wins` is reported beside the spread, because a decision that helps a lot on
 * average and hurts one month in three is a different proposition from one that
 * helps a little every time.
 *
 * `better` says which direction counts as a win, because for jobs completed it
 * is up and for jobs late it is down. Getting that wrong would report a
 * regression as a success, so it is a required argument rather than a default.
 */
export function paired(
  base: BatchResult,
  variant: BatchResult,
  pick: (r: RunResult) => number,
  better: 'higher' | 'lower',
): Paired {
  // Paired at all only because the seeds line up. If they ever did not, the
  // subtraction would silently compare unrelated months and still return a
  // plausible-looking number — the exact failure this whole design avoids.
  if (base.runs.length !== variant.runs.length) {
    throw new Error('paired: the two batches ran different numbers of seeds');
  }

  const differences = base.runs.map((run, i) => {
    const other = variant.runs[i]!;
    if (run.seed !== other.seed) {
      throw new Error(`paired: seed mismatch at index ${i} (${run.seed} vs ${other.seed})`);
    }
    return pick(other) - pick(run);
  });

  const spread = spreadOf(differences);
  const isWin = (d: number) => (better === 'higher' ? d > 0 : d < 0);

  return {
    differences,
    median: spread.median,
    p10: spread.p10,
    p90: spread.p90,
    wins: differences.filter(isWin).length,
    losses: differences.filter((d) => d !== 0 && !isWin(d)).length,
    ties: differences.filter((d) => d === 0).length,
    seeds: differences.length,
  };
}

/**
 * Median and the 10th to 90th percentile.
 *
 * Median rather than mean because one catastrophic week should not be able to
 * move the headline, and P10-P90 rather than a standard deviation because the
 * distribution is not symmetric and nobody should have to assume it is. Nearest
 * rank, not interpolated: with fifty runs the difference is noise, and a real
 * observed value is easier to defend than a computed one.
 */
export function spreadOf(values: number[]): Spread {
  if (values.length === 0) return { median: 0, p10: 0, p90: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))]!;
  return { median: at(0.5), p10: at(0.1), p90: at(0.9) };
}
