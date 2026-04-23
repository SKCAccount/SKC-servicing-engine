# Sea King Capital — Project-level context for Claude Code sessions

This is the top-level `CLAUDE.md` read by every Claude Code session. It holds the invariants, conventions, and pointers you need to orient in any file.

**Read the per-package `README.md` before editing inside that package.** Those have domain-specific context that changes more often than this file.

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
9. **Domain package purity.** `packages/domain/` (future) and `packages/retailer-parsers/` have no I/O. No DB, no HTTP, no filesystem.
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
│   └── (future) domain/, events/, retailer-parsers/, bank-parsers/
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

---

## Per-turn working preference

- When modifying a file, show a big enough chunk to give context, not five-line fragments.
- Lead explanations with "here's what this does for the business" before the technical mechanism.
- Push back honestly when a proposal conflicts with an invariant. Silent compliance is worse than an argument.
