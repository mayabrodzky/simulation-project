/**
 * Run options taken from the URL.
 *
 * Three things a demo or a verification needs to pin down, none of which the
 * engine should know about: which lab (`seed`), when the run opens (`start`),
 * and how fast the clock moves (`speed`).
 *
 *     ?seed=42&start=sun-08:00&speed=60
 *
 * Why this exists at all: the clock used to start from the real time of day, so
 * every load began at a different moment. Two loads with the same seed were
 * therefore not comparable, a demo opened in the evening showed an empty lab
 * with everyone off shift, and anything that happens later in the week — the
 * weekend pause, a deadline being missed — took days of real time to reach.
 *
 * This module is in the view layer deliberately. The engine takes the start
 * minute and the speed as plain arguments and may not read `window`, `Date` or
 * the URL; that restriction is enforced by lint, and it is what keeps a
 * headless batch run possible. Parsing is kept pure — it takes the query string
 * and the current time as arguments — so it is testable without a browser.
 */

/** Minutes past midnight at which the lab opens. Matches the scenario's shift. */
const DEFAULT_START_MINUTE_OF_DAY = 8 * 60;
const MINUTES_PER_DAY = 24 * 60;

/**
 * Sunday, because minute 0 of the simulation is Sunday 00:00 and Sunday is the
 * first working day of this lab's week.
 */
const DEFAULT_START_DAY = 0;

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Bounds on speed. The lower bound keeps the clock moving at all; the upper
 * bound is a simulated day per real second, past which a frame advances more
 * than the eye can follow and the slice loop does a lot of work per frame for
 * no visible benefit.
 */
const MIN_SPEED = 0.1;
const MAX_SPEED = 1440;

export interface RunOptions {
  seed: number;
  /** Absolute simulated minute to open at, where minute 0 is Sunday 00:00. */
  startMinutes: number;
  /** Multiplier on simulated time. 1 is the pace the scenario was tuned at. */
  speed: number;
  /** What was asked for but could not be used, for one console line. */
  warnings: string[];
}

/**
 * @param search  `window.location.search`, with or without the leading `?`.
 * @param nowMs   Used only for the default seed, so a run without `?seed`
 *                still differs on every load. Passed in rather than read, so
 *                this function has no hidden dependency on the clock.
 */
export function parseRunOptions(search: string, nowMs: number): RunOptions {
  const params = new URLSearchParams(search);
  const warnings: string[] = [];

  return {
    seed: parseSeed(params.get('seed'), nowMs, warnings),
    startMinutes: parseStart(params.get('start'), warnings),
    speed: parseSpeed(params.get('speed'), warnings),
    warnings,
  };
}

function parseSeed(raw: string | null, nowMs: number, warnings: string[]): number {
  if (raw === null || raw === '') return nowMs;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    warnings.push(`seed "${raw}" is not a number; using a fresh one`);
    return nowMs;
  }
  return value;
}

/**
 * `sun-08:00`, `thu-15:55`, or a bare `08:00` meaning Sunday.
 *
 * A day name rather than a date: the simulation's calendar is a repeating week
 * with no notion of a month, so "Thursday afternoon" is the most specific thing
 * that can be meant. Rejecting an unparseable value rather than guessing,
 * because a demo that silently opened on the wrong day would be worse than one
 * that says so.
 */
export function parseStart(raw: string | null, warnings: string[] = []): number {
  const fallback = DEFAULT_START_DAY * MINUTES_PER_DAY + DEFAULT_START_MINUTE_OF_DAY;
  if (raw === null || raw === '') return fallback;

  const text = raw.trim().toLowerCase();
  const match = /^(?:([a-z]{3})-)?(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) {
    warnings.push(`start "${raw}" is not of the form sun-08:00; opening Sunday 08:00`);
    return fallback;
  }

  const [, dayName, hours, minutes] = match;
  const day = dayName === undefined ? DEFAULT_START_DAY : DAY_NAMES.indexOf(dayName as 'sun');
  if (day < 0) {
    warnings.push(`start "${raw}" names no day of the week; opening Sunday 08:00`);
    return fallback;
  }

  const hour = Number(hours);
  const minute = Number(minutes);
  if (hour > 23 || minute > 59) {
    warnings.push(`start "${raw}" is not a time of day; opening Sunday 08:00`);
    return fallback;
  }

  return day * MINUTES_PER_DAY + hour * 60 + minute;
}

function parseSpeed(raw: string | null, warnings: string[]): number {
  if (raw === null || raw === '') return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    warnings.push(`speed "${raw}" is not a positive number; using 1`);
    return 1;
  }
  const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, value));
  if (clamped !== value) {
    warnings.push(`speed ${value} is outside ${MIN_SPEED}–${MAX_SPEED}; using ${clamped}`);
  }
  return clamped;
}

/** `sun-08:00`, for echoing back what a run actually opened at. */
export function formatStart(startMinutes: number): string {
  const day = Math.floor(startMinutes / MINUTES_PER_DAY) % DAY_NAMES.length;
  const ofDay = ((startMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = String(Math.floor(ofDay / 60)).padStart(2, '0');
  const minutes = String(ofDay % 60).padStart(2, '0');
  return `${DAY_NAMES[day]}-${hours}:${minutes}`;
}
