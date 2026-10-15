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
import {
  paired,
  runBatch,
  type BatchResult,
  type Paired,
  type RunResult,
  type Spread,
} from './runner';

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
 * The same comparison again, seed by seed.
 *
 * The table above subtracts one median from another, which leaves the weather in:
 * both options face the same fifty months, and a month that is hard is hard
 * either way. That is why the change looked small against ranges that overlap
 * almost completely. Subtracting inside each seed removes the month and leaves
 * the decision — and it is the only one of the two that can answer "how often",
 * which is the question a manager actually asks.
 */
function pairedRow(
  name: string,
  base: BatchResult,
  variant: BatchResult,
  pick: (r: RunResult) => number,
  better: 'higher' | 'lower',
  decimals = 0,
): string {
  const p: Paired = paired(base, variant, pick, better);
  const sign = p.median > 0 ? '+' : '';
  const range = `${p.p10 > 0 ? '+' : ''}${fmt(p.p10, decimals)} to ${p.p90 > 0 ? '+' : ''}${fmt(p.p90, decimals)}`;
  const betterShare = (p.wins / p.seeds) * 10;
  const worseShare = (p.losses / p.seeds) * 10;

  return (
    `  ${name.padEnd(COLUMN)}` +
    `${(sign + fmt(p.median, decimals)).padEnd(14)}` +
    `${range.padEnd(22)}` +
    `${(fmt(betterShare, 1) + ' of 10').padEnd(12)}` +
    `${fmt(worseShare, 1)} of 10`
  );
}

function pairedReport(base: BatchResult, variant: BatchResult): string[] {
  return [
    '',
    `  Paired by seed — the same month under both options, subtracted`,
    '',
    `  ${''.padEnd(COLUMN)}${'typical'.padEnd(14)}${'P10 to P90'.padEnd(22)}${'better in'.padEnd(12)}worse in`,
    `  ${'-'.repeat(COLUMN + 56)}`,
    pairedRow('profit', base, variant, (r) => r.profit, 'higher'),
    pairedRow('jobs late', base, variant, (r) => r.jobsLate, 'lower'),
    pairedRow('jobs completed', base, variant, (r) => r.jobsCompleted, 'higher'),
    pairedRow('rush orders missed', base, variant, (r) => r.rushMissed, 'lower'),
    '',
    '  Each row is the median of fifty per-seed differences, not the difference',
    '  of two medians. Better and worse are counted separately because the rest',
    '  are ties: a row that is better in 3 and worse in 2 of 10 is a decision',
    '  that usually changes nothing, which reads very differently from 3 against 7.',
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

  // Run twice, because the dispatcher's rule for choosing a *person* is a
  // policy decision that can move a verdict, and a comparison that does not
  // say which rule produced it is not a finding. Least-versatile-first exists
  // to stop the only mass-spec scientist being spent on a centrifuge, which
  // is the very mechanism cross-training is meant to relieve.
  //
  // Nothing is tuned between the two. Same seeds, same scenario, same
  // everything but the rule.
  for (const policy of ['first-free', 'least-versatile'] as const) {
    const base = runBatch('as is', chemistryLab, SEEDS, { weeks: WEEKS, policy });
    const variant = runBatch('cross-trained x2', crossTrained(), SEEDS, {
      weeks: WEEKS,
      policy,
    });

    lines.push('', `Operator policy: ${policy}`);
    lines.push(...report(base, variant));
    lines.push(...pairedReport(base, variant));
  }
  process.stdout.write(lines.join('\n') + '\n');
}

main();
