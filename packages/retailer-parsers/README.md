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
├── types.ts                     — ParseContext, ParseResult, NormalizedPoRecord, NormalizedInvoiceRecord, NormalizedInvoiceDeductionRecord, NormalizedClientDeductionRecord, etc.
├── csv.ts                       — papaparse wrapper + header canonicalization + CRLF→LF normalization
├── xlsx.ts                      — exceljs wrapper + header canonicalization + cell-value-to-string normalization (Date → ISO, rich text → concatenated, etc.)
├── dates.ts                     — MM/DD/YYYY and MM-DD-YYYY parsers
├── walmart/
│   ├── shared.ts                — helpers used by header AND line parsers (status mapping, OMS cross-check, etc.)
│   ├── purchase-orders/
│   │   ├── index.ts             — auto-detecting dispatcher
│   │   ├── header-level.ts      — 1 row per PO, the fallback path
│   │   ├── line-level.ts        — N rows per PO, the default path
│   │   └── __fixtures__/        — real-sample slices from Derek's uploads
│   ├── invoices/                — Real parser (1E-1). XLSX. Filter rules + Allowance Amt deduction extraction + RETURN CENTER CLAIMS routing to client_deductions.
│   │   └── __fixtures__/
│   └── payments/                — Phase 1F
├── kroger/
│   ├── purchase-orders/         — Stub: throws with a clear message until a sample file arrives
│   ├── invoices/                — Phase 1E-2
│   └── payments/                — Phase 1F
├── generic/
│   └── purchase-orders/         — Real parser (1C). One CSV may span multiple retailers (per-row Retailer column).
│       └── __fixtures__/
└── advance-csv/
    └── po-numbers/              — Two-column CSV (Purchase Order Number, Retailer) for the Advance on POs secondary entry path. Pure parser; matching against existing POs happens server-side in apps/manager.
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

## Walmart invoice parser (Phase 1E-1)

`walmart/invoices/` parses Walmart's APIS 2.0 "Invoice By Date Search" XLSX export (16 columns). Per `docs/03_PARSERS.md` §Walmart Invoices:

- **Invoice number leading-zero handling.** Walmart stores invoice numbers as zero-padded text (`'000008939228281'`). The parser strips for canonical `invoice_number` and retains the padded form in `metadata.display_invoice_number`.
- **Three-way row routing.**
  - `Source = "RETURN CENTER CLAIMS"` AND `Net Amount = 0` → SKIP with reason `return_center_claim_zero_dollar`
  - `Source = "RETURN CENTER CLAIMS"` AND `Net Amount ≠ 0` → emit a `client_deductions` row (`source_category = chargeback`, `source_subcategory = walmart_return_center_claim`)
  - Any other `Source` → emit an invoice row
- **Allowance Amt extraction.** When an invoice row has `Allowance Amt ≠ 0`, the parser emits one `invoice_deductions` row alongside the invoice with `category` mapped via substring match on `Allowances Type` (`promotional` / `damage` / `shortage` / `otif_fine` / `pricing` / `other`) and `memo` from `Allowance Desc` (or fallback).
- **Soft validations.** `Invoice Type ≠ "W"` emits a warning but still creates the invoice. `Invoice Type = "W"` is the warehouse-invoice expectation; novel types surface for Manager review.
- **Hard skips.** Missing Invoice No / PO Number / unparseable Invoice Date / unparseable Net Amount Due / negative Net Amount on a non-RCC row.

The parser is async (exceljs uses Promises). Output shape:

```ts
{
  parser_version: 'walmart-invoices/1.0.0',
  rows: NormalizedInvoiceRecord[],
  invoice_deductions: NormalizedInvoiceDeductionRecord[],
  client_deductions: NormalizedClientDeductionRecord[],
  warnings: ParseWarning[],
  skipped: SkippedRow[],
  stats: { total_rows_read, valid_invoice_rows, invoice_deduction_rows, client_deduction_rows, skipped_rows, warning_count }
}
```

The upload handler (Phase 1E-3) is responsible for resolving `(retailer_slug, po_number)` → `purchase_order_id`, `(po_number, invoice_number)` → `invoice_id` for the deduction linkages, and the PO→AR conversion side effects (commit_invoice_upload RPC).

## Kroger invoice parser (Phase 1E-2)

`kroger/invoices/` parses Kroger's vendor-portal "Invoice search results" XLSX export (26 columns). Per `docs/03_PARSERS.md` §Kroger Invoices, the file mixes three kinds of rows:

- **`Warehouse`** — real invoices. Routed to `rows: NormalizedInvoiceRecord[]`. Required: positive `Net invoice amount`, non-empty `PO number`. Stored with metadata for `kroger_division`, `kroger_payment_refs` (split on comma), `kroger_uploaded_by` ('KCL' expected; non-KCL warns), and a few other audit fields.
- **`Promo Allowances`** — Kroger promotional chargebacks. Routed to `client_deductions: NormalizedClientDeductionRecord[]` with `source_category = 'promo_allowance'`, `source_subcategory = 'PromoBilling'`. Required: negative amount; sign inversion warns but still emits.
- **`Non-Promo Receivable`** — PRGX post-audit recoveries. Routed to `client_deductions` with `source_category = 'non_promo_receivable'`, `source_subcategory = 'PRGX'`.

Soft validations (warnings, still emit):
- Sign mismatch on Promo / NPR (positive instead of negative).
- Unexpected `PO number` on Promo / NPR (Kroger routing anomaly).
- Gross ≠ Net on Warehouse (inline deductions on a Warehouse row are unusual).
- Invoice received date < Invoice date (`kroger_date_anomaly`).
- Format-vs-category mismatch (short integer numbers categorized as Promo, or hyphenated numbers categorized as Warehouse).
- Non-USD currency.

Hard skips:
- Missing Invoice number / Invoice date / unparseable Net amount.
- Warehouse row with non-positive amount or missing PO number.
- Unknown `Invoice category`.

The first header cell in the real export carries a UTF-8 BOM (`\uFEFF`); `xlsx.ts`'s `canonicalizeXlsxHeader` strips it during normalization. Without that strip, `'Invoice number'` would never match the BOMed header and the parser would throw `KrogerInvoiceHeaderError`.

Excel-serial dates (Kroger's `Invoice date`, `Invoice received date`) come back from `exceljs` as JS `Date` objects; `xlsx.ts` converts to ISO `YYYY-MM-DD` (UTC date-only) before the parser sees them, so date handling is the same as for Walmart's text-stored dates.

Kroger's PO export remains a stub — the parser skeleton in `kroger/purchase-orders/` throws a clear "not yet supported" message until Derek receives a sample file.

## Advance CSV: PO numbers entry path

`advance-csv/po-numbers/` parses the spec's two-column "list of POs to advance against" template (`Purchase Order Number`, `Retailer`). Same single-source-of-truth pattern as the generic PO template: `PO_NUMBERS_TEMPLATE_HEADER` constant + `parsePoNumbersCsv()` function, served from `/api/advance-template/po-numbers` in apps/manager.

Validation rules: required headers (case-insensitive, whitespace-collapsed), rows missing PO# or Retailer skip with a reason, duplicate `(po_number, retailer_slug)` pairs dedupe silently, retailer slugs are lowercased and whitespace-collapsed for case-insensitive matching against `retailers.name` OR `retailers.display_name`. The matching step itself happens in `apps/manager .../advances/po/new/actions.ts → matchPosFromCsvAction` — this package only normalizes bytes to `PoNumbersRow` records.

## Full-replacement semantics (Walmart line-level)

Per resolved decision 2026-04-23: when a line-level file covers a PO that already exists in the DB, both the PO's header fields AND all of its `purchase_order_lines` are replaced atomically. This parser emits both the header records (one per PO) and line records (one per input row). The upload handler wraps the `DELETE FROM purchase_order_lines WHERE purchase_order_id = X; INSERT ...` pair in a transaction.

## Running the tests

```bash
pnpm -F @seaking/retailer-parsers test
```

Fixtures are trimmed real samples (preserves edge cases without bloating the repo). Every parser ships with `happy-path*` and `malformed` coverage. Edge-case files land as new retailer quirks are discovered.
