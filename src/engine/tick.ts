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

const MINUTES_PER_DAY = 1440;

export function tick(
  world: WorldState,
  dtSeconds: number,
  options: TickOptions = {},
): EngineEvent[] {
  const events: EngineEvent[] = [];
  const rng = rngFor(world);
  const t = world.tuning;
  const dt = dtSeconds * world.speed;

  world.elapsedSeconds += dt;

  if (!options.freezeClock) {
    world.minutes += dt * t.minutesPerSecond;
    if (world.minutes >= MINUTES_PER_DAY) world.minutes -= MINUTES_PER_DAY;

    if (rng.chance(t.emergencyRatePerSecond, dt)) {
      if (!world.emergencies.some((e) => e.status === 'pending')) {
        raiseEmergency(world, events);
      }
    }
    tickEmergencies(world, dt, events);
  }

  for (const person of world.staff) {
    tickStaff(world, person, dt, options, rng, events);
  }

  for (const eq of world.equipment) {
    if (eq.inUse) {
      eq.condition -= dt * t.conditionWearPerSecond;
      eq.totalWorkTime += dt;
    }
  }

  world.rngState = rng.getState();
  return events;
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
    if (e.timeLimit > 0) continue;

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

  if (person.state === 'working') person.energy -= dt * t.energyDrainPerSecond;
  if (person.state === 'break') person.energy += dt * t.energyRecoverPerSecond;
  if (person.energy < t.energyBreakThreshold && person.state !== 'break') person.state = 'break';
  if (person.energy > t.energyRecoveredThreshold && person.state === 'break') person.state = 'idle';

  if (person.activeTask) {
    const task = person.activeTask;
    if (!isTraining(task) && task.timeLimit !== undefined) {
      task.timeLimit -= dt;
      if (task.timeLimit <= 0) {
        failTask(world, person, task, events);
        return;
      }
    }
    if (isTraining(task)) tickTraining(world, person, task, dt, events);
    else tickJob(world, person, task, dt, events);
  }

  moveStaff(world, person, dt, options, rng);
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
  if (Math.round(person.x) !== equipment.x || Math.round(person.y) !== equipment.y) return;

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
  if (person.taskTimer > 0) return;

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
    if (person.taskTimer > 0) return;

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

  if (Math.round(person.x) === equipment.x && Math.round(person.y) === equipment.y) {
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
    if (dist > 0.1) {
      const speed = person.speed * (options.movementMultiplier ?? 1);
      // The * 60 is historical: speed was authored per frame at 60fps.
      person.x += (dx / dist) * speed * dt * 60;
      person.y += (dy / dist) * speed * dt * 60;
    } else {
      person.x = person.targetX;
      person.y = person.targetY;
    }
  } else if (
    person.state === 'idle' &&
    !person.activeTask &&
    rng.chance(world.tuning.wanderRatePerSecond, dt)
  ) {
    person.targetX = f.x + 1 + rng.next() * (f.w - 2);
    person.targetY = f.y + 1 + rng.next() * (f.h - 2);
  }

  person.x = Math.max(f.x + 0.5, Math.min(f.x + f.w - 0.5, person.x));
  person.y = Math.max(f.y + 0.5, Math.min(f.y + f.h - 0.5, person.y));
}
