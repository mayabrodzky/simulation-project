/**
 * Who works on what.
 *
 * Until now assignment happened *outside* the engine: the live view sent a
 * command when somebody clicked, and the batch runner handed out work between
 * `advance` calls. That second arrangement had a measurable cost. A2 guarantees
 * that stepping the engine coarsely matches stepping it finely, and a test
 * enforces it — but assignment from outside is not inside that guarantee, so a
 * coarser step also meant work was handed out less often. At a fifteen-minute
 * step the same seed completed 97 jobs where a one-minute step completed 102,
 * because people stood idle for up to a quarter of an hour beside work they
 * could have started.
 *
 * So the dispatcher lives in the slice loop, where the clamping already
 * guarantees that a slice never steps over the moment somebody becomes free.
 * The invariance guarantee then covers assignment too, and the batch runner can
 * step in hours rather than minutes.
 *
 * **No randomness anywhere.** Every ordering is total and every tie is broken by
 * id. Two runs of one seed must use the same people on the same jobs, or a
 * comparison between two options is measuring the dispatcher's coin-flips.
 */
import type { Job, Staff } from '../domain/types';
import type { EngineEvent } from './events';
import { attach, awaitsInstrumentOnly, canDoStep, isOpen } from './jobs';
import { allocate, claim, existsFor } from './resources';
import { isOnShift } from './shifts';
import type { WorldState } from './world';

/**
 * How the dispatcher picks a person for a job.
 *
 * Named because it changes the answer, not just the implementation. The lab
 * manager's stated complaint is that one senior person carries the lab, and
 * "who is carrying it" is a reported metric — so the dispatcher must not be the
 * thing that invents or erases that effect without anybody being able to see
 * which rule produced it.
 */
export type OperatorPolicy =
  /**
   * Whoever has been idle longest, by id. The naive rule, and the one the
   * measurements up to this point were taken under.
   */
  | 'first-free'
  /**
   * Fewest capabilities first.
   *
   * Do not burn the only mass-spec scientist on a centrifuge. The intent is to
   * keep scarce skills available, and whether it actually helps is an empirical
   * question this module deliberately does not assume the answer to.
   */
  | 'least-versatile';

export interface DispatchOptions {
  /** Off entirely, for the sandbox and for hands-on play. */
  enabled?: boolean;
  policy?: OperatorPolicy;
}

/**
 * Work in the order it should be taken.
 *
 * Earliest deadline, then rush, then arrival, then id. A total order: no two
 * jobs can compare equal, so the sequence is identical in every run of a seed.
 *
 * Earliest-deadline-first rather than shortest-job-first, which would complete
 * more jobs and miss more deadlines. That is a policy choice in favour of the
 * thing the lab manager is actually judged on.
 */
function byUrgency(a: Job, b: Job): number {
  if (a.dueAtMinute !== b.dueAtMinute) return a.dueAtMinute - b.dueAtMinute;
  if (a.rush !== b.rush) return a.rush ? -1 : 1;
  if (a.arrivedAtMinute !== b.arrivedAtMinute) return a.arrivedAtMinute - b.arrivedAtMinute;
  return a.id.localeCompare(b.id);
}

/** How many distinct things this person can do. The scarcity of their time. */
function versatility(person: Staff): number {
  return person.skills.length;
}

function byPolicy(policy: OperatorPolicy): (a: Staff, b: Staff) => number {
  if (policy === 'least-versatile') {
    return (a, b) => versatility(a) - versatility(b) || a.id - b.id;
  }
  return (a, b) => a.id - b.id;
}

/** Whether this person could be given new work this instant. */
export function isAvailable(world: WorldState, person: Staff): boolean {
  if (person.state !== 'idle') return false;
  if (person.jobId !== null || person.activeTask !== null) return false;
  // Nobody starts new work outside their own hours. Staying late to finish a
  // step is the only after-hours work there is, and that is not this.
  return isOnShift(person, world.simMinutes);
}

/**
 * Whether this job could be started right now by this person.
 *
 * A job whose attended phase is already done needs only an instrument, so it is
 * considered in the same pass as everything else — which is how a prepped
 * sample jumps ahead of newly arrived work when a machine frees up.
 */
function canStart(world: WorldState, person: Staff, job: Job): boolean {
  const step = job.steps[job.stepIndex];
  if (!step) return false;
  if (!canDoStep(person, step)) return false;

  // An instrument the lab does not own at all is not a reason to refuse: the
  // step completes on the spot, which is how a mis-specified scenario stays
  // visible instead of deadlocking. A7 reports it as an error.
  if (!existsFor(world, step.capability)) return true;

  // Needed now, rather than for an unattended phase later.
  if (step.resourceHeldDuring === 'unattended') return true;
  return allocate(world, step.capability) !== undefined;
}

/**
 * Puts prepped samples onto instruments that have just come free.
 *
 * A job whose preparation is finished needs an instrument and nobody else, so
 * it must not go through the dispatcher - see `awaitsInstrumentOnly` for what
 * happened when it did. This is the only path by which such a job starts
 * running, and it involves no person at all.
 *
 * Ordered by the same urgency rule the dispatcher uses, and run *before* it, so
 * a freed mass spectrometer goes to the sample already sitting beside it rather
 * than to work that has not been started. The hands-on minutes in a prepped
 * sample are already spent; making it queue behind fresh work wastes them.
 */
export function startPreppedRuns(world: WorldState, events: EngineEvent[]): void {
  // Scanned before anything is allocated, because this runs on every slice of
  // every run and the job list grows all month. Building and sorting an array
  // each time cost more than the rest of the loop put together: a forty-day
  // headless run went from seconds to over twenty. Nothing is allocated unless
  // something is actually queueing, and nothing is sorted unless two things
  // are competing for the same machine.
  let queue: Job[] | null = null;
  for (const job of world.jobs) {
    // One field read rejects everything that is not queueing, which is almost
    // every job almost always. `preppedAtMinute` is set at exactly the moment
    // a handover fails to find an instrument and cleared the moment one is
    // claimed, so it is the marker for this state and not merely a timestamp.
    if (job.preppedAtMinute === null) continue;
    if (!awaitsInstrumentOnly(world, job)) continue;
    (queue ??= []).push(job);
  }
  if (queue === null) return;
  if (queue.length > 1) queue.sort(byUrgency);

  for (const job of queue) {
    const step = job.steps[job.stepIndex];
    if (!step) continue;

    const machine = allocate(world, step.capability);
    if (!machine) continue;

    const waited = job.preppedAtMinute === null ? 0 : world.simMinutes - job.preppedAtMinute;

    claim(world, machine, job);
    job.status = 'unattended';
    job.blockReason = null;
    job.preppedAtMinute = null;
    events.push({
      type: 'job-on-instrument',
      jobId: job.id,
      name: job.name,
      minutes: step.unattendedRemaining,
      waited,
    });
  }
}

/**
 * Hands out as much work as can be started this instant.
 *
 * Jobs in urgency order, and for each the best available person under the
 * policy. Jobs rather than people in the outer loop, deliberately: iterating
 * people would give the first person the most urgent job they *personally* can
 * do, which quietly reorders the queue by who happens to be free.
 *
 * Pinned jobs are skipped — a human chose that pairing and the dispatcher does
 * not override it.
 */
export function dispatch(
  world: WorldState,
  events: EngineEvent[],
  options: DispatchOptions = {},
): void {
  if (options.enabled === false) return;
  const policy = options.policy ?? 'first-free';

  const free = world.staff.filter((person) => isAvailable(world, person));
  if (free.length === 0) return;

  const queue = world.jobs
    .filter(
      (job) =>
        isOpen(job) &&
        job.stepIndex < job.steps.length &&
        // Prepped and waiting for an instrument: no person can help it, and
        // offering it to one burned a slice of their paid time per cadence.
        !awaitsInstrumentOnly(world, job),
    )
    .sort(byUrgency);
  if (queue.length === 0) return;

  const order = byPolicy(policy);
  const available = [...free].sort(order);

  for (const job of queue) {
    if (available.length === 0) break;
    if (job.pinnedStaffId !== null) continue;

    const at = available.findIndex((person) => canStart(world, person, job));
    if (at === -1) continue;

    const person = available[at]!;
    available.splice(at, 1);
    attach(world, person, job, false);
    events.push({
      type: 'job-assigned',
      jobId: job.id,
      name: job.name,
      staffId: person.id,
      staffName: person.name,
    });
  }
}
