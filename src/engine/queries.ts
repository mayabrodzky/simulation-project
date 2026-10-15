/**
 * Questions the interface asks about a world.
 *
 * The view and the renderer used to read the simulation's shapes directly —
 * `person.activeTask.equipmentSequence[person.taskStep].duration` to draw a
 * progress bar. That couples every panel to the internal model, so changing
 * the model means finding every read scattered through the view, with nothing
 * to say when one has been missed.
 *
 * Here the interface asks *what is this person doing* and *what work is in
 * progress*, and gets back plain display data: strings, numbers, booleans.
 * When work stops being a field on a person and becomes an entity of its own,
 * the answers are rewritten here, in one typed file, and the panels do not
 * notice.
 *
 * Everything returned is already formatted for display and owns no references
 * into the world, so a caller cannot accidentally mutate the simulation by
 * holding on to one.
 */
import type { BlockReason, Job, Staff, StaffId } from '../domain/types';
import { clockLabel as formatClock, dayLabel, minuteOfDay } from './calendar';
import { awaitsInstrumentOnly } from './jobs';
import type { WorldState } from './world';

/** What one person is doing, as the staff panel and the canvas want it. */
export interface AssignmentView {
  /** The name of the work, for "Task: …". */
  label: string;
  /** Plain-language state: "Processing", "Moving to equipment". */
  statusText: string;
  /** 0–1. Zero when not yet started. */
  progress: number;
  isTraining: boolean;
}

/** One item for the ongoing-work panel. */
export interface ActiveWorkView {
  id: string;
  name: string;
  assignee: string;
  statusText: string;
  /** 0–1. */
  progress: number;
}

/** One item for the panel that lists work under time pressure. */
export interface UrgentWorkView {
  id: string;
  name: string;
  /** "Waiting" or "In Progress". */
  status: string;
  /** Seconds remaining, as the countdown is currently measured. */
  timeLeft: number;
  urgent: boolean;
}

/** One kind of work, with how much of it is waiting. */
export interface QueueLineView {
  workTypeId: string;
  name: string;
  /** How many have arrived and not yet been started. */
  waiting: number;
  /** Of those, how many are already past their deadline. */
  overdue: number;
  /** Working time until the soonest deadline among them, or null if none wait. */
  soonestDueInMinutes: number | null;
  /** Hands-on minutes one job of this kind takes, start to finish. */
  minutesEach: number;
  priceEach: number;
}

/** One row in the dialogue that hands a job to a person. */
export interface AssignableJobView {
  id: string;
  name: string;
  /** Working time until the deadline. Negative when already overdue. */
  dueInMinutes: number;
  /** Hands-on minutes still to do, which is not the same as the recipe total. */
  minutesOfWork: number;
  price: number;
  qualified: boolean;
  /** Named so the refusal explains itself and points at a training. */
  missingSkills: string[];
  /** Which machine this person would go to, for the step that is next. */
  nextStep: string;
  /** Someone started this and stopped, so it needs whoever can do the rest. */
  partlyDone: boolean;
}

/** People who can do a kind of work, and whether they can start it now. */
export interface QualifiedStaffView {
  /** Idle, on shift, holding nothing. Could be given the work this instant. */
  available: StaffId[];
  /** Qualified but busy, off duty, sick or on leave. */
  unavailable: StaffId[];
}

/** What is holding work up, in plain language, commonest first. */
export interface HoldUpView {
  reason: BlockReason;
  /** How many waiting jobs are held up by this. */
  jobs: number;
  /** A sentence a lab manager would recognise. */
  text: string;
}

/** Headline numbers about the backlog, for one line at the top of a panel. */
export interface BacklogView {
  waiting: number;
  overdue: number;
  /** Total hands-on minutes sitting in the queue — the backlog in real terms. */
  minutesOfWorkWaiting: number;
}

/**
 * The queue, one line per kind of work.
 *
 * Grouped rather than listed job by job: eighty blood panels is a number a
 * manager can act on, and eighty rows is not. Phase 2.5 decides how this is
 * drawn; this only decides what can be asked.
 */
export function queueByWorkType(world: WorldState): QueueLineView[] {
  return world.workTypes.map((workType) => {
    const waiting = world.jobs.filter(
      (job) => job.workTypeId === workType.id && isWaiting(job.status),
    );
    const soonest = waiting.reduce<number | null>(
      (best, job) => (best === null || job.dueAtMinute < best ? job.dueAtMinute : best),
      null,
    );
    return {
      workTypeId: workType.id,
      name: workType.name,
      waiting: waiting.length,
      overdue: waiting.filter((job) => job.dueAtMinute < world.simMinutes).length,
      soonestDueInMinutes: soonest === null ? null : soonest - world.simMinutes,
      // Hands-on minutes only. The instrument may hold a job for far longer -
      // a cell culture is three hours of work and two days of incubation - and
      // conflating them would make the queue look five times heavier than the
      // people time it actually needs.
      minutesEach: workType.steps.reduce((total, step) => total + step.attended, 0),
      priceEach: workType.basePrice,
    };
  });
}

/**
 * Why the queue is not moving, counted and phrased.
 *
 * This is the "what is holding the lab back" sentence the whole phase is aimed
 * at, and it is a count rather than an inference from utilisation figures.
 * Ordered by how many jobs each reason is holding up, because the manager's
 * question is which one to fix first.
 *
 * Phrasing lives here rather than in the engine for the usual reason: the
 * engine reports a `BlockReason` and the words are a display decision. It lives
 * *here* rather than in the panel so that the batch runner's verdict and the
 * live lab cannot describe the same state differently.
 */
export function holdUps(world: WorldState): HoldUpView[] {
  const counts = new Map<BlockReason, number>();
  for (const job of world.jobs) {
    if (job.blockReason === null) continue;
    counts.set(job.blockReason, (counts.get(job.blockReason) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, jobs]) => ({ reason, jobs, text: phrase(reason, jobs) }));
}

function phrase(reason: BlockReason, jobs: number): string {
  const n = String(jobs);
  switch (reason) {
    case 'no-qualified-operator':
      return `${n} waiting for a skill nobody here has`;
    case 'everyone-busy':
      return `${n} waiting for someone to be free`;
    case 'resource-busy':
      return `${n} waiting for an instrument in use`;
    case 'outside-working-hours':
      return `${n} waiting for the lab to open`;
    case 'no-such-resource':
      return `${n} needing equipment the lab does not have`;
  }
}

export function backlogView(world: WorldState): BacklogView {
  let waiting = 0;
  let overdue = 0;
  let minutes = 0;
  for (const job of world.jobs) {
    if (!isWaiting(job.status)) continue;
    waiting += 1;
    if (job.dueAtMinute < world.simMinutes) overdue += 1;
    for (let i = job.stepIndex; i < job.steps.length; i++) minutes += job.steps[i]!.remaining;
  }
  return { waiting, overdue, minutesOfWorkWaiting: minutes };
}

/** Whether any hands-on minutes have been spent on this job. */
function hasBeenStarted(job: Job): boolean {
  return job.steps.some((step) => step.remaining < step.total);
}

/** Work that has arrived and nobody has finished. */
function isWaiting(status: Job['status']): boolean {
  return status === 'waiting' || status === 'blocked';
}

/** The HUD clock, so the renderer needs no opinion about how time is stored. */
export interface ClockView {
  label: string;
  dayLabel: string;
  isNight: boolean;
}

const NIGHT_START_HOUR = 21;
const NIGHT_END_HOUR = 6;

/**
 * What one person is doing.
 *
 * Two sources, and the caller knows about neither: a job looked up from the
 * world by id, or a training held on the person. The panels asked this question
 * through here before either was true, which is why introducing jobs, and then
 * deleting emergencies, was one function rather than six call sites each
 * time.
 */
export function describeAssignment(world: WorldState, person: Staff): AssignmentView | null {
  const job = person.jobId === null ? undefined : world.jobs.find((j) => j.id === person.jobId);
  if (job) {
    return {
      label: job.name,
      statusText: person.state === 'working' ? 'Processing' : 'Moving to equipment',
      progress: jobProgress(job),
      isTraining: false,
    };
  }

  const training = person.activeTask;
  if (!training) return null;

  return {
    label: training.name,
    statusText: person.state === 'working' ? 'Training in progress' : 'Moving to equipment',
    progress: training.duration > 0 ? clamp01(1 - person.taskTimer / training.duration) : 0,
    isTraining: true,
  };
}

/**
 * How far through the whole job, not the current step.
 *
 * Across every step rather than within one, because a progress bar that resets
 * to zero three times tells a manager less than one that moves once. Possible
 * only now that the steps and their totals live in one place.
 */
function jobProgress(job: Job): number {
  let total = 0;
  let done = 0;
  job.steps.forEach((step, i) => {
    total += step.total;
    if (i < job.stepIndex) done += step.total;
    else if (i === job.stepIndex) done += step.total - step.remaining;
  });
  return total > 0 ? clamp01(done / total) : 0;
}

/** Work currently being carried out, whoever is carrying it. */
export function listActiveWork(world: WorldState): ActiveWorkView[] {
  const items: ActiveWorkView[] = [];
  for (const person of world.staff) {
    const assignment = describeAssignment(world, person);
    if (!assignment) continue;
    items.push({
      id: `staff-${person.id}`,
      name: assignment.label,
      assignee: person.name,
      statusText: assignment.statusText,
      progress: assignment.progress,
    });
  }
  return items;
}

/**
 * Jobs this person could take, soonest deadline first.
 *
 * Replaces the list of recipes the assign dialogue used to show. Unqualified
 * jobs are included rather than hidden, with the missing skill named: "you
 * cannot do this, and here is why" is the sentence that makes training worth
 * buying, and a shorter list would hide the reason the lab is stuck.
 */
export function listAssignableJobs(world: WorldState, person: Staff): AssignableJobView[] {
  return (
    world.jobs
      // A job with no current step has nothing anybody can do to it, and should
      // never have been offered. Listing one reported it as *qualified* for
      // everybody - a missing step requires no skill - so it sorted to the front
      // of the queue on age and every attempt to take it was refused.
      .filter(
        (job) =>
          isWaiting(job.status) &&
          job.stepIndex < job.steps.length &&
          // Prepped and queueing for an instrument. Nobody can do anything for
          // it, so offering it in the assign dialogue only invites a refusal.
          !awaitsInstrumentOnly(world, job),
      )
      .slice()
      .sort((a, b) => a.dueAtMinute - b.dueAtMinute || a.id.localeCompare(b.id))
      .map((job) => {
        const remaining = job.steps.slice(job.stepIndex);
        // Against the *current* step only: a job moves between specialists at
        // each step boundary, so being able to start it is the question.
        const step = job.steps[job.stepIndex];
        const needed = step?.skillRequired ?? null;
        const missing = needed !== null && !person.skills.includes(needed) ? [needed] : [];
        return {
          id: job.id,
          name: job.name,
          dueInMinutes: job.dueAtMinute - world.simMinutes,
          minutesOfWork: remaining.reduce((sum, s) => sum + s.remaining, 0),
          nextStep: step?.capability ?? '',
          price: job.basePrice,
          qualified: missing.length === 0,
          missingSkills: missing,
          // Any work at all, not just a completed step. This was `stepIndex > 0`,
          // which detects progress only across a step *boundary* — so a
          // single-step job 86% finished reported itself as untouched, and mass
          // spectrometry is a quarter of what the lab sells. The one signal for
          // "has anyone worked on this?" was wrong for all of it.
          partlyDone: hasBeenStarted(job),
        };
      })
  );
}

/**
 * Who could carry out a kind of work, split by whether they can take it now.
 *
 * Two lists rather than one. "Three people can do this and two of them are out"
 * is a more useful sentence than "three people can do this", and it is the
 * sentence that makes a hire or a training worth considering — a lab with
 * enough skills on paper and nobody available is a different problem from a lab
 * with nobody trained.
 *
 * Qualification is per step, since a job moves between specialists: anyone who
 * can do *any* step counts. Requiring the whole recipe would name nobody for
 * three of the four kinds of work this lab sells.
 */
export function qualifiedStaffForWorkType(
  world: WorldState,
  workTypeId: string,
): QualifiedStaffView {
  const workType = world.workTypes.find((w) => w.id === workTypeId);
  if (!workType) return { available: [], unavailable: [] };

  const canDoSomeStep = world.staff.filter((person) =>
    workType.steps.some(
      (step) => step.skillRequired === null || person.skills.includes(step.skillRequired),
    ),
  );
  return {
    available: canDoSomeStep.filter((p) => isUnoccupied(world, p)).map((p) => p.id),
    unavailable: canDoSomeStep.filter((p) => !isUnoccupied(world, p)).map((p) => p.id),
  };
}

/** How many people are currently learning a skill. */
export function countTraining(world: WorldState): number {
  return world.staff.filter((p) => p.activeTask?.type === 'training').length;
}

/**
 * Rush orders still live, soonest deadline first.
 *
 * Replaces the emergency list. The panel it feeds was written against a
 * separate kind of work with its own entity, its own progress fields and its
 * own events; it now reads ordinary jobs that happen to carry a flag, and the
 * shape it receives is unchanged.
 *
 * Time left can be negative. A rush order quoted in wall-clock hours and
 * arriving on a Thursday afternoon may simply be impossible, and showing it as
 * overdue is more honest than clamping it to zero.
 */
export function listUrgentWork(world: WorldState): UrgentWorkView[] {
  return world.jobs
    .filter((job) => job.rush && !isFinished(job.status))
    .slice()
    .sort((a, b) => a.dueAtMinute - b.dueAtMinute || a.id.localeCompare(b.id))
    .map((job) => ({
      id: job.id,
      name: job.name,
      status: statusText(job.status),
      timeLeft: job.dueAtMinute - world.simMinutes,
      urgent: true,
    }));
}

function isFinished(status: Job['status']): boolean {
  return status === 'done-on-time' || status === 'done-late' || status === 'expired';
}

function statusText(status: Job['status']): string {
  switch (status) {
    case 'in-progress':
      return 'In Progress';
    case 'unattended':
      return 'On the instrument';
    case 'blocked':
      return 'Held up';
    default:
      return 'Waiting';
  }
}

/** Time remaining on one rush order, or null if it is no longer live. */
export function urgentTimeLeft(world: WorldState, id: string): number | null {
  const job = world.jobs.find((j) => j.id === id);
  if (!job || isFinished(job.status)) return null;
  return job.dueAtMinute - world.simMinutes;
}

export function clockView(world: WorldState): ClockView {
  const hour = Math.floor(minuteOfDay(world.simMinutes) / 60);
  return {
    label: formatClock(world.simMinutes),
    dayLabel: dayLabel(world.simMinutes),
    isNight: hour < NIGHT_END_HOUR || hour >= NIGHT_START_HOUR,
  };
}

/**
 * How loaded a person is, 0–100.
 *
 * Hours worked this week against contracted hours. Over 100 is possible and is
 * the point: it means overtime, which is precisely the thing the lab manager
 * says is invisible until payroll.
 *
 * This read the invented energy percentage until B1. Only this function
 * changed; the bar that displays it never knew the difference, which is what
 * the query seam was built for.
 */
export function staffLoadPercent(_world: WorldState, person: Staff): number {
  const contracted = person.weeklyHours * 60;
  if (contracted <= 0) return 0;
  return Math.max(0, Math.round((person.minutesWorkedThisWeek / contracted) * 100));
}

/**
 * Whether a person is free to be given work: on shift, and not already on
 * something. Asked by the staff picker and, as a cosmetic matter, by the
 * canvas — an unoccupied person bobs on the spot.
 */
export function isUnoccupied(_world: WorldState, person: Staff): boolean {
  return person.state === 'idle' && !person.activeTask && person.jobId === null;
}

/** Ids of everyone free to take work. */
export function unoccupiedStaffIds(world: WorldState): StaffId[] {
  return world.staff.filter((p) => isUnoccupied(world, p)).map((p) => p.id);
}

/** Progress per person, keyed by id, for the canvas. */
export function progressByStaff(world: WorldState): Record<StaffId, number> {
  const out: Record<StaffId, number> = {};
  for (const person of world.staff) {
    if (person.state !== 'working') continue;
    const assignment = describeAssignment(world, person);
    if (assignment) out[person.id] = assignment.progress;
  }
  return out;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
