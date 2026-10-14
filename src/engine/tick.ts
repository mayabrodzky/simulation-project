/**
 * Advancing the world by a slice of time.
 *
 * `tick` mutates the world in place and returns what happened. Not an
 * immutable reducer: Phase 4 runs hundreds of simulated weeks, and allocating a
 * fresh WorldState per step would mean tens of millions of allocations.
 * Determinism does not require immutability — it requires that the output
 * depends only on (world, dt), which is guaranteed here by having no access to
 * Math.random, Date, or the DOM. ESLint enforces all three for this directory.
 */
import type { Equipment, Staff } from '../domain/types';
import { minuteOfDay } from './calendar';
import { ARRIVAL_RADIUS, EPSILON, hasArrivedAt, hasReached, isArrived } from './geometry';
import {
  expireAbandonedJobs,
  nextJobEventIn,
  releaseJobOf,
  nextUnattendedEventIn,
  recomputeBlockReasons,
  tickJobs,
  tickUnattended,
} from './jobs';
import { dispatch, type DispatchOptions } from './dispatch';
import { accrueFixedCosts } from './money';
import { applyShiftWindow, creditWork, nextShiftEventIn, rollLedgers } from './shifts';
import type { EngineEvent } from './events';
import { admitArrivals, ensureArrivalsThrough, rngForStaff, type WorldState } from './world';

export interface TickOptions {
  /**
   * Who works on what, decided inside the loop.
   *
   * Here rather than outside it because the clamping already guarantees a slice
   * never steps over the moment somebody becomes free — so putting assignment
   * inside brings it under the step-size invariance guarantee. Outside, a
   * coarser step meant work was handed out less often: 97 jobs against 102 for
   * the same seed at fifteen minutes against one.
   */
  dispatch?: DispatchOptions;
  /**
   * Sandbox mode freezes the clock and suspends new work arriving, while
   * letting people finish what they are doing. Passed in rather than stored on
   * the world, because it is a property of how the app is using the simulation
   * rather than of the lab itself.
   */
  freezeClock?: boolean;
  /** Sandbox mode also fast-forwards movement so a plan plays out quickly. */
  movementMultiplier?: number;
}

/**
 * Advances by a slice of *real* time, for the live view.
 *
 * A convenience over `advance`: it applies the speed multiplier and converts
 * real seconds into simulated minutes. Fast-forward is therefore a multiplier
 * here rather than a change to the engine, which is what lets the same
 * simulation be watched at ×1 and replayed at ×60.
 */
export function tick(
  world: WorldState,
  dtSeconds: number,
  options: TickOptions = {},
): EngineEvent[] {
  const realSeconds = dtSeconds * world.speed;
  world.elapsedSeconds += realSeconds;
  return advance(world, realSeconds * world.tuning.minutesPerSecond, options);
}

/**
 * Advances the world by `dtMinutes` of simulated time.
 *
 * This is the engine's real entry point, and the one the batch runner calls.
 * Simulated minutes are the unit everything is expressed in: step durations,
 * deadlines, shift hours, overtime.
 */
/** Below this, two instants are the same instant. Guards against float dust. */
/**
 * An upper bound on slices per call, so a zero-length event cannot spin
 * forever. Generous: a simulated day produces a few thousand.
 */
const MAX_SLICES = 200_000;

export function advance(
  world: WorldState,
  dtMinutes: number,
  options: TickOptions = {},
): EngineEvent[] {
  const events: EngineEvent[] = [];

  // Demand for the whole span, before the first slice. Asking for the end of
  // the span rather than for each slice is what keeps this step-size
  // independent: one call for a fortnight and twenty thousand one-minute calls
  // both finish having generated through the same week.
  ensureArrivalsThrough(world, world.simMinutes + dtMinutes);

  let remaining = dtMinutes;
  let guard = 0;

  // Each slice is clamped to the next thing that actually happens — a step
  // finishing, someone arriving at a machine, a deadline, a scheduled event.
  // One iteration per event means nothing is ever stepped over, so advancing a
  // day at a time gives the same answer as advancing a minute at a time. That
  // equivalence is what lets the batch runner be fast and still describe the
  // simulation someone watched.
  while (remaining > EPSILON) {
    if (guard++ > MAX_SLICES) {
      throw new Error('advance: too many slices — an event is firing at zero length');
    }
    const slice = Math.min(remaining, Math.max(nextEventIn(world, options), EPSILON));
    applySlice(world, slice, options, events);
    remaining -= slice;
  }

  return events;
}

/**
 * Minutes until the soonest thing that needs to be landed on exactly.
 *
 * Anything continuous and unobserved — equipment wear, the clock — does not
 * appear here, because stepping over it changes nothing. Anything with a
 * threshold does.
 */
function nextEventIn(world: WorldState, options: TickOptions): number {
  const t = world.tuning;
  let soonest = Infinity;
  const at = (minute: number) => {
    const delta = minute - world.simMinutes;
    if (delta > EPSILON && delta < soonest) soonest = delta;
  };
  const inMinutes = (delta: number) => {
    if (delta > EPSILON && delta < soonest) soonest = delta;
  };

  if (!options.freezeClock) {
    // A sample turning up.
    //
    // Not yet load-bearing, and deliberately kept: nothing acts on a job the
    // instant it arrives, so admitting one at the end of the slice it fell
    // inside would currently give the same answer. That stops being true in
    // the next step, where a free person can pick a job up the moment it lands
    // — and then the difference between "started at 09:40" and "started at
    // midnight, because the batch runner steps a day at a time" is a whole
    // working day of throughput. Confirmed by mutation testing: removing this
    // line breaks no test today.
    const nextArrival = world.arrivalQueue[0];
    if (nextArrival) at(nextArrival.arrivedAtMinute);

    // A step finishing, or a client giving up.
    inMinutes(nextJobEventIn(world));

    // An instrument finishing a run on its own. Clamped like everything else,
    // but deliberately not conditioned on the lab being open.
    inMinutes(nextUnattendedEventIn(world));

    // The lab opening or closing. Stepping over a close means a shift that
    // ends at 16:00 ends at midnight in a batch run that steps a day at a
    // time, which is eight hours of work nobody did.
    inMinutes(nextShiftEventIn(world));

    // Handing out work. An event like any other, and that is the whole point:
    // the instants are a function of the clock alone, so every caller agrees on
    // them however finely it steps.
    at(nextDispatchAt(world));
  }

  for (const person of world.staff) {
    if (person.state === 'off' || person.state === 'sick' || person.state === 'vacation') continue;

    // A step finishing.
    if (person.state === 'working') inMinutes(person.taskTimer);

    // The daily hours cap, which is what stops overtime running away. An
    // instant the loop has to land on: stepping over it would let somebody work
    // a thirteenth hour because the slice happened to be long.
    const capMinutes = t.maxHoursPerDay * 60;
    if (person.state === 'working' && person.minutesWorkedToday < capMinutes) {
      inMinutes(capMinutes - person.minutesWorkedToday);
    }

    // Arriving at a destination — meaning reaching the radius that counts as
    // arrived, not the exact point. Clamping to the exact point instead would
    // step past the radius on a coarse slice and land on it on a fine one, so
    // work would start at different moments for the same run.
    if (person.targetX !== null && person.targetY !== null) {
      const dx = person.targetX - person.x;
      const dy = person.targetY - person.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = person.speed * (options.movementMultiplier ?? 1);
      if (!isArrived(dist) && speed > 0) inMinutes((dist - ARRIVAL_RADIUS) / speed);
    } else if (person.state === 'idle' && !person.activeTask) {
      at(person.nextWanderAtMinute);
    }
  }

  return soonest;
}

/**
 * Whether someone has reached a machine.
 *
 * Previously this compared rounded coordinates, which is true once a person is
 * within half a tile rather than when they get there. That is a threshold on
 * *position* rather than on time, so a fine step caught the earlier instant
 * and a coarse one jumped past it — the same work started at different moments
 * depending only on how the simulation was being watched. Arrival is an event
 * the loop already lands on exactly.
 */
function applySlice(
  world: WorldState,
  dt: number,
  options: TickOptions,
  events: EngineEvent[],
): void {
  const t = world.tuning;

  if (!options.freezeClock) {
    world.simMinutes += dt;
    world.minutes = minuteOfDay(world.simMinutes);

    // Day and week ledgers. Safe to do lazily here because midnight falls
    // outside every shift, so no attended minute is ever credited between a day
    // ending and this noticing.
    rollLedgers(world);

    // New work appears after existing work has been charged for the slice, for
    // the same reason the emergency is raised here rather than at the top: a
    // job that arrives at the end of a slice must not be treated as having
    // been present during it.
    for (const job of admitArrivals(world)) {
      events.push({
        type: 'job-arrived',
        jobId: job.id,
        name: job.name,
        dueAtMinute: job.dueAtMinute,
      });
    }

    expireAbandonedJobs(world, events);

    // Rent, utilities and admin, by the minute. Identical in every option being
    // compared, which is exactly why it has to be here: leaving it out would
    // overstate the proportional effect of every decision.
    accrueFixedCosts(world, dt);
  }

  // Instruments running on their own advance first, and are not conditioned on
  // anybody being present: this is the one clock no shift bounds. A 48-hour
  // incubation started on Thursday afternoon finishes on Saturday.
  if (!options.freezeClock) tickUnattended(world, dt, events);

  // Machines are charged for the slice before people act in it. A slice is
  // clamped so that nothing starts or stops partway through, so whatever was
  // running at the start was running throughout. Charging afterwards instead
  // would bill a machine for the slice in which it was switched on at the very
  // last instant, and by an amount that depends on slice length.
  for (const eq of world.equipment) {
    if (eq.inUse) {
      eq.condition -= dt * t.conditionWearPerMinute;
      eq.totalWorkTime += dt;
    }
  }

  for (const person of world.staff) {
    tickStaff(world, person, dt, options, events);
  }

  // Jobs advance after people have moved, so arrival and the start of work are
  // the same instant rather than a slice apart. The loop iterates jobs rather
  // than people: work exists whether or not anyone is attached to it, which is
  // the whole point of the change.
  tickJobs(world, dt, events);

  // People arrive and leave after the slice they were present for has been
  // paid for.
  //
  // This was the other way round and it lost work. A slice clamped to end at
  // 16:00 lies entirely inside working hours, so every minute of it counts —
  // but sending people home first meant the job was already back in the queue
  // when tickJobs ran, and the final slice before closing was discarded. How
  // much work vanished depended on how long that slice happened to be, so a
  // coarse run and a fine run disagreed: 14 minutes against 15.
  //
  // Same rule as A2: whatever was true during a slice is charged for that
  // slice before anything changes.
  if (!options.freezeClock) applyShiftWindow(world, events);

  // Work is handed out after everything else has settled and before the
  // reasons are computed: somebody who has just been given a job is not
  // waiting for anything, and a job just taken is no longer in the queue.
  //
  // On a fixed cadence of absolute simulated time, which the loop clamps to
  // like any other event — see `nextDispatchIn`. Two weaker rules were tried
  // and both made the answer depend on how finely the caller stepped.
  if (!options.freezeClock && hasReached(world.simMinutes, nextDispatchAt(world))) {
    // Advanced by whole cadences from where it was, never recomputed from the
    // clock. `Math.floor(simMinutes + EPSILON)` looked equivalent and was not:
    // at a sixtieth-of-a-second step the clock reaches minute 567 as
    // 566.9999999997, which floors to 566, so the marker never moved and
    // dispatch then fired on *every* slice. The finest caller lost the cadence
    // entirely while coarser ones kept it — the exact failure the cadence was
    // introduced to prevent.
    while (hasReached(world.simMinutes, nextDispatchAt(world))) {
      world.dispatchedAtMinute += DISPATCH_CADENCE_MINUTES;
    }
    dispatch(world, events, options.dispatch);
  }

  // Why anything is not moving, computed from scratch once everything else has
  // settled — it is derived state, so it goes after every change rather than
  // among them. Computed before the shift window, it reported "everyone is
  // busy" at eight in the morning, when in fact nobody had arrived yet.
  //
  // Advisory only: a blocked job is still `waiting` to every other rule, which
  // is what stops it being an absorbing state and the simulation deadlocking
  // quietly.
  recomputeBlockReasons(world, events);
}

/**
 * Abandons a training part-way through.
 *
 * Only trainings reach here now. It used to serve the emergency path too, where
 * it charged a flat penalty and indexed a step list - the source of the Phase 1
 * crash where a cancelled training produced a NaN budget. With one kind of
 * work to undo there is nothing left to get wrong.
 */
export function failTask(
  world: WorldState,
  person: Staff,
  task: NonNullable<Staff['activeTask']>,
  events: EngineEvent[],
): void {
  void events;
  const equipment = world.equipment.find((e) => e.id === task.equipmentId);
  releaseEquipment(equipment, person);
  resetStaffTask(person);
}

function releaseEquipment(equipment: Equipment | undefined, person: Staff): void {
  if (equipment && equipment.assignedTo === person.id) {
    equipment.inUse = false;
    equipment.assignedTo = null;
  }
}

function resetStaffTask(person: Staff): void {
  person.activeTask = null;
  person.state = 'idle';
}

/**
 * Sends somebody home because they have hit the daily hours cap.
 *
 * The job goes back to the queue with its counters intact, like every other
 * interruption. Separate from the shift window because the cause is different
 * and worth distinguishing in a report: one is the lab closing, the other is a
 * person having worked twelve hours.
 */
function stopForTheDay(world: WorldState, person: Staff, events: EngineEvent[]): void {
  const job = releaseJobOf(world, person);
  person.state = 'off';
  person.targetX = null;
  person.targetY = null;
  events.push({
    type: 'hours-cap-reached',
    staffId: person.id,
    staffName: person.name,
    minutesWorked: person.minutesWorkedToday,
    jobSetDown: job?.id ?? null,
  });
}

function tickStaff(
  world: WorldState,
  person: Staff,
  dt: number,
  options: TickOptions,
  events: EngineEvent[],
): void {
  if (person.state === 'off' || person.state === 'sick' || person.state === 'vacation') return;
  const t = world.tuning;

  // Hours worked, credited once, in one place. A person 'working' at the start
  // of a slice works through all of it — the loop is clamped so nothing starts
  // or stops partway — so this count and the progress made on the job agree by
  // construction rather than by coincidence.
  if (person.state === 'working') {
    creditWork(world, person, dt);
    // The cap is the one thing that can send somebody home mid-step.
    if (person.minutesWorkedToday >= t.maxHoursPerDay * 60) {
      stopForTheDay(world, person, events);
      return;
    }
  }

  // Movement first, then the work. Arrival is an instant the loop lands on
  // exactly, so looking at the work *after* moving means it starts at that
  // instant rather than at the start of whatever slice comes next — which
  // would make the start time depend on how finely the simulation is stepped.
  moveStaff(world, person, dt, options);

  // Training is the only thing still ticked on a person. Everything else is
  // ticked on the job, which is what let the queue exist at all.
  if (person.activeTask) tickTraining(world, person, person.activeTask, dt, events);
}

function tickTraining(
  world: WorldState,
  person: Staff,
  task: Extract<NonNullable<Staff['activeTask']>, { type: 'training' }>,
  dt: number,
  events: EngineEvent[],
): void {
  const equipment = world.equipment.find((eq) => eq.id === task.equipmentId);
  if (!equipment) return;
  if (!hasArrivedAt(person, equipment)) return;

  if (person.state !== 'working') {
    if (equipment.inUse) {
      person.state = 'idle';
      return;
    }
    person.state = 'working';
    equipment.inUse = true;
    equipment.assignedTo = person.id;
  }

  person.taskTimer -= dt;
  if (person.taskTimer > EPSILON) return;

  if (!person.skills.includes(task.skillToLearn)) person.skills.push(task.skillToLearn);
  releaseEquipment(equipment, person);
  person.activeTask = null;
  person.state = 'idle';
  events.push({
    type: 'training-completed',
    staffId: person.id,
    staffName: person.name,
    skill: task.skillToLearn,
  });
}

function moveStaff(world: WorldState, person: Staff, dt: number, options: TickOptions): void {
  const f = world.layout.labFloor;

  if (person.targetX !== null && person.targetY !== null) {
    const dx = person.targetX - person.x;
    const dy = person.targetY - person.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!isArrived(dist)) {
      const speed = person.speed * (options.movementMultiplier ?? 1);
      person.x += (dx / dist) * speed * dt;
      person.y += (dy / dist) * speed * dt;
    } else {
      person.x = person.targetX;
      person.y = person.targetY;
    }
  } else if (
    person.state === 'idle' &&
    !person.activeTask &&
    hasReached(world.simMinutes, person.nextWanderAtMinute)
  ) {
    // Drawn from this person's own stream, not the lab's. Wandering is
    // cosmetic, but if it drew from the shared stream then how many people
    // there are would shift when emergencies happen — and a decision that
    // hires someone would change the weather along with the staffing.
    const own = rngForStaff(person);
    person.targetX = f.x + 1 + own.next() * (f.w - 2);
    person.targetY = f.y + 1 + own.next() * (f.h - 2);
    person.nextWanderAtMinute =
      world.simMinutes + own.nextInterval(world.tuning.wanderRatePerMinute);
    person.rngState = own.getState();
  }

  person.x = Math.max(f.x + 0.5, Math.min(f.x + f.w - 0.5, person.x));
  person.y = Math.max(f.y + 0.5, Math.min(f.y + f.h - 0.5, person.y));
}

/**
 * When work is next handed out.
 *
 * Every whole simulated minute. The cadence is arbitrary in itself — what
 * matters is that it is a function of *absolute simulated time* and nothing
 * else, so the instants are identical whether the caller steps a minute at a
 * time or a day.
 *
 * Two weaker rules were tried first and both failed, in instructive ways.
 * Dispatching at the end of every slice made the finer caller look more often,
 * so a one-minute run assigned a job at 567.98 that a fifteen-minute run
 * assigned at 566.98. Dispatching only on slices that ended on an event fixed
 * that case and still failed at an hour against a day — because once people are
 * walking, the *events themselves* are arrivals whose instants depend on who was
 * dispatched when, so "the next event" is not a cadence both runs agree on. It
 * is circular: dispatch changes the events, and the events were deciding when
 * to dispatch.
 *
 * A clock-derived cadence breaks the circle. The cost is that somebody who
 * becomes free at 566.98 waits until 567 — under a minute, uniformly, in every
 * run, and far smaller than the quarter of an hour the old out-of-loop
 * arrangement cost at a fifteen-minute step.
 */
function nextDispatchAt(world: WorldState): number {
  return world.dispatchedAtMinute + DISPATCH_CADENCE_MINUTES;
}

/** How often work is handed out, in simulated minutes. */
const DISPATCH_CADENCE_MINUTES = 1;
