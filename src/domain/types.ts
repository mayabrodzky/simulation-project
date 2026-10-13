/**
 * Shared domain types.
 *
 * This module depends on nothing. `engine`, `scenarios`, `render` and `ui` all
 * depend only on it, which is what keeps the dependency direction one-way.
 *
 * Field names deliberately still match the current runtime shapes rather than
 * the names the engine will eventually want (`equipmentSequence` → `steps`,
 * durations suffixed with their unit). Renaming is a change to logic and
 * belongs with the engine extraction, not with moving data into a file.
 */

export type StaffId = number;
export type EquipmentId = number;
export type TaskId = string;
export type JobId = string;
/** Identifies a kind of work the lab sells. Scenario-defined. */
export type WorkTypeId = string;

/** What a person is trained to do. Scenario-defined. */
export type Skill = string;

/**
 * What a step needs doing *to* it, and what an instrument can do.
 *
 * Replaces matching a step to a machine by exact name. Naming the machine made
 * capacity a name rather than a count: the shop sold "Microscope B" and no step
 * asked for it, so a second instrument could never relieve anything. A step now
 * asks for `microscopy` and any instrument offering it will do — which is what
 * makes "lease a second mass spectrometer" a decision the model can evaluate.
 */
export type Capability = string;

export type StaffState = 'idle' | 'working' | 'break' | 'off' | 'sick' | 'vacation';

/* --- Time ------------------------------------------------------------------
 *
 * Simulated time is one monotonic count of minutes since the start of the run,
 * where minute 0 is Sunday 00:00. Nothing wraps. A wrapping clock cannot say
 * what day it is, which is why deadlines, overtime and shifts are all
 * impossible to express against one.
 */

/** 0 = Sunday. The lab works Sunday to Thursday. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** When a group of people are at work. Minutes are measured from midnight. */
export interface Shift {
  days: DayOfWeek[];
  startMinute: number; // 08:00 → 480
  endMinute: number; // 16:00 → 960
}

export interface Calendar {
  /** The default shift. Individuals may override it — an evening shift is a decision. */
  shift: Shift;
  /**
   * Whether "two working days" counts the day the job arrived.
   *
   * false (the default) means a job arriving Sunday is due at close on
   * Tuesday. This is a genuine open question for the lab manager rather than a
   * fact, which is why it is data — see docs/product-spec.md §7.
   */
  deadlineCountsArrivalDay: boolean;
  /**
   * Rush deadlines are quoted in wall-clock hours, not working hours: "24
   * hours" means tomorrow, including overnight. That is what makes a rush
   * order hard, and it is also why one arriving on Thursday afternoon may be
   * impossible to meet.
   */
  rushDeadlineMode: 'calendar' | 'working';
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/* --- Scenario data (the facts about one domain) --------------------------- */

export interface StaffTemplate {
  name: string;
  role: string;
  skills: Skill[];
  /**
   * Contracted hours a week. 40 for full-time, 20 for a part-timer.
   *
   * Turned into an actual shift window at world creation, because the engine
   * needs to know *when* somebody is in the building, not only how much. A
   * number rather than a window because that is what a contract says, and
   * because B1 charges labour against contracted hours whether or not they are
   * worked — an idle hire has to cost something or decision A looks free.
   */
  weeklyHours: number;
}

export interface EquipmentTemplate {
  name: string;
  icon: string;
  x: number;
  y: number;
  /** The skill a person trains on here. Not what the instrument *does*. */
  skill: Skill | null;
  /** What work this instrument can take. */
  capabilities: Capability[];
  /**
   * How many of this instrument the lab owns. What decision B increases.
   *
   * Each one becomes a separate instance with its own id and position, so two
   * mass spectrometers are two things that can run at once rather than one
   * sprite drawn twice.
   */
  count: number;
  /**
   * How many jobs one instrument can hold at the same time.
   *
   * One for a centrifuge, eight for an incubator — a cabinet holds many plates.
   * Without this the model jams rather than merely queueing: twelve cell
   * cultures at 48 hours each is 576 instrument-hours a week against 168
   * calendar hours, which is infeasible at any *count* if each instrument holds
   * one job. `count` is the decision; `capacity` is the physics.
   */
  capacity: number;
}

export interface TaskStep {
  /** Matches EquipmentTemplate.name. Resolved by name at assignment time. */
  name: string;
  duration: number;
  skillRequired: Skill | null;
}

/* --- Work ------------------------------------------------------------------
 *
 * A `WorkType` is what the lab sells — a recipe, scenario data, never changed
 * by the simulation. A `Job` is one instance of it: a real sample that arrived
 * at a real minute, is due at a real minute, and is either waiting, being
 * worked on, finished or abandoned.
 *
 * The distinction is the whole point of this step. Before it, work did not
 * exist until a person was told to do it, so there was no queue, no backlog and
 * no such thing as late. "Are we falling behind?" — the question the product
 * exists to answer — was not expressible.
 */

/**
 * When a step holds its instrument.
 *
 * The distinction the scenario's whole story depends on. Mass spectrometry is
 * 60 minutes of preparation and then 90 minutes of the instrument running
 * alone: if the instrument were held during preparation too, demand on it would
 * be 30 jobs x 150 min = 75 hours a week instead of 45, and the lab would be
 * structurally broken rather than merely tight. So preparation holds nobody's
 * instrument.
 *
 * `'both'` is for the things you load and stay with — a centrifuge, a
 * microscope — and for an incubator, which is occupied from the moment the
 * plates go in.
 */
export type ResourceHeld = 'attended' | 'unattended' | 'both';

/** One stage of a recipe. */
export interface WorkStepTemplate {
  /** What needs doing, not which machine does it. */
  capability: Capability;
  skillRequired: Skill | null;
  /** Minutes with a person attached. Only advances in their working hours. */
  attended: number;
  /**
   * Minutes the instrument runs alone.
   *
   * Ignores the calendar completely: a 48-hour incubation runs through nights
   * and weekends. That needs no overnight special case, which is the point of
   * separating the two clocks — the operator's time is bounded by a shift and
   * the instrument's is not.
   */
  unattended: number;
  resourceHeldDuring: ResourceHeld;
}

export interface WorkType {
  id: WorkTypeId;
  name: string;
  /** Mean jobs arriving per week. */
  perWeek: number;
  /**
   * Spread around `perWeek`, as a fraction. 0.2 means the weekly count is drawn
   * uniformly from 80%–120% of the mean. Real demand is lumpy, and a lab that
   * only ever receives exactly the average never shows a queue.
   */
  variation: number;
  /** Price in ₪ before any lateness adjustment. A6 adds partial credit. */
  basePrice: number;
  /** Working days allowed, counted as close of business on the n-th. */
  dueWorkingDays: number;
  steps: WorkStepTemplate[];
}

export type JobStatus =
  | 'waiting'
  | 'in-progress'
  /**
   * The instrument is running and nobody is attached.
   *
   * A real state rather than a flavour of in-progress, because the operator is
   * free and dispatchable while this is true — which is the whole reason the
   * mass spectrometer can be a bottleneck without its scientist being one.
   */
  | 'unattended'
  /** Advisory, recomputed every pass, never absorbing. Set in A3c. */
  | 'blocked'
  | 'done-on-time'
  | 'done-late'
  /** The client gave up and cancelled. */
  | 'expired';

/**
 * Why a job is not moving.
 *
 * Counted by reason over a run, this is the "what is holding the lab back"
 * sentence, obtained for free rather than inferred from utilisation numbers.
 */
export type BlockReason =
  | 'no-qualified-operator'
  | 'everyone-busy'
  | 'resource-busy'
  | 'outside-working-hours'
  | 'no-such-resource';

/** A step of a live job. Counts *remaining*, which is what makes pausing free. */
export interface JobStep {
  capability: Capability;
  skillRequired: Skill | null;
  /** Attended minutes still to do. Pausing is simply not decrementing it. */
  remaining: number;
  /** What the attended phase started as, so progress needs no second source. */
  total: number;
  /** Unattended minutes still to run. Counts down through the night. */
  unattendedRemaining: number;
  unattendedTotal: number;
  resourceHeldDuring: ResourceHeld;
}

export interface Job {
  id: JobId;
  workTypeId: WorkTypeId;
  /** Copied from the work type so a display never has to resolve the recipe. */
  name: string;
  status: JobStatus;
  /** Absolute minute. */
  arrivedAtMinute: number;
  /**
   * Absolute minute, computed once at arrival rather than counted down.
   *
   * A countdown has to be decremented by someone, which is why lateness used to
   * be binary and why a paused job used to keep losing time. An instant is
   * simply compared against the clock.
   */
  dueAtMinute: number;
  /**
   * When the client gives up, as an absolute minute. Also set once at arrival.
   *
   * Stored rather than derived because deriving it means walking the calendar
   * day by day, and the alternative is doing that for every waiting job on
   * every slice — hundreds of thousands of times a simulated week.
   */
  expiresAtMinute: number;
  /** The work type's ordinary price, before any rush premium or lateness. */
  basePrice: number;
  /**
   * A client who needs it tomorrow.
   *
   * A flag on an ordinary job, not a separate entity. The emergencies it
   * replaces were a parallel kind of work with their own templates, their own
   * progress fields on the person, their own events and a flat penalty - and
   * none of that was needed, because what makes a rush order matter is
   * arithmetic rather than mechanism. See settlement in jobs.ts.
   */
  rush: boolean;
  steps: JobStep[];
  stepIndex: number;
  /** Who is on it, when anyone is. */
  operatorId: StaffId | null;
  /** Which machine it holds, when it holds one. */
  equipmentId: EquipmentId | null;
  /** Set by manual assignment. The dispatcher never reassigns a pinned job. */
  pinnedStaffId: StaffId | null;
  completedAtMinute: number | null;
  /** What was actually paid. A6 makes this differ from basePrice. */
  settledRevenue: number;
  blockReason: BlockReason | null;
  /**
   * When the current block began, or null if nothing is in the way.
   *
   * Reset the moment the reason clears, so it measures one continuous wait
   * rather than a total. A job that is blocked, freed and blocked again has not
   * stalled; a job blocked for two days has.
   */
  blockedSinceMinute: number | null;
  /** Set once when the block has lasted long enough to be worth reporting. */
  stallReported: boolean;
}

export interface CatalogItem {
  id: string;
  name: string;
  icon: string;
  cost: number;
  skill: Skill | null;
  /**
   * What the purchase would let the lab do.
   *
   * Phase 1 recorded that bought equipment could never relieve a bottleneck:
   * steps matched machines by exact name and the shop sold names - "Microscope
   * B", "Auto-Sampler" - that no step asked for. A purchase now adds
   * capability, so a second instrument is extra capacity for the work that
   * already queues. This is the last piece of that finding.
   */
  capabilities: Capability[];
  capacity: number;
}

export interface Prop {
  type: 'desk' | 'shelf' | 'plant' | 'coffee' | 'door';
  x: number;
  y: number;
  w?: number;
  h?: number;
  icon: string;
}

export interface Wall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  height: number;
}

export interface Layout {
  gridWidth: number;
  gridHeight: number;
  tileSize: number;
  tileHeight: number;
  labFloor: Rect;
  office1: Rect;
  office2: Rect;
  initialCamera: Camera;
}

/**
 * Every model assumption in one place. Phase 2 makes this user-editable and
 * Phase 4 surfaces it as the "I assumed PCR takes ~90 min" panel, so anything
 * tunable belongs here rather than inline at its point of use.
 *
 * Rates are per simulated second, which is the unit the current loop uses.
 */
export interface Tuning {
  startingMoney: number;
  startingMaterials: number;
  startingSamples: number;
  /**
   * Simulated minutes per real second, for the live view. The batch runner
   * ignores it and steps in simulated minutes directly.
   */
  minutesPerSecond: number;
  /** Clock position at startup, in minutes past midnight. */
  startMinutes: number;

  trainingCost: number;
  trainingDuration: number;
  repairCost: number;
  repairAmount: number;
  calibrateCost: number;
  calibrateAmount: number;

  energyDrainPerMinute: number;
  energyRecoverPerMinute: number;
  energyBreakThreshold: number;
  energyRecoveredThreshold: number;
  conditionWearPerMinute: number;

  /** Average idle wanders per simulated minute. Cosmetic. */
  wanderRatePerMinute: number;

  /** Grid units covered per simulated minute. */
  staffWalkGridPerMinute: number;
  initialEnergyMin: number;
  initialEnergyRange: number;
  initialConditionMin: number;
  initialConditionRange: number;
  /** Staff beyond this index start off-shift. */
  staffOnShiftCount: number;

  /**
   * Working days past its deadline before a client cancels and the job becomes
   * `expired`.
   *
   * An assumption, not a fact — recorded in docs/product-spec.md §7 as a
   * question for the lab manager. It is here rather than inline because it
   * decides how much revenue a badly overloaded lab loses outright, and that
   * number should be arguable with rather than buried.
   */
  abandonAfterWorkingDays: number;

  /**
   * Hours of continuous blocking before a job is reported as stalled.
   *
   * A warning, not a rule: nothing changes when it fires. It exists because a
   * simulation that fails by quietly doing nothing is the worst failure shape
   * available — it looks like a working run with a disappointing result.
   */
  stalledAfterHours: number;

  /* --- What work is worth, and what lateness costs --------------------------
   *
   * The asymmetry here is the whole reason a rush order is a decision rather
   * than a bonus. A 900 shekel job quoted as a rush is worth 1,350 on time and
   * 630 missed - against materials already spent - so the same job swings by
   * 720 shekels on whether it lands. An ordinary job swings by 180.
   */

  /** Share of arrivals a client needs tomorrow. */
  /* --- Instrument occupancy ------------------------------------------------
   *
   * Two assumptions about what an instrument is doing when nobody is watching
   * it. Both decide which instrument limits the lab, so both are here rather
   * than inline, and both are written up as open questions in
   * docs/product-spec.md rather than settled quietly.
   */

  /**
   * Whether a finished run frees its instrument immediately.
   *
   * True: the moment a 90-minute run ends, the instrument is available, so its
   * availability is the whole calendar week. False: the sample sits in it until
   * somebody comes to take it out, so availability is the working week and the
   * instrument is occupied overnight.
   *
   * The difference is the whole of the specification's bottleneck claim. Mass
   * spectrometry needs 45 instrument-hours a week, which is 27% of a calendar
   * week and 112% of a working one — barely warm under the first reading and
   * the lab's hard limit under the second.
   */
  instrumentFreedWhenRunEnds: boolean;

  /**
   * How many cultures the incubator holds at once.
   *
   * Here rather than in the equipment list because it is the same kind of
   * assumption as the one above and belongs beside it: twelve cell cultures at
   * 48 hours each is 576 instrument-hours a week, so this number alone decides
   * whether the work is possible. At 1 it is not possible at any number of
   * incubators; at 6 it is comfortable.
   */
  incubatorCapacity: number;

  /** How long a client gives a rush order, in wall-clock hours. */
  rushDeadlineHours: number;
  /** Share of arrivals a client needs tomorrow. */
  rushFraction: number;
  /** What a client pays for a rush. */
  rushPriceMultiplier: number;
  /** What an ordinary job is worth if it misses its deadline. */
  latePriceFraction: number;
  /**
   * What a missed rush refunds, as a share of the ordinary price.
   *
   * Applied *after* the premium is lost, so a missed rush pays 0.7 of the
   * ordinary price - less than an ordinary late job, because the client was
   * promised something and planned around it.
   */
  rushFailRefundFraction: number;
}

/**
 * Running totals the engine keeps as it ticks. Deliberately small for now:
 * Phase 2 replaces the invented energy percentage with real measures — hours
 * worked, overtime, backlog, delays — and this is where they attach.
 */
export interface Metrics {
  tasksCompleted: number;
  tasksFailed: number;
  revenue: number;
  penalties: number;
  trainingSpend: number;
  equipmentSpend: number;
}

export interface Scenario {
  id: string;
  name: string;
  layout: Layout;
  tuning: Tuning;
  /** Working days and shift hours. The lab's week. */
  calendar: Calendar;
  staff: StaffTemplate[];
  equipment: EquipmentTemplate[];
  /** What the lab sells, and how much of it arrives. */
  workTypes: WorkType[];
  catalog: CatalogItem[];
  props: Prop[];
  walls: Wall[];
}

/* --- Runtime entities ----------------------------------------------------- */

/**
 * What a person is currently doing. A discriminated union, because the two
 * cases genuinely have different shapes: a job carries a sequence of equipment
 * steps and a deadline, while a training has a single duration and no steps.
 * Treating them as one loose shape is what lets failTask reach for
 * `task.equipmentSequence[...]` on a training and crash.
 */
/**
 * The only thing still kept on a person rather than on the work.
 *
 * Training is genuinely a property of the person - it changes what they can do
 * and belongs to nobody else - so it has no job and no queue. Everything else
 * that used to live here moved onto the job.
 */
export type ActiveTask = ActiveTraining;

export interface ActiveTraining {
  type: 'training';
  name: string;
  skillToLearn: Skill;
  equipmentId: EquipmentId;
  duration: number;
}

export interface Staff extends StaffTemplate {
  id: StaffId;
  x: number;
  y: number;
  targetX: number | null;
  targetY: number | null;
  /**
   * Whether this person is on the roster at all.
   *
   * Separate from `state`, and the separation matters. `state === 'off'` used to
   * mean two unrelated things — "not employed on this shift" and "outside
   * opening hours" — so once the calendar started sending people home at 16:00
   * there was no way to tell someone who had gone home from someone who is not
   * on the rota. A hire changes this; the clock changes `state`.
   */
  rostered: boolean;
  /**
   * When this person is in the building.
   *
   * Per person, not per lab. The spec employs two part-timers on 20 hours, and
   * decision C — add an evening shift — is a change to some people's shifts and
   * not to the lab's opening hours. Derived from `weeklyHours` and the lab
   * calendar at creation.
   */
  shift: Shift;
  state: StaffState;
  speed: number;
  color: string;
  /** @deprecated Invented metric. Phase 2 replaces it with workload and overtime. */
  energy: number;
  /**
   * The job this person is on, if any.
   *
   * An id rather than the job itself: the job is the thing that holds progress,
   * and two references to one job would be two places to keep in step. The
   * pairing is symmetric — `job.operatorId` points back — and both are cleared
   * together.
   */
  jobId: JobId | null;
  /** A training in progress. The last thing held on a person rather than work. */
  activeTask: ActiveTask | null;
  /** Minutes of training left. Trainings have one phase and no queue. */
  taskTimer: number;
  /** When this person next wanders, if idle. An absolute minute. */
  nextWanderAtMinute: number;
  /**
   * This person's own generator position. Idle wandering draws from it rather
   * than from the lab's stream, so how many people there are cannot shift when
   * events happen.
   */
  rngState: number;
}

/**
 * One instrument on the floor. An *instance*, not a kind.
 *
 * Still called Equipment, and still carrying `inUse`/`assignedTo`, so the
 * renderer and the equipment panel need no change in this commit. `inUse` is
 * now derived from `heldBy` — true when any slot is taken — and kept only for
 * them; the engine asks about slots.
 */
export interface Equipment extends EquipmentTemplate {
  id: EquipmentId;
  /** Which of several identical instruments this is: "Microscope 2 of 2". */
  instance: number;
  condition: number;
  /**
   * The jobs occupying this instrument's slots, at most `capacity` of them.
   *
   * A list rather than a count, so releasing is exact: a job gives back the
   * slot it took and cannot decrement a counter it never incremented.
   */
  heldBy: JobId[];
  /** Derived from `heldBy`. Kept for the renderer and the panel. */
  inUse: boolean;
  /** The operator of the first holding job, for the panel's "in use by" text. */
  assignedTo: StaffId | null;
  totalWorkTime: number;
}
