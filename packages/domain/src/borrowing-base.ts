/**
 * Borrowing-base and borrowing-ratio math for Sea King Capital.
 *
 * Pure functions, no I/O. Inputs are integer cents and basis points; outputs
 * are integer cents and basis points. The schema's `current_rule_set()`
 * helper resolves the rule snapshot at the SQL boundary; this module
 * consumes the resolved rates.
 *
 * Why bps everywhere instead of percent: the database stores rates as bps
 * (300 = 3.00%). Keeping bps in TS too means we never lose precision in
 * decimal-to-bps conversion mid-pipeline.
 *
 * Spec definitions (01_FUNCTIONAL_SPEC.md §Definitions of Key Metrics):
 *
 *   PO Borrowing Base
 *     A percentage of outstanding purchase order value (non-invoiced).
 *
 *   PO Borrowing Base Available
 *     PO Borrowing Base minus principal outstanding on non-invoiced POs.
 *
 *   AR Borrowing Base
 *     A percentage of outstanding invoice value. Invoices over the
 *     aged-out threshold do not contribute.
 *
 *   AR Borrowing Base Available
 *     AR Borrowing Base minus principal outstanding on invoiced POs.
 *
 *   Borrowing Ratio (per PO)
 *     If un-invoiced: principal advanced / total PO value
 *     If invoiced:    principal advanced / total invoice value
 *
 *     Per spec, ratio is "rounded to the nearest hundredth of a percent"
 *     for display, and "rounded to the nearest percent" for the allocation
 *     ranking buckets. Both rounding rules are exposed here.
 */

import { applyBpsFloor, cents, subClamped, type Cents } from '@seaking/money';

// --------------------------------------------------------------------------
// Borrowing base
// --------------------------------------------------------------------------
//
// IMPORTANT: every borrowing-base helper FLOORS the result. Per spec
// clarification (Derek 2026-04-25): each underlying's contribution to the
// borrowing base is `floor(value × rate / 10000)`, computed PER underlying
// before summing. Aggregate-then-multiply produces fractional cents and
// lets the effective per-PO advance rate creep over the cap.
//
// The single-PO/AR room helpers below already floor implicitly via
// applyBpsFloor; aggregate base totals (poBorrowingBase, arBorrowingBase)
// are intended to be called over per-PO floored sums, NOT over an aggregate
// value. The cleanest call shape is to compute per-PO base via
// applyBpsFloor in the caller, then sum.

/**
 * PO Borrowing Base for a single PO = floor(po_value × po_advance_rate_bps / 10000).
 *
 * For aggregate Client-level totals, call this per PO and sum the results.
 * Do NOT pass an aggregate value to this function — that would compute
 * `floor(sum_value × rate / 10000)` which can exceed the per-PO sum and
 * over-state the borrowing base by fractional pennies × N POs.
 */
export function poBorrowingBase(
  poValueCents: Cents,
  poAdvanceRateBps: number,
): Cents {
  return applyBpsFloor(poValueCents, poAdvanceRateBps);
}

/**
 * AR Borrowing Base for a single invoice = floor(invoice_value × rate / 10000).
 * Same per-underlying convention as poBorrowingBase.
 */
export function arBorrowingBase(
  invoiceValueCents: Cents,
  arAdvanceRateBps: number,
): Cents {
  return applyBpsFloor(invoiceValueCents, arAdvanceRateBps);
}

/**
 * Pre-Advance AR Borrowing Base contribution from a single eligible AR
 * principal slice. Per resolution 4 (CLAUDE.md), aged-out AR principal is
 * excluded from the pool.
 */
export function preAdvanceBorrowingBase(
  eligibleArPrincipalCents: Cents,
  preAdvanceRateBps: number,
): Cents {
  return applyBpsFloor(eligibleArPrincipalCents, preAdvanceRateBps);
}

/** Available = base − outstanding, floored at 0. */
export function borrowingBaseAvailable(base: Cents, outstanding: Cents): Cents {
  return subClamped(base, outstanding);
}

// --------------------------------------------------------------------------
// Borrowing ratio
// --------------------------------------------------------------------------

/**
 * Borrowing ratio in basis points: principal / underlying-value × 10000,
 * with banker's-style rounding to the nearest bp.
 *
 * `denominator` is PO value when un-invoiced or invoice value when invoiced.
 * Returns 0 when denominator = 0 (no value → no ratio).
 *
 * NB: ratio can exceed 10000 bps (>100%) when an advance is over-extended
 * relative to its underlying. We don't clamp — the over-advanced state is
 * a real condition the UI surfaces.
 */
export function borrowingRatioBps(principalCents: Cents, denominatorCents: Cents): number {
  const d = denominatorCents as number;
  if (d === 0) return 0;
  const num = (principalCents as number) * 10000;
  return Math.round(num / d);
}

/** Round bps to the nearest whole percent (100 bps increments). */
export function roundBpsToNearestPercent(bps: number): number {
  return Math.round(bps / 100) * 100;
}

/** Format bps as a percentage with two decimal places (e.g. 7350 → "73.50%"). */
export function formatBpsAsPercent(bps: number): string {
  const pct = bps / 100;
  return `${pct.toFixed(2)}%`;
}

/**
 * "Room" on a single PO = max(0, floor(po_value × rate / 10000) − principal).
 * Used by the advance-allocation algorithm — see po-advance.ts.
 *
 * Floor on the per-PO base: per spec, each PO's contribution to the
 * borrowing base is rounded down to the nearest cent. This guarantees the
 * pro-forma ratio after a leveling allocation never exceeds the rate cap.
 */
export function singlePoRoomCents(
  poValueCents: Cents,
  principalOutstandingCents: Cents,
  poAdvanceRateBps: number,
): Cents {
  const baseForPo = applyBpsFloor(poValueCents, poAdvanceRateBps);
  return subClamped(baseForPo, principalOutstandingCents);
}

/**
 * Same idea for AR — room on an invoice contributing to AR borrowing base.
 */
export function singleArRoomCents(
  invoiceValueCents: Cents,
  principalOutstandingCents: Cents,
  arAdvanceRateBps: number,
): Cents {
  const baseForInvoice = applyBpsFloor(invoiceValueCents, arAdvanceRateBps);
  return subClamped(baseForInvoice, principalOutstandingCents);
}

// Re-export Cents so callers can stay import-light.
export { cents, type Cents };
