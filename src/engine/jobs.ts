/**
 * The life of a job: taken up, worked, finished, or abandoned.
 *
 * The important structural change here is that **the loop iterates jobs, not
 * people**. Before, work was a field on a person, so a person had to exist and
 * be available for work to exist at all — which is why nothing could queue,
 * nothing could wait for a machine, and an interruption had to be unwound by
 * hand.
 *
 * Progress is held as `remaining` on the job's current step. That single choice
 * is what makes every interruption free: a shift ending, a person going sick, a
 * reassignment and later a breakdown are all "stop decrementing", with no code
 * of their own and nothing to restore on resume. Nothing anywhere records when
 * a step started, so nothing can disagree about it.
 *
 * What is deliberately *not* here yet:
 *   - **Lateness costs nothing.** A job records `done-late` and still pays its
 *     base price. The partial-credit arithmetic belongs with rush orders in A6,
 *     where the asymmetry that makes a missed rush expensive lives.
 *   - **Nothing chooses who works on what.** Assignment is a command from the
 *     interface. The dispatcher is B3.
 *   - **`blocked` is never set.** A job that wants a busy machine waits as
 *     `in-progress` with its operator standing there. A3c makes that visible,
 *     which is what turns a stalled queue into a stated reason.
 */
import type { Equipment, Job, JobStep, Staff, StaffId } from '../domain/types';
import type { EngineEvent } from './events';
import { EPSILON, hasArrivedAt, hasReached } from './geometry';
import { findEquipmentByName, findStaff, type WorldState } from './world';

/** Statuses from which a job can still be picked up. */
export function isOpen(job: Job): boolean {
  return job.status === 'waiting' || job.status === 'blocked';
}

/** Statuses from which nothing more will happen. */
export function isFinished(job: Job): boolean {
  return job.status === 'done-on-time' || job.status === 'done-late' || job.status === 'expired';
}

export function findJob(world: WorldState, id: string): Job | undefined {
  return world.jobs.find((job) => job.id === id);
}

/** The job this person is on, if any. */
export function jobOf(world: WorldState, person: Staff): Job | undefined {
  return person.jobId === null ? undefined : findJob(world, person.jobId);
}

/**
 * Whether this person can do the step the job is on *now*.
 *
 * One step, not the whole remaining job — and that distinction decides which
 * constraint binds the lab, so it is worth stating why.
 *
 * Requiring one person to hold every skill a job needs sounds stricter and
 * safer. It is neither: with this scenario's staff it makes 96 of the 186
 * offered hours a week structurally impossible, because nobody rostered holds
 * both PCR Operation and Spectrophotometry, or all three skills a cell culture
 * needs. The lab would then be limited by one technician's skill set rather
 * than by the mass spectrometer the scenario is built around — and a load audit
 * run against it would report a bottleneck that is an artefact of this
 * function.
 *
 * Real labs hand a sample from one specialist to the next between steps, which
 * is also what the plan's handover design assumes. So qualification is per
 * step, and a job changes hands when it has to.
 */
export function canDoStep(person: Staff, step: JobStep | undefined): boolean {
  if (!step) return false;
  return step.skillRequired === null || person.skills.includes(step.skillRequired);
}

/** Whether this person can take the job on as it stands. */
export function canOperate(person: Staff, job: Job): boolean {
  return canDoStep(person, job.steps[job.stepIndex]);
}

/** The skill the current step needs and this person lacks, if any. */
export function missingSkillsFor(person: Staff, job: Job): string[] {
  const step = job.steps[job.stepIndex];
  if (!step || canDoStep(person, step)) return [];
  return step.skillRequired === null ? [] : [step.skillRequired];
}

/**
 * Attaches a person to a job and starts them walking to the first machine.
 *
 * Both sides of the pairing are written here and nowhere else, which is what
 * keeps `person.jobId` and `job.operatorId` from drifting apart.
 */
export function attach(world: WorldState, person: Staff, job: Job, pinned: boolean): void {
  person.jobId = job.id;
  job.operatorId = person.id;
  job.status = 'in-progress';
  job.blockReason = null;
  if (pinned) job.pinnedStaffId = person.id;

  // Idle rather than working: they have to get there first. Work begins at the
  // instant of arrival, which the slice loop lands on exactly.
  person.state = 'idle';
  walkToCurrentStep(world, person, job);
}

/**
 * Detaches whoever is on this job and gives back any machine it holds.
 *
 * The job goes back to `waiting` with its counters untouched, which is the
 * whole point: there is nothing to save and nothing to restore. Used by a shift
 * ending, by sickness, and by an operator who has vanished.
 */
export function release(world: WorldState, job: Job): void {
  const operator = job.operatorId === null ? undefined : findStaff(world, job.operatorId);
  if (operator) {
    operator.jobId = null;
    operator.targetX = null;
    operator.targetY = null;
    if (operator.state === 'working') operator.state = 'idle';
  }
  releaseMachine(world, job);
  job.operatorId = null;
  if (!isFinished(job)) job.status = 'waiting';
}

/** Releases whatever this person is holding, if anything. Called by commands. */
export function releaseJobOf(world: WorldState, person: Staff): Job | undefined {
  const job = jobOf(world, person);
  if (job) release(world, job);
  else person.jobId = null;
  return job;
}

function releaseMachine(world: WorldState, job: Job): void {
  if (job.equipmentId === null) return;
  const machine = world.equipment.find((e) => e.id === job.equipmentId);
  if (machine) {
    machine.inUse = false;
    machine.assignedTo = null;
  }
  job.equipmentId = null;
}

function currentStepMachine(world: WorldState, job: Job): Equipment | undefined {
  const step = job.steps[job.stepIndex];
  return step ? findEquipmentByName(world, step.name) : undefined;
}

function walkToCurrentStep(world: WorldState, person: Staff, job: Job): void {
  const machine = currentStepMachine(world, job);
  if (machine) {
    person.targetX = machine.x;
    person.targetY = machine.y;
  } else {
    // A step naming a machine that does not exist is done on the spot, which is
    // how the original behaved. It keeps a mis-specified scenario from
    // deadlocking; A7 reports it as a scenario error instead of hiding it.
    person.targetX = null;
    person.targetY = null;
  }
}

/* --- Advancing ------------------------------------------------------------ */

/**
 * Minutes until the next thing a job needs the loop to land on exactly.
 *
 * A step finishing, and a client giving up. A deadline passing is not here: it
 * changes no state when it happens, only what the comparison at settlement
 * says, so stepping over one is harmless.
 */
export function nextJobEventIn(world: WorldState): number {
  let soonest = Infinity;
  for (const job of world.jobs) {
    if (job.status === 'in-progress') {
      const operator = job.operatorId === null ? undefined : findStaff(world, job.operatorId);
      const step = job.steps[job.stepIndex];
      if (step && operator?.state === 'working' && step.remaining > EPSILON) {
        if (step.remaining < soonest) soonest = step.remaining;
      }
    } else if (isOpen(job)) {
      const until = job.expiresAtMinute - world.simMinutes;
      if (until > EPSILON && until < soonest) soonest = until;
    }
  }
  return soonest;
}

/** Clients give up on work that has sat too long past its deadline. */
export function expireAbandonedJobs(world: WorldState, events: EngineEvent[]): void {
  for (const job of world.jobs) {
    if (!isOpen(job)) continue;
    if (!hasReached(world.simMinutes, job.expiresAtMinute)) continue;

    job.status = 'expired';
    job.completedAtMinute = world.simMinutes;
    world.metrics.tasksFailed += 1;
    events.push({
      type: 'job-expired',
      jobId: job.id,
      name: job.name,
      workingDaysLate: world.tuning.abandonAfterWorkingDays,
    });
  }
}

/**
 * Advances every job that someone is on.
 *
 * Called after people have moved, so that arrival and the start of work are the
 * same instant rather than a slice apart — the ordering A2 established and
 * tested.
 */
export function tickJobs(world: WorldState, dt: number, events: EngineEvent[]): void {
  for (const job of world.jobs) {
    if (job.status !== 'in-progress') continue;
    tickOneJob(world, job, dt, events);
  }
}

function tickOneJob(world: WorldState, job: Job, dt: number, events: EngineEvent[]): void {
  const operator = job.operatorId === null ? undefined : findStaff(world, job.operatorId);

  // The operator is gone, or no longer able to work. The job simply stops; its
  // counters are already where they should be.
  if (!operator || operator.state === 'sick' || operator.state === 'vacation') {
    release(world, job);
    return;
  }
  // On a break, holding whatever they hold. Energy disappears in B1 and this
  // case with it.
  if (operator.state === 'break') return;

  const step = job.steps[job.stepIndex];
  if (!step) {
    settle(world, job, operator, events);
    return;
  }

  if (operator.state !== 'working') {
    startStep(world, job, operator, step.name);
    return;
  }

  step.remaining -= dt;
  if (step.remaining > EPSILON) return;

  // Clamped to zero rather than left at float dust, so a step that is finished
  // reads as finished everywhere, including in a progress bar.
  step.remaining = 0;
  releaseMachine(world, job);
  job.stepIndex += 1;

  if (job.stepIndex >= job.steps.length) {
    settle(world, job, operator, events);
    return;
  }

  // The operator keeps the job only if they can do what comes next. Otherwise
  // it goes back to the queue, prepped, for whoever can — which is the handover
  // a real lab does between specialists, and the thing that makes the whole
  // 186 hours a week reachable at all.
  if (!canDoStep(operator, job.steps[job.stepIndex])) {
    events.push({
      type: 'job-handed-over',
      jobId: job.id,
      name: job.name,
      staffId: operator.id,
      staffName: operator.name,
      nextStep: job.steps[job.stepIndex]?.name ?? '',
    });
    release(world, job);
    return;
  }

  operator.state = 'idle';
  walkToCurrentStep(world, operator, job);
}

/**
 * Takes hold of the machine for the current step, if it is free.
 *
 * Returns without starting when the operator is still walking, or when the
 * machine is busy — in which case they stand and wait. A3c names that wait.
 */
function startStep(world: WorldState, job: Job, operator: Staff, machineName: string): void {
  const machine = findEquipmentByName(world, machineName);

  if (machine) {
    if (!hasArrivedAt(operator, machine)) return;
    if (machine.inUse && machine.assignedTo !== operator.id) return;
    machine.inUse = true;
    machine.assignedTo = operator.id;
    job.equipmentId = machine.id;
  }

  operator.targetX = null;
  operator.targetY = null;
  operator.state = 'working';
}

function settle(world: WorldState, job: Job, operator: Staff, events: EngineEvent[]): void {
  // Tolerant the other way: finishing at the deadline is on time.
  const onTime = !hasReached(world.simMinutes, job.dueAtMinute + EPSILON);

  job.status = onTime ? 'done-on-time' : 'done-late';
  job.completedAtMinute = world.simMinutes;
  // Full price either way for now. A6 makes a late job pay 80% and a missed
  // rush order lose its premium and refund part of the base, which is the
  // asymmetry that makes lateness something to decide about.
  job.settledRevenue = job.basePrice;

  world.money += job.settledRevenue;
  world.metrics.revenue += job.settledRevenue;
  world.metrics.tasksCompleted += 1;

  releaseMachine(world, job);
  job.operatorId = null;
  operator.jobId = null;
  operator.state = 'idle';
  operator.targetX = null;
  operator.targetY = null;

  events.push({
    type: 'job-completed',
    jobId: job.id,
    name: job.name,
    onTime,
    revenue: job.settledRevenue,
    minutesLate: onTime ? 0 : world.simMinutes - job.dueAtMinute,
  });
}

/* --- Assignment ----------------------------------------------------------- */

export type AssignOutcome =
  | { ok: true; job: Job }
  | {
      ok: false;
      reason: 'no-such-job' | 'job-not-open' | 'not-idle' | 'unqualified';
      detail?: string;
    };

/**
 * Hands a waiting job to a person.
 *
 * Validation only; the refusal reasons are returned rather than phrased, so the
 * interface chooses the words. `pinned` records that a human chose this pairing,
 * which the dispatcher in B3 must not override.
 */
export function assignJob(
  world: WorldState,
  staffId: StaffId,
  jobId: string,
  pinned: boolean,
): AssignOutcome {
  const person = findStaff(world, staffId);
  if (!person) return { ok: false, reason: 'no-such-job' };

  const job = findJob(world, jobId);
  if (!job) return { ok: false, reason: 'no-such-job', detail: jobId };
  if (!isOpen(job)) return { ok: false, reason: 'job-not-open', detail: job.name };

  if (person.state !== 'idle' || person.jobId !== null || person.activeTask) {
    return { ok: false, reason: 'not-idle', detail: person.name };
  }
  if (!canOperate(person, job)) return { ok: false, reason: 'unqualified', detail: person.name };

  attach(world, person, job, pinned);
  return { ok: true, job };
}
