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
import { dayIndex, isWithinShift, nextCalendarBoundary, weekIndex } from './calendar';
import type { EngineEvent } from './events';
import { EPSILON } from './geometry';
import { releaseJobOf } from './jobs';
import { chargeWeeklyLabour } from './money';
import type { WorldState } from './world';

/**
 * Resets the day and week ledgers when the clock has moved on.
 *
 * Lazy rather than scheduled, and that is safe for one specific reason:
 * midnight falls outside every shift, so no attended minute is ever credited
 * between a day ending and this noticing. A reset that had to land exactly
 * would need a clamp in the slice loop; this one does not.
 */
export function rollLedgers(world: WorldState): void {
  const day = dayIndex(world.simMinutes);
  if (day !== world.ledgerDay) {
    world.ledgerDay = day;
    for (const person of world.staff) person.minutesWorkedToday = 0;
  }

  const week = weekIndex(world.simMinutes);
  if (week !== world.ledgerWeek) {
    // Payroll for the week just ended, charged *before* the counters are
    // cleared. Getting that order wrong would bill every week as though nobody
    // had worked any overtime at all.
    chargeWeeklyLabour(world);

    world.ledgerWeek = week;
    for (const person of world.staff) {
      person.minutesWorkedThisWeek = 0;
      person.overtimeMinutesThisWeek = 0;
    }
  }
}

/**
 * Credits a slice of work to a person, and says whether it was overtime.
 *
 * One place, so the ledger and the work done cannot disagree. Overtime is
 * minutes worked outside this person's own contracted shift — not minutes past
 * forty hours, which would count a part-timer's ordinary Tuesday as overtime.
 */
export function creditWork(world: WorldState, person: Staff, minutes: number): void {
  person.minutesWorkedToday += minutes;
  person.minutesWorkedThisWeek += minutes;

  // Judged at the *start* of the slice being credited, not at the clock's
  // current value. The clock has already advanced by the time work is credited,
  // so a slice ending exactly at 16:00 would otherwise be recorded as overtime
  // — fifteen minutes of ordinary afternoon counted as a premium. The loop
  // clamps to shift boundaries, so a slice never straddles one and its start is
  // an unambiguous answer.
  const sliceStarted = world.simMinutes - minutes;
  if (!isWithinShift(person.shift, sliceStarted)) {
    person.overtimeMinutesThisWeek += minutes;
  }
}

/**
 * How much slower this person is working, from hours already done this week.
 *
 * Read from the ledger at the point work is consumed rather than stored as a
 * flag, so crossing the threshold mid-step needs no recomputation and there is
 * no second place that could disagree about whether somebody is tired.
 */
export function fatiguePace(world: WorldState, person: Staff): number {
  const threshold = world.tuning.fatigueAfterWeeklyHours * 60;
  return person.minutesWorkedThisWeek > threshold ? world.tuning.fatiguePaceMultiplier : 1;
}

/**
 * Whether somebody may stay past their shift to finish what they started.
 *
 * Without this, overtime could never happen: everybody was sent home the
 * instant their shift ended, so the specification's overtime bands would have
 * priced a quantity that was always zero, and the lab manager's actual
 * complaint — that overtime is invisible until payroll — would have been
 * unmodellable.
 *
 * The rule is deliberately the narrowest one that produces overtime at all:
 * *finish the step you are on, then go.* Nobody starts new work after hours,
 * and nobody exceeds the daily cap. It needs no policy input and no judgement
 * about when a lab would ask somebody to stay.
 */
export function mayWorkLate(world: WorldState, person: Staff): boolean {
  if (person.minutesWorkedToday >= world.tuning.maxHoursPerDay * 60) return false;
  return person.state === 'working' && person.jobId !== null;
}

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

    // Mid-step and inside the daily cap: they stay to finish, which is the
    // only way overtime arises. The step boundary sends them home.
    if (!open && mayWorkLate(world, person)) continue;

    // Somebody who has hit the daily cap stays home even though the lab is
    // open. Without this the cap was undone the instant it fired: the window
    // runs after the work, saw an idle lab and an off-duty rostered person, and
    // brought them straight back.
    if (person.minutesWorkedToday >= world.tuning.maxHoursPerDay * 60) {
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
  // Cached until the clock reaches it. Working this out walks the calendar day
  // by day — `nextOpen` has a loop — once per person, and the slice loop asks
  // on every slice: a million times for four simulated hours. Unthrottled it
  // took the step-size invariance test from two seconds to over seven.
  if (world.simMinutes >= world.nextShiftBoundaryAtMinute - EPSILON) {
    let soonest = Infinity;
    // Every distinct shift, because a part-timer leaving at noon is an instant
    // the loop has to land on just as much as the lab closing at four.
    for (const person of world.staff) {
      const at = nextCalendarBoundary(person.shift, world.simMinutes);
      if (at > world.simMinutes + EPSILON && at < soonest) soonest = at;
    }
    world.nextShiftBoundaryAtMinute = soonest;
  }
  return world.nextShiftBoundaryAtMinute - world.simMinutes;
}

/** Whether the building is open at all. Individual shifts may be shorter. */
export function isLabOpen(world: WorldState): boolean {
  return isWithinShift(world.calendar.shift, world.simMinutes);
}

/** Whether this person is contracted to be here right now. */
export function isOnShift(person: Staff, minute: number): boolean {
  return isWithinShift(person.shift, minute);
}
