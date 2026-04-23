/**
 * UI helpers for displaying cents. Thin wrapper around @seaking/money —
 * exists so UI code can import "display cents as dollars" without pulling in
 * the arithmetic utilities it doesn't need.
 */

import { formatDollars, type Cents, type SignedCents, fromBigInt, fromBigIntSigned } from '@seaking/money';

/** Format a Cents value as "$1,234.56". */
export function displayCents(c: Cents | SignedCents | number): string {
  if (typeof c === 'number') {
    return formatDollars(c as Cents);
  }
  return formatDollars(c);
}

/**
 * Convert a bigint (as returned by Supabase for `bigint` columns) to a display
 * string. Handles signed/unsigned based on whether the value is negative.
 */
export function displayBigIntCents(b: bigint): string {
  if (b < 0n) return formatDollars(fromBigIntSigned(b));
  return formatDollars(fromBigInt(b));
}
