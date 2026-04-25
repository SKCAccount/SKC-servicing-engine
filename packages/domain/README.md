# @seaking/domain

Pure financial-logic functions for Sea King. No I/O, no React, no Supabase — bytes/numbers in, bytes/numbers out. Tests need no mocks.

## What's in here

| Module | Purpose |
|---|---|
| `borrowing-base.ts` | PO/AR/Pre-Advance borrowing-base math, borrowing-ratio calculation, per-PO room calculation |
| `po-advance.ts` | Allocation across selected POs using **ratio leveling** + per-line pro-forma metrics for the review screen |

`po-advance.ts` uses the deterministic `allocate` primitive from `@seaking/money` for the integer-cents rounding step at the end. The leveling math itself is local to this package.

## Public API

```ts
import {
  poBorrowingBase, arBorrowingBase, preAdvanceBorrowingBase,
  borrowingBaseAvailable, borrowingRatioBps,
  roundBpsToNearestPercent, formatBpsAsPercent,
  singlePoRoomCents, singleArRoomCents,
  planPoAdvance, summarizeSelectedPos,
} from '@seaking/domain';
```

## Per-underlying floor borrowing base

Every borrowing-base helper (`poBorrowingBase`, `arBorrowingBase`, `preAdvanceBorrowingBase`, `singlePoRoomCents`, `singleArRoomCents`) returns `floor(value × rate / 10000)` for a SINGLE underlying via `applyBpsFloor` from `@seaking/money`. For Client-level totals, call the per-underlying helper inside a loop and sum the results — `summarizeSelectedPos` is the canonical example.

Why per-underlying floor instead of aggregate × rate:

- The spec says each PO's contribution is rounded down to the nearest cent.
- Aggregate-then-multiply produces fractional cents that lets the effective per-PO advance rate creep over the cap by fractional pennies × N POs.
- After leveling and integer rounding, individual POs could land at pro-forma ratio `> rate_cap` (e.g. 70.005% on a 70% cap).

Floor per underlying is the conservative answer; the per-row totals never exceed the spec's percentage. Same convention applied at the SQL projection layer in `mv_client_position` (migration 0021).

`planPoAdvance` adds a final post-clamp pass after the deterministic allocator returns its shares — any PO landed 1 cent above its floored room (rare but possible when ideal sits exactly at room boundary) gets clamped, with the excess greedily redistributed to POs with remaining capacity. Test coverage in `po-advance.test.ts` "Derek 2026-04-25 regression."

## The PO advance allocation rule — ratio leveling

Per `01_FUNCTIONAL_SPEC.md §Advancing Purchase Orders`, after committing the advance the per-PO Borrowing Ratios should remain as low and as **equal** as possible, without reassigning principal between POs. That intent is implemented as ratio leveling:

1. Lift the POs at the lowest current borrowing ratio to match the next-lowest tier in the selection.
2. The merged group continues lifting toward the next-lowest tier above it (or the borrowing-rate cap).
3. When the requested allocation runs out partway through a lift, distribute the remainder ratably by PO value across the current set so every participating PO ends at the same final ratio.

Concrete example (70% advance rate):

```
PO 1: $1,000 value, $500 principal → 50% ratio, room $200
PO 2: $800   value, $400 principal → 50% ratio, room $160
PO 3: $1,200 value,   $0 principal →  0% ratio, room $840
Allocate $800.

Stage 1: PO3 alone at 0%. Cost to lift to 50% = $600. Apply.
         PO3 += $600,  remaining = $200.
Stage 2: All three at 50%. Cost to lift to 70% = $200+$160+$240 = $600.
         $200 < $600 → partial lift, ratable by value (5:4:6).
         PO1 += $66.67, PO2 += $53.33, PO3 += $80.

Final ratios: 56.67% / 56.67% / 56.67%, totaling exactly $800.
```

Implementation note: the target ratio R is computed **analytically** (sort selection by ratio, walk inter-tier segments, find the segment where cumulative cost crosses `total`, solve for R). An iterative version would stall when ratio gaps round to sub-cent costs. Once R is known, per-PO float ideal allocations get one deterministic pass through `allocate` from `@seaking/money` so the integer parts sum to `total` exactly.

`planPoAdvance(totalCents, pos, poAdvanceRateBps)` returns a `PoAdvancePlan` with one line per PO:

- `current_principal_cents`, `current_ratio_bps`
- `newly_assigned_cents`
- `pro_forma_principal_cents`, `pro_forma_ratio_bps`
- `pro_forma_over_advanced` (true if pushed past 100%)

Plus `any_over_advanced` at the plan level so the UI can render the over-extension warning the spec calls for. POs whose room is 0 (already at the borrowing-rate cap or already over-advanced) are excluded from the allocation set.

## Tests

```bash
pnpm -F @seaking/domain test
```
