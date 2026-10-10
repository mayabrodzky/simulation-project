/**
 * Tests for the claims this refactor makes.
 *
 * Each of these existed as "I checked it once by hand" before. They are cheap
 * to write only because the engine is headless: no browser, no DOM, no canvas,
 * no animation frame. That is the payoff from separating the simulation from
 * the screen, in a form that can be measured.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import { dayOfWeek } from './calendar';
import { applyCommand } from './commands';
import { isQualified, missingSkills } from './rules';
import { createRng } from './rng';
import { tick } from './tick';
import { createWorld, type WorldState } from './world';

const SEED = 42;

function run(seed: number, ticks: number, dt = 1 / 30): WorldState {
  const world = createWorld(chemistryLab, seed, 480);
  for (let i = 0; i < ticks; i++) tick(world, dt);
  return world;
}

/** The parts of a world that should match exactly between identical runs. */
function fingerprint(world: WorldState) {
  return {
    money: world.money,
    minutes: world.minutes,
    rngState: world.rngState,
    metrics: world.metrics,
    staff: world.staff.map((p) => [p.id, p.state, p.x, p.y, p.energy, p.taskStep]),
    equipment: world.equipment.map((e) => [e.id, e.inUse, e.condition, e.assignedTo]),
    emergencies: world.emergencies.map((e) => [e.id, e.status, e.timeLimit]),
  };
}

describe('determinism', () => {
  it('produces an identical run from the same seed', () => {
    expect(fingerprint(run(SEED, 1000))).toEqual(fingerprint(run(SEED, 1000)));
  });

  it('produces a different run from a different seed', () => {
    expect(fingerprint(run(SEED, 1000))).not.toEqual(fingerprint(run(SEED + 1, 1000)));
  });

  it('does not depend on how finely time is sliced for continuous quantities', () => {
    // The clock and equipment wear integrate over dt, so stepping the same
    // simulated duration in different sized steps must agree. Discrete events
    // legitimately differ, which is why this checks the clock rather than a
    // fingerprint.
    const coarse = createWorld(chemistryLab, SEED, 480);
    for (let i = 0; i < 60; i++) tick(coarse, 1);
    const fine = createWorld(chemistryLab, SEED, 480);
    for (let i = 0; i < 600; i++) tick(fine, 0.1);
    expect(fine.minutes).toBeCloseTo(coarse.minutes, 6);
  });

  it('keeps the rng reproducible across a clone, which sandbox mode relies on', () => {
    const world = run(SEED, 100);
    const copy = structuredClone(world);
    const a = createRng(1);
    a.setState(world.rngState);
    const b = createRng(1);
    b.setState(copy.rngState);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });
});

describe('isQualified', () => {
  const task = (...skills: (string | null)[]) => ({
    equipmentSequence: skills.map((skillRequired) => ({
      name: 'X',
      duration: 1,
      skillRequired,
    })),
  });

  it('accepts a person holding every required skill', () => {
    expect(isQualified({ skills: ['A', 'B'] }, task('A', 'B'))).toBe(true);
  });

  it('accepts extra skills beyond those required', () => {
    expect(isQualified({ skills: ['A', 'B', 'C'] }, task('A'))).toBe(true);
  });

  it('rejects a person missing any one required skill', () => {
    expect(isQualified({ skills: ['A'] }, task('A', 'B'))).toBe(false);
  });

  it('treats a step with no required skill as open to anyone', () => {
    expect(isQualified({ skills: [] }, task(null))).toBe(true);
    expect(isQualified({ skills: [] }, task(null, null))).toBe(true);
  });

  it('rejects a person with no skills when any step requires one', () => {
    expect(isQualified({ skills: [] }, task(null, 'A'))).toBe(false);
  });

  it('reports which skills are missing, without duplicates', () => {
    expect(missingSkills({ skills: ['A'] }, task('A', 'B', 'B', null))).toEqual(['B']);
  });

  it('matches the scenario it was extracted from', () => {
    const world = createWorld(chemistryLab, SEED, 480);
    const bloodPanel = world.tasks.find((t) => t.name === 'Blood Sample Analysis');
    const hadas = world.staff.find((p) => p.name === 'Hadas Ben Hamo');
    const amir = world.staff.find((p) => p.name === 'Amir Barzilay');
    expect(isQualified(hadas!, bloodPanel!)).toBe(true);
    expect(isQualified(amir!, bloodPanel!)).toBe(false);
  });
});

describe('cancelling a task mid-flight', () => {
  function startTraining(world: WorldState) {
    const dana = world.staff.find((p) => p.name === 'Dana Cohen')!;
    const microscope = world.equipment.find((e) => e.name === 'Microscope A')!;
    applyCommand(world, {
      type: 'START_TRAINING',
      staffId: dana.id,
      equipmentId: microscope.id,
      skill: 'Microscopy',
    });
    return dana;
  }

  it('does not throw or corrupt the budget when someone is marked sick during training', () => {
    // This used to crash: the failure path charged task.penalty, which a
    // training does not have, so the budget became NaN, and it indexed
    // task.equipmentSequence, which a training does not have either, so it
    // threw. Typing ActiveTask as a real union is what made both impossible.
    const world = createWorld(chemistryLab, SEED, 480);
    const dana = startTraining(world);
    const budgetDuringTraining = world.money;

    expect(() =>
      applyCommand(world, { type: 'SET_STATUS', staffId: dana.id, sick: true }),
    ).not.toThrow();

    expect(Number.isFinite(world.money)).toBe(true);
    expect(world.money).toBe(budgetDuringTraining);
    expect(dana.state).toBe('sick');
    expect(dana.activeTask).toBeNull();
  });

  it('releases the machine the trainee was holding', () => {
    const world = createWorld(chemistryLab, SEED, 480);
    const dana = startTraining(world);
    const microscope = world.equipment.find((e) => e.name === 'Microscope A')!;
    // Walk her to the machine so the training actually starts.
    for (let i = 0; i < 400; i++) tick(world, 1 / 30);
    expect(microscope.inUse).toBe(true);

    applyCommand(world, { type: 'SET_STATUS', staffId: dana.id, sick: true });
    expect(microscope.inUse).toBe(false);
    expect(microscope.assignedTo).toBeNull();
  });

  it('refuses to mark an off-shift person sick, rather than putting them back on shift', () => {
    const world = createWorld(chemistryLab, SEED, 480);
    const offDuty = world.staff.find((p) => p.state === 'off')!;
    const events = applyCommand(world, { type: 'SET_STATUS', staffId: offDuty.id, sick: true });
    expect(events).toEqual([{ type: 'rejected', reason: 'off-shift', detail: offDuty.name }]);
    expect(offDuty.state).toBe('off');
  });
});

describe('the engine reports rather than renders', () => {
  it('raises an emergency as an event, with no side effects outside the world', () => {
    // The emergency path crossed into the DOM before the extraction, which is
    // why it could not be tested at all. Forcing the rate high makes it
    // certain within a few ticks.
    const world = createWorld(chemistryLab, SEED, 480);
    world.tuning = { ...world.tuning, emergencyRatePerMinute: 50 };
    const events = [];
    for (let i = 0; i < 20 && events.length === 0; i++) events.push(...tick(world, 1));

    const raised = events.find((e) => e.type === 'emergency-raised');
    expect(raised).toBeDefined();
    expect(world.emergencies).toHaveLength(1);
    expect(world.emergencies[0]!.status).toBe('pending');
  });

  it('gives refusals a reason instead of a sentence', () => {
    const world = createWorld(chemistryLab, SEED, 480);
    const amir = world.staff.find((p) => p.name === 'Amir Barzilay')!;
    const bloodPanel = world.tasks.find((t) => t.name === 'Blood Sample Analysis')!;
    const events = applyCommand(world, {
      type: 'ASSIGN_TASK',
      staffId: amir.id,
      taskId: bloodPanel.id,
    });
    expect(events).toEqual([{ type: 'rejected', reason: 'unqualified', detail: amir.name }]);
    expect(amir.activeTask).toBeNull();
  });
});

describe('the world clock', () => {
  it('knows what day it is, and keeps counting past midnight', () => {
    // Minute 0 is Sunday 00:00, so a world started at 480 begins Sunday 08:00.
    const world = createWorld(chemistryLab, SEED, 480);
    expect(world.simMinutes).toBe(480);
    expect(dayOfWeek(world.simMinutes)).toBe(0);

    // Run three simulated days. The old clock wrapped and lost the date.
    const minutesToRun = 3 * 24 * 60;
    const seconds = minutesToRun / chemistryLab.tuning.minutesPerSecond;
    for (let i = 0; i < seconds; i++) tick(world, 1);

    expect(world.simMinutes).toBeCloseTo(480 + minutesToRun, 6);
    expect(dayOfWeek(world.simMinutes)).toBe(3); // Sunday + 3 → Wednesday
  });

  it('keeps the derived time of day inside a day, for the HUD', () => {
    const world = createWorld(chemistryLab, SEED, 1380); // 23:00
    for (let i = 0; i < 600; i++) {
      tick(world, 1);
      expect(world.minutes).toBeGreaterThanOrEqual(0);
      expect(world.minutes).toBeLessThan(24 * 60);
    }
    // It wrapped past midnight while the absolute clock did not.
    expect(world.minutes).toBeLessThan(1380);
    expect(world.simMinutes).toBeGreaterThan(1380);
  });

  it('freezes both clocks in sandbox mode', () => {
    const world = createWorld(chemistryLab, SEED, 480);
    for (let i = 0; i < 100; i++) tick(world, 1, { freezeClock: true });
    expect(world.simMinutes).toBe(480);
    expect(world.minutes).toBe(480);
  });
});
