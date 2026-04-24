/**
 * Date parsing utilities for retailer source files.
 *
 * Per 03_PARSERS.md each parser carries an explicit per-file format contract
 * and rejects ambiguous inputs rather than guessing. This module provides
 * the three formats observed across Phase 1 retailers:
 *   - MM/DD/YYYY (Walmart PO)
 *   - MM-DD-YYYY (Walmart invoice, Walmart payment, Kroger payment)
 *   - Excel serial date (Kroger invoices — handled by pandas/xlsx libs, not here)
 *
 * All functions return ISO 'YYYY-MM-DD' strings or null. Blank inputs
 * become null. Unparseable inputs return null AND should be surfaced as
 * a warning by the caller.
 */

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Accepts "MM/DD/YYYY" or blank. Returns ISO or null. */
export function parseUsSlashDate(input: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const mm = Number(match[1]);
  const dd = Number(match[2]);
  const yyyy = Number(match[3]);
  if (!isValidYmd(yyyy, mm, dd)) return null;
  return `${yyyy}-${pad(mm)}-${pad(dd)}`;
}

/** Accepts "MM-DD-YYYY" or blank. Returns ISO or null. */
export function parseUsDashDate(input: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const match = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!match) return null;
  const mm = Number(match[1]);
  const dd = Number(match[2]);
  const yyyy = Number(match[3]);
  if (!isValidYmd(yyyy, mm, dd)) return null;
  return `${yyyy}-${pad(mm)}-${pad(dd)}`;
}

/** Calendar validity check (including leap years). */
function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Quick month-length check.
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const feb = m === 2 ? (isLeap(y) ? 29 : 28) : (daysInMonth[m - 1] ?? 0);
  const limit = m === 2 ? feb : (daysInMonth[m - 1] ?? 0);
  return d <= limit;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
