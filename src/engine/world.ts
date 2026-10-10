/**
 * The simulation's state, and how one is built.
 *
 * A WorldState holds simulation facts only — money, people, machines, work,
 * the clock. It deliberately holds nothing about *looking* at the simulation:
 * no camera, no hovered entity, no selected staff, no open modal. Those live in
 * ViewState on the app side.
 *
 * That split is what makes Phase 4's two-labs-side-by-side cheap: two worlds,
 * two view states, one renderer called twice. It is also what makes a headless
 * run possible at all, since nothing here needs a browser.
 */
import type {
  Calendar,
  CatalogItem,
  Emergency,
  EmergencyTemplate,
  Equipment,
  Layout,
  Metrics,
  Prop,
  Scenario,
  Staff,
  TaskDefinition,
  Tuning,
  Wall,
} from '../domain/types';
import { minuteOfDay } from './calendar';
import { createRng, type Rng } from './rng';

export interface WorldState {
  scenarioId: string;
  /** Simulated seconds elapsed. */
  elapsedSeconds: number;
  /**
   * The clock: minutes since the run began, where minute 0 is Sunday 00:00.
   * Monotonic, never wrapped — which is what lets the engine know what day it
   * is, and therefore what a deadline in working days means.
   */
  simMinutes: number;
  /**
   * Minutes past midnight, derived from simMinutes every tick.
   *
   * Kept only so the HUD and the time-of-day overlay need no change. Engine
   * logic reads simMinutes; nothing should read this.
   */
  minutes: number;
  /** Working days, shift hours, and how deadlines are counted. */
  calendar: Calendar;
  /** Multiplier applied to elapsed time. 1 is real time. */
  speed: number;

  money: number;
  materials: number;
  samples: number;

  staff: Staff[];
  equipment: Equipment[];
  emergencies: Emergency[];
  /** Templates new emergencies are raised from. */
  emergencyTemplates: EmergencyTemplate[];
  tasks: TaskDefinition[];
  catalog: CatalogItem[];
  props: Prop[];
  walls: Wall[];

  layout: Layout;
  tuning: Tuning;

  /** The generator's position. Stored so a run can be cloned or resumed. */
  rngState: number;
  /** Source of unique ids. Replaces Date.now(), which is not deterministic. */
  nextId: number;

  metrics: Metrics;
}

export function createWorld(scenario: Scenario, seed: number, startMinutes?: number): WorldState {
  const rng = createRng(seed);
  const t = scenario.tuning;
  const f = scenario.layout.labFloor;

  const staff: Staff[] = scenario.staff.map((template, i) => ({
    ...template,
    skills: [...template.skills],
    id: i,
    x: f.x + 2 + (i % 4) * 3,
    y: f.y + 2 + Math.floor(i / 4) * 2,
    targetX: null,
    targetY: null,
    state: i < t.staffOnShiftCount ? 'idle' : 'off',
    energy: t.initialEnergyMin + rng.next() * t.initialEnergyRange,
    speed: t.staffWalkSpeed,
    color: `hsl(${i * 45}, 70%, 50%)`,
    activeTask: null,
    taskStep: 0,
    taskTimer: 0,
  }));

  const equipment: Equipment[] = scenario.equipment.map((template, i) => ({
    ...template,
    id: i,
    condition: t.initialConditionMin + rng.next() * t.initialConditionRange,
    inUse: false,
    assignedTo: null,
    totalWorkTime: 0,
  }));

  return {
    scenarioId: scenario.id,
    elapsedSeconds: 0,
    simMinutes: startMinutes ?? t.startMinutes,
    minutes: minuteOfDay(startMinutes ?? t.startMinutes),
    calendar: scenario.calendar,
    speed: 1,

    money: t.startingMoney,
    materials: t.startingMaterials,
    samples: t.startingSamples,

    staff,
    equipment,
    emergencies: [],
    emergencyTemplates: scenario.emergencies.map((e) => ({
      ...e,
      equipmentSequence: e.equipmentSequence.map((step) => ({ ...step })),
    })),
    tasks: scenario.tasks.map((task) => ({
      ...task,
      equipmentSequence: task.equipmentSequence.map((step) => ({ ...step })),
    })),
    catalog: scenario.catalog.map((item) => ({ ...item })),
    props: scenario.props.map((prop) => ({ ...prop })),
    walls: scenario.walls.map((wall) => ({ ...wall })),

    layout: scenario.layout,
    tuning: scenario.tuning,

    rngState: rng.getState(),
    nextId: 1,

    metrics: {
      tasksCompleted: 0,
      tasksFailed: 0,
      revenue: 0,
      penalties: 0,
      trainingSpend: 0,
      equipmentSpend: 0,
    },
  };
}

/**
 * A deep copy, used by sandbox mode to snapshot the live lab and by Phase 4 to
 * fork a world per decision. structuredClone rather than a JSON round-trip:
 * it is faster, and it does not quietly turn undefined into a missing key.
 */
export function cloneWorld(world: WorldState): WorldState {
  return structuredClone(world);
}

/** Restores the generator to where this world left off. */
export function rngFor(world: WorldState): Rng {
  const rng = createRng(1);
  rng.setState(world.rngState);
  return rng;
}

/** A unique id that does not depend on the wall clock. */
export function nextId(world: WorldState, prefix: string): string {
  return `${prefix}${world.nextId++}`;
}

export function findStaff(world: WorldState, id: number): Staff | undefined {
  return world.staff.find((p) => p.id === id);
}

export function findEquipment(world: WorldState, id: number): Equipment | undefined {
  return world.equipment.find((e) => e.id === id);
}

export function findEquipmentByName(world: WorldState, name: string): Equipment | undefined {
  return world.equipment.find((e) => e.name === name);
}
