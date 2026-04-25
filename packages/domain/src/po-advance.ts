/**
 * Advance allocation across selected POs — RATIO LEVELING algorithm.
 *
 * Per spec §Advancing Purchase Orders, the goal is to keep per-PO Borrowing
 * Ratios as low and as EQUAL as possible after the advance, *without*
 * reassigning principal between POs. The spec wording:
 *
 *   "Of the selected POs, those with the lowest Borrowing Ratio shall be
 *    ratably assigned the balance. As more POs become tied with each other
 *    in Borrowing Ratio, they will also start to be assigned the remaining
 *    balance ratably."
 *
 * The implementation that matches that intent is *ratio leveling*:
 *
 *   1. Identify the POs at the lowest current borrowing ratio.
 *   2. Bring that group up to the NEXT-LOWEST ratio in the set (or the
 *      borrowing-rate cap if there is no higher group).
 *   3. The lifted group joins the next-lowest tier, and we repeat.
 *   4. Once the requested allocation is exhausted partway through a lift,
 *      every PO in the current leveling set ends at the same final ratio.
 *
 * Concrete example (70% advance rate):
 *
 *   PO 1: $1,000 value, $500 principal → 50% ratio, room $200
 *   PO 2: $800   value, $400 principal → 50% ratio, room $160
 *   PO 3: $1,200 value,  $0  principal →  0% ratio, room $840
 *   Allocate $800.
 *
 *   Stage 1: PO3 alone at 0%. Cost to lift to 50% = $600. Apply.
 *           PO3 += $600.  Remaining = $200.
 *   Stage 2: All three at 50%. Cost to lift to 70% = $200+$160+$240 = $600.
 *           $200 < $600 → partial lift, ratable by value (5:4:6 ratio).
 *           PO1 += $66.67, PO2 += $53.33, PO3 += $80.
 *
 *   Final ratios: 56.67% / 56.67% / 56.67%, totaling exactly $800.
 *
 * Implementation: we find the target ratio R analytically (not iteratively,
 * which would stall when ratio gaps round to sub-cent costs). Once R is
 * known, we derive per-PO float ideal allocations and convert to integer
 * cents via @seaking/money's deterministic `allocate`. The parts sum to the
 * requested total exactly.
 */

import { allocate, cents, type Cents } from '@seaking/money';
import { borrowingRatioBps, poBorrowingBase, singlePoRoomCents } from './borrowing-base';

export interface SelectedPoForAdvance {
  id: string;
  po_value_cents: Cents;
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
  pro_forma_over_advanced: boolean;
}

export interface PoAdvancePlan {
  total_cents: Cents;
  lines: PoAdvanceLine[];
  any_over_advanced: boolean;
}

/**
 * Build the per-PO allocation table the Manager sees on the review screen.
 *
 * @param totalCents       The new advance amount in integer cents.
 * @param pos              The POs the Manager selected.
 * @param poAdvanceRateBps Current rule_set's PO advance rate in bps.
 *
 * Throws RangeError if the requested total exceeds the aggregate available
 * room across all selected POs.
 */
export function planPoAdvance(
  totalCents: Cents,
  pos: readonly SelectedPoForAdvance[],
  poAdvanceRateBps: number,
): PoAdvancePlan {
  const total = totalCents as number;

  if (pos.length === 0) {
    if (total !== 0) {
      throw new RangeError(`planPoAdvance: nonzero total ${total} with no POs`);
    }
    return { total_cents: cents(0), lines: [], any_over_advanced: false };
  }
  if (total === 0) {
    return buildPlan(pos, totalCents, new Map());
  }

  // Per-PO data + current (continuous, float) ratios.
  type Ent = {
    p: SelectedPoForAdvance;
    v: number;
    /** Continuous ratio in bps. POs whose value is 0 are treated as at-cap. */
    ratio: number;
    room: number;
  };
  const entries: Ent[] = pos.map((p) => {
    const v = p.po_value_cents as number;
    const pp = p.current_principal_cents as number;
    const room = singlePoRoomCents(
      p.po_value_cents,
      p.current_principal_cents,
      poAdvanceRateBps,
    ) as number;
    return {
      p,
      v,
      ratio: v > 0 ? (pp * 10000) / v : poAdvanceRateBps,
      room,
    };
  });

  // POs at or above the rate cap have room === 0 — exclude them. They're
  // already over-extended; the per-PO bad-standing flow handles them.
  const eligible = entries.filter((e) => e.room > 0);

  const totalRoom = eligible.reduce((a, e) => a + e.room, 0);
  if (total > totalRoom) {
    throw new RangeError(
      `planPoAdvance: cannot allocate ${total} cents; total available capacity is ${totalRoom} cents (POs at borrowing-rate cap or already over-advanced).`,
    );
  }

  // ----------------------------------------------------------------------
  // Find the target ratio R analytically.
  //
  // Sort eligible POs by current ratio ascending and group ties into tiers.
  // Walk segments between consecutive tier ratios. At each segment, the
  // leveling set has a fixed sum-of-values; raising it by Δratio costs
  // Δ × ΣV / 10000. Find the segment in which the cumulative cost crosses
  // `total` and solve for R within that segment.
  // ----------------------------------------------------------------------
  // Sort by current ratio ascending; tie-break by id-asc so the order is
  // fully deterministic across runs even if upstream insertion order shifts.
  // (JS sort is stable per ES2019, but relying on insertion order from a
  // Map populated across multiple paths — manual checks, select-all,
  // CSV upload — is brittle.)
  const sorted = [...eligible].sort((a, b) => {
    if (a.ratio !== b.ratio) return a.ratio - b.ratio;
    return a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0;
  });

  const tiers: Array<{ ratio: number; sumV: number }> = [];
  for (const e of sorted) {
    const last = tiers[tiers.length - 1];
    if (last && Math.abs(last.ratio - e.ratio) < 1e-9) {
      last.sumV += e.v;
    } else {
      tiers.push({ ratio: e.ratio, sumV: e.v });
    }
  }

  let remaining = total;
  let prevRatio = tiers[0]!.ratio;
  let setSumV = tiers[0]!.sumV;
  let R = prevRatio;

  // Inter-tier segments.
  for (let i = 1; i < tiers.length; i++) {
    const nextRatio = tiers[i]!.ratio;
    const delta = nextRatio - prevRatio;
    const segmentCost = (delta * setSumV) / 10000;
    if (segmentCost >= remaining) {
      R = prevRatio + (remaining * 10000) / setSumV;
      remaining = 0;
      break;
    }
    remaining -= segmentCost;
    prevRatio = nextRatio;
    setSumV += tiers[i]!.sumV;
    R = prevRatio;
  }

  // Final segment from the last tier ratio to the rate cap. The totalRoom
  // check above guarantees this segment can absorb whatever's left.
  if (remaining > 0) {
    const delta = poAdvanceRateBps - prevRatio;
    if (delta > 0 && setSumV > 0) {
      R = prevRatio + (remaining * 10000) / setSumV;
    } else {
      R = poAdvanceRateBps;
    }
    remaining = 0;
  }

  // ----------------------------------------------------------------------
  // Per-PO float ideal: max(0, R - ratio) × v / 10000.
  // Convert to integer cents via deterministic ratable allocation.
  // ----------------------------------------------------------------------
  const ideals = new Map<string, number>();
  for (const e of eligible) {
    ideals.set(e.p.id, Math.max(0, ((R - e.ratio) * e.v) / 10000));
  }
  const targetSet = eligible.filter((e) => (ideals.get(e.p.id) ?? 0) > 0);

  const allocationById = new Map<string, number>();

  if (targetSet.length === 0) {
    // R sat at the lowest tier (no lift needed). Defensive fallback —
    // shouldn't happen when total > 0 and we passed the room check.
    for (const e of eligible) allocationById.set(e.p.id, 0);
  } else {
    // Scale ideals to large integer weights so the deterministic rounder
    // can distribute `total` proportional to the float ideals. Sub-cent
    // precision via 1e6 multiplier; max(1, ...) avoids weight=0 for any
    // PO that should get *some* share.
    const totalIdeal = targetSet.reduce((a, e) => a + (ideals.get(e.p.id) ?? 0), 0);
    const SCALE = 1e6;
    const allocations = allocate(
      cents(total),
      targetSet.map((e) => ({
        id: e.p.id,
        weight: Math.max(1, Math.round(((ideals.get(e.p.id) ?? 0) / totalIdeal) * SCALE)),
      })),
    );
    for (const a of allocations) {
      allocationById.set(a.id, a.share as number);
    }
  }

  // Per-PO room cap — final safety pass.
  //
  // The leveling target ratio R is bounded by poAdvanceRateBps, so the
  // float ideal for each PO is ≤ (rate × value / 10000) − principal. But
  // ideal can equal floor(rate × value / 10000) − principal + fractional,
  // and when the deterministic allocator distributes the +1-cent rounding
  // remainder, a PO can land 1 cent above its floored room. That single
  // cent pushes pro_forma_ratio over the rate cap.
  //
  // Clamp each PO at its room and redistribute any excess greedily to POs
  // that still have remaining capacity. This is always feasible because
  // total ≤ totalRoom = Σ(floored room) was checked at line 126.
  const roomById = new Map<string, number>();
  for (const e of eligible) roomById.set(e.p.id, e.room);
  let excess = 0;
  for (const e of eligible) {
    const assigned = allocationById.get(e.p.id) ?? 0;
    if (assigned > e.room) {
      excess += assigned - e.room;
      allocationById.set(e.p.id, e.room);
    }
  }
  if (excess > 0) {
    // Redistribute excess to POs with remaining capacity. Largest-capacity-
    // first with id-asc as the deterministic tiebreak (mirrors `allocate`'s
    // remainder-distribution rule).
    const candidates = eligible
      .map((e) => ({
        id: e.p.id,
        remaining: e.room - (allocationById.get(e.p.id) ?? 0),
      }))
      .filter((c) => c.remaining > 0)
      .sort((a, b) => {
        if (b.remaining !== a.remaining) return b.remaining - a.remaining;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    let i = 0;
    while (excess > 0 && i < candidates.length) {
      const c = candidates[i]!;
      const give = Math.min(excess, c.remaining);
      allocationById.set(c.id, (allocationById.get(c.id) ?? 0) + give);
      excess -= give;
      i++;
    }
    // If excess > 0 still, total exceeded sum of room — earlier check
    // should have caught it. Hard error to surface the bug.
    if (excess > 0) {
      throw new Error(
        `planPoAdvance: ${excess} cents could not be distributed within per-PO room caps; algorithm bug`,
      );
    }
  }

  return buildPlan(pos, totalCents, allocationById);
}

/** Assemble the PoAdvancePlan output from per-PO allocations. */
function buildPlan(
  pos: readonly SelectedPoForAdvance[],
  totalCents: Cents,
  allocationById: Map<string, number>,
): PoAdvancePlan {
  let anyOver = false;
  const lines = pos.map<PoAdvanceLine>((p) => {
    const newlyAssigned = allocationById.get(p.id) ?? 0;
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
  return { total_cents: totalCents, lines, any_over_advanced: anyOver };
}

// --------------------------------------------------------------------------
// summarizeSelectedPos — unchanged
// --------------------------------------------------------------------------

export interface SelectedPosSummary {
  total_po_value_cents: Cents;
  total_current_principal_cents: Cents;
  total_borrowing_base_cents: Cents;
  total_borrowing_base_available_cents: Cents;
  aggregate_ratio_bps: number;
}

export function summarizeSelectedPos(
  pos: readonly SelectedPoForAdvance[],
  poAdvanceRateBps: number,
): SelectedPosSummary {
  let totalValue = 0;
  let totalPrincipal = 0;
  let totalBase = 0;
  let totalRoom = 0;
  for (const p of pos) {
    totalValue += p.po_value_cents as number;
    totalPrincipal += p.current_principal_cents as number;
    // Per Derek's clarification: each PO's contribution to the borrowing
    // base is floor(po_value × rate / 10000). Sum the per-PO bases rather
    // than (sum_value × rate / 10000) — aggregate-then-multiply creates
    // fractional pennies and lets pro-forma ratio creep above the cap.
    const baseForPo = poBorrowingBase(p.po_value_cents, poAdvanceRateBps) as number;
    totalBase += baseForPo;
    totalRoom += Math.max(0, baseForPo - (p.current_principal_cents as number));
  }
  return {
    total_po_value_cents: cents(totalValue),
    total_current_principal_cents: cents(totalPrincipal),
    total_borrowing_base_cents: cents(totalBase),
    total_borrowing_base_available_cents: cents(totalRoom),
    aggregate_ratio_bps: borrowingRatioBps(cents(totalPrincipal), cents(totalValue)),
  };
}
