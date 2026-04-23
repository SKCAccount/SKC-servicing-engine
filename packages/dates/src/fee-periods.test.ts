import { describe, expect, it } from 'vitest';
import { makeDate, toIsoDate } from './calendar';
import { periodN, periodNumberAsOf, periodsThroughDate, type FeeRules } from './fee-periods';

const STANDARD_RULES: FeeRules = {
  period1Days: 30,
  period2Days: 15,
  subsequentPeriodDays: 15,
  period1FeeRateBps: 300, // 3%
  period2FeeRateBps: 150, // 1.5%
  subsequentPeriodFeeRateBps: 150,
};

describe('periodN()', () => {
  const advanceDate = makeDate(2026, 4, 1);

  it('period 1 starts on Advance Date, lasts 30 days', () => {
    const p = periodN(advanceDate, 1, STANDARD_RULES);
    expect(toIsoDate(p.startDate)).toBe('2026-04-01');
    expect(toIsoDate(p.endDate)).toBe('2026-04-30');
    expect(p.feeRateBps).toBe(300);
    expect(toIsoDate(p.feeAccrualDate)).toBe('2026-04-01');
  });

  it('period 2 starts the day after period 1 ends', () => {
    const p = periodN(advanceDate, 2, STANDARD_RULES);
    expect(toIsoDate(p.startDate)).toBe('2026-05-01');
    expect(toIsoDate(p.endDate)).toBe('2026-05-15');
    expect(p.feeRateBps).toBe(150);
  });

  it('period 3 uses the subsequent-period length/rate', () => {
    const p = periodN(advanceDate, 3, STANDARD_RULES);
    expect(toIsoDate(p.startDate)).toBe('2026-05-16');
    expect(toIsoDate(p.endDate)).toBe('2026-05-30');
    expect(p.feeRateBps).toBe(150);
  });

  it('rejects invalid N', () => {
    expect(() => periodN(advanceDate, 0, STANDARD_RULES)).toThrow();
    expect(() => periodN(advanceDate, -1, STANDARD_RULES)).toThrow();
  });
});

describe('periodNumberAsOf()', () => {
  const advanceDate = makeDate(2026, 4, 1);

  it('day 0 → period 1', () => {
    expect(periodNumberAsOf(advanceDate, makeDate(2026, 4, 1), STANDARD_RULES)).toBe(1);
  });
  it('day 29 (last day of period 1) → period 1', () => {
    expect(periodNumberAsOf(advanceDate, makeDate(2026, 4, 30), STANDARD_RULES)).toBe(1);
  });
  it('day 30 (first day of period 2) → period 2', () => {
    expect(periodNumberAsOf(advanceDate, makeDate(2026, 5, 1), STANDARD_RULES)).toBe(2);
  });
  it('day 44 (last day of period 2) → period 2', () => {
    expect(periodNumberAsOf(advanceDate, makeDate(2026, 5, 15), STANDARD_RULES)).toBe(2);
  });
  it('day 45 (first day of period 3) → period 3', () => {
    expect(periodNumberAsOf(advanceDate, makeDate(2026, 5, 16), STANDARD_RULES)).toBe(3);
  });
  it('day 59 (last day of period 3) → period 3', () => {
    expect(periodNumberAsOf(advanceDate, makeDate(2026, 5, 30), STANDARD_RULES)).toBe(3);
  });
  it('day 60 → period 4', () => {
    expect(periodNumberAsOf(advanceDate, makeDate(2026, 5, 31), STANDARD_RULES)).toBe(4);
  });

  it('throws on asOf before advanceDate', () => {
    expect(() => periodNumberAsOf(advanceDate, makeDate(2026, 3, 31), STANDARD_RULES)).toThrow();
  });
});

describe('periodsThroughDate()', () => {
  const advanceDate = makeDate(2026, 4, 1);

  it('returns empty when asOf is before advance', () => {
    expect(periodsThroughDate(advanceDate, makeDate(2026, 3, 1), STANDARD_RULES)).toEqual([]);
  });

  it('returns only period 1 when still in period 1', () => {
    const result = periodsThroughDate(advanceDate, makeDate(2026, 4, 15), STANDARD_RULES);
    expect(result).toHaveLength(1);
    expect(result[0]!.periodNumber).toBe(1);
  });

  it('returns all periods through the given date', () => {
    const result = periodsThroughDate(advanceDate, makeDate(2026, 5, 20), STANDARD_RULES);
    expect(result).toHaveLength(3);
    expect(result.map((p) => p.periodNumber)).toEqual([1, 2, 3]);
    expect(result.map((p) => p.feeRateBps)).toEqual([300, 150, 150]);
  });
});
