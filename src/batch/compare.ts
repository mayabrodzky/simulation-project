/**
 * `npm run compare` — the first answer this project gives to a question.
 *
 * Runs the lab fifty times over four simulated weeks for two cases, and prints
 * what differs:
 *
 *   as is                      — the lab as the specification describes it
 *   cross-train two people     — Dana and Hadas learn Mass Spectrometry
 *
 * Both cases face the **same fifty demand seeds**, which is the only reason the
 * difference between them means anything. Without it the comparison would be
 * part decision and part weather, with nothing to separate them.
 *
 * No interface and no money. This is a text table, and it exists to show that
 * the model can answer a question at all.
 */
import { chemistryLab } from '../scenarios';
import type { Scenario } from '../domain/types';
import { auditScenario } from '../engine/audit';
import { runBatch, type BatchResult, type Spread } from './runner';

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);
const WEEKS = 4;

/** Decision D from the specification: cross-train two people on mass spec. */
function crossTrained(): Scenario {
  const learners = new Set(['Dana Cohen', 'Hadas Ben Hamo']);
  return {
    ...chemistryLab,
    id: 'chemistry-lab-cross-trained',
    staff: chemistryLab.staff.map((person) =>
      learners.has(person.name) && !person.skills.includes('Mass Spectrometry')
        ? { ...person, skills: [...person.skills, 'Mass Spectrometry'] }
        : person,
    ),
  };
}

function fmt(value: number, decimals = 0): string {
  return value.toFixed(decimals);
}

function spread(s: Spread, decimals = 0): string {
  return `${fmt(s.median, decimals)}  (${fmt(s.p10, decimals)}–${fmt(s.p90, decimals)})`;
}

/** Wide enough for a six-figure sum with a range beside it. */
const COLUMN = 26;

function row(name: string, a: Spread, b: Spread, decimals = 0): string {
  const delta = b.median - a.median;
  const sign = delta > 0 ? '+' : '';
  return (
    `  ${name.padEnd(COLUMN)}` +
    `${spread(a, decimals).padEnd(COLUMN)}` +
    `${spread(b, decimals).padEnd(COLUMN)}` +
    `${delta === 0 ? '—' : sign + fmt(delta, decimals)}`
  );
}

function report(base: BatchResult, variant: BatchResult): string[] {
  const pct = (s: Spread) => ({
    median: s.median * 100,
    p10: s.p10 * 100,
    p90: s.p90 * 100,
  });

  return [
    '',
    `Polaris — ${SEEDS.length} runs x ${WEEKS} weeks, same demand seeds for both cases`,
    '',
    `  ${''.padEnd(COLUMN)}${base.label.padEnd(COLUMN)}${variant.label.padEnd(COLUMN)}change`,
    `  ${'-'.repeat(COLUMN * 3 + 6)}`,
    row('jobs completed', base.jobsCompleted, variant.jobsCompleted),
    row('jobs late', base.jobsLate, variant.jobsLate),
    row('rush orders missed', base.rushMissed, variant.rushMissed),
    row('jobs abandoned', base.jobsAbandoned, variant.jobsAbandoned),
    row('average backlog', base.averageBacklog, variant.averageBacklog, 1),
    row(
      'mass-spec utilisation %',
      pct(base.massSpecUtilisation),
      pct(variant.massSpecUtilisation),
      1,
    ),
    '',
    `  money, over the four weeks`,
    row('revenue', base.revenue, variant.revenue),
    row('labour', base.labour, variant.labour),
    row('  of which overtime', base.labourOvertime, variant.labourOvertime),
    row('profit', base.profit, variant.profit),
    row('profit per month', base.profitPerMonth, variant.profitPerMonth),
    '',
    '  Median, with the 10th-90th percentile across runs in brackets.',
    '  Money in shekels. Labour is charged on contracted hours whether worked or',
    '  not, so an idle hire still costs; overtime adds only the premium.',
    '',
  ];
}

/**
 * What the audit says before anything is run.
 *
 * Printed first on purpose. If the binding constraint is not the thing the
 * decision addresses, the comparison will show very little and the reason ought
 * to be visible above the table rather than inferred from it.
 */
function constraints(scenario: Scenario): string[] {
  const audit = auditScenario(scenario);
  const attendedOnly = audit.byCapability.filter(
    (c) => c.attendedMinutesPerWeek === c.minutesPerWeek,
  );
  return [
    `  offered ${fmt(audit.offeredAttendedMinutes / 60, 1)} hands-on h/wk against ` +
      `${fmt(audit.contractedMinutes / 60, 1)} contracted`,
    `  tightest instrument needing a person: ${attendedOnly[0]?.capability ?? '-'} at ` +
      `${fmt((attendedOnly[0]?.utilisationInWorkingHours ?? 0) * 100)}% of working hours`,
    `  tightest skill: ${audit.bindingSkill?.skill ?? '-'} at ` +
      `${fmt((audit.bindingSkill?.utilisation ?? 0) * 100)}%`,
  ];
}

export function main(): void {
  const lines: string[] = ['', 'Before running — what the arithmetic says limits this lab:'];
  lines.push(...constraints(chemistryLab));

  const base = runBatch('as is', chemistryLab, SEEDS, { weeks: WEEKS });
  const variant = runBatch('cross-trained x2', crossTrained(), SEEDS, { weeks: WEEKS });

  lines.push(...report(base, variant));
  process.stdout.write(lines.join('\n') + '\n');
}

main();
