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
- **Phase 1D (commits 1-3 + follow-on fixes)**: `@seaking/domain` package (borrowing-base math + ratio-leveling allocation, 36 tests); `commit_po_advance` RPC; Advance on Purchase Orders UI with multi-page selection, filter/sort/pagination, "select all matches" across pages (parallel-paginated, 5,000-row hard cap), and batch-reassignment acknowledgement.

Coming in Phase 1D commits 4-5 and 1E onward: standalone Assign-to-Batch screen + unified outstanding items table (POs/invoices/pre-advances), CSV-of-PO-numbers secondary entry path for advances, Client dashboard aggregate metrics, then invoice ingestion.

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

---

## DB / SQL pitfalls (burned-once, document forever)

Each of these caused a real bug this build phase. Future migrations should preempt them.

1. **`ALTER TYPE … ADD VALUE` must commit before anything uses the new value.** Postgres won't let you reference a newly-added enum value within the same transaction that adds it. Supabase wraps each migration file in a transaction. Solution: put `ALTER TYPE … ADD VALUE` in its own migration file, on its own.
2. **SQL functions referenced from materialized views must `SET search_path = public`.** When `CREATE MATERIALIZED VIEW` inlines a SQL-language function, the planner runs with a restricted search_path; bare table references inside the function body fail with "relation does not exist." Required on `current_rule_set`, `next_batch_number`, anything similar.
3. **Audit triggers must run `SECURITY DEFINER` + explicit `SET search_path = public`.** `audit_log` has RLS enabled with no INSERT policy (writes are trigger-populated only). Without `SECURITY DEFINER`, the caller's INSERT is blocked. Pattern in `log_reference_change` and `log_po_line_change`.
4. **Bulk DML in PL/pgSQL: avoid per-row FOR loops; use `INSERT … ON CONFLICT` over `jsonb_array_elements`.** A naive per-row loop with audit triggers firing per row hits Supabase's 60-second statement timeout at ~3000 rows. Single-statement bulk INSERT runs in milliseconds. Pattern: `bulk_upsert_purchase_orders` with the `xmax = 0` trick to distinguish inserted vs updated counts in one pass.
5. **Supabase/PostgREST clamps responses at `max-rows = 1000` per request.** A `.limit(5000)` call returns 1000 rows silently. Workaround: parallel paginated `.range(start, end)` requests; merge client-side. The dominant cost is round-trip latency, not data transfer, so 5 concurrent requests run roughly as fast as one. Pattern: `fetchAllMatchingPoIdsAction`.
6. **Mixed CRLF/LF line endings break papaparse.** Auto-detection picks the first newline style; bare LFs in a CRLF file get treated as in-cell newlines, silently merging rows. Fix in `packages/retailer-parsers/src/csv.ts`: pre-normalize to LF before parsing.

---

## List-page UX conventions

Two large list pages now exist (`/clients/[id]/purchase-orders`, `/clients/[id]/advances/po/new`). New ones should follow the same shape so the UX feels consistent.

- **Filter / sort / pagination state lives in URL search params.** Bookmarkable, SSR-driven, no client-cache to drift. Standard params: `q`, `retailer`, `batch`, `status`, `sort`, `dir`, `page`, `pageSize`. Filters reset to page 1; sort changes preserve filters but reset to page 1; pagination preserves everything else.
- **Sort column whitelist enforced server-side.** Map URL tokens to DB columns explicitly; never `ORDER BY $userInput`.
- **Stable secondary sort by `id`** so equal-key rows have a deterministic order across pagination.
- **Multi-select selection state belongs in client memory, NOT URL.** A `Map<id, fullData>` keyed by row id survives router pushes (filter/sort/page changes) and lets aggregate metrics + downstream actions compute correctly even when selected rows have scrolled out of view. The "select all in view" checkbox toggles only the visible page; a separate "Select all N matches" affordance fetches the full filtered set via a server action when applicable.
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
