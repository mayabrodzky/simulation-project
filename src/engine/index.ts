/**
 * The simulation engine.
 *
 * Contract, enforced by eslint for everything under src/engine:
 *   1. no DOM            2. no Math.random (use the world's rng)
 *   3. no Date or performance — time only ever arrives as a `dt` argument
 *
 * Those three rules are what make a run reproducible from its seed, and what
 * let the simulation run hundreds of times in the background with no browser.
 *
 * The UI talks to the engine in one direction only: it sends Commands and
 * reads back EngineEvents. It never mutates the world itself.
 */
export { createWorld, cloneWorld, findStaff, findEquipment, type WorldState } from './world';
export { tick, advance, failTask, type TickOptions } from './tick';
export { applyCommand, type Command } from './commands';
export { isQualified, missingSkills } from './rules';
export { createRng, type Rng } from './rng';
export { isPanelAffecting, type EngineEvent, type RejectionReason } from './events';
export { formatMinutes } from './time';
export {
  dayOfWeek,
  isWithinShift,
  minuteOfDay,
  nextOpen,
  addWorkingDays,
  addWorkingMinutes,
  workingMinutesBetween,
} from './calendar';
/**
 * The seam the interface asks questions through, rather than reading the
 * simulation's shapes. Keeps panels and the canvas independent of how work is
 * represented, which is what lets that representation change.
 */
export {
  backlogView,
  countTraining,
  describeAssignment,
  clockView,
  isUnoccupied,
  listActiveWork,
  listUrgentWork,
  progressByStaff,
  queueByWorkType,
  staffLoadPercent,
  unoccupiedStaffIds,
  urgentTimeLeft,
  type ActiveWorkView,
  type BacklogView,
  type AssignmentView,
  type ClockView,
  type QueueLineView,
  type UrgentWorkView,
} from './queries';
