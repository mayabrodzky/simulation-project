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
  Job,
  WorkType,
  CatalogItem,
  Equipment,
  Layout,
  Metrics,
  Prop,
  Scenario,
  Staff,
  Tuning,
  Wall,
} from '../domain/types';
import { generateWeekArrivals } from './arrivals';
import { dayIndex, isWithinShift, minuteOfDay, shiftForWeeklyHours, weekIndex } from './calendar';
import { hasReached } from './geometry';
import { createRng, deriveSeed, type Rng } from './rng';

export interface WorldState {
  scenarioId: string;
  /**
   * The master seed. Kept on the world because derived streams are needed
   * during a run, not only at creation — the next week of demand is derived
   * from it when the clock reaches that week.
   */
  seed: number;
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
  /**
   * Work that has arrived: waiting, in progress, finished or abandoned.
   *
   * Finished jobs are kept rather than discarded. "How late were we last week?"
   * cannot be answered from a queue that throws away everything it completes,
   * and the batch runner reports exactly that.
   */
  jobs: Job[];
  /**
   * Work that will arrive, soonest first. Generated ahead of the clock so the
   * slice loop can land exactly on each arrival.
   */
  arrivalQueue: Job[];
  /**
   * How many weeks of demand have been generated. Weeks are keyed
   * independently, so this is bookkeeping rather than state the result depends
   * on — see arrivals.ts.
   */
  weeksGenerated: number;
  /** Source of job ids, so they read in arrival order. */
  nextJobNumber: number;
  /**
   * When block reasons were last worked out.
   *
   * They are derived state, recomputed at most once per simulated minute. The
   * slice loop can run a million times for four simulated hours, and anything
   * that walks every job against every person on every slice makes a fast run
   * slower than the real-time one it is supposed to replace.
   */
  blockReasonsAtMinute: number;
  /**
   * The next instant somebody's shift starts or ends.
   *
   * Cached because working it out walks the calendar day by day, per person,
   * and the slice loop asks on every slice. Recomputed only once the clock
   * reaches it.
   */
  nextShiftBoundaryAtMinute: number;
  /** What the lab sells. Scenario data; the simulation never changes it. */
  workTypes: WorkType[];
  catalog: CatalogItem[];
  props: Prop[];
  walls: Wall[];

  layout: Layout;
  tuning: Tuning;

  /** The generator's position. Stored so a run can be cloned or resumed. */
  rngState: number;
  /** Source of unique ids. Replaces Date.now(), which is not deterministic. */
  nextId: number;
  /**
   * The day and week the hour ledgers were last reset for.
   *
   * Compared against the clock rather than scheduled, because nothing works
   * across midnight — the reset always lands before the new day's first
   * attended minute, whatever the step size.
   */
  ledgerDay: number;
  ledgerWeek: number;

  metrics: Metrics;
}

/**
 * Refuses to simulate an assumption the engine does not implement.
 *
 * `instrumentFreedWhenRunEnds` changes what the audit judges feasible — under
 * the strict reading this scenario is impossible in three places — but the
 * simulation itself always behaves as though a finished run frees its
 * instrument. Modelling the alternative means a sample sitting in an instrument
 * until somebody comes to take it out, which is an unload step the engine does
 * not have.
 *
 * So setting it to false throws rather than running. A parameter that silently
 * governs one half of the system and not the other is worse than no parameter:
 * it produces a confident answer to a question it did not actually ask.
 */
function assertTuningIsImplemented(scenario: Scenario): void {
  if (!scenario.tuning.instrumentFreedWhenRunEnds) {
    throw new Error(
      'instrumentFreedWhenRunEnds: false is not implemented in the simulation. ' +
        'It changes what the audit judges feasible, and the engine would still ' +
        'behave as though a run frees its instrument. See docs/product-spec.md §7.',
    );
  }
}

export function createWorld(scenario: Scenario, seed: number, startMinutes?: number): WorldState {
  assertTuningIsImplemented(scenario);
  const rng = createRng(deriveSeed(seed, 'operations'));
  const t = scenario.tuning;
  const f = scenario.layout.labFloor;
  const start = startMinutes ?? t.startMinutes;

  // Each person and each machine draws from a stream of its own, named after
  // it. Appending a ninth person therefore leaves the other eight, every
  // machine, and the schedule of events exactly as they were — which is what
  // makes "with this decision" and "without it" the same lab.
  const staff: Staff[] = scenario.staff.map((template, i) => {
    const own = createRng(deriveSeed(seed, `staff:${i}`));
    // Contracted hours become an actual window. A part-timer on twenty hours
    // works mornings; see shiftForWeeklyHours for why that reading was chosen.
    const shift = shiftForWeeklyHours(scenario.calendar, template.weeklyHours);
    return {
      ...template,
      skills: [...template.skills],
      id: i,
      x: f.x + 2 + (i % 4) * 3,
      y: f.y + 2 + Math.floor(i / 4) * 2,
      targetX: null,
      targetY: null,
      rostered: i < t.staffOnShiftCount,
      shift,
      // A world opened at 02:00 starts with an empty floor, not a full one.
      // Read from the calendar here rather than by calling applyShiftWindow,
      // which would make world.ts depend on shifts.ts and jobs.ts and so on
      // itself — the dependency direction is worth more than the reuse.
      state: i < t.staffOnShiftCount && isWithinShift(shift, start) ? 'idle' : 'off',
      minutesWorkedToday: 0,
      minutesWorkedThisWeek: 0,
      overtimeMinutesThisWeek: 0,
      speed: t.staffWalkGridPerMinute,
      color: `hsl(${i * 45}, 70%, 50%)`,
      jobId: null,
      activeTask: null,
      taskStep: 0,
      taskTimer: 0,
      nextWanderAtMinute: start + own.nextInterval(t.wanderRatePerMinute),
      rngState: own.getState(),
    };
  });

  // Counts expand into instances. Two mass spectrometers are two things that
  // can run at once, each with its own id, wear and position — not one sprite
  // drawn twice, which is what "capacity is a name" produced before.
  //
  // Condition is still derived per instance from its own stream, so adding a
  // second instrument cannot change the first one's starting condition.
  const equipment: Equipment[] = [];
  scenario.equipment.forEach((template, typeIndex) => {
    for (let instance = 0; instance < Math.max(1, template.count); instance++) {
      const id = equipment.length;
      const own = createRng(deriveSeed(seed, `equipment:${typeIndex}:${instance}`));
      equipment.push({
        ...template,
        capabilities: [...template.capabilities],
        id,
        instance: instance + 1,
        // Spread sideways so two of the same instrument are both visible. A
        // real layout for multiple instruments is Phase 2.5's problem.
        x: template.x + instance * 1.2,
        y: template.y,
        name: template.count > 1 ? `${template.name} ${instance + 1}` : template.name,
        condition: t.initialConditionMin + own.next() * t.initialConditionRange,
        heldBy: [],
        inUse: false,
        assignedTo: null,
        totalWorkTime: 0,
      });
    }
  });

  const world: WorldState = {
    scenarioId: scenario.id,
    seed,
    elapsedSeconds: 0,
    simMinutes: start,
    minutes: minuteOfDay(start),
    calendar: scenario.calendar,
    speed: 1,

    money: t.startingMoney,
    materials: t.startingMaterials,
    samples: t.startingSamples,

    staff,
    equipment,
    jobs: [],
    arrivalQueue: [],
    weeksGenerated: 0,
    nextJobNumber: 1,
    blockReasonsAtMinute: -Infinity,
    nextShiftBoundaryAtMinute: -Infinity,
    workTypes: scenario.workTypes.map((w) => ({
      ...w,
      steps: w.steps.map((step) => ({ ...step })),
    })),
    catalog: scenario.catalog.map((item) => ({ ...item })),
    props: scenario.props.map((prop) => ({ ...prop })),
    walls: scenario.walls.map((wall) => ({ ...wall })),

    layout: scenario.layout,
    tuning: scenario.tuning,

    rngState: rng.getState(),
    nextId: 1,
    ledgerDay: dayIndex(start),
    ledgerWeek: weekIndex(start),

    metrics: {
      tasksCompleted: 0,
      tasksFailed: 0,
      revenue: 0,
      penalties: 0,
      trainingSpend: 0,
      equipmentSpend: 0,
    },
  };

  // Demand for the opening week has to exist before the first slice, so the
  // loop can clamp to the first arrival rather than stepping over it.
  ensureArrivalsThrough(world, start);
  return world;
}

/**
 * Generates demand up to and including the week after `throughMinute`.
 *
 * Called with the end of the span about to be simulated, which is what makes it
 * independent of step size: advancing a fortnight in one call and in twenty
 * thousand calls both finish having generated through the same week, because
 * the last call's end is the same instant either way.
 *
 * The one-week lookahead is so the queue is never empty merely because the
 * clock is near a week boundary — the view asks what arrives next.
 */
export function ensureArrivalsThrough(world: WorldState, throughMinute: number): void {
  const wanted = weekIndex(throughMinute) + 2;
  // Called once per slice, which at a sixtieth-of-a-second step is nearly a
  // million times for four simulated hours, so the common case of "nothing to
  // generate" has to cost one comparison and no allocation.
  if (world.weeksGenerated >= wanted) return;

  while (world.weeksGenerated < wanted) {
    const week = world.weeksGenerated;
    const arrivals = generateWeekArrivals(
      world.workTypes,
      world.calendar,
      world.tuning,
      world.seed,
      week,
      world.nextJobNumber,
    );
    world.nextJobNumber += arrivals.length;
    world.weeksGenerated = week + 1;

    // A world may start mid-week, and anything already in the past at that
    // point never arrives. Dropping it here rather than admitting it late
    // keeps "arrived" meaning "the clock reached this instant".
    for (const job of arrivals) {
      if (job.arrivedAtMinute >= world.simMinutes) world.arrivalQueue.push(job);
    }
  }
  world.arrivalQueue.sort((a, b) => a.arrivedAtMinute - b.arrivedAtMinute);
}

/** Moves everything that has now arrived out of the queue. Returns what moved. */
export function admitArrivals(world: WorldState): Job[] {
  const admitted: Job[] = [];
  while (
    world.arrivalQueue.length > 0 &&
    hasReached(world.simMinutes, world.arrivalQueue[0]!.arrivedAtMinute)
  ) {
    const job = world.arrivalQueue.shift()!;
    world.jobs.push(job);
    admitted.push(job);
  }
  return admitted;
}

/**
 * A deep copy, used by sandbox mode to snapshot the live lab and by Phase 4 to
 * fork a world per decision. structuredClone rather than a JSON round-trip:
 * it is faster, and it does not quietly turn undefined into a missing key.
 */
export function cloneWorld(world: WorldState): WorldState {
  return structuredClone(world);
}

/** Restores the lab-wide operations generator to where this world left off. */
export function rngFor(world: WorldState): Rng {
  const rng = createRng(1);
  rng.setState(world.rngState);
  return rng;
}

/**
 * Restores one person's own generator.
 *
 * Each entity carries its own stream, so how many entities exist cannot change
 * what the others draw. The caller must write `getState()` back when done —
 * see `deriveSeed` for why this is worth the bookkeeping.
 */
export function rngForStaff(person: Staff): Rng {
  const rng = createRng(1);
  rng.setState(person.rngState);
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
