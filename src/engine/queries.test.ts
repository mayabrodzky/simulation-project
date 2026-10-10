/**
 * The seam the interface asks questions through.
 *
 * These tests pin the *contract* rather than the current implementation: what
 * the view is entitled to ask and what shape it gets back. The answers are
 * rewritten when work becomes an entity of its own, and these assertions are
 * what will say whether the panels still get what they need.
 */
import { describe, expect, it } from 'vitest';
import { chemistryLab } from '../scenarios';
import { applyCommand } from './commands';
import {
  clockView,
  countTraining,
  describeAssignment,
  isUnoccupied,
  listActiveWork,
  progressByStaff,
  staffLoadPercent,
  unoccupiedStaffIds,
} from './queries';
import { tick } from './tick';
import { createWorld, type WorldState } from './world';

const SEED = 42;
const newWorld = (startMinutes = 480) => createWorld(chemistryLab, SEED, startMinutes);

const hadas = (w: WorldState) => w.staff.find((p) => p.name === 'Hadas Ben Hamo')!;

/**
 * Advances until the person is actually working, rather than for a fixed
 * number of ticks. A fixed count has to be re-guessed whenever a duration
 * changes, and overshooting completes the task being observed.
 */
function runUntilWorking(world: WorldState, staffId: number, maxTicks = 5000): void {
  for (let i = 0; i < maxTicks; i++) {
    if (world.staff.find((p) => p.id === staffId)?.state === 'working') return;
    tick(world, 1 / 30);
  }
  throw new Error('runUntilWorking: never started');
}
const bloodPanel = (w: WorldState) => w.tasks.find((t) => t.name === 'Blood Sample Analysis')!;

describe('describeAssignment', () => {
  it('returns nothing for someone with no work', () => {
    const world = newWorld();
    expect(describeAssignment(world, hadas(world))).toBeNull();
  });

  it('names the work and reports travel before it starts', () => {
    const world = newWorld();
    const person = hadas(world);
    applyCommand(world, { type: 'ASSIGN_TASK', staffId: person.id, taskId: bloodPanel(world).id });

    const view = describeAssignment(world, person);
    expect(view?.label).toBe('Blood Sample Analysis');
    expect(view?.statusText).toBe('Moving to equipment');
    expect(view?.progress).toBe(0);
    expect(view?.isTraining).toBe(false);
  });

  it('reports progress once the work is under way', () => {
    const world = newWorld();
    const person = hadas(world);
    applyCommand(world, { type: 'ASSIGN_TASK', staffId: person.id, taskId: bloodPanel(world).id });
    runUntilWorking(world, person.id);

    // Work begins the instant the person arrives and continues through the
    // rest of that slice, so a little progress has already been made.
    const atStart = describeAssignment(world, person)!;
    expect(atStart.statusText).toBe('Processing');
    expect(atStart.progress).toBeGreaterThanOrEqual(0);
    expect(atStart.progress).toBeLessThan(0.1);

    for (let i = 0; i < 100; i++) tick(world, 1 / 30);
    const later = describeAssignment(world, person)!;
    expect(later.progress).toBeGreaterThan(atStart.progress);
    expect(later.progress).toBeLessThanOrEqual(1);
  });

  it('distinguishes training from a job', () => {
    const world = newWorld();
    const dana = world.staff.find((p) => p.name === 'Dana Cohen')!;
    const microscope = world.equipment.find((e) => e.name === 'Microscope A')!;
    applyCommand(world, {
      type: 'START_TRAINING',
      staffId: dana.id,
      equipmentId: microscope.id,
      skill: 'Microscopy',
    });
    expect(describeAssignment(world, dana)?.isTraining).toBe(true);
    expect(countTraining(world)).toBe(1);
  });

  it('keeps progress within bounds for every person over a long run', () => {
    const world = newWorld();
    applyCommand(world, {
      type: 'ASSIGN_TASK',
      staffId: hadas(world).id,
      taskId: bloodPanel(world).id,
    });
    for (let i = 0; i < 5000; i++) {
      tick(world, 1 / 30);
      for (const p of world.staff) {
        const view = describeAssignment(world, p);
        if (!view) continue;
        expect(view.progress).toBeGreaterThanOrEqual(0);
        expect(view.progress).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('listActiveWork', () => {
  it('is empty when nobody is working', () => {
    expect(listActiveWork(newWorld())).toEqual([]);
  });

  it('lists work with its assignee', () => {
    const world = newWorld();
    const person = hadas(world);
    applyCommand(world, { type: 'ASSIGN_TASK', staffId: person.id, taskId: bloodPanel(world).id });

    const [item, ...rest] = listActiveWork(world);
    expect(rest).toHaveLength(0);
    expect(item?.name).toBe('Blood Sample Analysis');
    expect(item?.assignee).toBe('Hadas Ben Hamo');
  });

  it('returns display data, holding no reference into the world', () => {
    const world = newWorld();
    applyCommand(world, {
      type: 'ASSIGN_TASK',
      staffId: hadas(world).id,
      taskId: bloodPanel(world).id,
    });
    const item = listActiveWork(world)[0]!;
    const before = world.staff.map((p) => p.name);
    item.assignee = 'tampered';
    expect(world.staff.map((p) => p.name)).toEqual(before);
  });
});

describe('who is free', () => {
  it('counts everyone on shift and unoccupied', () => {
    const world = newWorld();
    // Six start on shift; the other two are off.
    expect(unoccupiedStaffIds(world)).toHaveLength(6);
  });

  it('excludes someone who has been given work', () => {
    const world = newWorld();
    const person = hadas(world);
    applyCommand(world, { type: 'ASSIGN_TASK', staffId: person.id, taskId: bloodPanel(world).id });
    expect(isUnoccupied(world, person)).toBe(false);
    expect(unoccupiedStaffIds(world)).not.toContain(person.id);
  });

  it('excludes someone off shift', () => {
    const world = newWorld();
    const offDuty = world.staff.find((p) => p.state === 'off')!;
    expect(isUnoccupied(world, offDuty)).toBe(false);
  });
});

describe('progressByStaff', () => {
  it('has an entry only for people actually working', () => {
    const world = newWorld();
    applyCommand(world, {
      type: 'ASSIGN_TASK',
      staffId: hadas(world).id,
      taskId: bloodPanel(world).id,
    });
    expect(progressByStaff(world)).toEqual({});

    runUntilWorking(world, hadas(world).id);
    expect(Object.keys(progressByStaff(world))).toEqual([String(hadas(world).id)]);
  });
});

describe('clockView', () => {
  it('formats the time of day and names the day', () => {
    const world = newWorld(480); // Sunday 08:00
    expect(clockView(world).label).toBe('08:00');
    expect(clockView(world).dayLabel).toBe('Sun');
    expect(clockView(world).isNight).toBe(false);
  });

  it('knows night from day', () => {
    expect(clockView(newWorld(23 * 60)).isNight).toBe(true);
    expect(clockView(newWorld(3 * 60)).isNight).toBe(true);
    expect(clockView(newWorld(6 * 60)).isNight).toBe(false);
    expect(clockView(newWorld(21 * 60)).isNight).toBe(true);
  });
});

describe('staffLoadPercent', () => {
  it('is a whole number between 0 and 100', () => {
    const world = newWorld();
    for (const p of world.staff) {
      const load = staffLoadPercent(world, p);
      expect(Number.isInteger(load)).toBe(true);
      expect(load).toBeGreaterThanOrEqual(0);
      expect(load).toBeLessThanOrEqual(100);
    }
  });
});
