/**
 * The calendar is pure arithmetic with no world and no randomness, which makes
 * it both the easiest thing in this phase to test exhaustively and the most
 * important: deadlines, overtime, shift windows and "does this pause
 * overnight?" all derive from it, so an error here reaches every number the
 * simulation reports without announcing itself.
 */
import { describe, expect, it } from 'vitest';
import type { Calendar, Shift } from '../domain/types';
import {
  MINUTES_PER_DAY,
  addCalendarHours,
  addWorkingDays,
  addWorkingMinutes,
  clockLabel,
  dayLabel,
  dayOfWeek,
  dayIndex,
  isWithinShift,
  isWorkingDay,
  minuteOfDay,
  nextCalendarBoundary,
  nextOpen,
  shiftEndAfter,
  weekIndex,
  workingMinutesBetween,
} from './calendar';

/** The lab: Sunday–Thursday, 08:00–16:00. */
const shift: Shift = { days: [0, 1, 2, 3, 4], startMinute: 480, endMinute: 960 };
const calendar: Calendar = {
  shift,
  deadlineCountsArrivalDay: false,
  rushDeadlineMode: 'calendar',
};

/** Readable instants. Minute 0 is Sunday 00:00. */
const SUN = 0,
  MON = 1,
  TUE = 2,
  WED = 3,
  THU = 4,
  FRI = 5,
  SAT = 6;
const at = (day: number, hour: number, minute = 0) => day * MINUTES_PER_DAY + hour * 60 + minute;

describe('reading the clock', () => {
  it('treats minute 0 as Sunday 00:00', () => {
    expect(dayOfWeek(0)).toBe(0);
    expect(minuteOfDay(0)).toBe(0);
    expect(dayLabel(0)).toBe('Sun');
  });

  it('counts days and weeks without wrapping', () => {
    expect(dayIndex(at(THU, 23, 59))).toBe(4);
    expect(dayIndex(at(SUN, 0) + 14 * MINUTES_PER_DAY)).toBe(14);
    expect(weekIndex(at(SAT, 23))).toBe(0);
    expect(weekIndex(at(SUN, 0) + 7 * MINUTES_PER_DAY)).toBe(1);
  });

  it('keeps the day of week correct across many weeks', () => {
    for (let w = 0; w < 10; w++) {
      expect(dayOfWeek(at(WED, 9) + w * 7 * MINUTES_PER_DAY)).toBe(3);
    }
  });

  it('formats a time of day', () => {
    expect(clockLabel(at(MON, 8, 5))).toBe('08:05');
    expect(clockLabel(at(MON, 16))).toBe('16:00');
    expect(clockLabel(at(MON, 0))).toBe('00:00');
  });
});

describe('is the lab open', () => {
  it('is open inside the shift on a working day', () => {
    expect(isWithinShift(shift, at(MON, 8))).toBe(true);
    expect(isWithinShift(shift, at(MON, 12))).toBe(true);
    expect(isWithinShift(shift, at(MON, 15, 59))).toBe(true);
  });

  it('treats the end of the shift as closed, so closing is one instant', () => {
    expect(isWithinShift(shift, at(MON, 16))).toBe(false);
    expect(isWithinShift(shift, at(MON, 7, 59))).toBe(false);
  });

  it('is shut on Friday and Saturday whatever the hour', () => {
    expect(isWorkingDay(shift, at(FRI, 12))).toBe(false);
    expect(isWorkingDay(shift, at(SAT, 12))).toBe(false);
    expect(isWithinShift(shift, at(FRI, 10))).toBe(false);
  });
});

describe('nextOpen', () => {
  it('returns the instant unchanged when already open', () => {
    expect(nextOpen(shift, at(MON, 10))).toBe(at(MON, 10));
  });

  it('waits for this morning when the day has not started', () => {
    expect(nextOpen(shift, at(MON, 3))).toBe(at(MON, 8));
  });

  it('moves to tomorrow after closing', () => {
    expect(nextOpen(shift, at(MON, 16))).toBe(at(TUE, 8));
    expect(nextOpen(shift, at(MON, 22))).toBe(at(TUE, 8));
  });

  it('skips the weekend — Thursday 16:00 opens again Sunday 08:00', () => {
    expect(nextOpen(shift, at(THU, 16))).toBe(at(SUN, 8) + 7 * MINUTES_PER_DAY);
  });

  it('skips the weekend from inside it', () => {
    expect(nextOpen(shift, at(FRI, 12))).toBe(at(SUN, 8) + 7 * MINUTES_PER_DAY);
    expect(nextOpen(shift, at(SAT, 23))).toBe(at(SUN, 8) + 7 * MINUTES_PER_DAY);
  });

  it('is idempotent', () => {
    const once = nextOpen(shift, at(THU, 20));
    expect(nextOpen(shift, once)).toBe(once);
  });
});

describe('workingMinutesBetween', () => {
  it('measures a span inside one day', () => {
    expect(workingMinutesBetween(shift, at(MON, 9), at(MON, 11))).toBe(120);
  });

  it('counts only the open part of a span', () => {
    expect(workingMinutesBetween(shift, at(MON, 6), at(MON, 10))).toBe(120);
    expect(workingMinutesBetween(shift, at(MON, 15), at(MON, 20))).toBe(60);
  });

  it('gives a full day as the shift length', () => {
    expect(workingMinutesBetween(shift, at(MON, 0), at(MON, 24))).toBe(480);
  });

  it('ignores the night between two days', () => {
    expect(workingMinutesBetween(shift, at(MON, 15), at(TUE, 9))).toBe(60 + 60);
  });

  it('ignores the weekend', () => {
    // Thursday 15:00 → Sunday 09:00 is one hour Thursday plus one hour Sunday.
    expect(workingMinutesBetween(shift, at(THU, 15), at(SUN, 9) + 7 * MINUTES_PER_DAY)).toBe(120);
  });

  it('counts a whole week as five shifts', () => {
    expect(workingMinutesBetween(shift, 0, 7 * MINUTES_PER_DAY)).toBe(5 * 480);
  });

  it('is zero for an empty or reversed span', () => {
    expect(workingMinutesBetween(shift, at(MON, 10), at(MON, 10))).toBe(0);
    expect(workingMinutesBetween(shift, at(MON, 12), at(MON, 9))).toBe(0);
  });

  it('is zero across a weekend with no working time in it', () => {
    expect(workingMinutesBetween(shift, at(FRI, 0), at(SAT, 23))).toBe(0);
  });

  it('is zero for a span that falls between two shifts', () => {
    // 17:00 Monday to 07:00 Tuesday touches two working days but no working
    // minutes. Both days' windows lie entirely outside the span, so each
    // contributes a negative overlap that must not be summed.
    expect(workingMinutesBetween(shift, at(MON, 17), at(TUE, 7))).toBe(0);
  });

  it('is never negative for any span in a fortnight', () => {
    for (let from = 0; from < 7 * MINUTES_PER_DAY; from += 137) {
      for (const length of [30, 300, 1000, 5000]) {
        expect(workingMinutesBetween(shift, from, from + length)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('addWorkingMinutes', () => {
  it('stays inside the day when there is room', () => {
    expect(addWorkingMinutes(shift, at(MON, 9), 120)).toBe(at(MON, 11));
  });

  it('starts from the next opening when the lab is shut', () => {
    expect(addWorkingMinutes(shift, at(MON, 3), 60)).toBe(at(MON, 9));
    expect(addWorkingMinutes(shift, at(MON, 20), 60)).toBe(at(TUE, 9));
  });

  it('spills into the next working day', () => {
    // One hour before closing, plus two hours of work, lands an hour into Tuesday.
    expect(addWorkingMinutes(shift, at(MON, 15), 120)).toBe(at(TUE, 9));
  });

  it('spills across the weekend', () => {
    expect(addWorkingMinutes(shift, at(THU, 15), 120)).toBe(at(SUN, 9) + 7 * MINUTES_PER_DAY);
  });

  it('lands exactly at closing without rolling over', () => {
    expect(addWorkingMinutes(shift, at(MON, 15), 60)).toBe(at(MON, 16));
  });

  it('returns the instant unchanged for no work', () => {
    expect(addWorkingMinutes(shift, at(MON, 10), 0)).toBe(at(MON, 10));
  });

  it('is the inverse of workingMinutesBetween', () => {
    for (const start of [at(SUN, 9), at(MON, 15, 30), at(THU, 8), at(FRI, 12)]) {
      for (const n of [1, 60, 479, 480, 481, 1200, 2400]) {
        const end = addWorkingMinutes(shift, start, n);
        expect(workingMinutesBetween(shift, nextOpen(shift, start), end)).toBe(n);
      }
    }
  });
});

describe('addWorkingDays — deadlines', () => {
  it('gives close of business, not a count of worked minutes', () => {
    // Arrive Sunday morning, two working days → close on Tuesday.
    expect(addWorkingDays(calendar, at(SUN, 9), 2)).toBe(at(TUE, 16));
  });

  it('does not penalise a job for arriving late in the day', () => {
    // 09:00 and 15:55 on the same Wednesday get the same deadline.
    expect(addWorkingDays(calendar, at(WED, 9), 2)).toBe(
      addWorkingDays(calendar, at(WED, 15, 55), 2),
    );
  });

  it('skips the weekend', () => {
    // Wednesday + 2 working days → Thursday, then Sunday.
    expect(addWorkingDays(calendar, at(WED, 9), 2)).toBe(at(SUN, 16) + 7 * MINUTES_PER_DAY);
  });

  it('starts the clock at the next opening when the lab is shut', () => {
    // Arriving Thursday night, the clock starts Sunday; one working day → Monday.
    expect(addWorkingDays(calendar, at(THU, 22), 1)).toBe(at(MON, 16) + 7 * MINUTES_PER_DAY);
  });

  it('honours deadlineCountsArrivalDay', () => {
    const inclusive: Calendar = { ...calendar, deadlineCountsArrivalDay: true };
    // Counting the arrival day, "two working days" from Sunday ends Monday.
    expect(addWorkingDays(inclusive, at(SUN, 9), 2)).toBe(at(MON, 16));
    // And one working day means the end of today.
    expect(addWorkingDays(inclusive, at(SUN, 9), 1)).toBe(at(SUN, 16));
  });

  it('handles the spec deadlines of 2, 5 and 7 working days', () => {
    const start = at(SUN, 9);
    expect(addWorkingDays(calendar, start, 2)).toBe(at(TUE, 16));
    expect(addWorkingDays(calendar, start, 5)).toBe(at(SUN, 16) + 7 * MINUTES_PER_DAY);
    expect(addWorkingDays(calendar, start, 7)).toBe(at(TUE, 16) + 7 * MINUTES_PER_DAY);
  });

  it('always lands at a closing time on a working day', () => {
    for (let d = 0; d < 14; d++) {
      for (const n of [1, 2, 5, 7]) {
        const due = addWorkingDays(calendar, at(SUN, 9) + d * MINUTES_PER_DAY, n);
        expect(minuteOfDay(due)).toBe(shift.endMinute);
        expect(shift.days).toContain(dayOfWeek(due));
      }
    }
  });
});

describe('rush deadlines are wall-clock', () => {
  it('counts the night, so 24 hours means tomorrow', () => {
    expect(addCalendarHours(at(MON, 14), 24)).toBe(at(TUE, 14));
  });

  it('can land in closed time — which is the point, and a real finding', () => {
    // A rush arriving Thursday afternoon falls due on Friday, when the lab is shut.
    const due = addCalendarHours(at(THU, 14), 24);
    expect(isWithinShift(shift, due)).toBe(false);
    expect(dayOfWeek(due)).toBe(5);
  });
});

describe('nextCalendarBoundary', () => {
  it('returns todays closing while open', () => {
    expect(nextCalendarBoundary(shift, at(MON, 10))).toBe(at(MON, 16));
  });

  it('returns the next opening while shut', () => {
    expect(nextCalendarBoundary(shift, at(MON, 18))).toBe(at(TUE, 8));
    expect(nextCalendarBoundary(shift, at(FRI, 12))).toBe(at(SUN, 8) + 7 * MINUTES_PER_DAY);
  });

  it('always moves forward, so a slice loop cannot stall', () => {
    let t = at(SUN, 0);
    for (let i = 0; i < 40; i++) {
      const next = nextCalendarBoundary(shift, t);
      expect(next).toBeGreaterThan(t);
      t = next;
    }
  });

  it('alternates opening and closing across a fortnight', () => {
    let t = at(SUN, 0);
    const boundaries: number[] = [];
    for (let i = 0; i < 20; i++) {
      t = nextCalendarBoundary(shift, t);
      boundaries.push(minuteOfDay(t));
    }
    // Ten working days in a fortnight, each contributing an open and a close.
    expect(boundaries.filter((m) => m === shift.startMinute)).toHaveLength(10);
    expect(boundaries.filter((m) => m === shift.endMinute)).toHaveLength(10);
  });
});

describe('shiftEndAfter', () => {
  it('gives today closing while open', () => {
    expect(shiftEndAfter(shift, at(MON, 10))).toBe(at(MON, 16));
  });

  it('gives the next working day closing while shut', () => {
    expect(shiftEndAfter(shift, at(MON, 20))).toBe(at(TUE, 16));
    expect(shiftEndAfter(shift, at(FRI, 10))).toBe(at(SUN, 16) + 7 * MINUTES_PER_DAY);
  });
});

describe('an evening shift — decision C must be expressible', () => {
  const evening: Shift = { days: [0, 1, 2, 3, 4], startMinute: 960, endMinute: 1320 };

  it('opens when the day shift closes', () => {
    expect(isWithinShift(evening, at(MON, 16))).toBe(true);
    expect(isWithinShift(shift, at(MON, 16))).toBe(false);
  });

  it('adds six hours a day of capacity', () => {
    expect(workingMinutesBetween(evening, 0, 7 * MINUTES_PER_DAY)).toBe(5 * 360);
  });

  it('does not overlap the day shift at any minute of a week', () => {
    for (let m = 0; m < 7 * MINUTES_PER_DAY; m += 10) {
      expect(isWithinShift(shift, m) && isWithinShift(evening, m)).toBe(false);
    }
  });
});
