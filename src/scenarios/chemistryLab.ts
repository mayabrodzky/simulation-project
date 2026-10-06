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
import type { Layout, Scenario, Tuning } from '../domain/types';

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

const f = layout.labFloor;
const o1 = layout.office1;
const o2 = layout.office2;

/** Wall height, in the renderer's z units. */
const WALL_HEIGHT = 25;

const tuning: Tuning = {
  startingMoney: 25000,
  startingMaterials: 200,
  startingSamples: 120,
  minutesPerSecond: 0.5,
  startMinutes: 480, // 08:00. Overwritten at startup by the real clock today.

  trainingCost: 300,
  trainingDuration: 60,
  repairCost: 200,
  repairAmount: 50,
  calibrateCost: 100,
  calibrateAmount: 25,

  energyDrainPerSecond: 0.2,
  energyRecoverPerSecond: 1,
  energyBreakThreshold: 20,
  energyRecoveredThreshold: 95,
  conditionWearPerSecond: 0.05,

  // Calibrated to match the old per-frame probabilities at 60fps, which is
  // what these were implicitly tuned against: 0.0005 and 0.005 per frame,
  // times 60 frames per second.
  emergencyRatePerSecond: 0.03,
  wanderRatePerSecond: 0.3,

  staffWalkSpeed: 0.02,
  initialEnergyMin: 80,
  initialEnergyRange: 20,
  initialConditionMin: 70,
  initialConditionRange: 30,
  staffOnShiftCount: 6,
};

export const chemistryLab: Scenario = {
  id: 'chemistry-lab',
  name: 'Chemistry Lab',
  layout,
  tuning,

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
