# @seaking/dates

Calendar-date utilities anchored to America/New_York, plus fee-period math.

## Why this package exists

Every business-meaningful date in Sea King — Advance Date, Posting Date, Wire Date, Invoice Date — is a calendar date (no time, no timezone), anchored to America/New_York. Keeping all date arithmetic in one place that explicitly assumes this timezone prevents the classic "runs fine in dev, breaks at midnight UTC" bug class.

## Public API

### Calendar dates

- `CalendarDate` — alias for `Temporal.PlainDate` (via the `@js-temporal/polyfill`)
- `parseIsoDate("2026-04-23")`, `toIsoDate(d)`
- `todayInNY()` — today's date in America/New_York
- `makeDate(2026, 4, 23)`
- `addDays(d, n)`, `addMonths(d, n)`
- `daysBetween(from, to)`
- `compareDates`, `isBefore`, `isAfter`, `isSame`, `minDate`, `maxDate`

### Fee-period math

- `periodN(advanceDate, n, rules)` — get the Nth fee period
- `periodNumberAsOf(advanceDate, asOf, rules)` — which period is `asOf` in?
- `periodsThroughDate(advanceDate, asOf, rules)` — enumerate all periods started by `asOf`

`FeeRules` matches the `rule_sets` table (period lengths + bps rates).

## The fee-period rule (01_FUNCTIONAL_SPEC.md)

> At the moment a new period begins (midnight America/New_York on the boundary day), the full period fee is recognized, added to the outstanding fee balance, and is immediately collectible by the next payment received.

Step-function, not daily accrual. Period 1 covers `advanceDate` through `advanceDate + (period1Days - 1)` inclusive. Period 2 starts on `advanceDate + period1Days`. Etc.

## Tests

```bash
pnpm -F @seaking/dates test
```
