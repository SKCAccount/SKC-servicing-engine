# Sea King Capital — Project-level context for Claude Code sessions

This is the top-level `CLAUDE.md` read by every Claude Code session. It holds the invariants, conventions, and pointers you need to orient in any file.

**Read in this order when starting a session:**
1. This file (`CLAUDE.md`) — invariants, conventions, reading order
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — module layering, auth flow, data flow, patterns for common tasks
3. The relevant package's `README.md` before editing inside that package
4. The git log (`git log --oneline -30`) to see what's been shipped recently

When the user's ask is ambiguous, prefer asking before assuming. Every ambiguity silently resolved is a future bug.

---

## What this app is

Sea King Capital provides two forms of financing to CPG companies:

- **PO financing** — advance capital against a retailer's purchase order before fulfillment. The PO is collateral.
- **AR factoring** — advance capital against an invoice. The invoice is collateral; when the retailer pays, we collect.

This monorepo is the system of record. It replaces Excel. Every PO, invoice, advance, fee, payment, and remittance flows through it. Users: Manager (Admin/Operator), Client (read-only portal + advance requests), and stubbed Investor/Creditor roles.

Derek is the founder, primary user, and a beginner developer. Favor explicit clarity over cleverness. Complete updated files over snippets when refactoring.

---

## Non-negotiable invariants (schema-enforced)

1. **Money is integer cents** (`bigint`). No float/numeric/decimal. Display conversion only at the API/UI boundary. Use `packages/money/` for all arithmetic.
2. **Calendar dates are `date`** anchored to America/New_York. Event timestamps are `timestamptz` used only for ordering.
3. **`ledger_events` is append-only.** Enforced by a DB trigger that blocks UPDATE/DELETE (even for `service_role`). Corrections are compensating events.
4. **Three-part PO uniqueness**: `(client_id, retailer_id, po_number)`. Never `(retailer, po_number)`.
5. **Optimistic locking** via `version` column on every mutable table. Increment on update; reject stale versions.
6. **RLS on every table.** Deny-by-default, scope by Client via `current_user_client_ids()`.
7. **Fee rates are prospective; borrowing base rates are retroactive.** `advances` reference `rule_set_id` at creation (frozen fees). Borrowing base reads `current_rule_set(client_id)` (retroactive).
8. **Event sourcing discipline.** Current state is derivable from `ledger_events` alone. Never mutate state without an event.
9. **Domain package purity.** `packages/domain/` and `packages/retailer-parsers/` have no I/O. No DB, no HTTP, no filesystem. Pure functions, tests need no mocks.
10. **Parsers are pure.** `packages/retailer-parsers/*`: bytes in, `ParseResult` out. Upload handler does the persistence.

---

## Terminology conventions

Sea King **never uses loan vocabulary**:

| Avoid | Use |
|---|---|
| loan, borrow | **advance** |
| interest | **fees** |
| draw request | **advance request** |
| borrower | **Client** |

---

## Repository layout

```
sea-king-command/
├── apps/
│   ├── manager/         # Next.js App Router — primary Manager UI
│   ├── client-portal/   # Next.js App Router — read-only Client views + Advance Request form
│   └── jobs/            # Supabase Edge Functions — daily fee accrual, weekly digest, aged-out warnings
├── packages/
│   ├── money/           # Cents type, ratable allocation with deterministic tie-breaking
│   ├── dates/           # America/New_York helpers, fee-period math
│   ├── validators/      # Zod schemas at API boundaries
│   ├── db/              # Supabase migrations + generated types (types.ts)
│   ├── auth/            # Supabase Auth wrappers + role resolution
│   ├── ui/              # Shared shadcn/ui component library
│   ├── api/             # Shared API types
│   ├── notifications/   # Resend templates + dispatch
│   ├── domain/          # Borrowing-base + ratio-leveling allocation; pure
│   ├── retailer-parsers/# Walmart PO + generic CSV (Kroger PO stubbed)
│   └── (future) events/, bank-parsers/
└── tests/               # pgTAP tests
```

Each package has its own `README.md`. Read it before editing that package.

---

## Tech stack

- **Runtime**: Node.js 20+, TypeScript 5.7 strict mode (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- **Package manager**: pnpm workspaces
- **Web framework**: Next.js 15 App Router
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **Database**: Supabase (PostgreSQL 15+, Auth, Storage, Edge Functions)
- **Validation**: Zod at every API boundary
- **Testing**: Vitest (unit), pgTAP (RLS), Playwright (E2E, later)
- **Email**: Resend

---

## Build / test / run

```bash
# Install
pnpm install

# Dev (both apps in parallel)
pnpm dev

# Dev (one app)
pnpm dev:manager
pnpm dev:client-portal

# Type check and lint everything
pnpm typecheck
pnpm lint

# Unit tests
pnpm test

# DB ops (requires `supabase link` once)
pnpm db:push         # apply local migrations to linked project
pnpm db:types        # regenerate packages/db/src/types.ts
```

### Supabase dashboard configuration (NOT in code)

Some settings live only in the Supabase project dashboard and must be applied manually in each environment:

**Authentication → URL Configuration**
- **Site URL**: canonical production URL of the Manager app (localhost:3000 for dev)
- **Redirect URLs** (allowlist — add one per environment):
  - `http://localhost:3000/auth/callback`
  - `http://localhost:3001/auth/callback`
  - production equivalents when deployed

**Authentication → Email Templates** (optional but recommended)
- Default templates use `{{ .ConfirmationURL }}` which routes through Supabase's `/auth/v1/verify` endpoint. That works with our unified `/auth/callback` handler. No template changes required.

Without the redirect allowlist, `inviteUserByEmail` and `resetPasswordForEmail` both fail silently (Supabase refuses to embed a non-allowlisted `redirectTo`).

---

## What's shipped

See `git log --oneline` for the canonical history. Phase progress:

- **Phase 1A** (commit `97807f0`): monorepo scaffold, money + dates + validators packages, login + empty Client Selection, migrations 0001-0010 applied.
- **Phase 1B**: completed auth (invite + password reset, `/auth/callback` handles BOTH PKCE and OTP flows), Client CRUD (admin-only), Set Borrowing Base and Fee Rules screen with `upsert_rule_set` RPC, user invitation flow.
- **Phase 1C**: `@seaking/retailer-parsers` package with Walmart PO parser (header + line-level + auto-detect) and generic CSV PO template; PO Upload UI + Supabase Storage + `bulk_upsert_purchase_orders` RPC; PO list view with filters + sortable columns + configurable pagination.
- **Phase 1D commits 1-3 + follow-on fixes**: `@seaking/domain` package (borrowing-base math + ratio-leveling allocation, 38 tests); `commit_po_advance` RPC; Advance on Purchase Orders UI with multi-page selection, filter/sort/pagination, "select all matches" across pages (parallel-paginated, 5,000-row hard cap), and batch-reassignment acknowledgement.
- **Phase 1D commit 4** — standalone Assign-to-Batch screen at `/clients/[id]/batches/assign`. Migration 0019 adds `po_batch_reassigned` to `ledger_event_type`; migration 0020 ships `v_purchase_orders_with_balance` (pre-joined PO + outstanding-principal view), the `reassign_to_batch` RPC, and retrofits `commit_po_advance` to emit the same event whenever it reassigns POs. Both paths now write per-PO `po_batch_reassigned` events with `metadata.from_batch_id` / `to_batch_id` / `source`.
- **Phase 1D commit 5** — per-Client dashboard aggregate metrics. The 13-metric "Main Interface" block (PO/AR/Pre-Advance principal + value + ratio + BB available, total fees, remittance balance, over-advanced flag) at the top of `/clients/[id]`, with a URL-driven Batch filter. Server-side helper `loadClientPosition(clientId, batchId)` reads `mv_client_position` for the unfiltered view and computes per-batch metrics inline via 5 parallel queries when filtered.
- **CSV-of-PO-numbers secondary entry path** (Phase 1C deferral, shipped post-1D-5) — two-column CSV (`Purchase Order Number`, `Retailer`) on the Advance on POs page. Parser in `@seaking/retailer-parsers/advance-csv/po-numbers` (12 tests), template at `/api/advance-template/po-numbers`, server action `matchPosFromCsvAction` resolves retailer slugs, looks up POs, classifies into matched / unmatched / skipped, and surfaces "Export unmatched as CSV".
- **Per-underlying floor borrowing base** (post-1D-5 fix) — migration 0021 rebuilds `mv_client_position` so each underlying's BB contribution is `floor(value × rate / 10000)` summed per Client (not aggregate × rate). `@seaking/money` adds `applyBpsFloor`; `@seaking/domain`'s borrowing-base helpers and `summarizeSelectedPos` use it. `planPoAdvance` post-clamps deterministic-rounding output so no individual PO ends up over its floored room. Resolves a real bug where pro-forma ratio could creep above the rate cap and a UI display garbage where fractional cents flowed through `formatDollars`.
- **Phase 1E-1 — XLSX infra + Walmart invoice parser.** `@seaking/retailer-parsers/xlsx.ts` shared utility (parallels `csv.ts`) wraps `exceljs` and normalizes cell values to strings (Date → ISO, rich text → concatenated, BOM stripped). `@seaking/retailer-parsers/walmart/invoices` ships a pure parser implementing the spec's three-way row routing (real invoice / RETURN CENTER CLAIMS chargeback → `client_deductions` / SKIP) plus `Allowance Amt` extraction → `invoice_deductions`. 34 tests covering the real fixture + synthetic edge cases.
- **Phase 1E-2 — Kroger invoice parser.** Same shape as Walmart, but the routing is the three-way category split (`Warehouse` → `invoices`; `Promo Allowances` → `client_deductions` with `source_subcategory='PromoBilling'`; `Non-Promo Receivable` → `client_deductions` with `source_subcategory='PRGX'`). Sign-vs-category cross-check (Warehouse positive, others negative), date-anomaly warning when received < invoice date, invoice-number format heuristic (short integer = warehouse, long hyphenated = promo/NPR). 29 tests. Real fixture has one row with empty Net amount that the parser correctly skips with `unparseable_net_amount` — documented inline.
- **Type filter on Assign-to-Batch.** `/clients/[id]/batches/assign` now supports a multi-select Type filter (PO Advance / AR Advance / Pre-Advance) with the same comma-separated URL convention as Batch and Status. URL: `?type=po_advance,ar_advance`. Today only `po_advance` rows actually exist; the filter is future-proof scaffolding for when 1E-3 (invoice upload) and pre-advance creation land. When the filter excludes `po_advance`, the page short-circuits the PO query and returns zero rows.

Coming in Phase 1E-3 onward: invoice upload UI + `commit_invoice_upload` RPC handling PO→AR conversion, partial invoicing splits, pre-advance conversion. Walmart/Kroger payment parsers + waterfall in 1F.

---

## Commit conventions

Conventional Commits style, scoped by package:

- `feat(money): add ratable allocation with deterministic tie-breaking`
- `feat(walmart-parser): handle multi-row payment structure with deduction extraction`
- `fix(waterfall): correct cascade from fee priority 7 to principal priorities`
- `refactor(schema): drop redundant index on advances.po_id`
- `test(rls): add cross-tenant read assertions for advances`

Small, focused commits. Derek reads the git log.

---

## Key references

| Source material | Path |
|---|---|
| Architecture overview (read second) | `ARCHITECTURE.md` |
| Build prompt (orientation) | `docs/BUILD_PROMPT.md` |
| Functional spec (canonical behavior) | `docs/01_FUNCTIONAL_SPEC.md` |
| Schema narrative | `docs/02_SCHEMA.md` |
| Parser specs | `docs/03_PARSERS.md` |
| ERDs | `docs/ERD.svg`, `docs/ERD_supplement.svg` |

When spec and schema disagree, the schema is authoritative. When spec and parser docs disagree, the parser docs win for parser-specific concerns. When in doubt, flag to Derek rather than silently assuming.

---

## Decisions already locked (do not re-litigate without explicit confirmation)

See `docs/BUILD_PROMPT.md` §7 for the full list. Highlights:

- Integer cents (`bigint`) storage; conversion at boundaries
- Three-part PO key `(client_id, retailer_id, po_number)`
- Event log append-only at DB level
- Rule sets immutable; fees prospective, borrowing base retroactive
- Payment allocation split: two independent inputs, must sum to 100
- Waterfall Model A (single split at top, cascade across buckets)
- Advance lifecycle: `committed` → `funded`
- Two-pass matcher: strict exact → fuzzy (±3 days for Walmart/Kroger, ±1 day default) → manual
- `invoice_deductions` (invoice-specific) + `client_deductions` (vendor-wide) unioned via `v_all_deductions`
- Chase bank parser Phase 1 only — note the 8 data columns / 7 header columns quirk
- **PO advance allocation = ratio leveling.** When advancing across selected POs, lift the lowest-ratio tier to match the next-lowest, repeat, then ratably distribute any remainder by PO value across the merged set. Every PO ends at the same final ratio. Implementation in `packages/domain/src/po-advance.ts` finds the target ratio analytically (not by iteration with integer rounding, which stalls on sub-cent ratio gaps).
- **Walmart line-level PO uploads = full replacement.** When a line-level file covers a PO that already exists, both header fields AND all `purchase_order_lines` rows are replaced atomically. Implemented in `bulk_upsert_purchase_orders` RPC.
- **Generic CSV requires `Retailer` column per row.** Single upload may legitimately span multiple retailers. Server resolves each row's slug case-insensitively against `retailers.name` OR `display_name`, groups rows by resolved retailer_id, calls `bulk_upsert_purchase_orders` once per group (each group atomic; cross-group is independent). Unresolved retailer slugs surface as skipped rows in the upload review. Admin must pre-create new retailers in `retailers` table (Studio only — no UI yet).
- **Advance batch reassignment = explicit acknowledgement.** When committing an advance reassigns selected POs from a different batch, the UI surfaces an amber warning with the affected PO list and a required ack checkbox. The `commit_po_advance` RPC also moves all existing committed/funded advances on those POs to the destination batch (per spec: `advance.batch_id` follows PO/invoice on reassignment). `ledger_events.batch_id` stays immutable — historical fact.
- **Two ack flags on `CommitPoAdvanceInput`**: `acknowledged_over_advanced` (any pro-forma ratio > 100%) and `acknowledged_batch_reassignment`. Both default to false; UI checks both before allowing commit.
- **Batch reassignment is a first-class ledger event.** Every PO that moves batch (whether via `commit_po_advance` or the standalone `reassign_to_batch` RPC) emits one `po_batch_reassigned` row with `metadata.from_batch_id` (nullable for first-time-batched POs) / `to_batch_id` / `source` (`commit_po_advance` | `reassign_to_batch`). Zero financial deltas; the row is the audit fact. Per Derek's principle: changes that affect Client position show on the ledger, not just `audit_log`. (Migration 0019 + 0020.)
- **Per-underlying floor borrowing base.** Each PO's contribution to PO Borrowing Base is `floor(po_value × po_advance_rate_bps / 10000)`, summed per Client. Same per-underlying floor for AR borrowing base (per invoice) and pre-advance (per eligible AR principal slice). Aggregate-then-multiply produces fractional cents that let the effective per-underlying rate creep over the cap; floor-per-underlying is conservative and never exceeds the spec's percentage. Implemented at SQL (mv_client_position, migration 0021), JS (`@seaking/money` `applyBpsFloor`, `@seaking/domain` borrowing-base helpers + `summarizeSelectedPos`), with a post-clamp in `planPoAdvance` so deterministic rounding can't push individual POs over their floored room.
- **PO cancellation is a ledger event when it changes BB.** When a Walmart or generic-CSV upload flips an existing PO's status from a non-cancelled state into `cancelled` via `bulk_upsert_purchase_orders`, the RPC emits one `po_cancelled` event with metadata carrying the prior status, the upload_id, the cancellation reason category, and the memo. The reverse direction (cancelled → outstanding) emits `po_cancellation_reversed` with `reverses_event_id` pointing at the prior unreversed `po_cancelled` event — the trigger `maintain_reversal_backpointer` handles the back-pointer update. Legacy cancellations that predate migration 0022 won't have a prior event to reference; their reverses are audit_log only (graceful degradation). NEW PO inserts with status='cancelled' on first appearance do NOT emit (the PO never contributed to BB). The Manager-initiated cancellation flow in Phase 1G will emit through the same channel with `metadata.source = 'manager_initiated'`. (Migration 0022.)

---

## DB / SQL pitfalls (burned-once, document forever)

Each of these caused a real bug this build phase. Future migrations should preempt them.

1. **`ALTER TYPE … ADD VALUE` must commit before anything uses the new value.** Postgres won't let you reference a newly-added enum value within the same transaction that adds it. Supabase wraps each migration file in a transaction. Solution: put `ALTER TYPE … ADD VALUE` in its own migration file, on its own.
2. **SQL functions referenced from materialized views must `SET search_path = public`.** When `CREATE MATERIALIZED VIEW` inlines a SQL-language function, the planner runs with a restricted search_path; bare table references inside the function body fail with "relation does not exist." Required on `current_rule_set`, `next_batch_number`, anything similar.
3. **Audit triggers must run `SECURITY DEFINER` + explicit `SET search_path = public`.** `audit_log` has RLS enabled with no INSERT policy (writes are trigger-populated only). Without `SECURITY DEFINER`, the caller's INSERT is blocked. Pattern in `log_reference_change` and `log_po_line_change`.
4. **Bulk DML in PL/pgSQL: avoid per-row FOR loops; use `INSERT … ON CONFLICT` over `jsonb_array_elements`.** A naive per-row loop with audit triggers firing per row hits Supabase's 60-second statement timeout at ~3000 rows. Single-statement bulk INSERT runs in milliseconds. Pattern: `bulk_upsert_purchase_orders` with the `xmax = 0` trick to distinguish inserted vs updated counts in one pass.
5. **Supabase/PostgREST clamps responses at `max-rows = 1000` per request.** A `.limit(5000)` call returns 1000 rows silently. Workaround: parallel paginated `.range(start, end)` requests; merge client-side. The dominant cost is round-trip latency, not data transfer, so 5 concurrent requests run roughly as fast as one. Pattern: `fetchAllMatchingPoIdsAction`.
6. **Mixed CRLF/LF line endings break papaparse.** Auto-detection picks the first newline style; bare LFs in a CRLF file get treated as in-cell newlines, silently merging rows. Fix in `packages/retailer-parsers/src/csv.ts`: pre-normalize to LF before parsing.
7. **`.in('purchase_order_id', chunk)` against `mv_advance_balances` is a fan-out trap.** The MV has one row per ADVANCE (not per PO). With ~500 POs and 2+ advances each, the response can exceed 1000 advance rows and hit pitfall #5's clamp — silently undercounting per-PO principal. Symptom: dashboard total disagrees with "Select all matches" total in the Advance on POs page (Derek hit this 2026-04-25). The clean fix is to read from `v_purchase_orders_with_balance` (introduced in migration 0020) — it pre-aggregates principal per PO inside the SQL view, so one query returns one row per PO with the principal column already summed. Use the view for any list page that needs per-PO outstanding principal.
8. **`SUM(bigint)` in Postgres returns `numeric`, not `bigint`.** That `numeric` carries through subsequent multiplication / division and arrives in JS as a non-integer. Without explicit `::bigint` casts on aggregated borrowing-base columns, the projection returns fractional cents that surface as garbage like `$2,013,695.72.59999999403954` in the UI. Cast aggregations back to bigint at the projection layer; defensively floor at the JS display boundary too. (Migration 0021 + `formatDollars`.)

---

## List-page UX conventions

Three list pages now follow this pattern (`/clients/[id]/purchase-orders`, `/clients/[id]/advances/po/new`, `/clients/[id]/batches/assign`). New ones should follow the same shape so the UX feels consistent.

- **Filter / sort / pagination state lives in URL search params.** Bookmarkable, SSR-driven, no client-cache to drift. Standard params: `q`, `retailer`, `batch`, `status`, `sort`, `dir`, `page`, `pageSize`. Filters reset to page 1; sort changes preserve filters but reset to page 1; pagination preserves everything else.
- **Multi-value filters serialize as comma-separated.** `?batch=id1,id2,unassigned`, `?status=active,partially_invoiced`, `?type=po_advance,pre_advance`. Empty (or absent) value means "no filter on that field." Special token `unassigned` for the batch field means `batch_id IS NULL`. Server applies via `.in()`, `.is(null)`, or `.or('batch_id.is.null,batch_id.in.(...)')` for combinations. When a filter would exclude the only emitted source (e.g. Type filter without `po_advance` on a page that only has POs today), short-circuit the query and return zero rows.
- **Sort column whitelist enforced server-side.** Map URL tokens to DB columns explicitly; never `ORDER BY $userInput`.
- **Stable secondary sort by `id`** so equal-key rows have a deterministic order across pagination.
- **Multi-select selection state belongs in client memory, NOT URL.** A `Map<id, fullData>` keyed by row id survives router pushes (filter/sort/page changes) and lets aggregate metrics + downstream actions compute correctly even when selected rows have scrolled out of view. The "select all in view" checkbox toggles only the visible page; a separate "Select all N matches" affordance fetches the full filtered set via a server action when applicable.
- **Read from `v_purchase_orders_with_balance`** when the page needs per-PO outstanding principal (e.g. for sorting by current principal, or for borrowing-base computations). It pre-joins `purchase_orders` to a per-PO aggregate of `mv_advance_balances` so principal arrives in the same row — no separate balance fetch, no `.in()` fan-out trap (DB pitfall #7).
- **Page-jump input** beats a sea of numbered page links once total pages > ~10.
- **Allowed page sizes**: 25 / 50 / 100 / 250 (UX cliff between 250 and 1k of in-DOM rows).

---

## Open questions — RESOLVED (2026-04-23)

| # | Item | Resolution |
|---|---|---|
| 2 | Pre-advance `purchase_order_id` nullability | Option A: nullable only when `advance_type='pre_advance'`, enforced by CHECK (migration 0011) |
| 3 | Pre-advance → AR conversion mechanics | Create new advance, emit `pre_advance_converted` + `balance_transferred_out`/`_in`, link via `transferred_from_advance_id`. Preserve pre-advance's `advance_date` — that's when capital was actually extended. |
| 4 | Pre-advance borrowing base — include aged-out AR principal? | NO. Migration 0011 rewrites `mv_client_position` to use the eligible (non-aged-out) AR principal pool. Aged-out positions are impaired collateral; can't support further pre-advances. |
| 5 | NULL `invoice_date` handling | Reject at upload; migration 0011 adds `NOT NULL` on `invoices.invoice_date`. Parsers must filter. |
| 6 | Walmart "Closed" status with no invoice | Map to new `po_status = 'closed_awaiting_invoice'` (migration 0011). Transitions to `fully_invoiced` when invoices cover the PO. |
| 7 | Cancellation memo+category both required | Schema already enforces. Category IS required per Derek 2026-04-23. |
| 8 | One-time fee polymorphic target validation | Option B: DB trigger validates target_id resolves against the right table (migration 0011). |
| 10 | Partial invoicing split mechanics | Create a new "still-PO" row linked via `parent_po_id`. Heavier but cleaner for audit. Advances re-allocated pro-rata via `balance_transferred_out/in` events; Manager can override proportions on the review screen. |

### Resolved 2026-04-24 / 2026-04-25

| Item | Resolution |
|---|---|
| PO advance allocation: cascade vs. leveling | **Leveling** — see "Decisions already locked." Bucket cascade behavior was incorrect; spec actually intends ratio leveling. |
| Walmart `Closed`/`Closed` OMS mismatch warnings | False-positive bug: the cross-check only treated OMS=`Active` as active-like. Fixed to bucket both columns into active-like vs cancelled-like sets. |
| Per-retailer atomic commit for generic uploads | Group rows by resolved retailer_id; one `bulk_upsert_purchase_orders` call per group. Each group atomic; cross-group is independent. Partial-success error message guides the user when later groups fail after earlier groups committed. |
| Reassigning a PO mid-advance | UI surfaces ack-required warning; RPC moves all existing committed/funded advances on the affected POs to the destination batch. `ledger_events.batch_id` stays immutable. |

---

## Per-turn working preference

- When modifying a file, show a big enough chunk to give context, not five-line fragments.
- Lead explanations with "here's what this does for the business" before the technical mechanism.
- Push back honestly when a proposal conflicts with an invariant. Silent compliance is worse than an argument.
