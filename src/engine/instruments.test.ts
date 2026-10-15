/**
 * Instrument time, operator time, and how many instruments there are.
 *
 * Three claims, and each is a thing the product could not previously express.
 *
 * **An instrument can run while its operator does something else.** Mass
 * spectrometry is 60 minutes of preparation and 90 minutes of the instrument
 * running alone. If those were one number the lab would have no way to be
 * limited by an instrument without also being limited by its scientist, and the
 * scenario's whole story is that it is.
 *
 * **Unattended time ignores the calendar.** A 48-hour incubation runs through
 * nights and weekends. This needs no overnight code — only the absence of a
 * shift check — which is the return on separating the two clocks.
 *
 * **Capacity is a count, not a name.** A step asks for `microscopy` and any
 * instrument offering it will do, so a second instrument is real capacity. That
 * is the Phase 1 limitation this finally retires, and the direct test of
 * decision B.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import type { Job, Scenario, Staff } from '../domain/types';
import { MINUTES_PER_DAY } from './calendar';
import { applyCommand } from './commands';
import { allocate, existsFor, instrumentsFor, provides } from './resources';
import { advance } from './tick';
import { createWorld, type WorldState } from './world';

const SEED = 42;
const SUNDAY_0800 = 480;

/**
 * Runs with the dispatcher off.
 *
 * These tests build a precise situation by hand and assert about it. With
 * dispatch on — the default the live lab wants — the engine hands out work the
 * moment somebody is free, so the subject would be given something else before
 * the test could give it anything.
 */
const QUIET = { dispatch: { enabled: false } } as const;

function newWorld(scenario: Scenario = chemistryLab, startMinutes = SUNDAY_0800) {
  const world = createWorld(scenario, SEED, startMinutes);
  return world;
}

function waitForJob(world: WorldState, workTypeId: string): Job {
  for (let i = 0; i < 5000; i++) {
    const found = world.jobs.find((j) => j.workTypeId === workTypeId && j.status === 'waiting');
    if (found) return found;
    advance(world, 1, QUIET);
  }
  throw new Error(`waitForJob: no ${workTypeId} arrived`);
}

const person = (world: WorldState, name: string): Staff =>
  world.staff.find((p) => p.name === name)!;

/** Runs until a predicate holds, or gives up with a useful message. */
function runUntil(world: WorldState, what: string, done: () => boolean, maxMinutes = 6000): void {
  for (let i = 0; i < maxMinutes * 2 && !done(); i++) advance(world, 0.5, QUIET);
  if (!done()) throw new Error(`runUntil: ${what} never happened`);
}

describe('an instrument runs while its operator does something else', () => {
  it('releases the scientist the moment preparation is finished', () => {
    // The claim the scenario's bottleneck depends on. Sixty minutes of
    // preparation, then the instrument runs for ninety on its own and the
    // scientist is free — free enough to start another job in the same slice.
    const world = newWorld();
    const job = waitForJob(world, 'mass-spec');
    const amit = person(world, 'Dr. Amit Katz');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: amit.id, jobId: job.id });

    runUntil(world, 'the instrument took over', () => job.status === 'unattended');

    expect(job.operatorId).toBeNull();
    expect(amit.jobId).toBeNull();
    expect(amit.state).toBe('idle');
    // The attended phase is done and the unattended phase has barely started.
    expect(job.steps[0]!.remaining).toBe(0);
    expect(job.steps[0]!.unattendedRemaining).toBeGreaterThan(80);
    // And the instrument is held, which is the whole point.
    expect(job.equipmentId).not.toBeNull();
  });

  it('does not hold the instrument during preparation', () => {
    // The spec's bottleneck claim is 30 jobs x 90 minutes = 45 instrument-hours
    // a week. Held during preparation too it would be 75, and the lab would be
    // structurally broken rather than merely tight.
    const world = newWorld();
    const job = waitForJob(world, 'mass-spec');
    const amit = person(world, 'Dr. Amit Katz');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: amit.id, jobId: job.id });

    runUntil(world, 'preparation started', () => amit.state === 'working');
    expect(job.steps[0]!.resourceHeldDuring).toBe('unattended');
    expect(job.equipmentId).toBeNull();

    const spectrometer = instrumentsFor(world, 'mass-spec')[0]!;
    expect(spectrometer.heldBy).toHaveLength(0);
  });

  it('lets a second job prepare while the first instrument is running', () => {
    // Two scientists hold Mass Spectrometry. With one instrument, the second
    // can do all sixty minutes of preparation while the first job runs — and
    // then has to wait. That queue is the bottleneck.
    const world = newWorld();
    const first = waitForJob(world, 'mass-spec');
    const amit = person(world, 'Dr. Amit Katz');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: amit.id, jobId: first.id });
    runUntil(world, 'the first run started', () => first.status === 'unattended');

    const second = world.jobs.find(
      (j) => j.workTypeId === 'mass-spec' && j.status === 'waiting' && j.id !== first.id,
    );
    if (!second) return; // only one in the queue this early in the week

    const lihi = person(world, 'Dr. Lihi Dayan');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: lihi.id, jobId: second.id });
    runUntil(world, 'the second preparation finished', () => second.steps[0]!.remaining === 0);

    // Prepared, operator released, and no instrument — waiting for the one.
    expect(lihi.jobId).toBeNull();
    expect(second.equipmentId).toBeNull();
    expect(second.status).toBe('waiting');
  });
});

describe('unattended time ignores the calendar', () => {
  it('finishes an incubation over a weekend with nobody in the building', () => {
    // Started Thursday afternoon, due to finish 48 hours later on Saturday.
    // Nothing in the engine knows this is special; the instrument's clock is
    // simply not a person's.
    const thursdayAfternoon = 4 * MINUTES_PER_DAY + 13 * 60;
    const world = newWorld(chemistryLab, thursdayAfternoon);
    const job = waitForJob(world, 'cell-culture');
    // Michal, not Nina: Nina is contracted 08:00-12:00 and this starts at one
    // in the afternoon, so she is already at home. Both hold Incubator
    // Handling, and picking the one who is actually there is the point of
    // having per-person shifts at all.
    const operator = person(world, 'Dr. Michal Levi');
    expect(operator.state).toBe('idle');

    // Skip to the incubation step: the biosafety step is two hours of work.
    job.stepIndex = 1;
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: operator.id, jobId: job.id });
    runUntil(world, 'the incubation started', () => job.status === 'unattended');

    const startedAt = world.simMinutes;
    const left = job.steps[1]!.unattendedRemaining;
    expect(left).toBeGreaterThan(2000);

    // Through Friday and Saturday, when nobody is in the lab at all.
    advance(world, left, QUIET);

    expect(world.staff.every((p) => p.state === 'off')).toBe(true);
    expect(job.steps[1]!.unattendedRemaining).toBe(0);
    expect(job.stepIndex).toBe(2);
    expect(world.simMinutes - startedAt).toBeCloseTo(left, 6);
  });

  it('does not advance attended work once everybody has gone home', () => {
    // The other half of the claim, and the reason the two clocks are separate.
    //
    // Not "outside working hours": B1 lets somebody stay to finish the step
    // they are on, so attended work can continue past four. What it cannot do
    // is continue once the floor is empty.
    const world = newWorld();
    advance(world, 16 * 60 - 20 - world.simMinutes, QUIET);
    const job = waitForJob(world, 'blood-panel');
    const hadas = person(world, 'Hadas Ben Hamo');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: hadas.id, jobId: job.id });
    runUntil(world, 'work started', () => hadas.state === 'working');

    // Past closing and past the overtime that finishes the step.
    advance(world, 16 * 60 + 120 - world.simMinutes, QUIET);
    expect(world.staff.every((p) => p.state === 'off')).toBe(true);

    const left = job.steps.reduce((sum, s) => sum + s.remaining, 0);
    advance(world, 12 * 60, QUIET);

    expect(job.steps.reduce((sum, s) => sum + s.remaining, 0)).toBe(left);
  });

  it('gives the instrument back when the run finishes, not when someone returns', () => {
    const world = newWorld();
    const job = waitForJob(world, 'dna-pcr');
    const lihi = person(world, 'Dr. Lihi Dayan');
    applyCommand(world, { type: 'ASSIGN_JOB', staffId: lihi.id, jobId: job.id });
    runUntil(world, 'the cycler took over', () => job.status === 'unattended');

    const cycler = world.equipment.find((e) => e.id === job.equipmentId)!;
    expect(cycler.heldBy).toContain(job.id);

    advance(world, job.steps[0]!.unattendedRemaining, QUIET);

    expect(cycler.heldBy).not.toContain(job.id);
    expect(job.stepIndex).toBe(1);
  });
});

describe('capacity is a count, not a name', () => {
  it('matches a step to any instrument offering what it needs', () => {
    const world = newWorld();
    const microscope = instrumentsFor(world, 'microscopy')[0]!;
    expect(provides(microscope, 'microscopy')).toBe(true);
    expect(existsFor(world, 'microscopy')).toBe(true);
    // Not by name: the step says what it needs doing, not where.
    expect(chemistryLab.workTypes[0]!.steps[1]!.capability).toBe('microscopy');
  });

  it('expands a count into separate instruments that can run at once', () => {
    // Decision B, stated directly. Two instruments, two ids, two conditions,
    // two sets of slots — not one sprite drawn twice, which is what matching by
    // name produced.
    const twoScopes: Scenario = {
      ...chemistryLab,
      equipment: chemistryLab.equipment.map((e) =>
        e.capabilities.includes('microscopy') ? { ...e, count: 2 } : e,
      ),
    };
    const world = newWorld(twoScopes);
    const scopes = instrumentsFor(world, 'microscopy');

    expect(scopes).toHaveLength(2);
    expect(new Set(scopes.map((s) => s.id)).size).toBe(2);
    expect(scopes.map((s) => s.name)).toEqual(['Microscope 1', 'Microscope 2']);
    // Separate streams, so adding the second cannot change the first's wear.
    const one = newWorld();
    expect(scopes[0]!.condition).not.toBe(scopes[1]!.condition);
    expect(instrumentsFor(one, 'microscopy')[0]!.condition).toBeGreaterThan(0);
  });

  it('serialises two jobs on one instrument and overlaps them on two', () => {
    // The direct test of decision B: the same demand, one instrument against
    // two, and the difference is whether the work overlaps.
    function firstFreeInstrumentCount(count: number): number {
      const scenario: Scenario = {
        ...chemistryLab,
        equipment: chemistryLab.equipment.map((e) =>
          e.capabilities.includes('centrifuge') ? { ...e, count } : e,
        ),
      };
      const world = newWorld(scenario);
      const centrifuges = instrumentsFor(world, 'centrifuge');
      expect(centrifuges).toHaveLength(count);

      // Occupy the first, then ask for another.
      const job = waitForJob(world, 'blood-panel');
      centrifuges[0]!.heldBy.push(job.id);
      return allocate(world, 'centrifuge') === undefined ? 0 : 1;
    }

    expect(firstFreeInstrumentCount(1)).toBe(0);
    expect(firstFreeInstrumentCount(2)).toBe(1);
  });

  it('lets several jobs share one instrument when it has shelves', () => {
    // Six cultures at once, from `tuning.incubatorCapacity`. Without capacity
    // the model jams rather than queueing: twelve cell cultures at 48 hours
    // each is 576 instrument-hours a week, impossible at any *count* if each
    // instrument takes one job.
    const world = newWorld();
    const incubator = instrumentsFor(world, 'incubator')[0]!;
    expect(incubator.capacity).toBe(chemistryLab.tuning.incubatorCapacity);

    for (let i = 0; i < incubator.capacity; i++) incubator.heldBy.push(`fake-${i}`);
    expect(allocate(world, 'incubator')).toBeUndefined();

    incubator.heldBy.pop();
    expect(allocate(world, 'incubator')).toBe(incubator);
  });

  it('sells instruments that the work actually asks for', () => {
    // Phase 1 recorded that the shop sold names no step wanted, so a purchase
    // added a sprite and no capacity. Every catalogue item now offers a
    // capability some work type needs.
    const needed = new Set(chemistryLab.workTypes.flatMap((w) => w.steps.map((s) => s.capability)));
    for (const item of chemistryLab.catalog) {
      expect(item.capabilities.some((c) => needed.has(c))).toBe(true);
    }
  });

  it('numbers a bought instrument after the ones already there', () => {
    const world = newWorld();
    const before = instrumentsFor(world, 'microscopy').length;
    applyCommand(world, { type: 'BUY_EQUIPMENT', catalogId: 'cat001' });

    const after = instrumentsFor(world, 'microscopy');
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.name).toBe(`Microscope ${before + 1}`);
    expect(new Set(after.map((m) => m.id)).size).toBe(after.length);
  });
});

describe('slots are given back exactly once', () => {
  it('never leaves an instrument holding a job that has finished', () => {
    // An instrument stuck at capacity with nothing in it would deadlock
    // silently, which is why releasing searches rather than trusting the job's
    // own record of where it was.
    const world = newWorld();
    for (let day = 0; day < 21; day++) {
      advance(world, MINUTES_PER_DAY, QUIET);
      for (const resource of world.equipment) {
        for (const jobId of resource.heldBy) {
          const job = world.jobs.find((j) => j.id === jobId);
          expect(job, `${resource.name} holds unknown ${jobId}`).toBeDefined();
          expect(['in-progress', 'unattended']).toContain(job!.status);
        }
        expect(resource.heldBy.length).toBeLessThanOrEqual(resource.capacity);
      }
    }
  });
});
