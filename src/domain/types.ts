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

/** Scenario-defined. Phase 2 generalises this to a capability on any resource. */
export type Skill = string;

export type StaffState = 'idle' | 'working' | 'break' | 'off' | 'sick' | 'vacation';

export type EmergencyStatus = 'pending' | 'in-progress' | 'completed' | 'failed';

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
}

export interface EquipmentTemplate {
  name: string;
  icon: string;
  x: number;
  y: number;
  skill: Skill | null;
}

export interface TaskStep {
  /** Matches EquipmentTemplate.name. Resolved by name at assignment time. */
  name: string;
  duration: number;
  skillRequired: Skill | null;
}

export interface TaskDefinition {
  id: TaskId;
  name: string;
  reward: number;
  timeLimit: number;
  penalty: number;
  equipmentSequence: TaskStep[];
}

export interface EmergencyTemplate {
  name: string;
  reward: number;
  penalty: number;
  timeLimit: number;
  equipmentSequence: TaskStep[];
}

export interface CatalogItem {
  id: string;
  name: string;
  icon: string;
  cost: number;
  skill: Skill | null;
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
  /** Minutes of simulated clock per simulated second. */
  minutesPerSecond: number;
  /** Clock position at startup, in minutes past midnight. */
  startMinutes: number;

  trainingCost: number;
  trainingDuration: number;
  repairCost: number;
  repairAmount: number;
  calibrateCost: number;
  calibrateAmount: number;

  energyDrainPerSecond: number;
  energyRecoverPerSecond: number;
  energyBreakThreshold: number;
  energyRecoveredThreshold: number;
  conditionWearPerSecond: number;

  /**
   * Average occurrences per simulated second. Previously these were
   * probabilities rolled once per animation frame, which made the whole
   * simulation run faster on a high-refresh-rate monitor.
   */
  emergencyRatePerSecond: number;
  wanderRatePerSecond: number;

  staffWalkSpeed: number;
  initialEnergyMin: number;
  initialEnergyRange: number;
  initialConditionMin: number;
  initialConditionRange: number;
  /** Staff beyond this index start off-shift. */
  staffOnShiftCount: number;
}

export interface Scenario {
  id: string;
  name: string;
  layout: Layout;
  tuning: Tuning;
  staff: StaffTemplate[];
  equipment: EquipmentTemplate[];
  tasks: TaskDefinition[];
  catalog: CatalogItem[];
  props: Prop[];
  walls: Wall[];
  emergencies: EmergencyTemplate[];
}

/* --- Runtime entities ----------------------------------------------------- */

/**
 * What a person is currently doing. A discriminated union, because the two
 * cases genuinely have different shapes: a job carries a sequence of equipment
 * steps and a deadline, while a training has a single duration and no steps.
 * Treating them as one loose shape is what lets failTask reach for
 * `task.equipmentSequence[...]` on a training and crash.
 */
export type ActiveTask = ActiveJob | ActiveTraining;

/** A copy of a task definition or an emergency, taken when it was assigned. */
export interface ActiveJob {
  type?: undefined;
  id: TaskId;
  name: string;
  reward: number;
  penalty: number;
  /** Counts down; absent on tasks with no deadline. */
  timeLimit?: number;
  equipmentSequence: TaskStep[];
  isEmergency?: boolean;
  status?: EmergencyStatus;
  assignedTo?: StaffId | null;
}

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
  state: StaffState;
  speed: number;
  color: string;
  /** @deprecated Invented metric. Phase 2 replaces it with workload and overtime. */
  energy: number;
  activeTask: ActiveTask | null;
  taskStep: number;
  taskTimer: number;
}

export interface Equipment extends EquipmentTemplate {
  id: EquipmentId;
  condition: number;
  inUse: boolean;
  assignedTo: StaffId | null;
  totalWorkTime: number;
}

export interface Emergency extends EmergencyTemplate {
  id: string;
  status: EmergencyStatus;
}
