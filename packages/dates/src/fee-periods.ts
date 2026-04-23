/**
 * Fee-period math.
 *
 * Per 01_FUNCTIONAL_SPEC.md ("Fee mechanics"):
 *  - Period 1 lasts `period_1_days` starting on the Advance Date (inclusive).
 *  - Period 2 lasts `period_2_days`.
 *  - Every subsequent period lasts `subsequent_period_days`.
 *  - At the moment a new period begins (midnight America/New_York on the
 *    boundary day), the full period fee is recognized immediately.
 *
 * "Including the day of the advance" means: period 1 covers Advance Date
 * through Advance Date + (period_1_days - 1). Period 2 starts on
 * Advance Date + period_1_days.
 *
 * Example (3% day-1, 1.5% every 15 days, first period 30 days):
 *   Advance Date:     2026-04-01 → Period 1 fee charged at 2026-04-01
 *   Period 2 starts:  2026-05-01 → Period 2 fee charged at 2026-05-01
 *   Period 3 starts:  2026-05-16 → Period 3 fee charged at 2026-05-16
 *   ...
 */

import { addDays, daysBetween, isAfter, type CalendarDate } from './calendar';

export interface FeeRules {
  /** Days in period 1, including the Advance Date itself. */
  period1Days: number;
  /** Days in period 2. */
  period2Days: number;
  /** Days in every subsequent period. */
  subsequentPeriodDays: number;
  /** Fee rate for period 1 in basis points (300 = 3%). */
  period1FeeRateBps: number;
  /** Fee rate for period 2 in basis points. */
  period2FeeRateBps: number;
  /** Fee rate for every subsequent period in basis points. */
  subsequentPeriodFeeRateBps: number;
}

export interface FeePeriod {
  /** 1-indexed period number. */
  periodNumber: number;
  /** First day of this period (inclusive). */
  startDate: CalendarDate;
  /** Last day of this period (inclusive). */
  endDate: CalendarDate;
  /** Fee rate applied at the start of this period, in basis points. */
  feeRateBps: number;
  /** The date on which the fee for this period is recognized (= startDate). */
  feeAccrualDate: CalendarDate;
}

/** Number of days in period N (1-indexed). */
function periodLength(n: number, rules: FeeRules): number {
  if (n === 1) return rules.period1Days;
  if (n === 2) return rules.period2Days;
  return rules.subsequentPeriodDays;
}

/** Fee rate in bps for period N. */
function periodRate(n: number, rules: FeeRules): number {
  if (n === 1) return rules.period1FeeRateBps;
  if (n === 2) return rules.period2FeeRateBps;
  return rules.subsequentPeriodFeeRateBps;
}

/**
 * Compute the Nth period for an advance (1-indexed).
 * Period 1 starts on advanceDate.
 */
export function periodN(advanceDate: CalendarDate, n: number, rules: FeeRules): FeePeriod {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`periodN(): n must be a positive integer; got ${n}`);
  }

  let daysFromAdvance = 0;
  for (let i = 1; i < n; i++) {
    daysFromAdvance += periodLength(i, rules);
  }
  const start = addDays(advanceDate, daysFromAdvance);
  const length = periodLength(n, rules);
  const end = addDays(start, length - 1);

  return {
    periodNumber: n,
    startDate: start,
    endDate: end,
    feeRateBps: periodRate(n, rules),
    feeAccrualDate: start,
  };
}

/**
 * Which period number is `asOf` in, for an advance made on `advanceDate`?
 * Returns 1 for the first period, 2 for the second, etc.
 *
 * Throws if `asOf` is before `advanceDate`.
 */
export function periodNumberAsOf(
  advanceDate: CalendarDate,
  asOf: CalendarDate,
  rules: FeeRules,
): number {
  const delta = daysBetween(advanceDate, asOf);
  if (delta < 0) {
    throw new RangeError(
      `periodNumberAsOf(): asOf (${asOf}) is before advanceDate (${advanceDate})`,
    );
  }

  // Period 1 spans days [0, period1Days - 1]
  if (delta < rules.period1Days) return 1;
  let cumulative = rules.period1Days;

  // Period 2 spans days [period1Days, period1Days + period2Days - 1]
  if (delta < cumulative + rules.period2Days) return 2;
  cumulative += rules.period2Days;

  // Subsequent periods
  const extra = delta - cumulative;
  return 3 + Math.floor(extra / rules.subsequentPeriodDays);
}

/**
 * Enumerate every fee period that has started on or before `asOf`, starting
 * with period 1. Used by the daily fee-accrual job to emit fee_accrued events
 * for boundary crossings.
 */
export function periodsThroughDate(
  advanceDate: CalendarDate,
  asOf: CalendarDate,
  rules: FeeRules,
): FeePeriod[] {
  if (isAfter(advanceDate, asOf)) return [];
  const maxPeriod = periodNumberAsOf(advanceDate, asOf, rules);
  const periods: FeePeriod[] = [];
  for (let i = 1; i <= maxPeriod; i++) {
    periods.push(periodN(advanceDate, i, rules));
  }
  return periods;
}
