import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  isAfter,
  isBefore,
  isSame,
  makeDate,
  maxDate,
  minDate,
  parseIsoDate,
  toIsoDate,
} from './calendar';

describe('parseIsoDate / toIsoDate', () => {
  it('roundtrips ISO strings', () => {
    const d = parseIsoDate('2026-04-23');
    expect(toIsoDate(d)).toBe('2026-04-23');
  });
  it('rejects invalid formats', () => {
    expect(() => parseIsoDate('4/23/2026')).toThrow();
  });
});

describe('makeDate', () => {
  it('constructs from Y/M/D', () => {
    const d = makeDate(2026, 4, 23);
    expect(toIsoDate(d)).toBe('2026-04-23');
  });
});

describe('addDays', () => {
  it('adds positive', () => {
    const d = makeDate(2026, 1, 30);
    expect(toIsoDate(addDays(d, 5))).toBe('2026-02-04');
  });
  it('adds negative', () => {
    const d = makeDate(2026, 2, 1);
    expect(toIsoDate(addDays(d, -1))).toBe('2026-01-31');
  });
  it('crosses leap day in 2024', () => {
    const d = makeDate(2024, 2, 28);
    expect(toIsoDate(addDays(d, 1))).toBe('2024-02-29');
    expect(toIsoDate(addDays(d, 2))).toBe('2024-03-01');
  });
});

describe('addMonths', () => {
  it('clamps to end of target month', () => {
    const d = makeDate(2026, 1, 31);
    // Adding 1 month to Jan 31 → Feb 28 (2026 is non-leap)
    expect(toIsoDate(addMonths(d, 1))).toBe('2026-02-28');
  });
});

describe('daysBetween', () => {
  it('is zero for same date', () => {
    expect(daysBetween(makeDate(2026, 4, 23), makeDate(2026, 4, 23))).toBe(0);
  });
  it('counts forward', () => {
    expect(daysBetween(makeDate(2026, 4, 23), makeDate(2026, 4, 30))).toBe(7);
  });
  it('counts backward as negative', () => {
    expect(daysBetween(makeDate(2026, 4, 30), makeDate(2026, 4, 23))).toBe(-7);
  });
});

describe('comparison helpers', () => {
  const early = makeDate(2026, 1, 1);
  const late = makeDate(2026, 12, 31);

  it('compares', () => {
    expect(compareDates(early, late)).toBe(-1);
    expect(compareDates(late, early)).toBe(1);
    expect(compareDates(early, early)).toBe(0);
  });
  it('isBefore / isAfter / isSame', () => {
    expect(isBefore(early, late)).toBe(true);
    expect(isAfter(late, early)).toBe(true);
    expect(isSame(early, early)).toBe(true);
    expect(isBefore(early, early)).toBe(false);
  });
  it('min/max', () => {
    expect(toIsoDate(minDate(early, late))).toBe('2026-01-01');
    expect(toIsoDate(maxDate(early, late))).toBe('2026-12-31');
  });
});
