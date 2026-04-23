# @seaking/money

Integer-cents money type and ratable allocation for Sea King.

## Why this package exists

Every monetary amount in Sea King is stored as integer cents (`bigint` in the DB, `number` or `bigint` in TS). No floats. No `decimal` strings. This package is the one place that handles:

- Construction and validation of cents values
- Conversion between cents and display dollars
- Basis-points rate application (`applyBps`)
- Ratable allocation with deterministic tie-breaking

If you catch yourself writing `amount * 0.03` or `parseFloat(dollarString)` anywhere, stop and import from this package instead.

## Public API

### Types

- `Cents` — branded non-negative integer
- `SignedCents` — branded signed integer (for ledger deltas)

### Construction

- `cents(n: number): Cents`
- `signedCents(n: number): SignedCents`
- `fromDollarString("$1,234.56"): Cents`
- `fromDollarsNumber(12.34): Cents`
- `fromBigInt(b: bigint): Cents`
- `fromBigIntSigned(b: bigint): SignedCents`

### Conversion

- `formatDollars(c): string` — `"$1,234.56"`
- `toBigInt(c): bigint` — for DB writes

### Arithmetic

- `add(a, b)`, `sub(a, b)`, `subClamped(a, b)` (0-floor)
- `applyBps(amount, bps)` — e.g. `applyBps(cents(10000), 8000)` = `8000` (80% of $100)

### Allocation

- `allocate(total, targets)` — proportional, deterministic rounding
- `allocateLowestFirst(total, targets)` — lowest borrowing-ratio first, ratably among ties

## The allocation rule (01_FUNCTIONAL_SPEC.md)

> Ratable allocation computes each share in integer cents; the remainder (the sum of rounding gaps) is distributed one cent at a time, largest pre-rounding share first, ties broken by lowest target ID.

This is implemented in `allocate()`. The result is:
1. Exact — parts always sum to `total`.
2. Deterministic — same inputs → same output, always.
3. Tested — see `allocation.test.ts`.

## Tests

```bash
pnpm -F @seaking/money test
```
