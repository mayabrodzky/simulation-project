/**
 * Simulation rules that are true in any domain. No data, no DOM, no clock.
 */
import type { Skill, TaskStep } from '../domain/types';

/** Anything with a set of skills — a staff member, or a template of one. */
interface HasSkills {
  skills: Skill[];
}

/** Anything with an ordered sequence of steps — a task, a training, an emergency. */
interface HasSteps {
  equipmentSequence?: TaskStep[];
}

/**
 * Whether a person can perform every step of a task.
 *
 * A step with no required skill is open to anyone. This predicate was
 * previously copy-pasted at five call sites — the staff highlight, the task
 * list, the task modal, the assignment check and the emergency staff picker —
 * so the rule governing who may do what could have been changed in one place
 * and silently left stale in four.
 */
export function isQualified(person: HasSkills, task: HasSteps): boolean {
  const steps = task.equipmentSequence;
  if (!steps) return true;
  return steps.every((step) => !step.skillRequired || person.skills.includes(step.skillRequired));
}

/** The skills a person is missing for a task, for explaining a refusal. */
export function missingSkills(person: HasSkills, task: HasSteps): Skill[] {
  const steps = task.equipmentSequence ?? [];
  const missing = steps
    .map((step) => step.skillRequired)
    .filter((skill): skill is Skill => skill !== null && !person.skills.includes(skill));
  return [...new Set(missing)];
}
