/**
 * Working time.
 *
 * Simulated time is one monotonic count of minutes since the start of the run,
 * where minute 0 is Sunday 00:00. Everything here interprets that number: what
 * day it is, whether the lab is open, and how long something takes when nights
 * and weekends do not count.
 *
 * Why this module exists at all, and why it is built before anything uses it:
 * the clock it replaces wrapped at midnight, so the engine could not tell
 * Monday from Thursday. Deadlines in working days, overtime per week, shift
 * windows and "does this pause overnight?" are all unanswerable against a
 * wrapping clock — and an error here would propagate into every number
 * downstream without announcing itself.
 *
 * Every function is pure: no world, no state, no randomness, no clock.
 */
import type { Calendar, DayOfWeek, Shift } from '../domain/types';

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
export const DAYS_PER_WEEK = 7;
export const MINUTES_PER_WEEK = DAYS_PER_WEEK * MINUTES_PER_DAY;

/** Guards the day-walking loops against a malformed calendar with no working days. */
const MAX_DAYS_SEARCH = 400;

/* --- Reading the clock ---------------------------------------------------- */

export function dayIndex(minute: number): number {
  return Math.floor(minute / MINUTES_PER_DAY);
}

/** Minutes past midnight. Correct for negative inputs, which `%` alone is not. */
export function minuteOfDay(minute: number): number {
  return ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function dayOfWeek(minute: number): DayOfWeek {
  const d = ((dayIndex(minute) % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  return d as DayOfWeek;
}

export function weekIndex(minute: number): number {
  return Math.floor(dayIndex(minute) / DAYS_PER_WEEK);
}

/** The instant a given day begins. */
export function dayStart(day: number): number {
  return day * MINUTES_PER_DAY;
}

export function dayOfWeekOf(day: number): DayOfWeek {
  return (((day % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK) as DayOfWeek;
}

/* --- Is the lab open? ------------------------------------------------------ */

export function isWorkingDay(shift: Shift, minute: number): boolean {
  return shift.days.includes(dayOfWeek(minute));
}

/**
 * Whether `minute` falls inside the shift.
 *
 * The end is exclusive: at exactly 16:00 the lab is shut. That matters because
 * it makes closing a single unambiguous instant rather than a minute that is
 * both open and closed, which is what lets the slice loop in A2 stop exactly
 * on it.
 */
export function isWithinShift(shift: Shift, minute: number): boolean {
  if (!isWorkingDay(shift, minute)) return false;
  const m = minuteOfDay(minute);
  return m >= shift.startMinute && m < shift.endMinute;
}

/** The first working day at or after `day`. */
function nextWorkingDay(shift: Shift, day: number): number {
  for (let i = 0; i < MAX_DAYS_SEARCH; i++) {
    if (shift.days.includes(dayOfWeekOf(day + i))) return day + i;
  }
  throw new Error('calendar: shift has no working days');
}

/**
 * The next instant the lab is open, at or after `minute`.
 *
 * Returns `minute` unchanged when it is already open, so this is safe to apply
 * repeatedly.
 */
export function nextOpen(shift: Shift, minute: number): number {
  if (isWithinShift(shift, minute)) return minute;

  const today = dayIndex(minute);
  const m = minuteOfDay(minute);
  // Still before opening on a day the lab works: wait for this morning.
  if (shift.days.includes(dayOfWeekOf(today)) && m < shift.startMinute) {
    return dayStart(today) + shift.startMinute;
  }
  // Otherwise the next working day's opening.
  return dayStart(nextWorkingDay(shift, today + 1)) + shift.startMinute;
}

/** When the current or next shift closes. */
export function shiftEndAfter(shift: Shift, minute: number): number {
  const open = nextOpen(shift, minute);
  return dayStart(dayIndex(open)) + shift.endMinute;
}

/**
 * The next instant the lab opens or closes, strictly after `minute`.
 *
 * This is what lets the engine step in large slices without stepping over a
 * boundary: clamp each slice to the next one of these and a day-sized step
 * produces exactly the same result as a second-sized one.
 */
export function nextCalendarBoundary(shift: Shift, minute: number): number {
  if (isWithinShift(shift, minute)) {
    return dayStart(dayIndex(minute)) + shift.endMinute; // today's close
  }
  return nextOpen(shift, minute + 1) === minute + 1 ? minute + 1 : nextOpen(shift, minute);
}

/* --- Measuring working time ------------------------------------------------ */

/**
 * Working minutes in `[from, to)`. Zero when `to <= from`.
 *
 * Walks day by day rather than in closed form, because a shift that does not
 * align to day boundaries makes the closed form fiddly and this is never on a
 * hot path — the longest span anything asks about is a few weeks.
 */
export function workingMinutesBetween(shift: Shift, from: number, to: number): number {
  if (to <= from) return 0;

  let total = 0;
  const lastDay = dayIndex(to - 1);
  for (let day = dayIndex(from); day <= lastDay; day++) {
    if (!shift.days.includes(dayOfWeekOf(day))) continue;
    const windowStart = dayStart(day) + shift.startMinute;
    const windowEnd = dayStart(day) + shift.endMinute;
    const overlap = Math.min(to, windowEnd) - Math.max(from, windowStart);
    if (overlap > 0) total += overlap;
  }
  return total;
}

/**
 * The instant `minutes` of *working* time after `from`, skipping nights and
 * weekends. Used wherever a duration is quoted in working time.
 */
export function addWorkingMinutes(shift: Shift, from: number, minutes: number): number {
  if (minutes <= 0) return from;

  let cursor = nextOpen(shift, from);
  let remaining = minutes;

  for (let i = 0; i < MAX_DAYS_SEARCH; i++) {
    const closing = dayStart(dayIndex(cursor)) + shift.endMinute;
    const availableToday = closing - cursor;
    if (remaining <= availableToday) return cursor + remaining;
    remaining -= availableToday;
    cursor = nextOpen(shift, closing);
  }
  throw new Error('calendar: addWorkingMinutes did not terminate');
}

/**
 * Close of business on the n-th working day from `from`.
 *
 * Deliberately not "n × a day's working minutes". A client who asks for two
 * working days means the end of the second day, not 960 minutes of labour — and
 * quoting it this way makes the answer independent of what time the job
 * arrived, so one arriving at 15:55 is not effectively given five minutes less
 * than one arriving at 09:00.
 *
 * A job arriving outside working hours starts its clock at the next opening,
 * so arriving at 22:00 on Thursday does not burn Friday and Saturday.
 */
export function addWorkingDays(calendar: Calendar, from: number, days: number): number {
  const shift = calendar.shift;
  let day = dayIndex(nextOpen(shift, from));
  let remaining = calendar.deadlineCountsArrivalDay ? days - 1 : days;

  for (let i = 0; i < MAX_DAYS_SEARCH && remaining > 0; i++) {
    day = nextWorkingDay(shift, day + 1);
    remaining -= 1;
  }
  if (remaining > 0) throw new Error('calendar: addWorkingDays did not terminate');

  return dayStart(day) + shift.endMinute;
}

/**
 * When a job quoted `hours` of wall-clock time is due.
 *
 * Rush orders are quoted this way: "24 hours" means tomorrow, nights included.
 * That is what makes them hard, and it is why one arriving on a Thursday
 * afternoon can be impossible to meet — a real property of the lab rather than
 * a modelling artifact, and one worth reporting rather than smoothing away.
 */
export function addCalendarHours(from: number, hours: number): number {
  return from + hours * MINUTES_PER_HOUR;
}

/* --- Formatting ------------------------------------------------------------ */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function clockLabel(minute: number): string {
  const m = minuteOfDay(minute);
  const hh = Math.floor(m / MINUTES_PER_HOUR)
    .toString()
    .padStart(2, '0');
  const mm = Math.floor(m % MINUTES_PER_HOUR)
    .toString()
    .padStart(2, '0');
  return `${hh}:${mm}`;
}

export function dayLabel(minute: number): string {
  return DAY_NAMES[dayOfWeek(minute)] ?? '??';
}
