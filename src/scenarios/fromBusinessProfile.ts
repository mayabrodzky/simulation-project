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

/**
 * Invented, because a business profile cannot describe demand.
 *
 * The old shape needed only a reward and a duration. A work type also needs how
 * much of it arrives each week and how long a client waits, and the onboarding
 * form asks for neither — so these are placeholders that produce a plausible
 * simulation of nothing in particular. Already on the Phase 2.5 list: either
 * the form asks, or this path stops pretending to model a real business.
 */
const DEFAULT_PER_WEEK = 20;
const DEFAULT_VARIATION = 0.2;
const DEFAULT_DUE_WORKING_DAYS = 3;

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
        ? employees.map((e) => ({
            name: e.name,
            role: e.role,
            skills: [e.role],
            weeklyHours: 40,
          }))
        : chemistryLab.staff,

    equipment:
      tasks.length > 0
        ? tasks.map((_, i) => ({
            name: 'Workstation',
            icon: '💼',
            x: f.x + 3 + (i % 5) * 2.5,
            y: f.y + 2 + Math.floor(i / 5) * 4,
            skill: null,
            capabilities: ['general'],
            count: 1,
            capacity: 1,
          }))
        : chemistryLab.equipment,

    // A profile's "tasks" become work types, which now also need a volume and
    // a deadline. Both are guesses, and flagged: this path was already on the
    // Phase 2.5 list for review, since a profile cannot describe a lab's
    // demand and inventing one produces a simulation of nothing in particular.
    workTypes:
      tasks.length > 0
        ? tasks.map((t, i) => {
            const duration = t.duration ?? DEFAULT_DURATION;
            return {
              id: 'wt' + String(i + 1).padStart(3, '0'),
              name: t.name,
              perWeek: DEFAULT_PER_WEEK,
              variation: DEFAULT_VARIATION,
              basePrice: t.reward ?? DEFAULT_REWARD,
              dueWorkingDays: DEFAULT_DUE_WORKING_DAYS,
              steps: [
                {
                  capability: 'general',
                  skillRequired: null,
                  attended: duration,
                  unattended: 0,
                  resourceHeldDuring: 'both' as const,
                },
              ],
            };
          })
        : chemistryLab.workTypes,

    catalog: [
      {
        id: 'cat001',
        name: 'Workstation',
        capabilities: ['general'],
        capacity: 1,
        icon: '💼',
        cost: 1000,
        skill: null,
      },
      {
        id: 'cat002',
        name: 'Meeting Room',
        capabilities: ['meeting'],
        capacity: 1,
        icon: '🪑',
        cost: 2000,
        skill: null,
      },
      {
        id: 'cat003',
        name: 'Storage Unit',
        capabilities: ['storage'],
        capacity: 1,
        icon: '🗄️',
        cost: 500,
        skill: null,
      },
    ],
  };
}
