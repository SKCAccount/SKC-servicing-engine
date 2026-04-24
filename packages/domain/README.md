# @seaking/domain

Pure financial-logic functions for Sea King. No I/O, no React, no Supabase — bytes/numbers in, bytes/numbers out. Tests need no mocks.

## What's in here

| Module | Purpose |
|---|---|
| `borrowing-base.ts` | PO/AR/Pre-Advance borrowing-base math, borrowing-ratio calculation, per-PO room calculation |
| `po-advance.ts` | Allocation across selected POs (lowest-borrowing-ratio first, ratable among ties) + per-line pro-forma metrics for the review screen |

The allocation primitive itself lives in `@seaking/money` (`allocateLowestFirst`). This package wraps it with PO-domain inputs and outputs.

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

## The PO advance allocation rule

Per `01_FUNCTIONAL_SPEC.md §Advancing Purchase Orders`:

1. POs are bucketed by borrowing ratio rounded to the nearest percent.
2. The lowest-ratio bucket gets ratable allocation up to its room cap.
3. Once the bucket is full, the next-lowest bucket takes the remainder.
4. Each share is integer cents; the parts sum to the requested total exactly.

`planPoAdvance(totalCents, pos, poAdvanceRateBps)` returns a `PoAdvancePlan` with one line per PO:

- `current_principal_cents`, `current_ratio_bps`
- `newly_assigned_cents`
- `pro_forma_principal_cents`, `pro_forma_ratio_bps`
- `pro_forma_over_advanced` (true if pushed past 100%)

Plus `any_over_advanced` at the plan level so the UI can render the over-extension warning the spec calls for.

## Tests

```bash
pnpm -F @seaking/domain test
```
