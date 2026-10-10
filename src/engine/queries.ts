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
import type { Staff, StaffId } from '../domain/types';
import { clockLabel as formatClock, dayLabel, minuteOfDay } from './calendar';
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

/** The HUD clock, so the renderer needs no opinion about how time is stored. */
export interface ClockView {
  label: string;
  dayLabel: string;
  isNight: boolean;
}

const NIGHT_START_HOUR = 21;
const NIGHT_END_HOUR = 6;

// `_world` is unused while work still lives on the person. The parameter is
// present because the next step looks the job up from the world, and taking it
// now means every call site is written once rather than twice.
export function describeAssignment(_world: WorldState, person: Staff): AssignmentView | null {
  const task = person.activeTask;
  if (!task) return null;

  if (task.type === 'training') {
    const progress = task.duration > 0 ? clamp01(1 - person.taskTimer / task.duration) : 0;
    return {
      label: task.name,
      statusText: person.state === 'working' ? 'Training in progress' : 'Moving to equipment',
      progress,
      isTraining: true,
    };
  }

  const step = task.equipmentSequence[person.taskStep];
  const progress =
    person.state === 'working' && step && step.duration > 0
      ? clamp01(1 - person.taskTimer / step.duration)
      : 0;

  return {
    label: task.name,
    statusText: person.state === 'working' ? 'Processing' : 'Moving to equipment',
    progress,
    isTraining: false,
  };
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

/** How many people are currently learning a skill. */
export function countTraining(world: WorldState): number {
  return world.staff.filter((p) => p.activeTask?.type === 'training').length;
}

/** Work under time pressure, soonest deadline first. */
export function listUrgentWork(world: WorldState): UrgentWorkView[] {
  return world.emergencies
    .filter((e) => e.status === 'pending' || e.status === 'in-progress')
    .slice()
    .sort((a, b) => a.timeLimit - b.timeLimit)
    .map((e) => ({
      id: e.id,
      name: e.name,
      status: e.status === 'pending' ? 'Waiting' : 'In Progress',
      timeLeft: e.timeLimit,
      urgent: true,
    }));
}

/** Time remaining on one urgent item, or null if it is no longer live. */
export function urgentTimeLeft(world: WorldState, id: string): number | null {
  const found = world.emergencies.find((e) => e.id === id);
  return found ? found.timeLimit : null;
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
 * Reads the energy percentage today. Phase 2b replaces that with hours worked
 * against contracted hours, at which point only this function changes — the
 * bar that displays it does not know the difference.
 */
export function staffLoadPercent(_world: WorldState, person: Staff): number {
  return Math.max(0, Math.min(100, Math.floor(person.energy)));
}

/**
 * Whether a person is free to be given work: on shift, and not already on
 * something. Asked by the staff picker and, as a cosmetic matter, by the
 * canvas — an unoccupied person bobs on the spot.
 */
export function isUnoccupied(_world: WorldState, person: Staff): boolean {
  return person.state === 'idle' && !person.activeTask;
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
