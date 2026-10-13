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
import { applyCommand } from '../engine/commands';
import { listAssignableJobs } from '../engine/queries';
import { instrumentsFor } from '../engine/resources';
import { advance } from '../engine/tick';
import { createWorld, type WorldState } from '../engine/world';

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
}

export interface BatchOptions {
  weeks?: number;
}

/**
 * How often work is handed out, in simulated minutes.
 *
 * Fixed rather than configurable, and the reason is a measurement worth
 * recording. Stepping the engine coarsely *is* equivalent to stepping it finely
 * — A2 guarantees it and a test enforces it. But assignment happens **between**
 * `advance` calls, from out here, so a coarser step also means work is handed
 * out less often: at a 15-minute step the same seed completed 97 jobs where a
 * 1-minute step completed 102, because people stood idle for up to a quarter of
 * an hour next to work they could have started.
 *
 * That is not a flaw in the engine. It is the consequence of the dispatcher not
 * being *in* the engine yet, so its cadence is whatever the caller's loop
 * happens to be. Until B3 moves dispatch inside the slice loop — where it will
 * run at event boundaries like everything else — a fast run and a watched run
 * would disagree, and the only honest setting is the finest one.
 *
 * So the batch runner is currently as slow as the live view per simulated
 * minute, which is the price of the comparison meaning anything. B3 buys the
 * speed back.
 */
const DISPATCH_EVERY_MINUTES = 1;

const SUNDAY_0800 = 480;

/**
 * Takes the most urgent job each free person can start.
 *
 * Deliberately simple, and deliberately the *same* rule for every option being
 * compared. B3 builds a real dispatcher with a named operator policy; using a
 * clever one here would mean a comparison measured the policy as much as the
 * decision, and a different policy might favour one option over another.
 */
function assignWhatWeCan(world: WorldState): void {
  for (const person of world.staff) {
    if (person.state !== 'idle' || person.jobId !== null || person.activeTask) continue;
    const pick = listAssignableJobs(world, person).filter((row) => row.qualified)[0];
    if (pick) applyCommand(world, { type: 'ASSIGN_JOB', staffId: person.id, jobId: pick.id });
  }
}

export function runOnce(scenario: Scenario, seed: number, options: BatchOptions = {}): RunResult {
  const weeks = options.weeks ?? 4;
  const step = DISPATCH_EVERY_MINUTES;
  const totalMinutes = weeks * 7 * MINUTES_PER_DAY;

  const world = createWorld(scenario, seed, SUNDAY_0800);

  let backlogSamples = 0;
  let backlogTotal = 0;

  for (let elapsed = 0; elapsed < totalMinutes; elapsed += step) {
    advance(world, step);
    assignWhatWeCan(world);

    // Sampled hourly rather than every step: the mean is the same and the cost
    // is not, and a step-size change must not alter a reported metric.
    if (Math.floor(elapsed / 60) !== Math.floor((elapsed - step) / 60)) {
      backlogSamples += 1;
      backlogTotal += world.jobs.filter(
        (job) => job.status === 'waiting' || job.status === 'blocked',
      ).length;
    }
  }

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
