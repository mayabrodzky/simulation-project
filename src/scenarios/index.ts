/**
 * Scenario registry. The product ships one polished scenario; the engine is
 * generic so that adding another is config rather than code.
 */
import type { Scenario } from '../domain/types';
import { chemistryLab } from './chemistryLab';

export { chemistryLab } from './chemistryLab';
export { scenarioFromBusinessProfile } from './fromBusinessProfile';
export type { BusinessProfile } from './fromBusinessProfile';

export const scenarios: Record<string, Scenario> = {
  [chemistryLab.id]: chemistryLab,
};

export const defaultScenario: Scenario = chemistryLab;
