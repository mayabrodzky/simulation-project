/**
 * Everything a user can ask the lab to do, as data.
 *
 * A click becomes a Command object, the engine validates and applies it, and
 * returns events. The UI never reaches into the world to change it, and the
 * engine never reaches out to say what happened — it reports facts and lets the
 * UI choose the words.
 *
 * Refusals are events too (`rejected`, with a reason), rather than the engine
 * calling showNotification from inside business logic. That was the single
 * biggest obstacle to running the simulation without a browser.
 */
import type { EquipmentId, Skill, StaffId, TaskId } from '../domain/types';
import type { EngineEvent, RejectionReason } from './events';
import { isQualified } from './rules';
import { failTask } from './tick';
import { findEquipment, findEquipmentByName, findStaff, type WorldState } from './world';

export type Command =
  | { type: 'ASSIGN_TASK'; staffId: StaffId; taskId: TaskId }
  | { type: 'ASSIGN_EMERGENCY'; staffId: StaffId; emergencyId: string }
  | { type: 'START_TRAINING'; staffId: StaffId; equipmentId: EquipmentId; skill: Skill }
  | { type: 'SET_STATUS'; staffId: StaffId; sick: boolean }
  | { type: 'TOGGLE_SHIFT'; staffId: StaffId }
  | { type: 'SERVICE_EQUIPMENT'; equipmentId: EquipmentId; kind: 'repair' | 'calibrate' }
  | { type: 'BUY_EQUIPMENT'; catalogId: string };

export function applyCommand(world: WorldState, command: Command): EngineEvent[] {
  const events: EngineEvent[] = [];
  switch (command.type) {
    case 'ASSIGN_TASK':
      assignTask(world, command.staffId, command.taskId, null, events);
      break;
    case 'ASSIGN_EMERGENCY':
      assignTask(world, command.staffId, null, command.emergencyId, events);
      break;
    case 'START_TRAINING':
      startTraining(world, command, events);
      break;
    case 'SET_STATUS':
      setStatus(world, command.staffId, command.sick, events);
      break;
    case 'TOGGLE_SHIFT':
      toggleShift(world, command.staffId, events);
      break;
    case 'SERVICE_EQUIPMENT':
      serviceEquipment(world, command.equipmentId, command.kind, events);
      break;
    case 'BUY_EQUIPMENT':
      buyEquipment(world, command.catalogId, events);
      break;
  }
  return events;
}

function reject(events: EngineEvent[], reason: RejectionReason, detail?: string): void {
  events.push({ type: 'rejected', reason, detail });
}

function assignTask(
  world: WorldState,
  staffId: StaffId,
  taskId: TaskId | null,
  emergencyId: string | null,
  events: EngineEvent[],
): void {
  const person = findStaff(world, staffId);
  if (!person) return;
  if (person.state !== 'idle' || person.activeTask) {
    reject(events, 'not-idle', person.name);
    return;
  }

  const source = emergencyId
    ? world.emergencies.find((e) => e.id === emergencyId)
    : world.tasks.find((t) => t.id === taskId);
  if (!source) return;

  if (!isQualified(person, source)) {
    reject(events, 'unqualified', person.name);
    return;
  }

  const firstStep = source.equipmentSequence[0];
  const firstEquipment = firstStep ? findEquipmentByName(world, firstStep.name) : undefined;
  if (firstEquipment?.inUse) {
    const user = world.staff.find((s) => s.id === firstEquipment.assignedTo);
    reject(
      events,
      'equipment-in-use',
      user ? `${firstEquipment.name}|${user.name}` : firstEquipment.name,
    );
    return;
  }

  const copy = structuredClone(source);
  person.activeTask = emergencyId
    ? { ...copy, id: emergencyId, isEmergency: true }
    : { ...copy, id: taskId ?? copy.id };
  person.taskStep = 0;
  person.taskTimer = 0;
  person.state = 'idle';

  if (emergencyId) {
    const emergency = world.emergencies.find((e) => e.id === emergencyId);
    if (emergency) {
      emergency.status = 'in-progress';
      emergency.assignedTo = person.id;
    }
  }

  if (firstEquipment) {
    person.targetX = firstEquipment.x;
    person.targetY = firstEquipment.y;
  }

  events.push({
    type: 'task-assigned',
    staffId: person.id,
    staffName: person.name,
    taskName: source.name,
  });
}

function startTraining(
  world: WorldState,
  command: Extract<Command, { type: 'START_TRAINING' }>,
  events: EngineEvent[],
): void {
  const person = findStaff(world, command.staffId);
  if (!person) return;
  const equipment = findEquipment(world, command.equipmentId);
  if (!equipment) {
    reject(events, 'equipment-missing');
    return;
  }
  const cost = world.tuning.trainingCost;
  if (world.money < cost) {
    reject(events, 'no-funds', `${cost}`);
    return;
  }
  if (equipment.inUse) {
    reject(events, 'equipment-in-use', equipment.name);
    return;
  }
  if (person.skills.includes(command.skill)) {
    reject(events, 'already-known', command.skill);
    return;
  }

  world.money -= cost;
  world.metrics.trainingSpend += cost;
  person.activeTask = {
    type: 'training',
    name: `Training on ${equipment.name}`,
    skillToLearn: command.skill,
    equipmentId: equipment.id,
    duration: world.tuning.trainingDuration,
  };
  person.taskTimer = world.tuning.trainingDuration;
  person.targetX = equipment.x;
  person.targetY = equipment.y;

  events.push({
    type: 'training-started',
    staffId: person.id,
    staffName: person.name,
    skill: command.skill,
    cost,
  });
}

function setStatus(
  world: WorldState,
  staffId: StaffId,
  sick: boolean,
  events: EngineEvent[],
): void {
  const person = findStaff(world, staffId);
  if (!person) return;

  // Someone off shift cannot be marked sick. Without this, clearing sick
  // afterwards would set them to idle and quietly put them back on shift.
  if (person.state === 'off') {
    reject(events, 'off-shift', person.name);
    return;
  }

  // Cancelling mid-task used to crash when the task was a training: failTask
  // charged task.penalty (undefined, so the budget became NaN) and indexed
  // task.equipmentSequence (absent, so it threw). failTask now handles both.
  if (person.activeTask) failTask(world, person, person.activeTask, events);

  person.state = sick ? 'sick' : 'idle';
  events.push({
    type: 'staff-status-changed',
    staffId: person.id,
    staffName: person.name,
    status: person.state,
  });
}

function toggleShift(world: WorldState, staffId: StaffId, events: EngineEvent[]): void {
  const person = findStaff(world, staffId);
  if (!person) return;

  if (person.state === 'off') {
    person.state = 'idle';
    person.energy = 100;
  } else {
    if (person.activeTask) failTask(world, person, person.activeTask, events);
    person.state = 'off';
  }

  events.push({
    type: 'shift-toggled',
    staffId: person.id,
    staffName: person.name,
    onShift: person.state !== 'off',
  });
}

function serviceEquipment(
  world: WorldState,
  equipmentId: EquipmentId,
  kind: 'repair' | 'calibrate',
  events: EngineEvent[],
): void {
  const equipment = findEquipment(world, equipmentId);
  if (!equipment) {
    reject(events, 'equipment-missing');
    return;
  }
  const cost = kind === 'repair' ? world.tuning.repairCost : world.tuning.calibrateCost;
  const amount = kind === 'repair' ? world.tuning.repairAmount : world.tuning.calibrateAmount;
  if (world.money < cost) {
    reject(events, 'no-funds', `${cost}`);
    return;
  }

  world.money -= cost;
  world.metrics.equipmentSpend += cost;
  equipment.condition = Math.min(100, equipment.condition + amount);

  events.push({
    type: 'equipment-serviced',
    equipmentId: equipment.id,
    equipmentName: equipment.name,
    kind,
    cost,
  });
}

function buyEquipment(world: WorldState, catalogId: string, events: EngineEvent[]): void {
  const item = world.catalog.find((c) => c.id === catalogId);
  if (!item) return;
  if (world.money < item.cost) {
    reject(events, 'no-funds', `${item.cost}`);
    return;
  }

  const spot = findFreeTile(world);
  if (!spot) {
    reject(events, 'no-space');
    return;
  }

  world.money -= item.cost;
  world.metrics.equipmentSpend += item.cost;

  // A fresh id rather than the array length, which collides after a removal.
  const id = world.equipment.reduce((max, e) => Math.max(max, e.id), -1) + 1;
  world.equipment.push({
    id,
    name: item.name,
    icon: item.icon,
    skill: item.skill,
    x: spot.x,
    y: spot.y,
    condition: 100,
    inUse: false,
    assignedTo: null,
    totalWorkTime: 0,
  });

  events.push({
    type: 'equipment-purchased',
    equipmentId: id,
    equipmentName: item.name,
    cost: item.cost,
  });
}

function findFreeTile(world: WorldState): { x: number; y: number } | null {
  const f = world.layout.labFloor;
  for (let x = f.x + 1; x < f.x + f.w - 1; x++) {
    for (let y = f.y + 1; y < f.y + f.h - 1; y++) {
      const taken = world.equipment.some((e) => Math.round(e.x) === x && Math.round(e.y) === y);
      if (!taken) return { x, y };
    }
  }
  return null;
}
