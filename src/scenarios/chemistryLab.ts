/**
 * The chemistry lab scenario: every fact that is true of this lab and of no
 * other domain. Moved out of the simulation code unchanged — same names, same
 * numbers, same positions.
 *
 * The rules ("a person may only start a task if they hold every required
 * skill") stay in the engine. The facts ("Dana Cohen knows Centrifuge Usage")
 * live here. That split is what lets the same engine model something else
 * later, and it is what Phase 4's editable assumptions panel reads.
 */
import type { Calendar, Layout, Scenario, Tuning, WorkType } from '../domain/types';

const layout: Layout = {
  gridWidth: 24,
  gridHeight: 18,
  tileSize: 50,
  tileHeight: 10,
  labFloor: { x: 3, y: 3, w: 14, h: 8 },
  office1: { x: 17, y: 3, w: 5, h: 8 },
  office2: { x: 3, y: 11, w: 14, h: 5 },
  initialCamera: { x: 20, y: 100, zoom: 0.85 },
};

/**
 * Sunday to Thursday, 08:00–16:00 — 40 hours a week, as the spec describes.
 * Deadlines are quoted exclusive of the arrival day, and rush orders in
 * wall-clock hours. Both are open questions for the lab manager rather than
 * facts; see docs/product-spec.md.
 */
const calendar: Calendar = {
  shift: { days: [0, 1, 2, 3, 4], startMinute: 480, endMinute: 960 },
  deadlineCountsArrivalDay: false,
  rushDeadlineMode: 'calendar',
};

const f = layout.labFloor;
const o1 = layout.office1;
const o2 = layout.office2;

/** Wall height, in the renderer's z units. */
const WALL_HEIGHT = 25;

const tuning: Tuning = {
  startingMoney: 25000,
  startingMaterials: 200,
  startingSamples: 120,
  // One real second is one simulated minute, so a 20-minute step takes 20
  // seconds to watch and advances the clock by 20 minutes. Before the unit
  // correction those two disagreed by a factor of two.
  minutesPerSecond: 1.0,
  startMinutes: 480, // 08:00. Overwritten at startup by the real clock today.

  trainingCost: 300,
  trainingDuration: 60,
  repairCost: 200,
  repairAmount: 50,
  calibrateCost: 100,
  calibrateAmount: 25,

  energyDrainPerMinute: 0.2,
  energyRecoverPerMinute: 1,
  energyBreakThreshold: 20,
  energyRecoveredThreshold: 95,
  conditionWearPerMinute: 0.05,

  // Rates per simulated minute. The numbers are unchanged from when they
  // were per simulated second, which preserves the real-time spacing,
  // because one real second is now one simulated minute.
  emergencyRatePerMinute: 0.03,
  wanderRatePerMinute: 0.3,

  // 1.2 grid units a minute. Previously 0.02 multiplied by a hard-coded 60
  // inside the movement code, which hid the unit.
  staffWalkGridPerMinute: 1.2,
  initialEnergyMin: 80,
  initialEnergyRange: 20,
  initialConditionMin: 70,
  initialConditionRange: 30,
  staffOnShiftCount: 6,

  // Three working days past the deadline before the client cancels. An
  // assumption to put to the lab manager, not a fact — see
  // docs/product-spec.md section 7.
  abandonAfterWorkingDays: 3,
};

/**
 * What the lab sells, and how much of it arrives.
 *
 * Volumes and prices come from docs/product-spec.md, which records what the lab
 * manager described. The step durations are hands-on minutes only; the step
 * after this one splits each into attended and unattended time, which is what
 * lets an instrument run while its operator does something else.
 *
 * Two things here are modelling choices rather than reported facts, and both
 * decide which machine becomes the bottleneck:
 *
 * - **How hands-on minutes split across the steps of a job.** A different split
 *   makes the microscope bind before the mass spectrometer, and the whole
 *   story the scenario is built around changes. Stated explicitly so it can be
 *   argued with; A7 adds a check that the binding constraint is the expected
 *   one.
 * - **A uniform band around the weekly mean** rather than a Poisson count. See
 *   arrivals.ts.
 *
 * Mass spectrometry is new work. Until now no task asked for the Mass
 * Spectrometer, so the machine existed, could be bought a second time, and
 * could never relieve anything — the Phase 1 finding that bought equipment
 * cannot affect capacity. This is what retires it.
 */
export const workTypes: WorkType[] = [
  {
    id: 'blood-panel',
    name: 'Blood panel',
    perWeek: 80,
    variation: 0.2,
    basePrice: 180,
    dueWorkingDays: 2,
    steps: [
      { name: 'Centrifuge', duration: 25, skillRequired: 'Centrifuge Usage' },
      { name: 'Microscope A', duration: 20, skillRequired: 'Microscopy' },
    ],
  },
  {
    id: 'dna-pcr',
    name: 'DNA / PCR',
    perWeek: 40,
    variation: 0.2,
    basePrice: 650,
    dueWorkingDays: 5,
    steps: [
      { name: 'PCR Machine', duration: 45, skillRequired: 'PCR Operation' },
      { name: 'Spectrophotometer', duration: 45, skillRequired: 'Spectrophotometry' },
    ],
  },
  {
    id: 'cell-culture',
    name: 'Cell culture',
    perWeek: 12,
    variation: 0.25,
    basePrice: 1400,
    dueWorkingDays: 7,
    steps: [
      { name: 'Biosafety Cabinet', duration: 120, skillRequired: 'Biosafety Protocols' },
      { name: 'Incubator', duration: 15, skillRequired: 'Incubator Handling' },
      { name: 'Microscope A', duration: 45, skillRequired: 'Microscopy' },
    ],
  },
  {
    id: 'mass-spec',
    name: 'Mass spectrometry',
    perWeek: 30,
    variation: 0.2,
    basePrice: 900,
    dueWorkingDays: 5,
    steps: [{ name: 'Mass Spectrometer', duration: 60, skillRequired: 'Mass Spectrometry' }],
  },
];

export const chemistryLab: Scenario = {
  id: 'chemistry-lab',
  name: 'Chemistry Lab',
  layout,
  tuning,
  calendar,
  workTypes,

  staff: [
    {
      name: 'Dr. Amit Katz',
      role: 'Senior Researcher',
      skills: ['Microscopy', 'PCR Operation', 'Mass Spectrometry', 'Biosafety Protocols'],
    },
    {
      name: 'Dr. Michal Levi',
      role: 'Lab Director',
      skills: ['Management', 'Spectrophotometry', 'Incubator Handling'],
    },
    { name: 'Dana Cohen', role: 'Research Assistant', skills: ['Centrifuge Usage'] },
    { name: 'Hadas Ben Hamo', role: 'Lab Technician', skills: ['Centrifuge Usage', 'Microscopy'] },
    {
      name: 'Dr. Lihi Dayan',
      role: 'Data Analyst',
      skills: ['Mass Spectrometry', 'Spectrophotometry'],
    },
    { name: 'Amir Barzilay', role: 'Junior Researcher', skills: [] },
    { name: 'Nina Zur', role: 'Quality Control', skills: ['Biosafety Protocols', 'Microscopy'] },
    { name: 'Alex Tom', role: 'Lab Assistant', skills: [] },
  ],

  equipment: [
    { name: 'Microscope A', icon: '🔬', x: f.x + 5, y: f.y + 2, skill: 'Microscopy' },
    { name: 'Centrifuge', icon: '🌀', x: f.x + 7, y: f.y + 2, skill: 'Centrifuge Usage' },
    { name: 'PCR Machine', icon: '🧬', x: f.x + 9, y: f.y + 2, skill: 'PCR Operation' },
    { name: 'Incubator', icon: '🌡️', x: f.x + 11, y: f.y + 2, skill: 'Incubator Handling' },
    { name: 'Spectrophotometer', icon: '📊', x: f.x + 5, y: f.y + 6, skill: 'Spectrophotometry' },
    { name: 'Mass Spectrometer', icon: '⚗️', x: f.x + 7, y: f.y + 6, skill: 'Mass Spectrometry' },
    { name: 'Flow Cytometer', icon: '💠', x: f.x + 9, y: f.y + 6, skill: 'Flow Cytometry' },
    { name: 'Freezer -80°C', icon: '❄️', x: f.x + 1, y: f.y + 1.5, skill: 'Cryo Storage' },
    {
      name: 'Biosafety Cabinet',
      icon: '🛡️',
      x: f.x + 1,
      y: f.y + 3.5,
      skill: 'Biosafety Protocols',
    },
  ],

  tasks: [
    {
      id: 'TSK001',
      name: 'Blood Sample Analysis',
      reward: 500,
      timeLimit: 300,
      penalty: 250,
      equipmentSequence: [
        { name: 'Centrifuge', duration: 20, skillRequired: 'Centrifuge Usage' },
        { name: 'Microscope A', duration: 40, skillRequired: 'Microscopy' },
      ],
    },
    {
      id: 'TSK002',
      name: 'DNA Sequencing',
      reward: 1200,
      timeLimit: 600,
      penalty: 500,
      equipmentSequence: [
        { name: 'PCR Machine', duration: 60, skillRequired: 'PCR Operation' },
        { name: 'Spectrophotometer', duration: 30, skillRequired: 'Spectrophotometry' },
      ],
    },
    {
      id: 'TSK003',
      name: 'Cell Culture Test',
      reward: 850,
      timeLimit: 480,
      penalty: 400,
      equipmentSequence: [
        { name: 'Incubator', duration: 15, skillRequired: 'Incubator Handling' },
        { name: 'Biosafety Cabinet', duration: 45, skillRequired: 'Biosafety Protocols' },
        { name: 'Microscope A', duration: 30, skillRequired: 'Microscopy' },
      ],
    },
  ],

  emergencies: [
    {
      name: 'Critical Sample Analysis',
      reward: 2500,
      penalty: 4000,
      timeLimit: 120,
      equipmentSequence: [
        { name: 'Mass Spectrometer', duration: 30, skillRequired: 'Mass Spectrometry' },
        { name: 'Biosafety Cabinet', duration: 30, skillRequired: 'Biosafety Protocols' },
      ],
    },
  ],

  catalog: [
    { id: 'cat001', name: 'Microscope B', icon: '🔬', cost: 1500, skill: 'Microscopy' },
    { id: 'cat002', name: 'PCR Machine II', icon: '🧬', cost: 3000, skill: 'PCR Operation' },
    { id: 'cat003', name: 'Auto-Sampler', icon: '🤖', cost: 5000, skill: 'Spectrophotometry' },
  ],

  props: [
    { type: 'desk', x: f.x + 1.5, y: f.y + 6.5, w: 2, h: 1, icon: '💻' },
    { type: 'shelf', x: f.x + 12.5, y: f.y + 1.5, w: 1, h: 2, icon: '🗄️' },
    { type: 'plant', x: f.x + 0.5, y: f.y + 0.5, icon: '🌿' },
    { type: 'coffee', x: f.x + 12.5, y: f.y + 6.5, w: 1, h: 1, icon: '☕' },
    { type: 'desk', x: o1.x + 1, y: o1.y + 1.5, w: 1, h: 2, icon: '💻' },
    { type: 'desk', x: o1.x + 3, y: o1.y + 1.5, w: 1, h: 2, icon: '💻' },
    { type: 'desk', x: o1.x + 1, y: o1.y + 5.5, w: 1, h: 2, icon: '💻' },
    { type: 'desk', x: o1.x + 3, y: o1.y + 5.5, w: 1, h: 2, icon: '💻' },
    { type: 'plant', x: o1.x + 4.5, y: o1.y + 0.5, icon: '🌿' },
    { type: 'desk', x: o2.x + 2, y: o2.y + 1, w: 2, h: 1, icon: '💻' },
    { type: 'desk', x: o2.x + 6, y: o2.y + 1, w: 2, h: 1, icon: '💻' },
    { type: 'desk', x: o2.x + 10, y: o2.y + 1, w: 2, h: 1, icon: '💻' },
    { type: 'desk', x: o2.x + 4, y: o2.y + 3, w: 2, h: 1, icon: '💻' },
    { type: 'desk', x: o2.x + 8, y: o2.y + 3, w: 2, h: 1, icon: '💻' },
    // The entrance, previously appended by createArchitecture rather than
    // declared with the other props.
    { type: 'door', x: f.x + f.w / 2, y: f.y - 0.5, w: 2, h: 1, icon: '🚪' },
  ],

  walls: [
    { x1: f.x, y1: f.y, x2: f.x + f.w / 2 - 1, y2: f.y, height: WALL_HEIGHT },
    { x1: f.x + f.w / 2 + 1, y1: f.y, x2: f.x + f.w, y2: f.y, height: WALL_HEIGHT },
    { x1: f.x, y1: f.y, x2: f.x, y2: f.y + f.h, height: WALL_HEIGHT },
    { x1: o1.x, y1: o1.y, x2: o1.x + o1.w, y2: o1.y, height: WALL_HEIGHT },
    { x1: o1.x + o1.w, y1: o1.y, x2: o1.x + o1.w, y2: o1.y + o1.h, height: WALL_HEIGHT },
    { x1: o2.x, y1: o2.y + o2.h, x2: o2.x + o2.w, y2: o2.y + o2.h, height: WALL_HEIGHT },
    { x1: o2.x + o2.w, y1: o1.y + o1.h, x2: o2.x + o2.w, y2: o2.y + o2.h, height: WALL_HEIGHT },
    { x1: o2.x, y1: f.y + f.h, x2: o2.x, y2: o2.y + o2.h, height: WALL_HEIGHT },
    { x1: f.x + f.w, y1: f.y, x2: f.x + f.w, y2: f.y + f.h / 2 - 1, height: WALL_HEIGHT },
    { x1: f.x + f.w, y1: f.y + f.h / 2 + 1, x2: f.x + f.w, y2: o1.y + o1.h, height: WALL_HEIGHT },
    { x1: f.x, y1: f.y + f.h, x2: f.x + f.w / 2 - 2, y2: f.y + f.h, height: WALL_HEIGHT },
    { x1: f.x + f.w / 2, y1: f.y + f.h, x2: o2.x + o2.w, y2: o2.y, height: WALL_HEIGHT },
  ],
};
