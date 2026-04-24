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

import { applyBps, cents, subClamped, type Cents } from '@seaking/money';

// --------------------------------------------------------------------------
// Borrowing base
// --------------------------------------------------------------------------

/**
 * PO Borrowing Base = sum(active PO value) × po_advance_rate_bps / 10000.
 * Apply this against the aggregate active PO value for a Client.
 */
export function poBorrowingBase(
  activePoValueCents: Cents,
  poAdvanceRateBps: number,
): Cents {
  return applyBps(activePoValueCents, poAdvanceRateBps);
}

/**
 * AR Borrowing Base = sum(eligible invoice value) × ar_advance_rate_bps / 10000.
 * "Eligible" excludes invoices past the aged-out threshold.
 */
export function arBorrowingBase(
  eligibleArValueCents: Cents,
  arAdvanceRateBps: number,
): Cents {
  return applyBps(eligibleArValueCents, arAdvanceRateBps);
}

/**
 * Pre-Advance AR Borrowing Base = sum(eligible AR principal) × pre_advance_rate_bps / 10000.
 * Per resolution 4 (CLAUDE.md), the pool excludes aged-out AR principal.
 */
export function preAdvanceBorrowingBase(
  eligibleArPrincipalCents: Cents,
  preAdvanceRateBps: number,
): Cents {
  return applyBps(eligibleArPrincipalCents, preAdvanceRateBps);
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
 * "Room" on a single PO = max(0, borrowing-base-on-this-PO − principal-outstanding).
 * Used by the advance-allocation algorithm — see po-advance.ts.
 *
 * The borrowing-base-on-this-PO is the PO's individual contribution:
 *   po_value_cents × po_advance_rate_bps / 10000.
 */
export function singlePoRoomCents(
  poValueCents: Cents,
  principalOutstandingCents: Cents,
  poAdvanceRateBps: number,
): Cents {
  const baseForPo = applyBps(poValueCents, poAdvanceRateBps);
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
  const baseForInvoice = applyBps(invoiceValueCents, arAdvanceRateBps);
  return subClamped(baseForInvoice, principalOutstandingCents);
}

// Re-export Cents so callers can stay import-light.
export { cents, type Cents };
