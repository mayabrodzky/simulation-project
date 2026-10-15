/**
 * Where things are, and what counts as "there".
 *
 * Extracted so the slice loop and the job lifecycle can share one definition of
 * arrival. They must: the loop clamps a slice so that arrival falls on a slice
 * boundary, and the job decides whether work can start — if those two disagreed
 * by a hair, work would begin one slice late and the delay would depend on step
 * size. A2 found that bug once already.
 */
import type { Equipment, Staff } from '../domain/types';

/** How close counts as arrived. */
export const ARRIVAL_RADIUS = 0.1;

/** Below this, two instants are the same instant. Guards against float dust. */
export const EPSILON = 1e-9;

/**
 * Tolerant on purpose. Landing exactly on the radius leaves the distance a hair
 * outside it in floating point, which would leave someone standing next to a
 * machine they can never reach.
 */
export function isArrived(distance: number): boolean {
  return distance <= ARRIVAL_RADIUS + EPSILON;
}

/**
 * Whether the clock has reached an instant the loop was asked to land on.
 *
 * Tolerant for the same reason `isArrived` is, and it is not optional. The loop
 * clamps a slice so that it ends exactly on a scheduled instant, but
 * `simMinutes + slice` is not bit-identical to that instant once the clock has
 * accumulated thousands of additions: a job due to be abandoned at minute
 * 11,040 was reached at 11,039.999999999998 and so was never abandoned at all.
 *
 * Worse, whether it happens depends on the history of slice lengths, so the
 * same scheduled event fires in one run and is skipped in another — which is
 * precisely the step-size dependence the slice loop exists to remove. Every
 * comparison of the clock against a scheduled instant goes through here.
 */
export function hasReached(now: number, instant: number): boolean {
  return now >= instant - EPSILON;
}

export function distanceTo(person: Staff, x: number, y: number): number {
  const dx = x - person.x;
  const dy = y - person.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function hasArrivedAt(person: Staff, equipment: Equipment): boolean {
  return isArrived(distanceTo(person, equipment.x, equipment.y));
}
