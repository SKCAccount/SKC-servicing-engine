/**
 * Ratable allocation with deterministic tie-breaking.
 *
 * Problem: distribute a total (in cents) across N targets in proportion to
 * weights, such that the parts sum to EXACTLY the total. Integer cents forces
 * us to handle the rounding remainder explicitly.
 *
 * Algorithm (per 01_FUNCTIONAL_SPEC.md "Allocation implementation"):
 *   1. Compute each share as floor(total * weight_i / sum_of_weights).
 *   2. Let remainder = total - sum(shares). This is ≥ 0 and ≤ N - 1.
 *   3. Distribute the remainder one cent at a time, largest pre-rounding
 *      fractional part first; ties broken by lowest target ID.
 *
 * Properties:
 *   - Sum of shares = total exactly.
 *   - Each share ≤ ceil(total * weight_i / sum).
 *   - Deterministic given the same inputs and target IDs.
 *   - No target with weight > 0 gets 0 cents if the total allows it (modulo
 *     the sum-of-weights constraint).
 */

import { cents, type Cents } from './cents';

export interface AllocationTarget {
  /** Unique, stable, sortable ID — used for deterministic tie-breaking. */
  id: string;
  /** Weight used for proportional allocation. Must be non-negative integer cents. */
  weight: number;
}

export interface Allocation {
  id: string;
  share: Cents;
}

/**
 * Ratably allocate `total` cents across `targets` proportional to each weight.
 * Returns one Allocation per input target, preserving input order.
 */
export function allocate(total: Cents, targets: readonly AllocationTarget[]): Allocation[] {
  if (targets.length === 0) {
    if ((total as number) !== 0) {
      throw new RangeError(`allocate(): nonzero total ${total} with zero targets`);
    }
    return [];
  }

  for (const t of targets) {
    if (!Number.isInteger(t.weight) || t.weight < 0) {
      throw new RangeError(`allocate(): invalid weight for ${t.id}: ${t.weight}`);
    }
  }

  const totalWeight = targets.reduce((acc, t) => acc + t.weight, 0);
  if (totalWeight === 0) {
    // Fall back: distribute equally. If total doesn't divide evenly, favor lowest ID.
    return distributeEqually(total, targets);
  }

  // Step 1: integer floor shares + fractional parts.
  const shares = targets.map((t) => {
    const numerator = (total as number) * t.weight;
    const baseShare = Math.floor(numerator / totalWeight);
    const remainderNum = numerator - baseShare * totalWeight; // in [0, totalWeight)
    return {
      id: t.id,
      baseShare,
      remainderNum, // used as the fractional "score" for tie-breaking
    };
  });

  const allocatedSoFar = shares.reduce((acc, s) => acc + s.baseShare, 0);
  let remainderCents = (total as number) - allocatedSoFar;

  if (remainderCents < 0) {
    // Should be impossible with Math.floor, but guard.
    throw new Error(`allocate(): negative remainder ${remainderCents}; algorithm bug`);
  }

  if (remainderCents > 0) {
    // Step 2-3: sort by (remainderNum desc, id asc), give +1 to the first
    // `remainderCents` entries.
    const ranked = [...shares].sort((a, b) => {
      if (b.remainderNum !== a.remainderNum) return b.remainderNum - a.remainderNum;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    for (let i = 0; i < remainderCents; i++) {
      const entry = ranked[i]!;
      entry.baseShare += 1;
    }
  }

  // Build result in the original input order.
  const byId = new Map(shares.map((s) => [s.id, s.baseShare] as const));
  return targets.map((t) => ({
    id: t.id,
    share: cents(byId.get(t.id) ?? 0),
  }));
}

function distributeEqually(total: Cents, targets: readonly AllocationTarget[]): Allocation[] {
  const n = targets.length;
  const base = Math.floor((total as number) / n);
  const remainder = (total as number) - base * n;
  const sorted = [...targets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const extraSet = new Set(sorted.slice(0, remainder).map((t) => t.id));
  return targets.map((t) => ({
    id: t.id,
    share: cents(base + (extraSet.has(t.id) ? 1 : 0)),
  }));
}

/**
 * Variant used by the PO-advance UI: allocate additional capital to targets
 * with the lowest Borrowing Ratio first, ratably among ties.
 *
 * `targets[i].weight` is interpreted as the target's current "room" (its
 * un-advanced capacity in cents). Targets with weight 0 are skipped unless
 * all targets have weight 0, in which case allocation falls back to equal
 * distribution.
 */
export function allocateLowestFirst<T extends { id: string; borrowingRatioBps: number; room: number }>(
  total: Cents,
  targets: readonly T[],
): Allocation[] {
  if (targets.length === 0) return [];

  // Group by borrowingRatioBps (rounded to nearest percent per spec: "rounded
  // to the nearest percent"). 100 bps = 1%, so we group at 100bps buckets.
  const buckets = new Map<number, T[]>();
  for (const t of targets) {
    const bucket = Math.round(t.borrowingRatioBps / 100) * 100;
    const existing = buckets.get(bucket) ?? [];
    existing.push(t);
    buckets.set(bucket, existing);
  }

  const sortedBuckets = [...buckets.entries()].sort(([a], [b]) => a - b);

  let remaining = total as number;
  const results = new Map<string, number>(targets.map((t) => [t.id, 0]));

  for (const [, group] of sortedBuckets) {
    if (remaining <= 0) break;

    // Cap allocation to this group at the sum of their rooms.
    const totalRoom = group.reduce((acc, t) => acc + t.room, 0);
    if (totalRoom === 0) continue;

    const groupAllocation = Math.min(remaining, totalRoom);
    const subAllocations = allocate(
      cents(groupAllocation),
      group.map((t) => ({ id: t.id, weight: t.room })),
    );
    for (const a of subAllocations) {
      results.set(a.id, (results.get(a.id) ?? 0) + (a.share as number));
    }
    remaining -= groupAllocation;
  }

  if (remaining > 0) {
    // No room left in any bucket — surface as an error so the caller protects
    // the Manager from over-extending.
    throw new RangeError(
      `allocateLowestFirst(): cannot allocate ${remaining} cents; all targets at capacity`,
    );
  }

  return targets.map((t) => ({ id: t.id, share: cents(results.get(t.id) ?? 0) }));
}
