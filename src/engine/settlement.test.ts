/**
 * What a finished job is worth, and why a rush order is a decision.
 *
 * The arithmetic is the whole of it. There is no invented penalty anywhere:
 *
 * | | on time | late |
 * |---|---|---|
 * | ordinary | price | 80% |
 * | rush | 150% | 70% |
 *
 * A ₪900 mass-spec job quoted as a rush is worth ₪1,350 landed and ₪630 missed
 * — a swing of ₪720 on one job, against roughly ₪225 of materials already
 * spent. The same job taken normally swings by ₪180. That asymmetry is why a
 * lab manager cares which rush orders she accepts, and it falls out of the
 * prices rather than out of a punishment.
 *
 * It replaces a flat `penalty` charged on emergencies, which could be levied on
 * work nobody could have reached — the mechanism by which a simulated fortnight
 * reached minus a quarter of a million shekels.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import type { Job } from '../domain/types';
import { MINUTES_PER_DAY } from './calendar';
import { settlementFor } from './jobs';
import { advance } from './tick';
import { createWorld, type WorldState } from './world';

const SEED = 42;
const SUNDAY_0800 = 480;
const t = chemistryLab.tuning;

const newWorld = (startMinutes = SUNDAY_0800) => createWorld(chemistryLab, SEED, startMinutes);

/** A ₪900 job, which is the one the specification's example uses. */
function massSpecJob(world: WorldState, rush: boolean): Job {
  for (let i = 0; i < 5000; i++) {
    const found = world.jobs.find((j) => j.workTypeId === 'mass-spec' && j.rush === rush);
    if (found) return found;
    advance(world, 1);
  }
  throw new Error(`no ${rush ? 'rush' : 'ordinary'} mass-spec job arrived`);
}

describe('the four settlement cases', () => {
  const ordinary = { basePrice: 900, rush: false } as Job;
  const rush = { basePrice: 900, rush: true } as Job;
  const world = { tuning: t } as WorldState;

  it('pays an ordinary job its price on time', () => {
    expect(settlementFor(world, ordinary, true)).toBe(900);
  });

  it('pays an ordinary late job four fifths', () => {
    expect(settlementFor(world, ordinary, false)).toBe(720);
  });

  it('pays a rush order half again on time', () => {
    expect(settlementFor(world, rush, true)).toBe(1350);
  });

  it('reproduces the specification example for a missed rush', () => {
    // The premium is lost *and* 30% of the ordinary price is refunded.
    expect(settlementFor(world, rush, false)).toBe(630);
  });

  it('makes a missed rush worse than an ordinary late job', () => {
    // The client was promised something and planned around it, so a missed
    // rush pays less than ordinary lateness — not merely less than its own
    // quote. Without this a rush would be a free option.
    expect(settlementFor(world, rush, false)).toBeLessThan(settlementFor(world, ordinary, false));
  });

  it('makes the swing on a rush four times the swing on an ordinary job', () => {
    const rushSwing = settlementFor(world, rush, true) - settlementFor(world, rush, false);
    const normalSwing =
      settlementFor(world, ordinary, true) - settlementFor(world, ordinary, false);
    expect(rushSwing).toBe(720);
    expect(normalSwing).toBe(180);
    expect(rushSwing / normalSwing).toBe(4);
  });
});

describe('settlement in a running lab', () => {
  it('pays the premium when a rush order lands', () => {
    const world = newWorld();
    const job = massSpecJob(world, true);
    const before = world.money;

    job.dueAtMinute = world.simMinutes + 10 * MINUTES_PER_DAY; // comfortably in time
    job.steps.forEach((s) => {
      s.remaining = 0;
      s.unattendedRemaining = 0;
    });
    job.stepIndex = job.steps.length;
    job.status = 'in-progress';
    job.operatorId = world.staff[0]!.id;
    world.staff[0]!.jobId = job.id;
    advance(world, 1);

    expect(job.status).toBe('done-on-time');
    expect(job.settledRevenue).toBe(job.basePrice * t.rushPriceMultiplier);
    expect(world.money - before).toBeCloseTo(job.settledRevenue, 6);
  });

  it('charges nothing at all for work nobody reached', () => {
    // The old emergencies levied a flat ₪4,000 on any unassigned one, which is
    // how a budget reached minus a quarter of a million in two simulated
    // weeks. An abandoned job now simply pays nothing.
    const world = newWorld();
    const before = world.money;
    advance(world, 21 * MINUTES_PER_DAY);

    const expired = world.jobs.filter((j) => j.status === 'expired');
    expect(expired.length).toBeGreaterThan(0);
    for (const job of expired) expect(job.settledRevenue).toBe(0);
    // Nothing was done either, so the budget has not moved at all.
    expect(world.money).toBe(before);
    expect(world.money).toBeGreaterThan(0);
  });

  it('never leaves a finished job unpriced', () => {
    const world = newWorld();
    advance(world, 14 * MINUTES_PER_DAY);
    for (const job of world.jobs) {
      if (job.status === 'done-on-time' || job.status === 'done-late') {
        expect(job.settledRevenue).toBeGreaterThan(0);
        expect(job.completedAtMinute).not.toBeNull();
      }
    }
  });
});

describe('rush orders are ordinary jobs with a flag', () => {
  it('has no separate entity, template or queue', () => {
    const world = newWorld();
    // Everything urgent is a job. There is no second collection to keep in
    // step, which is what the emergency path required and kept getting wrong.
    expect('emergencies' in world).toBe(false);
    expect('emergencyTemplates' in world).toBe(false);
  });

  it('holds no work on a person except training', () => {
    const world = newWorld();
    advance(world, 7 * MINUTES_PER_DAY);
    for (const p of world.staff) {
      if (p.activeTask) expect(p.activeTask.type).toBe('training');
    }
  });

  it('gives a rush order the same steps as any other job of its type', () => {
    const world = newWorld();
    const rush = massSpecJob(world, true);
    const workType = chemistryLab.workTypes.find((w) => w.id === 'mass-spec')!;

    expect(rush.steps).toHaveLength(workType.steps.length);
    expect(rush.steps[0]!.capability).toBe(workType.steps[0]!.capability);
    expect(rush.basePrice).toBe(workType.basePrice);
  });
});
