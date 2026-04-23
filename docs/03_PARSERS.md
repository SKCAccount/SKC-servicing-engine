# Retailer Parser Specifications — Phase 1 (v2)

This document specifies the normalization parsers for **Walmart** and **Kroger** source files. Each parser transforms a retailer-specific export into a canonical record shape that the Sea King Capital schema can consume directly.

Parsers live under `packages/retailer-parsers/{retailer}/{type}/` where `type ∈ {purchase-orders, invoices, payments}`. Every parser exports a single function:

```ts
parse(file: File | Buffer, context: ParseContext): Promise<ParseResult>
```

Return shape:

```ts
type ParseResult = {
  parser_version: string;          // semver, e.g. "walmart-po/1.0.0"
  retailer_id: string;             // resolved from context
  rows: NormalizedRecord[];        // canonical records for database
  warnings: ParseWarning[];        // non-fatal issues (malformed rows, unknown codes)
  skipped: SkippedRow[];           // rows deliberately dropped with reason
  stats: {
    total_rows_read: number;
    valid_rows: number;
    skipped_rows: number;
    warning_count: number;
  };
};
```

Parsers are pure — bytes in, records out, no I/O side effects. The upload handler is responsible for writing the raw file to Supabase Storage and persisting the parsed records transactionally.

---

## Walmart

Walmart's SupplierOne / APIS 2.0 exports are the cleanest feeds in Phase 1. The **PO number is the thread that runs through every file** — PO exports have it, invoice exports have it, payment exports have it. No resolver logic is needed to link the three; the PO number is the shared key.

### File formats at a glance

| File | Source | Format | Lines | Unique key |
|---|---|---|---|---|
| Header PO export | SupplierOne — Header Level Purchase Order Data | CSV | 1 row per PO | `PO#` |
| Line PO export | SupplierOne — Line Level Purchase Order Data | CSV | Multi-row per PO | `PO# + Line number` |
| Invoices | APIS 2.0 — Invoice By Date Search | XLSX | Typically 1 row per invoice | `Invoice No` |
| Payments | APIS 2.0 — Check Level Payments | XLSX | Multi-row per invoice (main + deductions) | `Invoice Number + Type + Microfilm Nbr` |

### 1. Walmart Purchase Orders

Walmart offers two variants of the PO export: **Header Level** (1 row per PO, all PO#s) and **Line Level** (N rows per PO, line items included, limited to 1,000 POs per export). The parser accepts either and merges when both are present.

#### Header-level source (primary — full coverage)

| Source column | Normalized field | Notes |
|---|---|---|
| `PO#` | `po_number` | Integer in source; cast to string; preserve leading zeros (none observed but defensive) |
| `Supply chain status` | **used for classification** | See status mapping below |
| `OMS status` | **cross-check** | Should mirror `Supply chain status`; warn on mismatch |
| `Create date` | `issuance_date` | `MM/DD/YYYY` in source |
| `MABD` (Must Arrive By Date) | `requested_delivery_date` | `MM/DD/YYYY` |
| `PO total each order qty` | `quantity_ordered` | Integer; count of individual units |
| `Total unit cost` | `po_value_cents` | **Misleadingly named — this is the TOTAL DOLLAR VALUE of the PO, not the per-unit cost.** Confirmed by math: row 0 shows qty=420, "Total unit cost"=$1,305.36 → implied $3.11/unit. Also confirmed by line-level sum. Multiply by 100, round half-away-from-zero to get cents. Note: this value **already reflects line-level cancellations** — cancelled lines have NaN `VNPK order cost` so the header total is always `SUM(non-cancelled VNPK order cost)`. |
| `Destination node address: state, city` | `delivery_location` (part 1) | Note the double-space in source header; parser canonicalizes by collapsing whitespace runs |
| `Destination node address: zipcode` | `delivery_location` (part 2) | Concatenate as `"{city}, {state} {zip}"` for the single-field `delivery_location` |
| All other header fields (~30 columns) | (dropped) | Walmart logistics metadata; retained in raw file in Storage if ever needed |

*Item Description is NOT present in the header-level export.* Available only from the line-level export (see below).

**Status mapping** (`Supply chain status` → `purchase_orders.status`):

| Source value | Normalized | Cancellation? |
|---|---|---|
| `Open` | `active` | No |
| `Receiving` | `active` | No — partial receipt in progress; still a live PO |
| `Closed` | `fully_invoiced` (tentative) | No — "Closed" on Walmart's side doesn't mean Sea King's position is settled; Sea King's event log determines that |
| `Cancelled` | `cancelled` | **Yes** — routes through PO Cancellations workflow |

If `Supply chain status` disagrees with `OMS status`, emit a warning and treat `Supply chain status` as source of truth. (In the 2,919-row sample, they agreed on all rows.)

#### Line-level source (preferred default — up to 1,000 POs per export)

**This is the default upload format.** The upload UI presents a single "Upload Walmart POs" button and displays a prominent note:

> *Walmart offers both header-level and line-level exports. Line-level is preferred — it includes item descriptions and surfaces partial line cancellations. Use header-level only when you need to cover more than 1,000 POs in a single file and are willing to give up line detail.*

The Manager drops either file; the parser auto-detects which it is and routes.

**Auto-detection**. On parse, the parser reads the header row and checks for the presence of line-level-only columns (`Line number`, `Item description`, `VNPK order cost`, `Line status`). Presence of all four → line-level parser. Absence → header-level parser. Ambiguous states (some present, some missing) → hard error with a clear message: `"Walmart PO file has mixed column set — expected either all header-only columns or header+line columns. Got: {observed}"`.

**Per Derek's decision (2026-04-23): Option A — full replacement.** When a line-level file covers a PO that already exists in the database, the incoming row wins on all fields — both header-level fields (PO value, status, dates) AND line detail. Rationale: keeps the mental model simple ("upload latest Walmart data, it wins") and correctly handles cases like a PO being cancelled between a header upload and a subsequent line-level upload.

**Full merge algorithm**:

```
parse_line_level_file(file, context):
  rows = read_csv(file)
  grouped = group rows by PO#

  for each (po_number, line_rows) in grouped:
    # All rows for the same PO share identical header-level field values
    header_fields = extract_header_fields(line_rows[0])

    emit purchase_order upsert:
      key = (client_id, retailer_id, po_number)
      header_fields (status, po_value_cents, dates, etc.) = from header_fields
      # FULL REPLACEMENT: all header fields overwritten regardless of prior values,
      # subject to the Manager's "skip duplicates" toggle on the upload summary screen.

    emit purchase_order_lines full-replace:
      # Delete all existing lines for this PO, then insert the incoming ones.
      # Wrapped in a transaction so there's no moment where the PO has zero lines
      # visible to concurrent readers.
      DELETE FROM purchase_order_lines WHERE purchase_order_id = (resolved PO id)
      INSERT INTO purchase_order_lines (...) VALUES [one per line_row]
```

**Mixed-file workflow** (rare — Manager covering more than 1,000 POs). The Manager uploads files sequentially:

1. **Header-level file first** (covering all N POs, N > 1,000): all POs are upserted with header fields only; `purchase_order_lines` is empty for these.
2. **Line-level file(s) next** (each covering ≤1,000 POs): for the POs in the line-level file, header fields are overwritten AND lines are inserted. POs not in the line-level file keep their header-only state.

This is mechanically identical to ordinary full-replacement — the line-level file just happens to cover a subset.

**Line-level column mapping** (in addition to the 38 header columns covered above):

| Source column | Normalized target | Notes |
|---|---|---|
| `Item description` | `purchase_order_lines.item_description` | Populated in migration 0010 |
| `Walmart item No.` | `purchase_order_lines.retailer_item_number` | |
| `Line number` | `purchase_order_lines.line_number` | Per-PO sequence starting at 1 |
| `VNPK cost` | `purchase_order_lines.unit_cost_cents` | Per-vendor-pack unit cost |
| `VNPK order cost` | `purchase_order_lines.line_value_cents` | Line total. Summed across lines within a PO = header `Total unit cost`. |
| `Line status` | `purchase_order_lines.status` | Values: `Approved`, `Received`, `Partially Received`, `Cancelled` |
| `Line VNPK rec qty`, `Line WHPK rec qty` | (dropped in Phase 1) | Partial receipt quantities |
| `Total VNPK order qty.1`, `Total WHPK order qty.1` | (dropped) | Redundant with header values |
| `Tot. ordered weight (lbs)`, `Stores` | (dropped) | Logistics metadata |

**Partial line cancellations** (observed: 25 cancelled lines across 302 POs with mixed line statuses): when a PO has cancelled lines but is not itself cancelled, the `Total unit cost` on the header file already excludes the cancelled line value (cancelled lines have NaN `VNPK order cost`). So for PO valuation purposes, nothing special is needed. But for historical auditability, we retain the line-level record with `status=cancelled` to show what was originally ordered.

**Cancellation parsing**. When `Supply chain status = Cancelled`:
- Set `cancellation_reason_category = retailer_cancelled`
- Set `cancellation_memo = "Walmart-reported cancellation (SupplierOne status=Cancelled); source row uploaded {upload_timestamp}"`
- Set `cancelled_at = upload timestamp`
- Set `cancelled_by = user running the upload`

If the PO was previously active and this upload flips it to cancelled with outstanding principal, route through the PO Cancellations workflow → Advances in Bad Standing.

**Idempotency**. Uniqueness is `(client_id, retailer_id, po_number)`. Re-uploading produces an upsert with the Manager's overwrite toggle respected. Reloading an already-cancelled PO with matching cancellation metadata produces no change event.

**Validation rules** (parser refuses the file if any fail):
- `PO#` must be non-null and cast-able to string of digits
- `Total unit cost` must be ≥ 0
- `PO total each order qty` must be ≥ 0
- `Create date` and `MABD` must parse as dates or be blank
- `Supply chain status` must match one of the known values (unknown → warning, row skipped)

**Known quirks**:
- Columns `Destination node address:  state, city` and `Destination node address:  zipcode` have TWO spaces after the colon in the header. Parser canonicalizes header whitespace before mapping.
- `Reason` column is `float64` in pandas due to NaN presence — cast to nullable string.
- `Buyer ID` is free text with embedded commas (e.g., `"DRKEITH , S0A0BJ3 , JUD0037"`). Must quote-respect CSV parse.
- `Promo ID` was always `"N"` or null in the 2,919-row sample. If non-`"N"` values appear, store in `metadata.walmart_promo_id` for Manager review.

### 2. Walmart Invoices

Source is XLSX, single sheet, 16 columns. Typically 1 row per invoice, but the parser does not assume uniqueness — Walmart can split across rows for multi-line allowances.

| Source column | Normalized field | Notes |
|---|---|---|
| `Invoice No` | `invoice_number` | **String with leading zeros** (e.g., `000008939228281`) in source. Internally store stripped form (`8939228281`); retain padded form in `metadata.display_invoice_number`. |
| `Invoice Date` | `invoice_date` | `MM-DD-YYYY` |
| `Invoice Due Date` | `due_date` | `MM-DD-YYYY`; nullable for non-standard types |
| `PO Number` | `po_number` | String; primary link back to PO export |
| `Net Amount Due($)` | `invoice_value_cents` | Multiply by 100 |
| `Case Count` | (dropped) | |
| `Invoice Type` | **used for filtering** | `W` = warehouse invoice; others warn |
| `Source` | **used for filtering** | `EDI ASCX12` = real invoice; `RETURN CENTER CLAIMS` = chargeback (see below) |
| `Process State Description ` (trailing space in column name) | logged to warnings | `Extracted For Payment` indicates a non-pay row |
| `Store/DC Number` | `goods_delivery_location` | Resolve against PO's delivery location for consistency |
| `Micro film number` | `metadata.microfilm_number` | **Cross-reference key** to payment file (payments file uses `Microfilm Nbr` on Type 0 rows) |
| `Allowances Type`, `Allowance Desc`, `Allowance Amt` | **split into deductions** if nonzero | See deduction extraction below |
| `Vendor Number`, `Vendor Name` | (dropped) | Should match Client; warn on mismatch |

**Filter rules** — rows that do NOT become invoices:

| Source pattern | Action | Reason |
|---|---|---|
| `Source = "RETURN CENTER CLAIMS"` AND `Net Amount Due = 0` | **Skip row**, reason `return_center_claim_zero_dollar` | Bookkeeping entry, not a real invoice |
| `Source = "RETURN CENTER CLAIMS"` AND `Net Amount Due ≠ 0` | **Emit as deduction against referenced PO** | Genuine chargeback; `category = other`, `memo = "Walmart Return Center Claim; source PO {po_number}"` |
| `Invoice Type ≠ "W"` | Warn; emit invoice but flag for review | Unknown types are novel |
| `PO Number` is null or `0000000792` (placeholder) | Warn; retailer-internal reference row | The `0000000792` value appeared in the sample attached to the RETURN CENTER row |

**Deduction extraction**. If an invoice row has `Allowance Amt ≠ 0`:
- Emit one `invoice_deductions` row per nonzero allowance
- `category` mapped from `Allowances Type` (see shared deduction map below)
- `amount_cents = abs(Allowance Amt) * 100`
- `memo = Allowance Desc` if populated, else `"{Allowances Type} deduction from invoice {invoice_number}"`
- `known_on_date = Invoice Date`

**Validation rules**:
- `Invoice No` must be non-empty string
- `PO Number` must be non-empty (except for filtered rows)
- `Net Amount Due($)` must be numeric
- `Invoice Date` must parse or be blank

### 3. Walmart Payments

Source is XLSX. **Multi-row structure per invoice**: typically 1 main row (`Type = 0`) plus 0 or more deduction rows (non-zero Type). Sample: 6 invoices × 3 rows each = 18 rows.

| Source column | Normalized field | Notes |
|---|---|---|
| `Invoice Number` | `invoice_number` | Strip leading zeros to match invoice export's stripped form |
| `Invoice Date` | see algorithm | For Type 0: original invoice date. For deduction rows: date Walmart posted the deduction. |
| `PO Number` | `po_number` | Usually equals `Invoice Number` in Walmart's feed |
| `Paid Date` | `payment_date` | `MM-DD-YYYY` — Walmart's check/settlement date. **Not** the bank posting date. Expect a 1-3 day lag. |
| `Type` | **row kind classifier** | `0` = main payment; nonzero = deduction. Codes seen: `0`, `57`, `59`. |
| `Deduction Type Description` | `deduction.memo` | Human-readable label for non-zero Type |
| `Microfilm Nbr` | `metadata.microfilm_number` | Real value on Type 0 rows; placeholder `28` on deduction rows. Cross-references to invoice export. |
| `Discount Amt` | (see algorithm) | On Type 0: early-pay discount. On deduction rows: 0. |
| `Invoice Amt` | (see algorithm) | On Type 0: original invoice gross. On deduction rows: negative deduction amount. |
| `Paid Amt` | (see algorithm) | On Type 0: `Invoice Amt - Discount Amt`. On deduction rows: equals `Invoice Amt`. |
| Other columns | (dropped) | Accounting metadata |

**Normalization algorithm** — one `retailer_payment_details` row per Type 0, plus one `invoice_deductions` row per non-zero Type:

```
for each group g where g.key = (Invoice Number, Microfilm Nbr of Type 0 row, Paid Date):
  main = g.rows where Type == 0     // must be exactly 1
  deductions = g.rows where Type != 0

  emit retailer_payment_details:
    retailer_payment_upload_id  = current upload ID
    retailer_id                 = walmart
    purchase_order_number       = main.PO Number
    invoice_number              = strip_leading_zeros(main.Invoice Number)
    payment_date                = main.Paid Date
    invoice_date                = main.Invoice Date
    invoice_amount_cents        = main.Invoice Amt * 100
    discount_cents              = main.Discount Amt * 100
    deduction_cents             = sum(abs(d.Paid Amt) for d in deductions) * 100
    paid_amount_cents           = sum(row.Paid Amt for row in g) * 100
                                  // = (main.Invoice Amt - main.Discount Amt) - sum(abs(d.Paid Amt))
    matched_bank_transaction_id = NULL   // filled by matcher
    match_type                  = NULL

  for each deduction d in deductions:
    emit invoice_deductions (once invoice is resolved):
      invoice_id     = resolved_invoice.id
      category       = map_walmart_type_to_category(d.Type)
      amount_cents   = abs(d.Paid Amt) * 100
      memo           = d.Deduction Type Description
      known_on_date  = d.Invoice Date       // when Walmart posted the deduction
      payment_id     = matched_bank_transaction_id   // NULL until bank match
```

**Match tolerance**: `walmartBankMatchDayTolerance = 3` days (see Shared Concerns below). Per Derek's explicit answer to question #2.

**Microfilm cross-reference**: Type 0 `Microfilm Nbr` equals the invoice export's `Micro film number`. Use this to resolve `retailer_payment_details.resolved_invoice_id` when invoice numbers are formatted differently. Fall back to `(retailer, po_number, invoice_number)` lookup if microfilm fails.

**Validation rules**:
- Each group must have exactly one Type 0 row; more or fewer → hard error, skip group with warning
- `Paid Amt` on Type 0 should equal `Invoice Amt - Discount Amt` within 1 cent
- Type 0 `Microfilm Nbr` must be a real number (not 28, which is the deduction placeholder)

### Walmart deduction Type → category map

Shared by the invoice parser (for Allowance Type) and payment parser (for Type codes):

| Source code / description | `deduction_category` |
|---|---|
| `57` / "Quantity Discount for Assembly Stock" | `pricing` |
| `59` / "Defective Merchandise Allowance" | `damage` |
| `52` (MABD / OTIF, reserved) | `otif_fine` |
| `22`, `23` (shortages, reserved) | `shortage` |
| Any other known code | `other` (memo preserves original description) |
| Unknown code | `other` + warning; Manager can re-categorize |

Map lives at `packages/retailer-parsers/walmart/deduction-codes.ts`. Versioned — adding a new code is a parser-version bump, not a schema change.

---

## Kroger

Kroger is fully specified now that both the invoice and payment files have been provided. The **PO export** is still missing (not yet provided by the client) — that parser remains stubbed until the file arrives.

### File formats at a glance

| File | Status | Format | Grouping key |
|---|---|---|---|
| Invoices | **Specified** | XLSX | `Invoice number` (per Client, not globally unique) |
| Payments | **Specified** | XLSX | `Payment reference number` groups rows for one wire |
| Purchase Orders | **PENDING — parser stubbed** | TBD | TBD |

### Kroger invoice number format note

Kroger invoice numbers come in two shapes — format alone is a reliable classifier:

| Shape | Example | Issued by | Meaning |
|---|---|---|---|
| Short integer (4 digits) | `1405`, `1441`, `1443` | Client | Warehouse invoice — real invoice for a shipment |
| Long hyphenated string | `092-AE38942-011`, `092-R5H7035-620` | Kroger | Promo / post-audit / netting reference — not a real invoice |

### 1. Kroger Invoices

Source: XLSX, sheet `Invoice_search_results.xlsx`, 26 columns. **File contains three kinds of rows**, only one of which is a real invoice.

**Row breakdown (sample: 92 rows)**:

| `Invoice category` | Count | Sign | PO# present | Uploaded by | Maps to |
|---|---|---|---|---|---|
| `Warehouse` | 22 | Positive | Yes | `KCL` | `invoices` (real invoices) |
| `Promo Allowances` | 66 | Negative | No | `PromoBilling` | `client_deductions` (new table — migration 0009) |
| `Non-Promo Receivable` | 4 | Negative | No | `PRGX` | `client_deductions` |

#### Warehouse rows → `invoices` table

| Source column | Normalized field | Notes |
|---|---|---|
| `Invoice number` | `invoice_number` | Short integer as string; no leading-zero normalization |
| `Invoice date` | `invoice_date` | Excel serial in source; pandas `read_excel` parses natively |
| `Invoice received date` | `metadata.kroger_received_date` | Not a schema field |
| `PO number` | `po_number` | String; links to Kroger PO export (pending) |
| `Division` | `goods_delivery_location` | Human-readable, e.g., `795 - Tolleson Logistics` |
| `Location` | (dropped — redundant with Division) | |
| `Store number (Legacy)` | (dropped — redundant with Division) | |
| `Site number` | `metadata.kroger_site_number` | Cross-reference; can be null |
| `Net invoice amount` | `invoice_value_cents` | Multiply by 100 |
| `Gross invoice amount` | (cross-check — should equal Net for Warehouse rows) | Warn on mismatch |
| `Total deduction amount` | (verified zero on Warehouse rows) | Non-zero → warning |
| `Total discount amount` | (verified zero on Warehouse rows) | Non-zero → warning |
| `Total paid amount` | (informational) | Payment CSV is authoritative |
| `Payment date` | (informational) | Payment CSV is authoritative |
| `Payment reference number` | `metadata.kroger_payment_refs` | Can be comma-separated (e.g., `"6938527, 101910388"`). Split on comma, store as string array. |
| `Payment due date` | `due_date` | Nullable in Warehouse sample |
| `Invoice status` | cross-reference | `Approved` (not yet paid) or `Paid`. Warn if status disagrees with our internal `paid_in_full_date`. |
| `Invoice type` | (logged) | `Standard` or `STANDARD` — canonicalize to lowercase |
| `Invoice category` | **routing key** | Filter for Warehouse |
| `Supplier ERP ID`, `Supplier name` | (dropped) | Should match Client |
| `Invoice uploaded by` | (logged + consistency check) | `KCL` expected for Warehouse rows; mismatch → warning |
| `Tax 1`, `Remittance method`, `Currency` | (dropped) | `USD` assumed; warn if non-USD |

**Date anomaly handling** (per Derek's answer to #4 — confirmed no longer present on Kroger's site, but parser must still be resilient):
- Accept `Invoice date` and `Invoice received date` at face value
- If `Invoice received date < Invoice date`, emit a warning `kroger_date_anomaly` but don't reject
- Surface in upload summary UI so Manager can decide whether to flag

#### Promo Allowances → `client_deductions` table

Kroger promotional chargebacks applied across divisions globally, not tied to a specific invoice or PO.

| Source column | Normalized field |
|---|---|
| `Invoice number` | `source_ref` (e.g., `"092-AE38942-011"`) |
| `Net invoice amount` | `amount_cents` = `abs(value) * 100` |
| `Invoice date` | `known_on_date`, also `source_invoice_date` |
| `Division` | `division` |
| `Location` | `location_description` |
| `Invoice uploaded by` | `source_subcategory` (`PromoBilling`) |

Other fields set automatically by parser:
- `source_category = promo_allowance`
- `status = accepted` (default)
- `memo = "Kroger promo allowance {invoice_number}"`

#### Non-Promo Receivable → `client_deductions` table

Post-audit recoveries from PRGX. Same treatment as Promo Allowances except:
- `source_category = non_promo_receivable`
- `source_subcategory = PRGX`
- `memo = "PRGX post-audit recovery {invoice_number}"`

Per Derek's answer to #5, these are commonly disputed. The `client_deductions` schema supports a `disputed → upheld | reversed` lifecycle exactly for this purpose. Parser sets initial status to `accepted`; the Manager can transition to `disputed` from the UI.

#### Kroger invoice validation rules

- `Invoice number` must be non-empty
- Warehouse rows: `PO number` must be non-empty — reject row if missing
- Promo / Non-Promo rows: `PO number` must be empty — warn if present (Kroger routing anomaly)
- `Net invoice amount` must be numeric
- Sign consistency: Warehouse positive, Promo/Non-Promo negative — hard error on sign inversion
- `Invoice date` must parse (Excel serial or ISO string); reject row if unparseable
- **Classification consistency**: `Invoice category` should agree with `Invoice uploaded by` (Warehouse↔KCL, Promo Allowances↔PromoBilling, Non-Promo Receivable↔PRGX). Mismatch → warning, trust `Invoice category`.

### 2. Kroger Payments

Source: XLSX, 13 columns. **Netting-first structure** — unlike Walmart where each invoice is paid in isolation and deductions come separately, Kroger bundles everything (positive invoices and negative offsets) under a shared `Payment reference number` and reports the net.

**Critical structural insight** (sample: 23 rows under 1 Payment reference number):

| Aggregate across one `Payment reference number` | Meaning |
|---|---|
| `SUM(Net invoice amount)` | = The wire amount that will (or already did) hit the bank |
| `SUM(Invoice paid amount)` | = 0 (by construction of netting) — the positive invoice row's `Invoice paid amount` column holds the amount of its gross that was consumed offsetting negative rows |
| Positive row count | ≥ 1 real invoices paid |
| Negative row count | Deductions offset against those invoices |

In the sample: invoice `1405` had gross $41,760, but `Invoice paid amount` = $5,836.05. The remaining $5,836.05 was "absorbed" by 22 negative rows (each an independent promo/PRGX deduction). Net wire = $41,760 − $5,836.05 = **$35,923.95**.

**Column mapping** (applied per row):

| Source column | Normalized field | Notes |
|---|---|---|
| `Invoice number` | `invoice_number` (positive) / `source_ref` (negative) | Short form → real invoice; long hyphenated → client_deduction reference |
| `Invoice date` | `invoice_date` | Real date, not Excel serial in this file |
| `Gross invoice amount` | context only | Should equal `Net invoice amount` when deductions/discounts = 0 |
| `Deduction amount` | (logged) | Usually 0 in sample — Kroger reports these as separate negative rows, not inline on the positive |
| `Discount amount` | (logged) | Similarly usually 0 |
| `Net invoice amount` | `paid_amount_cents` (amount row contributes to the wire) | Multiply by 100; signed |
| `Invoice paid amount` | context only | For positive rows: how much of gross was consumed offsetting. For negative rows: equals `Net invoice amount`. |
| `Payment reference number` | **grouping key** | Shared by all rows in one settlement |
| `Settlement number` | cross-check with Payment reference number | Identical in sample (100% match); if they diverge, warn |
| `Payment reference date` | `payment_date` | Date the wire settled (or the netting resolved) |
| `Remittance method` | classifies row type | Values: `NETTING` (positive invoice-settlement rows), `ORA_AP/AR Netting` (negative offset rows). Canonicalize on lowercase; use as a signal. |
| `Currency` | (dropped) | USD assumed; warn if non-USD |
| `Location` | `metadata.kroger_location` | `Default Location` for offset rows; division for invoice rows |

**Normalization algorithm** — one `retailer_payment_details` row per positive invoice row, reconciliation of negative rows against existing `client_deductions`:

```
parse(file):
  for each row in file:
    classify_invoice_number(row.Invoice number):
      - short integer → 'invoice'
      - hyphenated (NNN-XXXNNNN-NNN pattern) → 'client_deduction_ref'

  group rows by row.Payment reference number

  for each group g:
    wire_amount_cents = sum(row.Net invoice amount for row in g) * 100

    emit bank_reconciliation_hint (matcher input):
      retailer_id               = kroger
      payment_reference_number  = g.payment_reference_number
      settlement_number         = g.settlement_number
      wire_amount_cents         = wire_amount_cents
      payment_reference_date    = g.payment_reference_date

    for each row in g:
      if classify_invoice_number(row) == 'invoice':
        emit retailer_payment_details:
          retailer_payment_upload_id = current upload ID
          retailer_id                = kroger
          purchase_order_number      = (none — resolver looks it up via invoice_number on Kroger invoices)
          invoice_number             = row.Invoice number
          payment_date               = row.Payment reference date
          invoice_date               = row.Invoice date
          invoice_amount_cents       = row.Gross invoice amount * 100
          discount_cents             = row.Discount amount * 100
          deduction_cents            = row.Deduction amount * 100
          paid_amount_cents          = row.Net invoice amount * 100
          matched_bank_transaction_id = NULL
          match_type                 = NULL
          metadata:
            kroger_payment_reference_number = g.payment_reference_number
            kroger_invoice_paid_amount_cents = row.Invoice paid amount * 100

      elif classify_invoice_number(row) == 'client_deduction_ref':
        // Look up existing client_deductions.source_ref match
        deduction = find_client_deduction(client_id, retailer_id, source_ref=row.Invoice number)
        if deduction exists:
          update deduction.netted_in_payment_ref = g.payment_reference_number
          // Do NOT change deduction.amount_cents — the invoice file already set it
        else:
          // Payment file references a deduction we haven't seen in the invoice file.
          // Emit a warning (likely the invoice file lags the payment file) and
          // create a stub client_deduction with the info we have.
          emit client_deduction:
            client_id, retailer_id
            source_ref = row.Invoice number
            source_category = classify_by_ref_pattern(row.Invoice number)
            amount_cents = abs(row.Net invoice amount) * 100
            known_on_date = row.Payment reference date
            memo = "Inferred from payment file; invoice record not yet ingested"
            status = accepted
            netted_in_payment_ref = g.payment_reference_number
            upload_id = current upload ID
```

**PO number resolution**: the Kroger payment file omits PO#. The parser resolves via invoice_number on the already-ingested `invoices` table:

```sql
SELECT purchase_order_id
FROM invoices
WHERE invoice_number = ?
  AND purchase_order_id IN (
    SELECT id FROM purchase_orders
    WHERE client_id = ? AND retailer_id = kroger_id
  )
```

This works because Kroger Warehouse invoice numbers are unique per Client (Client-issued sequential numbers). If lookup fails (invoice not yet ingested), warn and leave `resolved_invoice_id = NULL`; the Manager manually resolves in the payment review UI.

**Bank matching**: per Derek's answer to #6, assume some lag. Set `krogerBankMatchDayTolerance = 3` days to match Walmart. The wire sum is `sum(Net invoice amount) for the Payment reference number group`.

**Edge case: pure netting** (`wire_amount_cents = 0`): if deductions fully cancel invoices, no bank transaction will appear. Parser still ingests the payment records for reporting; bank matching is simply skipped for that Payment reference. Surface as a special status in the UI.

**Edge case: negative wire** (deductions exceed invoices): indicates Honey owes Kroger net. No incoming wire expected. Emit a warning; Manager reviews. (Not observed in sample, but the schema supports it — `wire_amount_cents` is signed.)

#### Kroger payment validation rules

- `Payment reference number` must be non-empty — this is the grouping key
- `Settlement number` should equal `Payment reference number` — mismatch → warning
- `Invoice number` must be non-empty
- `Net invoice amount` must be numeric
- All rows in a group must share the same `Payment reference date` — if not, take the max and warn
- Sign consistency: positive rows have `Remittance method = NETTING`; negative rows have `ORA_AP/AR Netting` (canonicalize case). Mismatch → warning, trust sign.

### 3. Kroger Purchase Orders — STUB

File not yet provided. Parser at `packages/retailer-parsers/kroger/purchase-orders/index.ts` exports:

```ts
export function parse(file: File | Buffer, context: ParseContext): Promise<ParseResult> {
  throw new Error(
    'Kroger PO parser not yet specified. Provide sample file to Derek to complete specification. ' +
    'Until then, Kroger POs must be manually created via the generic CSV template.'
  );
}
export const parser_version = 'kroger-po/0.0.0-stub';
```

When the Kroger PO file arrives, this spec will be updated with a third section under "Kroger" matching the structure of the Walmart PO spec.

---

## Shared concerns

### Date parsing

Every parser normalizes to ISO `YYYY-MM-DD`:

- **Excel date serials** (Kroger invoices): `date(1899, 12, 30) + n days`; pandas `read_excel` handles natively
- **`MM/DD/YYYY`** (Walmart PO): slash-separated US
- **`MM-DD-YYYY`** (Walmart invoice, Walmart payment, Kroger payment): dash-separated US
- **ISO `YYYY-MM-DD`** (defensive): data-warehouse passthroughs
- **Blank → null** (for nullable fields)

**Ambiguous dates** (e.g., `01/02/2026`) are never silently guessed. Each parser carries an explicit per-file format contract; inputs that don't match are rejected with a warning.

### Money parsing

- All monetary source values → integer cents via `cents = round(float(cleaned) * 100)` using banker's rounding (Python `round()` default) for determinism
- Negative amounts allowed for deductions; positive-only for principal and invoice values
- Reject rows with NaN, infinity, or un-parseable money strings

### Retailer resolution

The parser receives `ParseContext = { client_id, retailer_id, uploaded_by_user_id, upload_id }` from the upload handler. Parsers don't look up retailers themselves — the upload handler passes it explicitly. Adding a second Walmart format (e.g., a new SupplierOne variant) = new parser version, not new retailer.

### Bank match tolerance (per-retailer)

Per Derek's answers to #2 and #6:

```ts
// packages/retailer-parsers/config.ts
export const bankMatchDayTolerance = {
  walmart: 3,
  kroger:  3,
  default: 1,
};
```

The two-pass matcher in the Record a Payment workflow reads this table when fuzzy-matching.

### Parser versioning

Every parser exports `parser_version: "<retailer>-<type>/<semver>"`. Stored on every `*_uploads` row for audit. Example values:

- `walmart-po/1.0.0`
- `walmart-po-line/1.0.0`
- `walmart-invoice/1.0.0`
- `walmart-payment/1.0.0`
- `kroger-invoice/1.0.0`
- `kroger-payment/1.0.0`
- `kroger-po/0.0.0-stub` (until file arrives)

Changing a parser (new deduction code, new column interpretation) = semver bump. Reprocessing historical uploads with a new parser version is a Phase 2 concern.

### Test fixtures

Every parser ships with test fixtures at `packages/retailer-parsers/{retailer}/{type}/__fixtures__/`:

- `happy-path.{csv|xlsx}` — sample provided by Derek, lightly anonymized
- `edge-cases.{csv|xlsx}` — hand-crafted rows exercising every conditional path:
  - Walmart: cancelled PO, multi-deduction invoice, RETURN CENTER row, partial line cancellation
  - Kroger: Warehouse + Promo + Non-Promo mix, disputed deduction, pure-netting payment group, missing invoice reference in payment file
- `malformed.{csv|xlsx}` — intentionally bad rows to verify rejection behavior

Tests call `parse()` and snapshot-compare normalized output, warnings, skipped rows.

### Parser output → database write flow

1. Upload handler receives file + metadata
2. Writes `*_uploads` row, stores raw file in Supabase Storage
3. Invokes `parse(file, context)`
4. Parser returns `ParseResult`
5. Handler renders summary UI (counts, warnings, skipped) — Manager approves
6. On approval, handler writes normalized rows in a single DB transaction:
   - `purchase_orders` / `purchase_order_lines` / `invoices` / `bank_transactions` / `retailer_payment_details` / `client_deductions` (depending on parser)
   - `invoice_deductions` with `payment_id` set if from payment parser
   - Ledger events for any state changes (PO cancellation, advance conversion, deduction dispute)
7. On commit, projections refresh; notifications fire

---

## Resolved decisions

### Line-level Walmart PO schema (resolved — implemented in 0010)

`purchase_order_lines` table created in migration `0010_purchase_order_lines.sql`. Line-level parser is the default; header-level is a fallback for >1,000-PO exports. Auto-detection by column presence. Upload behavior is full replacement: incoming line-level file wins on header fields AND lines for the POs it covers. See the "Line-level source" section above for the full merge algorithm.

### Kroger PO parser (resolved — placeholder until file arrives)

Stub lives at `packages/retailer-parsers/kroger/purchase-orders/index.ts` throwing a clear error message. Workflow in the meantime:

- When the Kroger invoice parser encounters a `PO number` that doesn't resolve to an existing PO in the system, it emits a warning (not a hard error) and leaves `invoices.purchase_order_id = NULL` for that row.
- The upload summary UI surfaces these unresolved rows prominently with an inline action: "Create PO manually via generic CSV template, then re-resolve."
- The Manager uses the generic Kroger CSV template (covered in the build prompt, not retailer-parser-specific) to create the PO, then clicks "Re-resolve" on the unresolved invoice row. The parser looks up the newly-created PO and sets `purchase_order_id`.
- When the real Kroger PO file arrives (expected 1+ week from 2026-04-23), the stub is replaced with a proper parser and re-ingestion retroactively resolves any lingering manual POs (the `(client_id, retailer_id, po_number)` uniqueness key ensures no duplicates).

Claude Code should build the "Re-resolve" UI action as part of Phase 1 even though it's primarily useful for Kroger in the short term — it's also the correct UX for any future retailer where invoices arrive before POs.

### Kroger dispute workflow UI (resolved — minimal)

Phase 1 UI scope for disputing a `client_deductions` row:

- **On the client_deduction row**: a "Dispute" button (visible to any Manager). Clicking opens a small modal with a required memo field; submitting sets `status = disputed`, `disputed_at = now()`, `disputed_by = current user`, `dispute_memo = memo text`.
- **For rows in disputed state**: a "Resolve" button visible only to Admin Managers. Clicking opens a modal offering two choices:
  - **Upheld**: deduction stands. Sets `status = upheld`, `resolved_at = now()`, `resolved_by = current user`, `resolution_memo = (optional memo)`.
  - **Reversed**: deduction was reversed by retailer. Sets `status = reversed`, `resolved_at = now()`, `resolved_by = current user`, `resolution_memo = (optional memo)`, `reversed_by_bank_txn_id = (user picks from matched bank credits in the last 90 days, or leaves NULL if not yet matched)`.
- **Deductions Report filter**: a status filter with checkboxes for each state (`accepted`, `disputed`, `upheld`, `reversed`). Default shows all.
- **No dedicated Disputes Dashboard in Phase 1.** Schema fields for dispute timing, age, and outstanding dollar are all in place to build a dashboard in Phase 2 without migration.
