# Sea King Capital — Supabase Schema

> Draft v1 for review. Delivered before Walmart/Kroger sample files arrive; retailer-specific staging tables will be a Phase 1 addendum once the files are seen.

This document describes the database schema for the Sea King Capital PO Financing & AR Factoring System. It is organized in five layers:

1. **Reference data** — Clients, retailers, users, roles, rules
2. **Operational entities** — Purchase orders, invoices, batches, advances
3. **Event log** — Append-only record of every financial event
4. **Projections** — Materialized views that compute current state from events
5. **Audit log** — Change tracking for reference data (non-financial edits)

Every design decision traces back to our Q&A. Where a decision was made, I note it inline.

---

## 0. Principles (binding constraints)

These principles are enforced by the schema shape itself. They cannot be worked around without a migration.

- **Money is integer cents.** Every monetary column is `bigint` representing cents. The type system treats 100000 as $1,000.00. No `numeric`, no `decimal`, no `float`. Conversion to display happens at the API boundary.
- **Calendar dates are `date` (not `timestamptz`), anchored to America/New_York.** Every business-meaningful date — Advance Date, Posting Date, Wire Date, Invoice Date — is a `date`. Fee period math is deterministic because we never cross a timezone boundary mid-calculation.
- **Event timestamps are `timestamptz`.** `recorded_at`, `created_at` are `timestamptz` and used only for ordering and audit, never for business logic.
- **Events are append-only.** The `ledger_events` table has no `UPDATE` or `DELETE` grants — not even for `service_role`. Corrections are compensating events.
- **Reference data changes are logged.** Every `UPDATE` or `DELETE` on a reference table writes a row to `audit_log` via trigger.
- **Three-part PO uniqueness.** `(client_id, retailer_id, po_number)` — never `(retailer, po_number)`.
- **Optimistic locking.** Every mutable reference row has a `version integer NOT NULL DEFAULT 1` column. Updates bump it; stale versions reject.
- **RLS on everything.** No table is queryable without a role-scoped policy. Tests assert this.

---

## 1. Reference Data

Stable, CRUD-able entities. Changes are logged to `audit_log` but the rows themselves are mutable.

### `clients`
Represents a company Sea King provides financing to. Each Client has exactly one agreement set (fee rules, borrowing base rules).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `legal_name` | `text` NOT NULL | |
| `display_name` | `text` NOT NULL | Shown in UI |
| `status` | `client_status` NOT NULL | `active`, `inactive`, `paused` |
| `over_advanced_state` | `boolean` NOT NULL DEFAULT false | Maintained by trigger on ledger events |
| `over_advanced_since` | `timestamptz` | Set when state flips true |
| `created_at`, `updated_at`, `version` | standard | |

### `retailers`
The companies Clients sell to (Walmart, Kroger, etc.). Global registry shared across Clients.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `name` | `text` NOT NULL UNIQUE | "Walmart" |
| `display_name` | `text` NOT NULL | |
| `bank_description_patterns` | `text[]` NOT NULL DEFAULT '{}' | Match strings for bank ingestion, e.g. `{"Walmart Inc."}` |
| `has_standardized_parser` | `boolean` NOT NULL DEFAULT false | Walmart=true, Kroger=true initially |
| `created_at`, `updated_at`, `version` | standard | |

### `users`
Authentication is handled by Supabase Auth. This table extends `auth.users` with role and permissions.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK, FK → `auth.users.id`) | |
| `email` | `text` NOT NULL | |
| `role` | `user_role` NOT NULL | `admin_manager`, `operator`, `client`, `investor`, `creditor` |
| `client_id` | `uuid` (FK → `clients.id`) NULL | Required for `client` role, NULL otherwise |
| `status` | `user_status` NOT NULL | `active`, `disabled` |
| `notification_preferences` | `jsonb` NOT NULL DEFAULT `'{}'` | Per-user toggles (aged-out warnings, digest frequency, etc.) |
| `created_at`, `updated_at`, `version` | standard | |

### `user_client_access`
Many-to-many for Managers (and stub Investor/Creditor) who can see multiple Clients. Client-role users have `client_id` directly on `users` and don't use this table.

| Column | Type | Notes |
|---|---|---|
| `user_id` | `uuid` (FK → `users.id`) | PK part 1 |
| `client_id` | `uuid` (FK → `clients.id`) | PK part 2 |
| `granted_by` | `uuid` (FK → `users.id`) | |
| `granted_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

### `investors` / `creditors` (stubs)
Scaffolded per Q&A answer T8. Schema present, no UI in Phase 1. Nullable FK on advances will allow future capital source attribution.

Both tables: `id`, `name`, `contact_email`, `created_at`, `updated_at`, `version`.

### `investor_client_access` / `creditor_client_access`
Many-to-many between stub entities and Clients. Same structure as `user_client_access`.

### `rule_sets`
This is where the event sourcing discipline begins to apply to reference data. A `rule_set` is an **immutable snapshot** of fee rules + borrowing base rules + payment allocation rules. When the Manager "changes rules," we insert a new rule_set row and point the Client at it. Old rule_sets are never mutated — this is what makes "fee rates apply prospectively" work cleanly.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `client_id` | `uuid` (FK → `clients.id`) NOT NULL | Or NULL for the "global template" |
| `effective_from` | `date` NOT NULL | When this rule set began to apply |
| `effective_to` | `date` NULL | NULL = currently active; set when superseded |
| `created_by` | `uuid` (FK → `users.id`) NOT NULL | |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | |
| **Fee rules** | | |
| `period_1_days` | `int` NOT NULL | |
| `period_1_fee_rate_bps` | `int` NOT NULL | Basis points; 300 = 3% |
| `period_2_days` | `int` NOT NULL | |
| `period_2_fee_rate_bps` | `int` NOT NULL | |
| `subsequent_period_days` | `int` NOT NULL | |
| `subsequent_period_fee_rate_bps` | `int` NOT NULL | |
| **Borrowing base rules** | | |
| `po_advance_rate_bps` | `int` NOT NULL | |
| `ar_advance_rate_bps` | `int` NOT NULL | |
| `pre_advance_rate_bps` | `int` NOT NULL | Set to 0 if not offered |
| `ar_aged_out_days` | `int` NOT NULL | Typically 90 |
| `aged_out_warning_lead_days` | `int` NOT NULL DEFAULT 5 | |
| `aged_out_warnings_enabled` | `boolean` NOT NULL DEFAULT true | |
| **Payment allocation** | | |
| `payment_allocation_principal_bps` | `int` NOT NULL | New Q-answer: independent from AR rate |
| `payment_allocation_fee_bps` | `int` NOT NULL | Must sum to 10000 |

**Constraint**: `payment_allocation_principal_bps + payment_allocation_fee_bps = 10000`.

**Fee rate history** is preserved by never updating a rule_set once advances reference it. Each advance stores `rule_set_id_at_creation` — its fee schedule is forever determined by that snapshot. New rule_sets affect new advances only. **Borrowing base rate changes** are applied retroactively by reading the *current* rule_set for the Client, not the one frozen at advance creation — this matches your Q29 answer.

### `batches`
A batch is a grouping of POs/invoices for a single Client.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `client_id` | `uuid` (FK → `clients.id`) NOT NULL | |
| `batch_number` | `int` NOT NULL | Sequential per client, starting at 1 |
| `name` | `text` NOT NULL GENERATED | `'Batch ' || batch_number::text` |
| `created_at`, `updated_at`, `version` | standard | |

`UNIQUE (client_id, batch_number)`.

### `purchase_orders`
The operational entity at the heart of the system.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `client_id` | `uuid` (FK → `clients.id`) NOT NULL | |
| `retailer_id` | `uuid` (FK → `retailers.id`) NOT NULL | |
| `po_number` | `text` NOT NULL | The retailer's PO # |
| `batch_id` | `uuid` (FK → `batches.id`) NULL | NULL until assigned |
| `issuance_date` | `date` NULL | |
| `requested_delivery_date` | `date` NULL | |
| `delivery_location` | `text` NULL | |
| `item_description` | `text` NULL | |
| `quantity_ordered` | `int` NULL | |
| `unit_value_cents` | `bigint` NULL | |
| `po_value_cents` | `bigint` NOT NULL | Canonical PO value |
| `status` | `po_status` NOT NULL DEFAULT `'active'` | `active`, `cancelled`, `partially_invoiced`, `fully_invoiced`, `written_off` |
| `cancellation_reason_category` | `cancellation_reason` NULL | Required when status=cancelled |
| `cancellation_memo` | `text` NULL | Required when status=cancelled |
| `cancelled_at` | `timestamptz` NULL | |
| `cancelled_by` | `uuid` (FK → `users.id`) NULL | |
| `parent_po_id` | `uuid` (FK → `purchase_orders.id`) NULL | For the still-PO portion when a PO is split by partial invoicing |
| `upload_id` | `uuid` (FK → `po_uploads.id`) NULL | |
| `created_at`, `updated_at`, `version` | standard | |

`UNIQUE (client_id, retailer_id, po_number)` — **the three-part key**.

### `purchase_order_lines`
Line-item detail for purchase orders. Added in migration 0010. Primarily populated by Walmart's SupplierOne line-level export; may be populated by any future retailer that provides line detail. **Absence of lines is valid** — it just means the source was header-only (Walmart header export, generic CSV template).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `purchase_order_id` | `uuid` (FK → `purchase_orders.id`) NOT NULL | CASCADE on delete — lines follow their PO |
| `line_number` | `int` NOT NULL | Per-PO sequence starting at 1 |
| `retailer_item_number` | `text` NULL | e.g., Walmart "Walmart item No." |
| `item_description` | `text` NULL | Free text from retailer feed |
| `quantity_ordered` | `int` NULL | |
| `unit_cost_cents` | `bigint` NULL | |
| `line_value_cents` | `bigint` NULL | NULL for cancelled lines (Walmart feeds NaN) |
| `status` | `po_line_status` NOT NULL DEFAULT `'approved'` | `approved`, `received`, `partially_received`, `cancelled` |
| `upload_id` | `uuid` (FK → `po_uploads.id`) NULL | |
| `created_at`, `updated_at`, `version` | standard | |

`UNIQUE (purchase_order_id, line_number)`.

**CHECK constraint**: cancelled lines must have `line_value_cents` either NULL or 0 (the header-level PO total already excludes cancelled-line values by Walmart convention, so this ensures consistency).

**Upload behavior (full replacement, per resolved decision 2026-04-23)**. When a Walmart line-level file is uploaded for a PO that already exists, both the PO's header fields AND all of its lines are replaced atomically in a transaction: `DELETE FROM purchase_order_lines WHERE purchase_order_id = X; INSERT INTO purchase_order_lines (...) [new rows]`. This keeps the mental model simple ("upload latest Walmart data, it wins") and correctly handles cases like a PO being cancelled between a header upload and a subsequent line-level upload.

**Advisory consistency check**. Helper function `po_line_value_variance(po_id)` returns `po.po_value_cents - SUM(line_value_cents WHERE status <> 'cancelled')`. Should always be 0 for POs with lines. Non-zero surfaces as an app-layer warning, not a hard DB error — the parser may occasionally produce small discrepancies we want the Manager to see rather than reject outright.

### `invoices`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `purchase_order_id` | `uuid` (FK → `purchase_orders.id`) NOT NULL | |
| `invoice_number` | `text` NOT NULL | |
| `invoice_value_cents` | `bigint` NOT NULL | |
| `invoice_date` | `date` NULL | |
| `due_date` | `date` NULL | |
| `goods_delivery_date` | `date` NULL | |
| `goods_delivery_location` | `text` NULL | |
| `approval_status` | `text` NULL | Free-form from retailer |
| `item_description` | `text` NULL | |
| `paid_in_full_date` | `date` NULL | Set when principal on this invoice reaches 0 |
| `upload_id` | `uuid` (FK → `invoice_uploads.id`) NULL | |
| `created_at`, `updated_at`, `version` | standard | |

`UNIQUE (purchase_order_id, invoice_number)` — an invoice number is unique within its PO (one retailer can reissue invoice # 12345 across different POs).

### `invoice_deductions`
Per your answer to Q25/T12 — explicit modeling, not just net-paid.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `invoice_id` | `uuid` (FK → `invoices.id`) NOT NULL | |
| `category` | `deduction_category` NOT NULL | `shortage`, `damage`, `otif_fine`, `pricing`, `promotional`, `other` |
| `amount_cents` | `bigint` NOT NULL CHECK (amount_cents > 0) | |
| `memo` | `text` NULL | |
| `known_on_date` | `date` NOT NULL | When we learned of the deduction (typically payment date) |
| `payment_id` | `uuid` (FK → `payments.id`) NULL | The payment that revealed the deduction, if any |
| `created_at`, `updated_at`, `version` | standard | |

### `client_deductions`
Client-level deductions that are **not tied to a specific invoice**. Added in migration 0009. Supports retailers (notably Kroger) that assess promotional allowances, post-audit recoveries (e.g. via PRGX), and other net-against-payment charges at the vendor level rather than per-invoice.

Distinct from `invoice_deductions` — `invoice_deductions` requires an `invoice_id`; `client_deductions` does not. Both are surfaced together via the `v_all_deductions` view for the Deductions Report.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `client_id` | `uuid` (FK → `clients.id`) NOT NULL | |
| `retailer_id` | `uuid` (FK → `retailers.id`) NOT NULL | |
| `source_ref` | `text` NOT NULL | Retailer's own reference (e.g., Kroger `092-AE38942-011`) |
| `source_category` | `client_deduction_source` NOT NULL | `promo_allowance`, `non_promo_receivable`, `netting_offset`, `chargeback`, `other` |
| `source_subcategory` | `text` NULL | Retailer-specific sub-bucket (e.g., `PromoBilling` vs `PRGX`) |
| `amount_cents` | `bigint` NOT NULL CHECK (> 0) | Always positive (debit to Client's receivables) |
| `division`, `location_description` | `text` NULL | Context from source file |
| `memo` | `text` NULL | |
| `known_on_date` | `date` NOT NULL | When we became aware (typically the source invoice date or upload date) |
| `source_invoice_date` | `date` NULL | Retailer's reported date for this deduction |
| `status` | `client_deduction_status` NOT NULL DEFAULT `'accepted'` | `accepted`, `disputed`, `upheld`, `reversed` |
| `disputed_at` / `disputed_by` / `dispute_memo` | tracking | Set when Manager disputes |
| `resolved_at` / `resolved_by` / `resolution_memo` | tracking | Set when dispute resolves |
| `reversed_by_bank_txn_id` | `uuid` (FK → `bank_transactions.id`) NULL | For `status = reversed`: the bank credit that reflected the retailer returning the money |
| `netted_in_payment_ref` | `text` NULL | Retailer's payment reference number that netted this deduction (e.g., Kroger `6833532`) — useful for reports without joining through `payment_bank_links` |
| `upload_id` | `uuid` (FK → `invoice_uploads.id`) NULL | |
| `created_at`, `updated_at`, `version` | standard | |

**Uniqueness**: `UNIQUE (client_id, retailer_id, source_ref)` — re-uploading the same source file does not create duplicates.

**Status lifecycle**: `accepted → (optional) disputed → (resolved: upheld | reversed)`. CHECK constraint enforces field consistency across states (can't be `disputed` without `disputed_at`; can't be `reversed` without `reversed_by_bank_txn_id`).

**Why separate from `invoice_deductions`?** Invoice deductions are real-time at-payment adjustments tied to a specific invoice (e.g., Walmart's Type 57/59 deductions on a specific PO's payment). Client deductions are vendor-wide administrative charges (Kroger promo allowances, PRGX recoveries) that could have been assessed against literally any invoice in the payment batch — they're a Client-level balance, not an invoice-level one. Combining them into one table would either require a nullable `invoice_id` (loses the strong FK for invoice deductions) or stretch the model awkwardly.

**View `v_all_deductions`**: unions the two tables for the Deductions Report:

```sql
SELECT 'invoice' AS deduction_level, ... FROM invoice_deductions JOIN invoices ...
UNION ALL
SELECT 'client' AS deduction_level, ... FROM client_deductions;
```

RLS is inherited from the underlying tables.

### `advances`
**This is a reference-projection hybrid.** The `advances` table holds the *identity* and *immutable parameters* of an advance — its Advance Date, its rule_set, its initial principal, which PO/invoice it originated on. The *running balances* (current principal outstanding, current fees outstanding) are computed by views/projections from ledger events. This separation is critical: it means we can always reconstruct any advance's state at any historical moment by filtering events by date.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `client_id` | `uuid` (FK → `clients.id`) NOT NULL | Denormalized for RLS perf |
| `purchase_order_id` | `uuid` (FK → `purchase_orders.id`) NOT NULL | |
| `invoice_id` | `uuid` (FK → `invoices.id`) NULL | NULL when this is a PO advance; set on conversion |
| `batch_id` | `uuid` (FK → `batches.id`) NOT NULL | Batch at creation; follows PO/invoice on reassignment |
| `advance_type` | `advance_type` NOT NULL | `po`, `ar`, `pre_advance` |
| `advance_date` | `date` NOT NULL | Drives fee clock; user-set, equal to wire date |
| `initial_principal_cents` | `bigint` NOT NULL CHECK (initial_principal_cents > 0) | |
| `rule_set_id` | `uuid` (FK → `rule_sets.id`) NOT NULL | Frozen at creation; fee rules permanent |
| `committed_at` | `timestamptz` NOT NULL DEFAULT `now()` | When Manager clicked commit |
| `funded_at` | `timestamptz` NULL | Set on bank-statement match or manual mark |
| `funded_wire_number` | `text` NULL | |
| `status` | `advance_status` NOT NULL DEFAULT `'committed'` | `committed`, `funded`, `paid_in_full`, `transferred_out`, `written_off`, `reversed` |
| `transferred_from_advance_id` | `uuid` (FK → `advances.id`) NULL | If this is a destination of a bad-standing transfer |
| `transferred_to_advance_id` | `uuid` (FK → `advances.id`) NULL | If this was transferred out |
| `advance_request_id` | `uuid` (FK → `advance_requests.id`) NULL | If fulfilling a Client request |
| `capital_source_investor_id` | `uuid` (FK → `investors.id`) NULL | Phase 2 stub |
| `capital_source_creditor_id` | `uuid` (FK → `creditors.id`) NULL | Phase 2 stub |
| `created_at`, `updated_at`, `version` | standard | |

### `one_time_fees`
Per T3 — three target types, collected alongside their target's priority; client-level fees get Priority 0.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `client_id` | `uuid` (FK → `clients.id`) NOT NULL | |
| `target_type` | `fee_target_type` NOT NULL | `advance`, `purchase_order`, `invoice`, `batch`, `client` |
| `target_id` | `uuid` NULL | NULL when target_type=client; otherwise matches target_type table |
| `amount_cents` | `bigint` NOT NULL | |
| `description` | `text` NOT NULL | |
| `assessed_date` | `date` NOT NULL | |
| `assessed_by` | `uuid` (FK → `users.id`) NOT NULL | |
| `created_at`, `updated_at`, `version` | standard | |

A CHECK constraint enforces: `target_id IS NULL` iff `target_type = 'client'`.

### `advance_requests`
Client-initiated via portal (per T5).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `client_id` | `uuid` NOT NULL | |
| `requested_by` | `uuid` (FK → `users.id`) NOT NULL | |
| `requested_amount_cents` | `bigint` NOT NULL | |
| `context_text` | `text` NULL | Client's justification |
| `status` | `advance_request_status` NOT NULL | `pending`, `approved`, `rejected`, `fulfilled` |
| `reviewed_by` | `uuid` (FK → `users.id`) NULL | |
| `reviewed_at` | `timestamptz` NULL | |
| `rejection_reason` | `text` NULL | |
| `created_at`, `updated_at`, `version` | standard | |

### `advance_request_attachments`
Invoice files / supporting docs attached by the Client (T6, stored in Supabase Storage).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `advance_request_id` | `uuid` (FK → `advance_requests.id`) NOT NULL | |
| `storage_path` | `text` NOT NULL | Supabase Storage path |
| `filename` | `text` NOT NULL | |
| `mime_type` | `text` NOT NULL | |
| `size_bytes` | `bigint` NOT NULL | |
| `uploaded_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

### Upload metadata tables (retained indefinitely per T6)

- `po_uploads`, `invoice_uploads`, `bank_uploads`, `retailer_payment_uploads` — each stores the original file in Supabase Storage with upload timestamp, uploader, retailer (if applicable), and parser version used. Every ingested row links back to its upload via `upload_id` FK.

### `bank_transactions`
Raw line items from bank statement ingestion.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `bank_upload_id` | `uuid` (FK → `bank_uploads.id`) NOT NULL | |
| `client_id` | `uuid` (FK → `clients.id`) NOT NULL | |
| `posting_date` | `date` NOT NULL | |
| `description` | `text` NOT NULL | |
| `amount_cents` | `bigint` NOT NULL | Signed |
| `bank_classified_type` | `text` NOT NULL | `ACH_CREDIT`, `WIRE_INCOMING`, `WIRE_OUTGOING`, `ACCT_XFER` |
| `direction` | `bank_direction` NOT NULL | `credit`, `debit` |
| `retailer_id` | `uuid` (FK → `retailers.id`) NULL | Derived; editable |
| `memo_classification` | `bank_memo_class` NULL | `remittance_wire`, `advance_funding`, `internal_transfer`, `unknown` |
| `status` | `bank_txn_status` NOT NULL DEFAULT `'unassigned'` | `unassigned`, `matched`, `batch_applied`, `remittance`, `ignored` |
| `principal_only_override` | `boolean` NOT NULL DEFAULT false | Per-payment waterfall override |
| `created_at`, `updated_at`, `version` | standard | |

### `retailer_payment_details`
Rows from retailer payment CSVs (Walmart, Kroger).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `retailer_payment_upload_id` | `uuid` (FK → `retailer_payment_uploads.id`) NOT NULL | |
| `retailer_id` | `uuid` (FK → `retailers.id`) NOT NULL | |
| `purchase_order_number` | `text` NOT NULL | |
| `invoice_number` | `text` NOT NULL | |
| `payment_date` | `date` NOT NULL | |
| `invoice_date` | `date` NULL | |
| `invoice_amount_cents` | `bigint` NOT NULL | |
| `discount_cents` | `bigint` NOT NULL DEFAULT 0 | |
| `deduction_cents` | `bigint` NOT NULL DEFAULT 0 | |
| `paid_amount_cents` | `bigint` NOT NULL | |
| `matched_bank_transaction_id` | `uuid` (FK → `bank_transactions.id`) NULL | Filled by matcher |
| `match_type` | `match_type` NULL | `strict`, `fuzzy`, `manual` |
| `resolved_invoice_id` | `uuid` (FK → `invoices.id`) NULL | Resolved from po+invoice # + client context |
| `created_at`, `updated_at`, `version` | standard | |

### `payment_bank_links`
Links a `bank_transaction` (Matched or Batch Applied) to the specific POs/invoices/batches it pays. This is what enables "trace back every dollar."

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `bank_transaction_id` | `uuid` (FK → `bank_transactions.id`) NOT NULL | |
| `target_type` | `payment_link_target` NOT NULL | `invoice`, `batch` |
| `target_id` | `uuid` NOT NULL | FK to invoices or batches depending on target_type |
| `amount_cents` | `bigint` NOT NULL | Sub-allocation of the bank amount to this target |

### `remittances`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `client_id` | `uuid` (FK → `clients.id`) NOT NULL | |
| `wire_amount_cents` | `bigint` NOT NULL | |
| `wire_date` | `date` NOT NULL | Manager-entered, editable |
| `wire_tracking_number` | `text` NOT NULL | |
| `created_by` | `uuid` (FK → `users.id`) NOT NULL | |
| `created_at`, `updated_at`, `version` | standard | |

---

## 2. Event Log

This is the heart of the system. The `ledger_events` table is **append-only**, **immutable**, and **the source of truth** for every financial state.

### `ledger_events`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `client_id` | `uuid` (FK → `clients.id`) NOT NULL | Denormalized for RLS performance |
| `event_type` | `ledger_event_type` NOT NULL | See enum below |
| `event_seq` | `bigint` GENERATED ALWAYS AS IDENTITY | Monotonic ordering |
| `effective_date` | `date` NOT NULL | Business date the event applies to |
| `recorded_at` | `timestamptz` NOT NULL DEFAULT `now()` | System time |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | = recorded_at; retained for event-sourcing convention |
| `created_by` | `uuid` (FK → `users.id`) NOT NULL | |
| **Relationships** (nullable; present or NULL based on event_type) | | |
| `advance_id` | `uuid` (FK → `advances.id`) NULL | |
| `purchase_order_id` | `uuid` (FK → `purchase_orders.id`) NULL | |
| `invoice_id` | `uuid` (FK → `invoices.id`) NULL | |
| `batch_id` | `uuid` (FK → `batches.id`) NULL | |
| `bank_transaction_id` | `uuid` (FK → `bank_transactions.id`) NULL | |
| `remittance_id` | `uuid` (FK → `remittances.id`) NULL | |
| `one_time_fee_id` | `uuid` (FK → `one_time_fees.id`) NULL | |
| **Amounts** | | |
| `principal_delta_cents` | `bigint` NOT NULL DEFAULT 0 | Signed; +advance, -payment-to-principal |
| `fee_delta_cents` | `bigint` NOT NULL DEFAULT 0 | Signed; +accrual, -collection |
| `remittance_delta_cents` | `bigint` NOT NULL DEFAULT 0 | + when payment routes to remittance bucket, - when wire sent |
| **Metadata** | | |
| `notes` | `text` NULL | |
| `reverses_event_id` | `uuid` (FK → `ledger_events.id`) NULL | Set on compensating events |
| `reversed_by_event_id` | `uuid` (FK → `ledger_events.id`) NULL | Back-pointer; maintained by trigger |
| `metadata` | `jsonb` NOT NULL DEFAULT `'{}'` | Waterfall priority tag, allocation ratio, etc. |

### Event types (`ledger_event_type` enum)

| Event type | Deltas | Description |
|---|---|---|
| `advance_committed` | +principal | Manager commits a new advance |
| `advance_funded` | (none, status only) | Wire confirmed |
| `fee_accrued` | +fee | A fee period rolled over |
| `one_time_fee_assessed` | +fee | Manager adds a one-time fee |
| `payment_applied_to_principal` | -principal | Waterfall allocation |
| `payment_applied_to_fee` | -fee | Waterfall allocation |
| `payment_routed_to_remittance` | +remittance | Excess collection → remittance bucket |
| `remittance_wire_sent` | -remittance | Manager records outgoing wire |
| `advance_reversed` | opposite deltas | Undo |
| `po_converted_to_ar` | (link-change only) | Invoice upload converts PO advance to AR |
| `pre_advance_converted` | (link-change only) | Pre-advance binds to invoice |
| `balance_transferred_out` | -principal, -fee | Source side of bad-standing transfer |
| `balance_transferred_in` | +principal, +fee | Destination side |
| `advance_written_off` | -principal, -fee | Admin Manager writes off |
| `po_cancelled` | (status change) | Cancellation recorded |

### Waterfall metadata

When a payment is applied, each event's `metadata` captures the priority tier it landed on. For an invoice-level payment hitting fee priority 1:
```json
{ "waterfall": "invoice", "bucket": "fee", "priority": 1, "source_bank_transaction_id": "..." }
```
This makes the full waterfall execution reconstructible from events alone — critical for auditing unusual payment runs.

### Invariant enforcement

Database constraints enforce:

- `advance_committed` MUST have `advance_id` not null and `principal_delta_cents > 0`.
- `fee_accrued` and `one_time_fee_assessed` MUST have `fee_delta_cents > 0` and must match the assessed target.
- Payment events MUST have a `bank_transaction_id`.
- `remittance_wire_sent` MUST have a `remittance_id` and `remittance_delta_cents < 0`.
- Reversal events MUST have `reverses_event_id` not null.

---

## 3. Projections (Materialized Views)

These views compute current state from the event log. They're refreshed incrementally via triggers on `ledger_events` insert. All reads (including RLS-constrained Client portal queries) hit views, never raw events.

### `mv_advance_balances`

For every advance, current principal and fee outstanding.

```sql
CREATE MATERIALIZED VIEW mv_advance_balances AS
SELECT
  a.id AS advance_id,
  a.client_id,
  a.purchase_order_id,
  a.invoice_id,
  a.batch_id,
  a.advance_type,
  a.advance_date,
  a.status,
  COALESCE(SUM(e.principal_delta_cents), 0) AS principal_outstanding_cents,
  COALESCE(SUM(e.fee_delta_cents), 0) AS fees_outstanding_cents,
  MAX(e.effective_date) FILTER (WHERE e.principal_delta_cents < 0) AS last_principal_payment_date
FROM advances a
LEFT JOIN ledger_events e ON e.advance_id = a.id AND e.reversed_by_event_id IS NULL
GROUP BY a.id;
```

The `reversed_by_event_id IS NULL` filter automatically excludes events that have been compensated by a reversal — clean undo behavior.

### `mv_client_position`

Rolled-up per-Client metrics for the Main Interface.

```sql
-- Key fields (abbreviated):
-- po_principal_outstanding_cents
-- ar_principal_outstanding_cents
-- pre_advance_principal_outstanding_cents
-- total_fees_outstanding_cents
-- po_borrowing_base_cents         (computed via current rule_set)
-- ar_borrowing_base_cents         (aged-out invoices excluded)
-- pre_advance_borrowing_base_cents
-- po_borrowing_base_available_cents
-- ar_borrowing_base_available_cents
-- pre_advance_borrowing_base_available_cents
-- remittance_balance_cents
-- is_over_advanced (boolean)
```

### `mv_fee_accrual_schedule`

Per-advance forecast of upcoming fee events. Drives the aged-out warning job and the fee accrual daily job.

### `mv_invoice_aging`

Invoice-level view with days outstanding, age bucket (`current`, `1-30`, `31-60`, `61-90`, `90+`), borrowing base contribution.

### `mv_batch_position`

Per-batch rollup for the "Assign to Batch" table and batch-level waterfall calculations.

### Refresh strategy

Supabase's Postgres supports `REFRESH MATERIALIZED VIEW CONCURRENTLY`. A trigger on `ledger_events` inserts a notify on a background job queue; a worker coalesces refreshes (no more than one per view per 2 seconds). For Phase 1 this is fine; if we hit scale issues we move to incremental view maintenance via `pg_ivm` or hand-maintained projection tables.

**Determinism check**: a scheduled test (daily) rebuilds `mv_advance_balances` from scratch and diffs against the current state. Any drift is an alert.

---

## 4. Audit Log

Reference data changes (uploading a new PO, editing a retailer's bank pattern, changing a user's role, etc.) are logged here via triggers. Financial events go to `ledger_events` instead.

### `audit_log`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `table_name` | `text` NOT NULL | |
| `row_id` | `uuid` NOT NULL | |
| `operation` | `text` NOT NULL | `INSERT`, `UPDATE`, `DELETE` |
| `changed_by` | `uuid` (FK → `users.id`) NULL | NULL for system-driven changes |
| `changed_at` | `timestamptz` NOT NULL DEFAULT `now()` | |
| `before` | `jsonb` NULL | Row state before |
| `after` | `jsonb` NULL | Row state after |
| `client_id` | `uuid` NULL | Extracted for RLS filtering |

Triggers on every reference table call a shared `log_change()` function. `purchase_order_lines` uses a custom variant (`log_po_line_change()`) that extracts `client_id` via the parent PO for audit filtering, since the lines table doesn't carry `client_id` directly.

---

## 5. RLS Policies (overview)

All tables have RLS enabled. Policies use a helper function `current_user_client_ids()` that returns the set of client IDs the calling user has access to.

### Manager (admin_manager, operator)
- Full access to rows where `client_id IN current_user_client_ids()`.
- `ledger_events` insert allowed; update/delete disallowed (even for admin — event sourcing is non-negotiable).
- Operator cannot insert into `rule_sets` (only admin_manager can).

### Client
- Read-only access to rows where `client_id = users.client_id` (for the authenticated user's row).
- Client portal reads go through a set of sanitized views that strip out fields like `capital_source_*` and internal notes.
- Client CAN insert into `advance_requests` and `advance_request_attachments` scoped to their own client_id.

### Investor / Creditor (stub)
- Read-only access to summary views (`mv_client_position`) for clients linked via `investor_client_access` / `creditor_client_access`.
- No access to underlying rows.

### RLS test policy
Every RLS policy has a corresponding pgTAP test that:
1. Creates a user of role X with access to client A.
2. Inserts rows for client A and client B.
3. Asserts the user sees only client A's rows across all tables.

Tests run on every migration.

---

## ERD (visual)

See `ERD.svg` for the full cross-schema relationships diagram (5 layers: reference, operational, event, projection, audit). See `ERD_supplement.svg` for a focused view of the two tables added in migrations 0009 (`client_deductions`) and 0010 (`purchase_order_lines`), including the CASCADE relationship between `purchase_orders` and `purchase_order_lines` and the upload-path linkage.

---

## What's NOT in Phase 1 schema

- Investor/Creditor UI tables beyond the stubs (preferences, document storage per entity, return computation caches).
- Multi-currency — no FX columns.
- 1099 form generation — Year-End Fee Summary is a report, not a form generator.
- Client-facing document signing (e.g., remittance acknowledgments).

---

## Implementation file layout

```
packages/db/
├── migrations/
│   ├── 0001_extensions_and_enums.sql
│   ├── 0002_reference_tables.sql
│   ├── 0003_operational_tables.sql
│   ├── 0004_event_log.sql
│   ├── 0005_projections.sql
│   ├── 0006_audit_log.sql
│   ├── 0007_rls_policies.sql
│   ├── 0008_seed_system_retailers.sql
│   ├── 0009_client_deductions.sql
│   └── 0010_purchase_order_lines.sql
├── seed/
│   └── dev_seed.sql
└── types.ts        # auto-generated from schema
```

All 10 migrations parse cleanly against pglast (PostgreSQL's grammar). Each is idempotent and uses `IF NOT EXISTS` where applicable. Migration 0009 adds the `client_deductions` table (supports Kroger promo allowances and PRGX recoveries); migration 0010 adds the `purchase_order_lines` table (supports Walmart line-level PO data — the default Walmart upload format).
