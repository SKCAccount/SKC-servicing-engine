/**
 * Calendar dates (no time, no timezone) anchored to America/New_York.
 *
 * Every business-meaningful date in Sea King — Advance Date, Posting Date,
 * Wire Date, Invoice Date, aged-out thresholds — is a calendar date.
 * Storing these as `date` (not `timestamptz`) and doing all arithmetic in
 * this module means fee-period math is deterministic regardless of where
 * the server or client runs.
 *
 * We use Temporal.PlainDate as the canonical representation. Serialized as
 * ISO "YYYY-MM-DD" for transport and storage.
 */

import { Temporal } from '@js-temporal/polyfill';

export const SEA_KING_TIMEZONE = 'America/New_York';

/**
 * A calendar date in Sea King semantics. Thin wrapper around Temporal.PlainDate
 * to make intent obvious and prevent accidental mixing with Date/timestamptz.
 */
export type CalendarDate = Temporal.PlainDate;

/** Parse an ISO date string ("2026-04-23") into a CalendarDate. */
export function parseIsoDate(iso: string): CalendarDate {
  return Temporal.PlainDate.from(iso);
}

/** Serialize a CalendarDate to ISO "YYYY-MM-DD". */
export function toIsoDate(d: CalendarDate): string {
  return d.toString();
}

/** Today's date in America/New_York. */
export function todayInNY(): CalendarDate {
  return Temporal.Now.plainDateISO(SEA_KING_TIMEZONE);
}

/** Construct a CalendarDate from year, month (1-12), day (1-31). */
export function makeDate(year: number, month: number, day: number): CalendarDate {
  return Temporal.PlainDate.from({ year, month, day });
}

/** Add `days` to `d` (negative OK). */
export function addDays(d: CalendarDate, days: number): CalendarDate {
  return d.add({ days });
}

/** Add `months` to `d` (calendar-aware, clamps to end-of-month). */
export function addMonths(d: CalendarDate, months: number): CalendarDate {
  return d.add({ months });
}

/** Integer number of calendar days from `from` to `to` (negative if to < from). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return to.since(from, { largestUnit: 'days' }).days;
}

/** Compare: -1 if a < b, 0 if equal, +1 if a > b. */
export function compareDates(a: CalendarDate, b: CalendarDate): -1 | 0 | 1 {
  const cmp = Temporal.PlainDate.compare(a, b);
  return cmp < 0 ? -1 : cmp > 0 ? 1 : 0;
}

export function isBefore(a: CalendarDate, b: CalendarDate): boolean {
  return compareDates(a, b) === -1;
}

export function isAfter(a: CalendarDate, b: CalendarDate): boolean {
  return compareDates(a, b) === 1;
}

export function isSame(a: CalendarDate, b: CalendarDate): boolean {
  return compareDates(a, b) === 0;
}

/** Pick the earlier of two dates. */
export function minDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return isBefore(a, b) ? a : b;
}

/** Pick the later of two dates. */
export function maxDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return isAfter(a, b) ? a : b;
}
