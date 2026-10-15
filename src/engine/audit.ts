/**
 * Does this scenario make sense, and what limits it?
 *
 * Computed in closed form from the scenario alone — no simulation, no
 * randomness, no clock. That matters for two reasons. It catches a scenario
 * that cannot work *before* three hundred runs are spent on it. And it gives an
 * independent check on the engine: simulated utilisation and the arithmetic
 * here should agree, and when they do not, one of them is wrong in a way
 * neither could reveal alone.
 *
 * Phase 2 has produced three defects that no unit test could see, each visible
 * only as a property of the whole lab over a week. This is the formal version
 * of the throwaway scripts that found them.
 *
 * **The denominator is the hard part, and it is why utilisation is reported
 * twice.** An instrument doing attended work can only be used while somebody is
 * in the building — roughly 40 hours a week. One running unattended continues
 * through the night, so its availability is the full 168. The specification's
 * claim that the mass spectrometer is the bottleneck is 45 instrument-hours a
 * week, which is 112% of a working week and 27% of a calendar week. Picking one
 * denominator would decide that question by assumption, so both are given.
 */
import type { Capability, Scenario, Skill } from '../domain/types';
import { MINUTES_PER_HOUR, shiftForWeeklyHours } from './calendar';

const MINUTES_PER_WEEK = 7 * 24 * MINUTES_PER_HOUR;

export interface CapabilityLoad {
  capability: Capability;
  /** Instrument-minutes a week this capability needs. */
  minutesPerWeek: number;
  /** Of which, minutes with a person present. */
  attendedMinutesPerWeek: number;
  /** Instruments offering it, times their capacity. */
  slots: number;
  /** Against the hours somebody is in the building. */
  utilisationInWorkingHours: number;
  /** Against the whole calendar week, which only unattended work can use. */
  utilisationInCalendarHours: number;
}

export interface SkillLoad {
  skill: Skill;
  /** Hands-on minutes a week needing this skill. */
  minutesPerWeek: number;
  /** Contracted minutes a week held by people who have it. */
  capacityMinutesPerWeek: number;
  utilisation: number;
}

export interface ScenarioAudit {
  /** Hands-on minutes a week across all work. */
  offeredAttendedMinutes: number;
  /** Contracted minutes a week across all staff. */
  contractedMinutes: number;
  byCapability: CapabilityLoad[];
  bySkill: SkillLoad[];
  /** The capability with the highest utilisation in working hours. */
  bindingCapability: CapabilityLoad | undefined;
  /** The skill with the highest utilisation. */
  bindingSkill: SkillLoad | undefined;
  /** Conditions that make the scenario impossible rather than merely tight. */
  errors: string[];
  /** Conditions worth knowing about that do not make it impossible. */
  warnings: string[];
}

export function auditScenario(scenario: Scenario): ScenarioAudit {
  const errors: string[] = [];
  const warnings: string[] = [];

  const shift = scenario.calendar.shift;
  const openMinutesPerWeek = shift.days.length * (shift.endMinute - shift.startMinute);

  /* --- What the work needs ------------------------------------------------ */

  const capabilityMinutes = new Map<Capability, number>();
  const capabilityAttended = new Map<Capability, number>();
  const skillMinutes = new Map<Skill, number>();
  let offeredAttendedMinutes = 0;

  for (const workType of scenario.workTypes) {
    for (const step of workType.steps) {
      // How long the *instrument* is occupied depends on which phases hold it,
      // which is the distinction that makes the spec's arithmetic work.
      const held =
        (step.resourceHeldDuring === 'attended' || step.resourceHeldDuring === 'both'
          ? step.attended
          : 0) +
        (step.resourceHeldDuring === 'unattended' || step.resourceHeldDuring === 'both'
          ? step.unattended
          : 0);

      add(capabilityMinutes, step.capability, held * workType.perWeek);
      add(capabilityAttended, step.capability, step.attended * workType.perWeek);
      offeredAttendedMinutes += step.attended * workType.perWeek;
      if (step.skillRequired !== null) {
        add(skillMinutes, step.skillRequired, step.attended * workType.perWeek);
      }
    }
  }

  /* --- What the lab has -------------------------------------------------- */

  const slotsByCapability = new Map<Capability, number>();
  for (const template of scenario.equipment) {
    for (const capability of template.capabilities) {
      add(slotsByCapability, capability, Math.max(1, template.count) * template.capacity);
    }
  }

  let contractedMinutes = 0;
  const skillCapacity = new Map<Skill, number>();
  for (const person of scenario.staff) {
    const own = shiftForWeeklyHours(scenario.calendar, person.weeklyHours);
    const minutes = own.days.length * (own.endMinute - own.startMinute);
    contractedMinutes += minutes;
    for (const skill of person.skills) add(skillCapacity, skill, minutes);
  }

  /* --- Fatal: work the lab simply cannot do ------------------------------ */

  for (const [capability, minutes] of capabilityMinutes) {
    if (!slotsByCapability.has(capability)) {
      errors.push(
        `No instrument provides "${capability}", which ${hours(minutes)} h/wk of work needs.`,
      );
    }
  }
  for (const [skill, minutes] of skillMinutes) {
    if (!skillCapacity.has(skill)) {
      errors.push(`Nobody holds "${skill}", which ${hours(minutes)} h/wk of work needs.`);
    }
  }

  /* --- Load -------------------------------------------------------------- */

  const byCapability: CapabilityLoad[] = [...capabilityMinutes.entries()]
    .map(([capability, minutesPerWeek]) => {
      const slots = slotsByCapability.get(capability) ?? 0;
      const attendedMinutesPerWeek = capabilityAttended.get(capability) ?? 0;
      return {
        capability,
        minutesPerWeek,
        attendedMinutesPerWeek,
        slots,
        utilisationInWorkingHours:
          slots > 0 ? minutesPerWeek / (slots * openMinutesPerWeek) : Infinity,
        utilisationInCalendarHours:
          slots > 0 ? minutesPerWeek / (slots * MINUTES_PER_WEEK) : Infinity,
      };
    })
    .sort((a, b) => b.utilisationInWorkingHours - a.utilisationInWorkingHours);

  const bySkill: SkillLoad[] = [...skillMinutes.entries()]
    .map(([skill, minutesPerWeek]) => {
      const capacityMinutesPerWeek = skillCapacity.get(skill) ?? 0;
      return {
        skill,
        minutesPerWeek,
        capacityMinutesPerWeek,
        utilisation:
          capacityMinutesPerWeek > 0 ? minutesPerWeek / capacityMinutesPerWeek : Infinity,
      };
    })
    .sort((a, b) => b.utilisation - a.utilisation);

  /* --- Infeasible rather than tight -------------------------------------- */

  if (offeredAttendedMinutes > contractedMinutes) {
    errors.push(
      `Work needs ${hours(offeredAttendedMinutes)} hands-on hours a week against ` +
        `${hours(contractedMinutes)} contracted. No assignment can keep up.`,
    );
  }

  // Which denominator decides *feasibility* is itself an assumption, and it is
  // `instrumentFreedWhenRunEnds`. If a finished run frees its instrument, an
  // instrument can work round the clock and the calendar week is the limit. If
  // the sample sits in it until somebody unloads it, the working week is.
  //
  // The difference is not academic. At six shelves the incubator needs 579
  // instrument-hours a week: 57% of a calendar week and 241% of a working one.
  // The same scenario is comfortable under one reading and impossible under the
  // other, which is why both are reported and why this flag exists.
  const freedOnRunEnd = scenario.tuning.instrumentFreedWhenRunEnds;

  for (const load of byCapability) {
    const limit = freedOnRunEnd ? load.utilisationInCalendarHours : load.utilisationInWorkingHours;

    if (limit > 1) {
      const available = freedOnRunEnd
        ? `${hours(load.slots * MINUTES_PER_WEEK)} running continuously`
        : `${hours(load.slots * openMinutesPerWeek)} inside working hours`;
      errors.push(
        `"${load.capability}" needs ${hours(load.minutesPerWeek)} instrument-hours a week ` +
          `and ${load.slots} slot(s) offer ${available}.`,
      );
    } else if (load.utilisationInWorkingHours > 1) {
      warnings.push(
        `"${load.capability}" is at ${pct(load.utilisationInWorkingHours)} of working hours, ` +
          `and possible only because a finished run frees its instrument overnight.`,
      );
    } else if (load.utilisationInWorkingHours > 0.85) {
      warnings.push(
        `"${load.capability}" is at ${pct(load.utilisationInWorkingHours)} of working hours, ` +
          `so a queue is expected.`,
      );
    }
  }

  for (const load of bySkill) {
    if (load.utilisation > 1) {
      errors.push(
        `"${load.skill}" needs ${hours(load.minutesPerWeek)} h/wk and the people who hold it are ` +
          `contracted for ${hours(load.capacityMinutesPerWeek)}.`,
      );
    } else if (load.utilisation > 0.85) {
      warnings.push(`"${load.skill}" is at ${pct(load.utilisation)} of the people who hold it.`);
    }
  }

  /* --- Things that are merely odd ---------------------------------------- */

  const wanted = new Set(capabilityMinutes.keys());
  for (const template of scenario.equipment) {
    if (!template.capabilities.some((c) => wanted.has(c))) {
      warnings.push(`"${template.name}" is never used by any work type.`);
    }
  }
  for (const person of scenario.staff) {
    const used = person.skills.filter((s) => skillMinutes.has(s));
    if (used.length === 0) {
      warnings.push(`${person.name} holds no skill any work type needs.`);
    }
  }

  return {
    offeredAttendedMinutes,
    contractedMinutes,
    byCapability,
    bySkill,
    bindingCapability: byCapability[0],
    bindingSkill: bySkill[0],
    errors,
    warnings,
  };
}

/**
 * Throws if the scenario cannot work.
 *
 * Separate from the audit so that reporting and refusing are different
 * decisions: a batch runner should refuse, and a person reading a report should
 * see the warnings too.
 */
export function assertScenarioIsPossible(scenario: Scenario): void {
  const audit = auditScenario(scenario);
  if (audit.errors.length > 0) {
    throw new Error(`scenario "${scenario.id}" cannot work:\n  ${audit.errors.join('\n  ')}`);
  }
}

function add<K>(map: Map<K, number>, key: K, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

const hours = (minutes: number): string => (minutes / MINUTES_PER_HOUR).toFixed(1);
const pct = (fraction: number): string => `${(fraction * 100).toFixed(0)}%`;
