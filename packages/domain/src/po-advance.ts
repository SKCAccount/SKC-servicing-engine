/**
 * Advance allocation across selected POs.
 *
 * Wraps `allocateLowestFirst` from @seaking/money with the PO-domain types
 * the UI and server actions actually carry. The rule (per spec §Advancing
 * Purchase Orders) is:
 *
 *   - Of the selected POs, those with the lowest Borrowing Ratio (rounded
 *     to the nearest percent) are ratably assigned the new advance amount.
 *   - As more POs become tied at the rounded ratio, they too participate
 *     in the ratable allocation.
 *   - The goal is keeping per-PO Borrowing Ratios as low as possible
 *     without reassigning principal between POs.
 *
 * Output share for each PO is in integer cents and the parts sum to the
 * exact `total_cents` requested.
 */

import {
  allocateLowestFirst,
  cents,
  type Allocation,
  type Cents,
} from '@seaking/money';
import {
  borrowingRatioBps,
  roundBpsToNearestPercent,
  singlePoRoomCents,
} from './borrowing-base';

export interface SelectedPoForAdvance {
  /** PO id (becomes the allocation target id). */
  id: string;
  /** Total dollar value of the PO (canonical, in cents). */
  po_value_cents: Cents;
  /** Principal already advanced on this PO (sum across all advance series), in cents. */
  current_principal_cents: Cents;
}

export interface PoAdvanceLine {
  po_id: string;
  current_principal_cents: Cents;
  po_value_cents: Cents;
  current_ratio_bps: number;
  newly_assigned_cents: Cents;
  pro_forma_principal_cents: Cents;
  pro_forma_ratio_bps: number;
  /** True if this allocation pushes the PO above 100% (Manager alert per spec). */
  pro_forma_over_advanced: boolean;
}

export interface PoAdvancePlan {
  /** Total amount being advanced (= sum of all lines' newly_assigned_cents). */
  total_cents: Cents;
  /** Per-PO breakdown, in input order. */
  lines: PoAdvanceLine[];
  /** True if any line goes over 100% (UI surfaces a warning). */
  any_over_advanced: boolean;
}

/**
 * Build the per-PO allocation table the Manager sees on the review screen.
 *
 * @param totalCents      The new advance amount in integer cents.
 * @param pos             The POs the Manager selected.
 * @param poAdvanceRateBps Current rule_set's PO advance rate in bps (e.g. 7000 = 70%).
 *
 * Throws RangeError if the requested total exceeds the aggregate available
 * room across all selected POs (caller should validate up front, but this
 * is the safety net).
 */
export function planPoAdvance(
  totalCents: Cents,
  pos: readonly SelectedPoForAdvance[],
  poAdvanceRateBps: number,
): PoAdvancePlan {
  // Build the input that allocateLowestFirst expects. Each PO carries its
  // borrowing ratio (used for ranking) and its remaining room (the cap on
  // how much it can absorb).
  const targets = pos.map((p) => ({
    id: p.id,
    borrowingRatioBps: roundBpsToNearestPercent(
      borrowingRatioBps(p.current_principal_cents, p.po_value_cents),
    ),
    room: singlePoRoomCents(
      p.po_value_cents,
      p.current_principal_cents,
      poAdvanceRateBps,
    ) as number,
  }));

  // allocateLowestFirst handles the ratable + cascade logic.
  const allocations: Allocation[] = allocateLowestFirst(totalCents, targets);
  const byId = new Map(allocations.map((a) => [a.id, a.share as number]));

  let anyOver = false;
  const lines = pos.map<PoAdvanceLine>((p) => {
    const newlyAssigned = byId.get(p.id) ?? 0;
    const proFormaPrincipal = (p.current_principal_cents as number) + newlyAssigned;
    const currentRatioBps = borrowingRatioBps(p.current_principal_cents, p.po_value_cents);
    const proFormaRatioBps = borrowingRatioBps(cents(proFormaPrincipal), p.po_value_cents);
    const overAdvanced = proFormaRatioBps > 10000;
    if (overAdvanced) anyOver = true;
    return {
      po_id: p.id,
      current_principal_cents: p.current_principal_cents,
      po_value_cents: p.po_value_cents,
      current_ratio_bps: currentRatioBps,
      newly_assigned_cents: cents(newlyAssigned),
      pro_forma_principal_cents: cents(proFormaPrincipal),
      pro_forma_ratio_bps: proFormaRatioBps,
      pro_forma_over_advanced: overAdvanced,
    };
  });

  return {
    total_cents: totalCents,
    lines,
    any_over_advanced: anyOver,
  };
}

/**
 * Aggregate metrics across a set of POs, for the "summary at top of review
 * screen" the spec calls for. Returns un-allocated values (just sums).
 */
export interface SelectedPosSummary {
  total_po_value_cents: Cents;
  total_current_principal_cents: Cents;
  total_borrowing_base_cents: Cents;
  total_borrowing_base_available_cents: Cents;
  /** Aggregate ratio: sum(principal) / sum(value), in bps. */
  aggregate_ratio_bps: number;
}

export function summarizeSelectedPos(
  pos: readonly SelectedPoForAdvance[],
  poAdvanceRateBps: number,
): SelectedPosSummary {
  let totalValue = 0;
  let totalPrincipal = 0;
  let totalRoom = 0;
  for (const p of pos) {
    totalValue += p.po_value_cents as number;
    totalPrincipal += p.current_principal_cents as number;
    totalRoom += singlePoRoomCents(
      p.po_value_cents,
      p.current_principal_cents,
      poAdvanceRateBps,
    ) as number;
  }
  const totalBase = Math.round((totalValue * poAdvanceRateBps) / 10000);
  return {
    total_po_value_cents: cents(totalValue),
    total_current_principal_cents: cents(totalPrincipal),
    total_borrowing_base_cents: cents(totalBase),
    total_borrowing_base_available_cents: cents(totalRoom),
    aggregate_ratio_bps: borrowingRatioBps(cents(totalPrincipal), cents(totalValue)),
  };
}
