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
 */
import type { BlockReason, Equipment, Job, JobStep, Staff, StaffId } from '../domain/types';
import type { EngineEvent } from './events';
// Straight from the calendar rather than through shifts.ts, which imports
// this module: a cycle would resolve at runtime and is not worth relying on.
import { isWithinShift } from './calendar';
import { chargeMaterials } from './money';
import { fatiguePace } from './shifts';
import { EPSILON, hasArrivedAt, hasReached } from './geometry';
import {
  allBusyFor,
  allocate,
  claim,
  existsFor,
  hasFreeSlot,
  instrumentsFor,
  releaseSlots,
} from './resources';
import { findStaff, type WorldState } from './world';

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
  // No step means nothing to do, which is not the same as anybody being able
  // to do it. Both callers depend on that: one refuses the assignment and the
  // other decides whether to offer it.
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
  releaseSlots(world, job.id);
  job.equipmentId = null;
}

/**
 * Where the current step would be done.
 *
 * The instrument this job already holds if it holds one, otherwise any free
 * instrument offering the capability, otherwise the first that offers it at all
 * - so somebody walks to a busy instrument and waits there, which makes
 * contention visible on the floor rather than only in a number.
 */
function currentStepMachine(world: WorldState, job: Job): Equipment | undefined {
  const step = job.steps[job.stepIndex];
  if (!step) return undefined;
  if (job.equipmentId !== null) {
    const held = world.equipment.find((e) => e.id === job.equipmentId);
    if (held) return held;
  }
  return allocate(world, step.capability) ?? instrumentsFor(world, step.capability)[0];
}

function walkToCurrentStep(world: WorldState, person: Staff, job: Job): void {
  const machine = currentStepMachine(world, job);
  if (machine) {
    person.targetX = machine.x;
    person.targetY = machine.y;
  } else {
    // A step asking for a capability the lab does not have is done on the spot,
    // which is how the original behaved. It keeps a mis-specified scenario from
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
    world.metrics.jobsAbandoned += 1;
    // Nothing is charged. The materials already spent are not refunded and are
    // already in the account, which is the whole cost of an abandoned job.
    world.metrics.revenueIfAllOnTime += job.basePrice;
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
  const step = job.steps[job.stepIndex];
  if (!step) {
    settle(world, job, operator, events);
    return;
  }

  if (operator.state !== 'working') {
    startStep(world, job, operator, step);
    return;
  }

  // Fatigue, in one line at one call site. Past the weekly threshold the same
  // minute of presence buys less work done — which is what "tasks take 10%
  // longer" means, expressed as a rate rather than as a stored flag on a tired
  // person.
  step.remaining -= dt / fatiguePace(world, operator);
  if (step.remaining > EPSILON) return;

  // Clamped to zero rather than left at float dust, so a step that is finished
  // reads as finished everywhere, including in a progress bar.
  step.remaining = 0;

  // The attended phase is over. If the instrument still has work to do alone,
  // the operator is released *now* and is dispatchable in the same slice, while
  // the job stays alive with its instrument running. This is the whole point of
  // the split: a mass spectrometer can be the lab's bottleneck without its
  // scientist being one.
  if (step.unattendedRemaining > EPSILON) {
    handOverToInstrument(world, job, operator, step, events);
    return;
  }

  releaseMachine(world, job);
  job.stepIndex += 1;

  if (job.stepIndex >= job.steps.length) {
    settle(world, job, operator, events);
    return;
  }

  // Out of hours, they were only staying to finish this step. Now it is done,
  // they go home and the job waits for the morning.
  if (!isWithinShift(operator.shift, world.simMinutes)) {
    release(world, job);
    operator.state = 'off';
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
      nextStep: job.steps[job.stepIndex]?.capability ?? '',
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
function startStep(world: WorldState, job: Job, operator: Staff, step: JobStep): void {
  // A step that holds its instrument only while running unattended needs none
  // during preparation - mass-spec prep is sixty minutes at a bench, and
  // charging the instrument for it would make the spec's own numbers infeasible.
  const needsInstrumentNow = step.resourceHeldDuring !== 'unattended';

  if (existsFor(world, step.capability)) {
    const machine = currentStepMachine(world, job);
    if (!machine) return;
    if (!hasArrivedAt(operator, machine)) return;

    if (needsInstrumentNow && job.equipmentId !== machine.id) {
      if (!hasFreeSlot(machine)) return; // stand and wait; A3c names why
      claim(world, machine, job);
    }
  }

  operator.targetX = null;
  operator.targetY = null;
  operator.state = 'working';

  // Materials, once, when work genuinely begins on the job. Charged here rather
  // than at arrival because a job nobody ever starts has cost nothing, and
  // never refunded because the reagents are gone whatever the client pays.
  if (!job.materialsCharged) {
    job.materialsCharged = true;
    chargeMaterials(world, job.basePrice);
  }
}

/**
 * Hands the step over to the instrument and gives the person back.
 *
 * The job becomes `unattended`: alive, holding its instrument, with nobody
 * attached. Its unattended minutes then run on the instrument's clock, which is
 * not a person's - through nights and weekends, with no overnight special case
 * anywhere.
 */
function handOverToInstrument(
  world: WorldState,
  job: Job,
  operator: Staff,
  step: JobStep,
  events: EngineEvent[],
): void {
  // A step that only holds its instrument unattended claims it at this moment,
  // not before. If none is free the job waits here with the work prepped and
  // the operator already released - and *that queue is the bottleneck*, the one
  // state in the machine that represents it.
  if (step.resourceHeldDuring !== 'attended' && existsFor(world, step.capability)) {
    if (job.equipmentId === null) {
      const machine = allocate(world, step.capability);
      if (!machine) {
        // Prepped and waiting for an instrument. The operator goes free anyway:
        // keeping them standing over finished preparation is exactly the
        // confusion between people and instruments this step removes.
        detachOperator(job, operator);
        job.status = 'waiting';
        return;
      }
      claim(world, machine, job);
    }
  } else {
    releaseMachine(world, job);
  }

  detachOperator(job, operator);
  job.status = 'unattended';
  events.push({
    type: 'job-unattended',
    jobId: job.id,
    name: job.name,
    staffId: operator.id,
    staffName: operator.name,
    minutes: step.unattendedRemaining,
  });
}

/** Frees the person without touching the job's instrument or its counters. */
function detachOperator(job: Job, operator: Staff): void {
  job.operatorId = null;
  operator.jobId = null;
  operator.state = 'idle';
  operator.targetX = null;
  operator.targetY = null;
}

/**
 * Advances every instrument running on its own.
 *
 * The one clock in the simulation that no shift bounds. A 48-hour incubation
 * started on Thursday afternoon finishes on Saturday whether or not anybody is
 * in the building, and that needs no overnight code - only the absence of a
 * shift check.
 */
export function tickUnattended(world: WorldState, dt: number, events: EngineEvent[]): void {
  for (const job of world.jobs) {
    if (job.status !== 'unattended') continue;

    const step = job.steps[job.stepIndex];
    if (!step) {
      job.status = 'waiting';
      continue;
    }

    // Still waiting for a free instrument rather than running on one.
    if (step.resourceHeldDuring !== 'attended' && job.equipmentId === null) {
      if (!existsFor(world, step.capability)) {
        job.status = 'waiting';
        continue;
      }
      const machine = allocate(world, step.capability);
      if (!machine) continue;
      claim(world, machine, job);
    }

    step.unattendedRemaining -= dt;
    if (step.unattendedRemaining > EPSILON) continue;

    step.unattendedRemaining = 0;
    releaseMachine(world, job);
    job.stepIndex += 1;

    events.push({
      type: 'job-off-instrument',
      jobId: job.id,
      name: job.name,
      stepsLeft: job.steps.length - job.stepIndex,
    });

    // The instrument may have finished the *last* step, in which case the job
    // is done and nobody is attached to it. Parking it as `waiting` instead
    // left it permanently unfinishable - see settle.
    if (job.stepIndex >= job.steps.length) {
      settle(world, job, undefined, events);
      continue;
    }

    job.status = 'waiting';
  }
}

/** Minutes until the soonest unattended run finishes. */
export function nextUnattendedEventIn(world: WorldState): number {
  let soonest = Infinity;
  for (const job of world.jobs) {
    if (job.status !== 'unattended') continue;
    const step = job.steps[job.stepIndex];
    if (!step || job.equipmentId === null) continue;
    if (step.unattendedRemaining > EPSILON && step.unattendedRemaining < soonest) {
      soonest = step.unattendedRemaining;
    }
  }
  return soonest;
}

/**
 * Finishes and pays for a job.
 *
 * The operator is optional, and that is the whole of a bug worth recording: the
 * last step of a job can be completed by an *instrument*, with nobody attached.
 * Mass spectrometry is a single step whose final phase runs unattended, so
 * every one of the thirty a week reached the end of its work and was never
 * settled - it went back to `waiting` with `stepIndex` past the end of its own
 * step list.
 *
 * Those jobs were invisible in the worst way. With no current step they had no
 * block reason, so nothing reported them; they reported themselves as
 * *qualified* for everybody, because a missing step requires no skill; they
 * sorted to the front of the queue by having the oldest deadline; and every
 * assignment attempt was then refused. Throughput fell to zero over four
 * simulated days while the backlog filled with work that could not be done,
 * finished, or seen.
 */
function settle(
  world: WorldState,
  job: Job,
  operator: Staff | undefined,
  events: EngineEvent[],
): void {
  // Tolerant the other way: finishing at the deadline is on time.
  const onTime = !hasReached(world.simMinutes, job.dueAtMinute + EPSILON);

  job.status = onTime ? 'done-on-time' : 'done-late';
  job.completedAtMinute = world.simMinutes;
  job.settledRevenue = settlementFor(world, job, onTime);

  world.money += job.settledRevenue;
  world.metrics.revenue += job.settledRevenue;
  // What the same work would have earned on time, so lateness has a price
  // rather than being an absence from the revenue line.
  world.metrics.revenueIfAllOnTime += settlementFor(world, job, true);
  world.metrics.jobsCompleted += 1;
  if (!onTime) world.metrics.jobsLate += 1;

  releaseMachine(world, job);
  job.operatorId = null;
  if (operator) {
    operator.jobId = null;
    operator.state = 'idle';
    operator.targetX = null;
    operator.targetY = null;
  }

  events.push({
    type: 'job-completed',
    jobId: job.id,
    name: job.name,
    onTime,
    revenue: job.settledRevenue,
    minutesLate: onTime ? 0 : world.simMinutes - job.dueAtMinute,
  });
}

/**
 * What a finished job actually pays.
 *
 * Four cases, and the asymmetry between them is the whole reason a rush order
 * is a decision rather than a bonus:
 *
 * | | on time | late |
 * |---|---|---|
 * | ordinary | price | 80% of price |
 * | rush | 150% of price | 70% of price |
 *
 * A 900 shekel job quoted as a rush is worth 1,350 landed and 630 missed, a
 * swing of 720 against roughly 225 of materials already spent. The same job
 * ordinary swings by 180. Nothing invented a penalty: a missed rush is
 * expensive because the premium is lost *and* part of the ordinary price is
 * refunded, and it pays less than an ordinary late job because the client was
 * promised something and planned around it.
 *
 * This replaces `penalty`, a flat charge that could be levied on work nobody
 * could have reached - the mechanism by which a simulated fortnight reached
 * minus a quarter of a million shekels.
 */
export function settlementFor(world: WorldState, job: Job, onTime: boolean): number {
  const t = world.tuning;
  if (onTime) return job.rush ? job.basePrice * t.rushPriceMultiplier : job.basePrice;
  if (!job.rush) return job.basePrice * t.latePriceFraction;
  return job.basePrice * (1 - t.rushFailRefundFraction);
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

/* --- Why work is not moving ----------------------------------------------- */

/**
 * Recomputes `blockReason` for everything waiting.
 *
 * Advisory and recomputed from scratch every pass. It is **never an absorbing
 * state**: a blocked job is still `waiting` as far as every other rule is
 * concerned, still assignable, still expirable. Treating "blocked" as a real
 * state a job moves *into* is the likeliest way to ship a simulation that
 * deadlocks by doing nothing — the Phase 1 failure shape, where the system
 * fails silently rather than loudly.
 *
 * The point of it is not the status but the *reason*. Counted by reason over a
 * run, this is the "what is holding the lab back" sentence obtained directly
 * rather than inferred from utilisation figures. A week of this lab spends
 * roughly sixty hours with people standing at instruments somebody else is
 * using; without a reason recorded, that is invisible in every output.
 *
 * Reasons are ordered by how actionable they are, not by how likely: a job that
 * nobody in the building could do is a training or hiring decision, which is
 * worth more to know than that the lab is shut.
 */
export function recomputeBlockReasons(world: WorldState, events: EngineEvent[]): void {
  // At most once a simulated minute. This walks every open job against every
  // person, and the slice loop runs it hundreds of thousands of times for a
  // simulated week — unthrottled it took the step-size invariance test from two
  // seconds to over twelve, which is the second time in this phase that
  // something cheap-looking per slice has been the expensive thing.
  //
  // The cost is that a reason, and therefore a stall report, can be up to a
  // minute behind. Acceptable precisely because nothing *decides* anything from
  // it: it reports. Every quantity a metric is built from is still exact.
  if (world.simMinutes - world.blockReasonsAtMinute < 1) return;
  world.blockReasonsAtMinute = world.simMinutes;

  const open = world.staff.some((person) => isWithinShift(person.shift, world.simMinutes));

  for (const job of world.jobs) {
    if (!isOpen(job)) {
      setBlock(world, job, null, events);
      continue;
    }

    const step = job.steps[job.stepIndex];
    if (!step) {
      setBlock(world, job, null, events);
      continue;
    }

    // Nobody employed here holds the skill. A training or a hire, and true
    // whether or not the lab happens to be open.
    const capable = world.staff.filter((person) => canDoStep(person, step));
    if (capable.length === 0) {
      setBlock(world, job, 'no-qualified-operator', events);
      continue;
    }

    if (!existsFor(world, step.capability)) {
      setBlock(world, job, 'no-such-resource', events);
      continue;
    }

    if (!open) {
      setBlock(world, job, 'outside-working-hours', events);
      continue;
    }

    // Somebody could do it, so what is in the way is either the instrument or
    // the people being busy elsewhere. Distinguishing the two is the whole
    // point: one is answered by leasing an instrument and the other by hiring.
    // Every instrument offering this capability is full. Distinct from the
    // people being busy, and answered by a different decision.
    if (allBusyFor(world, step.capability)) {
      setBlock(world, job, 'resource-busy', events);
      continue;
    }

    const free = capable.some(
      (person) => person.state === 'idle' && person.jobId === null && person.activeTask === null,
    );
    setBlock(world, job, free ? null : 'everyone-busy', events);
  }
}

/**
 * Records why a job is held up, and how long it has been.
 *
 * The only writer of `blockReason`, which is what lets the duration be tracked
 * without every branch above remembering to. A *change* of reason restarts the
 * clock: waiting for an instrument and then waiting for a person are two
 * separate waits, and reporting them as one long stall would name the wrong
 * cause.
 */
function setBlock(
  world: WorldState,
  job: Job,
  reason: BlockReason | null,
  events: EngineEvent[],
): void {
  if (reason === null) {
    job.blockReason = null;
    job.blockedSinceMinute = null;
    job.stallReported = false;
    return;
  }

  if (job.blockReason !== reason) {
    job.blockReason = reason;
    job.blockedSinceMinute = world.simMinutes;
    job.stallReported = false;
    return;
  }

  const since = job.blockedSinceMinute ?? world.simMinutes;
  const blockedFor = world.simMinutes - since;
  if (!job.stallReported && blockedFor >= world.tuning.stalledAfterHours * 60) {
    job.stallReported = true;
    events.push({
      type: 'job-stalled',
      jobId: job.id,
      name: job.name,
      reason,
      blockedForMinutes: blockedFor,
    });
  }
}

/** How long each reason has held work up, in job-minutes. For the audit. */
export function blockedMinutesByReason(world: WorldState): Record<BlockReason, number> {
  const totals: Record<BlockReason, number> = {
    'no-qualified-operator': 0,
    'everyone-busy': 0,
    'resource-busy': 0,
    'outside-working-hours': 0,
    'no-such-resource': 0,
  };
  for (const job of world.jobs) {
    if (job.blockReason !== null) totals[job.blockReason] += 1;
  }
  return totals;
}
