/**
 * Tests for the URL options.
 *
 * Worth testing properly despite being parsing: these three values decide which
 * lab is shown and when it opens, so a silent misparse would make a demo or a
 * verification describe something other than what was asked for. The failure
 * mode is a plausible-looking run, not an error.
 */
import { describe, expect, it } from 'vitest';
import { formatStart, parseRunOptions, parseStart } from './runOptions';

const NOW = 1_700_000_000_000;
const MINUTES_PER_DAY = 1440;

describe('seed', () => {
  it('takes the seed from the URL', () => {
    expect(parseRunOptions('?seed=42', NOW).seed).toBe(42);
  });

  it('falls back to the clock, so an unseeded load still varies', () => {
    expect(parseRunOptions('', NOW).seed).toBe(NOW);
    expect(parseRunOptions('?seed=', NOW).seed).toBe(NOW);
  });

  it('warns rather than silently running a different lab', () => {
    const options = parseRunOptions('?seed=banana', NOW);
    expect(options.seed).toBe(NOW);
    expect(options.warnings).toHaveLength(1);
  });
});

describe('start', () => {
  it('defaults to Sunday 08:00, when the lab opens', () => {
    // Not the wall clock. A demo opened in the evening used to show an empty
    // lab with everyone off shift, and two loads of the same seed began at
    // different moments and so were not comparable.
    expect(parseStart(null)).toBe(8 * 60);
    expect(parseRunOptions('', NOW).startMinutes).toBe(8 * 60);
  });

  it('reads a day and a time', () => {
    expect(parseStart('sun-08:00')).toBe(8 * 60);
    expect(parseStart('mon-08:00')).toBe(MINUTES_PER_DAY + 8 * 60);
    expect(parseStart('thu-15:55')).toBe(4 * MINUTES_PER_DAY + 15 * 60 + 55);
    expect(parseStart('sat-23:59')).toBe(6 * MINUTES_PER_DAY + 23 * 60 + 59);
  });

  it('reads a bare time as Sunday', () => {
    expect(parseStart('09:30')).toBe(9 * 60 + 30);
    expect(parseStart('9:30')).toBe(9 * 60 + 30);
  });

  it('ignores case and surrounding space', () => {
    expect(parseStart('  THU-15:55 ')).toBe(4 * MINUTES_PER_DAY + 15 * 60 + 55);
  });

  it('refuses a bad value rather than guessing', () => {
    // A demo that silently opened on the wrong day would be worse than one
    // that says it could not read what was asked for.
    for (const bad of ['xyz-08:00', 'sun-25:00', 'sun-08:70', 'sunday-08:00', '8', 'sun']) {
      const warnings: string[] = [];
      expect(parseStart(bad, warnings)).toBe(8 * 60);
      expect(warnings).toHaveLength(1);
    }
  });

  it('round-trips through the label it reports', () => {
    for (const text of ['sun-08:00', 'mon-16:30', 'thu-15:55', 'sat-00:00']) {
      expect(formatStart(parseStart(text))).toBe(text);
    }
  });
});

describe('speed', () => {
  it('defaults to the pace the scenario was tuned at', () => {
    expect(parseRunOptions('', NOW).speed).toBe(1);
  });

  it('reads a multiplier', () => {
    expect(parseRunOptions('?speed=60', NOW).speed).toBe(60);
    expect(parseRunOptions('?speed=0.5', NOW).speed).toBe(0.5);
  });

  it('clamps rather than accepting a value that would stall or overwhelm', () => {
    expect(parseRunOptions('?speed=100000', NOW).speed).toBe(1440);
    expect(parseRunOptions('?speed=0.001', NOW).speed).toBe(0.1);
    expect(parseRunOptions('?speed=100000', NOW).warnings).toHaveLength(1);
  });

  it('rejects nonsense', () => {
    for (const bad of ['banana', '-5', '0']) {
      const options = parseRunOptions(`?speed=${bad}`, NOW);
      expect(options.speed).toBe(1);
      expect(options.warnings).toHaveLength(1);
    }
  });
});

describe('all three together', () => {
  it('reads the URL from the verification instructions', () => {
    const options = parseRunOptions('?seed=42&start=sun-08:00&speed=60', NOW);
    expect(options).toEqual({ seed: 42, startMinutes: 480, speed: 60, warnings: [] });
  });

  it('works without the leading question mark', () => {
    expect(parseRunOptions('seed=7&speed=10', NOW).seed).toBe(7);
  });

  it('keeps one bad value from discarding the others', () => {
    const options = parseRunOptions('?seed=42&start=nonsense&speed=60', NOW);
    expect(options.seed).toBe(42);
    expect(options.speed).toBe(60);
    expect(options.startMinutes).toBe(480);
    expect(options.warnings).toHaveLength(1);
  });

  it('ignores parameters it does not know', () => {
    expect(parseRunOptions('?seed=42&utm_source=x', NOW).seed).toBe(42);
  });
});
