/**
 * The working day: who is in the building, and when.
 *
 * A1 built the calendar — `isWithinShift`, `nextOpen`, `shiftEndAfter` — and
 * tested it thoroughly, and then nothing called any of it. People only changed
 * shift when someone clicked. That was invisible while work could not outlive a
 * few minutes; with jobs it means a technician works through the night and the
 * lab has no closing time, which makes every number about capacity wrong and
 * makes decision C — add an evening shift — unmodellable, because the day shift
 * never gives the machines back.
 *
 * The fix needed one thing untangled first. `state === 'off'` meant both "not on
 * the rota" and "outside opening hours", so there was no way to tell a person
 * who had gone home from a person who is not employed on this shift. `rostered`
 * now says the first and the clock decides the second.
 *
 * What a shift ending does to work in progress is the question A1 said this
 * would settle, and the answer costs almost nothing: **the job is released and
 * the machine given back.** Its `remaining` counters are already exactly right,
 * so there is nothing to save and nothing to restore — the point of holding
 * progress on the job rather than the person. Releasing the machine is what lets
 * an evening shift add real capacity; held overnight, utilisation would read
 * 100% with nobody in the building.
 */
import type { Staff } from '../domain/types';
import { isWithinShift, nextCalendarBoundary } from './calendar';
import type { EngineEvent } from './events';
import { releaseJobOf } from './jobs';
import type { WorldState } from './world';

/**
 * States the clock does not override.
 *
 * Someone off sick stays off sick through a shift change: being sick is about
 * the person, not the hour, and clearing it is a decision somebody makes.
 */
function isPersonalAbsence(person: Staff): boolean {
  return person.state === 'sick' || person.state === 'vacation';
}

/**
 * Brings rostered people in at opening and sends them home at close.
 *
 * Called every slice. Cheap in the common case — one `isWithinShift` for the
 * world and one comparison per person — because the slice loop runs it hundreds
 * of thousands of times for a simulated week.
 */
export function applyShiftWindow(world: WorldState, events: EngineEvent[]): void {
  for (const person of world.staff) {
    if (isPersonalAbsence(person)) continue;

    // Each person's own window, not the lab's. Two of the eight are part-time,
    // and an evening shift — decision C — is a change to some people's hours
    // rather than to when the building is unlocked.
    const open = isWithinShift(person.shift, world.simMinutes);

    if (!person.rostered) {
      // Not on the rota: at home whatever the clock says.
      if (person.state !== 'off') sendHome(world, person, events);
      continue;
    }

    if (open && person.state === 'off') {
      person.state = 'idle';
      events.push({
        type: 'shift-started',
        staffId: person.id,
        staffName: person.name,
      });
    } else if (!open && person.state !== 'off') {
      sendHome(world, person, events);
    }
  }
}

function sendHome(world: WorldState, person: Staff, events: EngineEvent[]): void {
  // Whatever they were holding goes back to the queue, part-finished, with its
  // counters untouched. The machine is freed in the same call.
  const job = releaseJobOf(world, person);
  person.state = 'off';
  person.targetX = null;
  person.targetY = null;

  events.push({
    type: 'shift-ended',
    staffId: person.id,
    staffName: person.name,
    jobSetDown: job?.id ?? null,
  });
}

/**
 * Minutes until the lab opens or closes.
 *
 * The loop has to land on these exactly. Stepping over a close means a shift
 * that ends at 16:00 ends at midnight in a batch run that steps a day at a
 * time, which is eight hours of work nobody did.
 */
export function nextShiftEventIn(world: WorldState): number {
  let soonest = Infinity;
  // Every distinct shift, because a part-timer leaving at noon is an instant
  // the loop has to land on just as much as the lab closing at four.
  for (const person of world.staff) {
    const next = nextCalendarBoundary(person.shift, world.simMinutes) - world.simMinutes;
    if (next > 0 && next < soonest) soonest = next;
  }
  return soonest;
}

/** Whether the building is open at all. Individual shifts may be shorter. */
export function isLabOpen(world: WorldState): boolean {
  return isWithinShift(world.calendar.shift, world.simMinutes);
}

/** Whether this person is contracted to be here right now. */
export function isOnShift(person: Staff, minute: number): boolean {
  return isWithinShift(person.shift, minute);
}
