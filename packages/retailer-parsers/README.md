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
├── types.ts                     — ParseContext, ParseResult, NormalizedPoRecord (with retailer_slug), etc.
├── csv.ts                       — papaparse wrapper + header canonicalization + CRLF→LF normalization
├── dates.ts                     — MM/DD/YYYY and MM-DD-YYYY parsers
├── walmart/
│   ├── shared.ts                — helpers used by header AND line parsers (status mapping, OMS cross-check, etc.)
│   ├── purchase-orders/
│   │   ├── index.ts             — auto-detecting dispatcher
│   │   ├── header-level.ts      — 1 row per PO, the fallback path
│   │   ├── line-level.ts        — N rows per PO, the default path
│   │   └── __fixtures__/        — real-sample slices from Derek's uploads
│   ├── invoices/                — Phase 1E
│   └── payments/                — Phase 1F
├── kroger/
│   ├── purchase-orders/         — Stub: throws with a clear message until a sample file arrives
│   ├── invoices/                — Phase 1E
│   └── payments/                — Phase 1F
└── generic/
    └── purchase-orders/         — Real parser (1C). One CSV may span multiple retailers (per-row Retailer column).
        └── __fixtures__/
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

## Generic CSV PO parser

Used by the upload UI's "Generic CSV template" option for retailers without a dedicated parser. A single CSV can legitimately span multiple retailers because each row carries a `Retailer` column.

**Required columns**: `Retailer`, `PO Number`, `PO Value`. Headers are case-insensitive (`po NUMBER` works) and whitespace-collapsed.

**Optional columns**: `Issuance Date`, `Requested Delivery Date`, `Delivery Location`, `Item Description`, `Quantity Ordered`, `Unit Value`, `Cancellation Status`, `Cancellation Reason`. Dates accept ISO `YYYY-MM-DD` or US `MM/DD/YYYY`. Money accepts `1234.56`, `$1,234.56`, etc.

**Retailer resolution** is the upload handler's job — it matches the parser's lowercased `retailer_slug` against `retailers.name` OR `display_name` (case-insensitive). Unresolved slugs surface as skipped rows in the upload review. Admin must pre-create new retailers in `retailers` (Studio only — no UI yet).

The exported `GENERIC_PO_TEMPLATE_HEADER` constant is the canonical column list. The Manager app's `/api/po-template/generic` route serves it as a downloadable CSV so the template can never drift from what the parser accepts.

## Full-replacement semantics (Walmart line-level)

Per resolved decision 2026-04-23: when a line-level file covers a PO that already exists in the DB, both the PO's header fields AND all of its `purchase_order_lines` are replaced atomically. This parser emits both the header records (one per PO) and line records (one per input row). The upload handler wraps the `DELETE FROM purchase_order_lines WHERE purchase_order_id = X; INSERT ...` pair in a transaction.

## Running the tests

```bash
pnpm -F @seaking/retailer-parsers test
```

Fixtures are trimmed real samples (preserves edge cases without bloating the repo). Every parser ships with `happy-path*` and `malformed` coverage. Edge-case files land as new retailer quirks are discovered.
