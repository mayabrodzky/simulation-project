/**
 * Builds a Scenario from a business profile saved through onboarding.html.
 *
 * This exists only to preserve today's /api/business behaviour. Under the
 * decision that the product ships one polished scenario rather than a
 * "configure your own business" tool, it is a candidate for removal in Phase
 * 2.5 — not a foundation to build on. See docs/interview-notes.md.
 *
 * It reproduces the original per-section conditions exactly, including their
 * inconsistency: staff, equipment and tasks each fell back to the demo lab
 * unless their own profile array was non-empty, while the catalog switched on
 * the mere presence of a profile.
 */
import type { Scenario } from '../domain/types';
import { chemistryLab } from './chemistryLab';

export interface BusinessProfile {
  name?: string;
  employees?: { name: string; role: string }[];
  tasks?: { name: string; reward?: number; duration?: number }[];
}

const DEFAULT_REWARD = 500;
const DEFAULT_DURATION = 30;
/** The original derived a deadline as twelve times the task's duration. */
const TIME_LIMIT_FACTOR = 12;
const PENALTY_FRACTION = 0.3;

export function scenarioFromBusinessProfile(profile: BusinessProfile): Scenario {
  const { layout } = chemistryLab;
  const f = layout.labFloor;

  // Optional chaining is the one intentional difference from the original,
  // which read .employees.length directly and threw on a profile missing the
  // key. Falling back to the demo lab is strictly better than crashing on
  // startup, and a crash is not behaviour worth preserving.
  const employees = profile.employees ?? [];
  const tasks = profile.tasks ?? [];

  return {
    ...chemistryLab,
    id: 'business-profile',
    name: profile.name ?? chemistryLab.name,

    staff:
      employees.length > 0
        ? employees.map((e) => ({ name: e.name, role: e.role, skills: [e.role] }))
        : chemistryLab.staff,

    equipment:
      tasks.length > 0
        ? tasks.map((_, i) => ({
            name: 'Workstation',
            icon: '💼',
            x: f.x + 3 + (i % 5) * 2.5,
            y: f.y + 2 + Math.floor(i / 5) * 4,
            skill: null,
          }))
        : chemistryLab.equipment,

    tasks:
      tasks.length > 0
        ? tasks.map((t, i) => {
            const reward = t.reward ?? DEFAULT_REWARD;
            const duration = t.duration ?? DEFAULT_DURATION;
            return {
              id: 'TSK' + String(i + 1).padStart(3, '0'),
              name: t.name,
              reward,
              timeLimit: duration * TIME_LIMIT_FACTOR,
              penalty: Math.round(reward * PENALTY_FRACTION),
              equipmentSequence: [{ name: 'Workstation', duration, skillRequired: null }],
            };
          })
        : chemistryLab.tasks,

    catalog: [
      { id: 'cat001', name: 'Workstation', icon: '💼', cost: 1000, skill: null },
      { id: 'cat002', name: 'Meeting Room', icon: '🪑', cost: 2000, skill: null },
      { id: 'cat003', name: 'Storage Unit', icon: '🗄️', cost: 500, skill: null },
    ],
  };
}
