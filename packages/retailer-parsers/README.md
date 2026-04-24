# @seaking/retailer-parsers

Pure functions that turn retailer-specific CSV/XLSX exports into our canonical normalized shapes.

## Why "pure"

Parsers take bytes in, return a `ParseResult` out. No DB writes, no HTTP, no filesystem. This split gives us two properties that matter:

1. **Review before commit.** The upload UI parses the file, shows the Manager a summary of what will happen, and only persists on confirmation. Because parsing is pure, we can re-run it freely — on the review page and again on submit — without side effects.
2. **Trivially testable.** Fixtures are plain files checked into `__fixtures__`. Tests call `parse()` and snapshot the output. No mocks, no database setup.

The **upload handler** in `apps/manager` owns persistence: writing the raw file to Supabase Storage, inserting the `*_uploads` row, and transforming `ParseResult` into `INSERT`/`DELETE` statements against the operational tables.

## Structure

```
packages/retailer-parsers/src/
├── types.ts           — ParseContext, ParseResult, NormalizedPoRecord, etc.
├── csv.ts             — papaparse wrapper + header canonicalization
├── dates.ts           — MM/DD/YYYY and MM-DD-YYYY parsers
├── walmart/
│   ├── shared.ts      — helpers used by header AND line parsers
│   ├── purchase-orders/
│   │   ├── index.ts        — auto-detecting dispatcher
│   │   ├── header-level.ts — 1 row per PO, the fallback path
│   │   ├── line-level.ts   — N rows per PO, the default path
│   │   └── __fixtures__/   — real-sample slices from Derek's uploads
│   ├── invoices/      — Phase 1E
│   └── payments/      — Phase 1F
├── kroger/            — 1C stub (purchase-orders throws); 1E/1F fill in
└── generic/           — 1C stub for the CSV template
```

## Walmart PO auto-detection

One upload button in the UI covers both Walmart PO exports. The dispatcher inspects the header row and routes:

| Columns present | Route |
|---|---|
| Shared required columns only | `header-level` parser |
| Shared required + all four line-level-only columns (`Line number`, `Item description`, `VNPK order cost`, `Line status`) | `line-level` parser |
| Shared required + SOME line-level-only columns | Hard error (`WalmartPoDetectionError`) |
| Missing shared required columns | Hard error (not a Walmart PO file) |

Mixed column sets are a hard error by design: silently picking the wrong path could corrupt downstream data, and spec says the Manager should see a clear message instead.

## Full-replacement semantics (Walmart line-level)

Per resolved decision 2026-04-23: when a line-level file covers a PO that already exists in the DB, both the PO's header fields AND all of its `purchase_order_lines` are replaced atomically. This parser emits both the header records (one per PO) and line records (one per input row). The upload handler wraps the `DELETE FROM purchase_order_lines WHERE purchase_order_id = X; INSERT ...` pair in a transaction.

## Running the tests

```bash
pnpm -F @seaking/retailer-parsers test
```

Fixtures are trimmed real samples (preserves edge cases without bloating the repo). Every parser ships with `happy-path*` and `malformed` coverage. Edge-case files land as new retailer quirks are discovered.
