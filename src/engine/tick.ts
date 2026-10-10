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
import type { ActiveJob, Equipment, Staff } from '../domain/types';
import { minuteOfDay } from './calendar';
import type { EngineEvent } from './events';
import type { Rng } from './rng';
import { findEquipmentByName, rngFor, type WorldState } from './world';

export interface TickOptions {
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
/** How close counts as arrived. */
const ARRIVAL_RADIUS = 0.1;

/** Below this, two instants are the same instant. Guards against float dust. */
const EPSILON = 1e-9;

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
  const rng = rngFor(world);

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
    applySlice(world, slice, options, rng, events);
    remaining -= slice;
  }

  world.rngState = rng.getState();
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
    at(world.nextEmergencyAtMinute);
    for (const e of world.emergencies) {
      if (e.status === 'pending' || e.status === 'in-progress') inMinutes(e.timeLimit);
    }
  }

  for (const person of world.staff) {
    if (person.state === 'off' || person.state === 'sick' || person.state === 'vacation') continue;

    // A step finishing.
    if (person.state === 'working') inMinutes(person.taskTimer);

    // A deadline falling due.
    const task = person.activeTask;
    if (task && !isTraining(task) && task.timeLimit !== undefined) inMinutes(task.timeLimit);

    // Energy crossing the threshold that forces a break, or clears one.
    if (person.state === 'working' && t.energyDrainPerMinute > 0) {
      inMinutes((person.energy - t.energyBreakThreshold) / t.energyDrainPerMinute);
    } else if (person.state === 'break' && t.energyRecoverPerMinute > 0) {
      inMinutes((t.energyRecoveredThreshold - person.energy) / t.energyRecoverPerMinute);
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
function hasArrivedAt(person: Staff, equipment: Equipment): boolean {
  const dx = equipment.x - person.x;
  const dy = equipment.y - person.y;
  return isArrived(Math.sqrt(dx * dx + dy * dy));
}

/**
 * Whether a distance counts as arrived.
 *
 * The tolerance is not decoration. Clamping a slice to the exact instant of
 * arrival leaves the distance a hair above the radius, and an untolerated
 * comparison then reports "not arrived" while the follow-up event is too small
 * to be worth a slice — so a whole step is taken and the walker overshoots.
 * One definition, used by the movement, the arrival test and the event clamp,
 * is what keeps those three agreeing.
 */
function isArrived(distance: number): boolean {
  return distance <= ARRIVAL_RADIUS + EPSILON;
}

/** Advances everything by a slice guaranteed not to step over any event. */
function applySlice(
  world: WorldState,
  dt: number,
  options: TickOptions,
  rng: Rng,
  events: EngineEvent[],
): void {
  const t = world.tuning;

  if (!options.freezeClock) {
    world.simMinutes += dt;
    world.minutes = minuteOfDay(world.simMinutes);

    // Existing work is charged for this slice before anything new appears, so
    // a deadline raised at the end of a slice is not immediately billed for a
    // slice it did not exist during. Getting this order wrong makes the
    // countdown depend on step size.
    tickEmergencies(world, dt, events);

    if (world.simMinutes >= world.nextEmergencyAtMinute) {
      if (!world.emergencies.some((e) => e.status === 'pending')) {
        raiseEmergency(world, events);
      }
      world.nextEmergencyAtMinute = world.simMinutes + rng.nextInterval(t.emergencyRatePerMinute);
    }
  }

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
    tickStaff(world, person, dt, options, rng, events);
  }
}

function raiseEmergency(world: WorldState, events: EngineEvent[]): void {
  const template = world.emergencyTemplates[0];
  if (!template) return;
  const id = `EMG${world.nextId++}`;
  world.emergencies.push({
    ...template,
    equipmentSequence: template.equipmentSequence.map((step) => ({ ...step })),
    id,
    status: 'pending',
  });
  events.push({ type: 'emergency-raised', emergencyId: id, name: template.name });
}

function tickEmergencies(world: WorldState, dt: number, events: EngineEvent[]): void {
  for (const e of world.emergencies) {
    if (e.status !== 'pending' && e.status !== 'in-progress') continue;
    e.timeLimit -= dt;
    if (e.timeLimit > EPSILON) continue;

    if (e.status === 'pending') {
      e.status = 'failed';
      world.money -= e.penalty;
      world.metrics.penalties += e.penalty;
      events.push({
        type: 'emergency-expired',
        emergencyId: e.id,
        name: e.name,
        penalty: e.penalty,
      });
    } else {
      const assignee = world.staff.find((s) => s.id === e.assignedTo);
      if (
        assignee?.activeTask &&
        !isTraining(assignee.activeTask) &&
        assignee.activeTask.id === e.id
      ) {
        failTask(world, assignee, assignee.activeTask, events);
      }
    }
  }
  world.emergencies = world.emergencies.filter(
    (e) => e.status === 'pending' || e.status === 'in-progress',
  );
}

function isTraining(
  task: NonNullable<Staff['activeTask']>,
): task is Extract<NonNullable<Staff['activeTask']>, { type: 'training' }> {
  return task.type === 'training';
}

/**
 * Cancels a task and charges its penalty.
 *
 * Exported because a command can cancel a task too — marking someone sick while
 * they are mid-job. That path used to crash: it called this unconditionally,
 * including on a training, which has neither a penalty nor an equipment
 * sequence, so the budget became NaN and indexing the sequence threw.
 */
export function failTask(
  world: WorldState,
  person: Staff,
  task: NonNullable<Staff['activeTask']>,
  events: EngineEvent[],
): void {
  if (isTraining(task)) {
    // A training has no penalty and no steps: release the machine and stop.
    const equipment = world.equipment.find((e) => e.id === task.equipmentId);
    releaseEquipment(equipment, person);
    resetStaffTask(person);
    return;
  }

  world.money -= task.penalty;
  world.metrics.penalties += task.penalty;
  world.metrics.tasksFailed += 1;

  const currentStep = task.equipmentSequence[person.taskStep];
  if (currentStep) releaseEquipment(findEquipmentByName(world, currentStep.name), person);

  if (task.isEmergency) {
    const emergency = world.emergencies.find((e) => e.id === task.id);
    if (emergency) emergency.status = 'failed';
  }

  resetStaffTask(person);
  events.push({
    type: 'task-failed',
    staffId: person.id,
    staffName: person.name,
    taskName: task.name,
    penalty: task.penalty,
  });
}

function releaseEquipment(equipment: Equipment | undefined, person: Staff): void {
  if (equipment && equipment.assignedTo === person.id) {
    equipment.inUse = false;
    equipment.assignedTo = null;
  }
}

function resetStaffTask(person: Staff): void {
  person.activeTask = null;
  person.taskStep = 0;
  person.state = 'idle';
}

function tickStaff(
  world: WorldState,
  person: Staff,
  dt: number,
  options: TickOptions,
  rng: Rng,
  events: EngineEvent[],
): void {
  if (person.state === 'off' || person.state === 'sick' || person.state === 'vacation') return;
  const t = world.tuning;

  if (person.state === 'working') person.energy -= dt * t.energyDrainPerMinute;
  if (person.state === 'break') person.energy += dt * t.energyRecoverPerMinute;
  if (person.energy < t.energyBreakThreshold && person.state !== 'break') person.state = 'break';
  if (person.energy > t.energyRecoveredThreshold && person.state === 'break') person.state = 'idle';

  // Movement first, then the work. Arrival is an instant the loop lands on
  // exactly, so looking at the work *after* moving means it starts at that
  // instant rather than at the start of whatever slice comes next — which
  // would make the start time depend on how finely the simulation is stepped.
  moveStaff(world, person, dt, options, rng);

  if (person.activeTask) {
    const task = person.activeTask;
    if (!isTraining(task) && task.timeLimit !== undefined) {
      task.timeLimit -= dt;
      if (task.timeLimit <= EPSILON) {
        failTask(world, person, task, events);
        return;
      }
    }
    if (isTraining(task)) tickTraining(world, person, task, dt, events);
    else tickJob(world, person, task, dt, events);
  }
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

function tickJob(
  world: WorldState,
  person: Staff,
  task: ActiveJob,
  dt: number,
  events: EngineEvent[],
): void {
  const currentStep = task.equipmentSequence[person.taskStep];
  if (!currentStep) {
    person.activeTask = null;
    return;
  }
  const equipment = findEquipmentByName(world, currentStep.name);

  if (person.state === 'working') {
    person.taskTimer -= dt;
    if (person.taskTimer > EPSILON) return;

    releaseEquipment(equipment, person);
    person.taskStep++;

    if (person.taskStep >= task.equipmentSequence.length) {
      world.money += task.reward;
      world.metrics.revenue += task.reward;
      world.metrics.tasksCompleted += 1;
      if (task.isEmergency) {
        const emergency = world.emergencies.find((e) => e.id === task.id);
        if (emergency) {
          emergency.status = 'completed';
          events.push({
            type: 'emergency-resolved',
            emergencyId: emergency.id,
            name: emergency.name,
          });
        }
      }
      resetStaffTask(person);
      events.push({
        type: 'task-completed',
        staffId: person.id,
        staffName: person.name,
        taskName: task.name,
        reward: task.reward,
      });
      return;
    }

    const nextStep = task.equipmentSequence[person.taskStep];
    const nextEquipment = nextStep ? findEquipmentByName(world, nextStep.name) : undefined;
    if (nextEquipment) {
      person.targetX = nextEquipment.x;
      person.targetY = nextEquipment.y;
    }
    person.state = 'idle';
    return;
  }

  if (!equipment) {
    // A step whose machine does not exist completes on the spot, which is how
    // the original behaved; it keeps a mis-specified scenario from deadlocking.
    person.targetX = null;
    person.targetY = null;
    person.state = 'working';
    person.taskTimer = currentStep.duration;
    return;
  }

  if (hasArrivedAt(person, equipment)) {
    if (equipment.inUse) {
      person.state = 'idle';
      return;
    }
    person.targetX = null;
    person.targetY = null;
    person.state = 'working';
    person.taskTimer = currentStep.duration;
    equipment.inUse = true;
    equipment.assignedTo = person.id;
  }
}

function moveStaff(
  world: WorldState,
  person: Staff,
  dt: number,
  options: TickOptions,
  rng: Rng,
): void {
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
    world.simMinutes >= person.nextWanderAtMinute
  ) {
    person.targetX = f.x + 1 + rng.next() * (f.w - 2);
    person.targetY = f.y + 1 + rng.next() * (f.h - 2);
    person.nextWanderAtMinute =
      world.simMinutes + rng.nextInterval(world.tuning.wanderRatePerMinute);
  }

  person.x = Math.max(f.x + 0.5, Math.min(f.x + f.w - 0.5, person.x));
  person.y = Math.max(f.y + 0.5, Math.min(f.y + f.h - 0.5, person.y));
}
