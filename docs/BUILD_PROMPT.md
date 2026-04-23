# Sea King Capital — Claude Code Build Prompt

Welcome. You're being handed a specification package to build the Sea King Capital PO Financing & AR Factoring System. This is a monorepo that will serve as the system of record for an active specialty-lending business. Correctness matters more than speed; every financial calculation will be trusted by real money decisions.

This document is your orientation. Read it in full before opening any other file.

---

## 1. What you're building

Sea King Capital provides two forms of financing to CPG companies:

- **PO financing** — we advance capital against a retailer's purchase order before the order is fulfilled. The PO becomes collateral.
- **AR factoring** — we advance capital against an invoice. The invoice becomes collateral; when the retailer pays, we collect.

This app replaces spreadsheets. It tracks every purchase order, invoice, advance, fee, payment, and remittance across multiple Client companies and their retailer customers (starting with Walmart and Kroger). The system computes borrowing base availability in real time, charges fees on a step-function schedule, runs a waterfall to allocate incoming payments across principal and fees, and produces the reports Derek uses to run the business.

**Users (four roles, two built in Phase 1)**:

- **Manager** (full UI in Phase 1). Two sub-roles: Admin Manager (sets rules, invites users, writes off, full access) and Operator (records transactions, can't change rules or write off).
- **Client** (read-only portal in Phase 1, plus Advance Request submission).
- **Investor** and **Creditor** — Phase 2 stubs. Tables exist, no UI.

**Primary user (the one who matters most)**: Derek, the founder/operator. He's a beginner developer who will read your code, run the app, and catch your bugs in live testing. Write code that's easy for him to modify. Favor complete updated files when changing things rather than showing snippets; favor explicit clarity over clever abstractions.

---

## 2. Your source materials

This directory contains everything you need:

| File | Purpose | When to consult |
|---|---|---|
| `BUILD_PROMPT.md` (this file) | Orientation, sequencing, quality bars | First, then as needed |
| `01_FUNCTIONAL_SPEC.md` | The complete functional specification — every screen, every workflow, every calculation rule | Primary source of truth for behavior |
| `02_SCHEMA.md` | Database schema narrative with design rationale | When implementing data access, understanding invariants |
| `03_PARSERS.md` | Retailer-specific CSV/XLSX parser specifications (Walmart and Kroger) | When implementing `packages/retailer-parsers/` |
| `migrations/*.sql` | Executable PostgreSQL migrations 0001-0010 | Apply directly; validated against pglast |
| `ERD.svg` | Full cross-schema relationship diagram | Visual companion to schema |
| `ERD_supplement.svg` | Focused diagram for migrations 0009 (client_deductions) and 0010 (purchase_order_lines) | Visual companion for the two additive tables |

**Reading order**: This file first → `01_FUNCTIONAL_SPEC.md` end-to-end → `02_SCHEMA.md` → `03_PARSERS.md` → then start coding. When questions arise mid-implementation, the functional spec is the tiebreaker unless the schema or parser docs explicitly override something.

---

## 3. Non-negotiable invariants

These are enforced by the schema and must be respected by every piece of application code:

1. **Money is integer cents** (`bigint`). No `float`, no `numeric`, no `decimal`. Convert to display format only at the API/UI boundary. Use the `packages/money/` module for all arithmetic and ratable allocation.

2. **Calendar dates are `date`** (not `timestamptz`), anchored to America/New_York. Event timestamps are `timestamptz` but used only for ordering, not business logic. Use `packages/dates/` for all fee-period math.

3. **`ledger_events` is append-only.** The database enforces this with a trigger that blocks UPDATE (except to `reversed_by_event_id`) and DELETE. Even `service_role` cannot bypass it. Corrections are compensating events — never edits.

4. **Three-part PO uniqueness**: `(client_id, retailer_id, po_number)`. Never assume `(retailer, po_number)` alone is unique.

5. **Optimistic locking** via `version integer NOT NULL DEFAULT 1` on every mutable table. Increment on update; reject stale versions with a clear diff shown to the user.

6. **RLS on every table.** No table is queryable without a role-scoped policy. Helper functions `current_user_client_ids()`, `is_manager()`, `is_admin_manager()`, `is_client_user()` are your building blocks. Every policy should have a corresponding pgTAP test.

7. **Fee rules are prospective; borrowing base rules are retroactive.** This duality is implemented by `rule_sets` being immutable snapshots referenced by advances at creation time (frozen fees) while the live borrowing base calculation reads `current_rule_set(client_id)` (retroactive rates). Do not violate this.

8. **Event sourcing discipline.** Current state is always derivable from `ledger_events` alone. If you ever find yourself writing code that mutates state without an event, stop and reconsider.

9. **Domain package purity.** `packages/domain/` has no I/O. No database calls, no HTTP calls, no filesystem access. It's pure functions operating on in-memory data. Tests don't need mocks.

10. **Parsers are pure.** `packages/retailer-parsers/*` take bytes in, return `ParseResult` out. No side effects. The upload handler does the persistence.

---

## 4. Architecture and repository structure

The functional spec's "Question on Structure" section was already answered (search for `ARCHITECTURE (finalized` in `01_FUNCTIONAL_SPEC.md`). Summary:

```
sea-king-command/
├── apps/
│   ├── manager/         # Next.js App Router — primary Manager UI
│   ├── client-portal/   # Next.js App Router — read-only Client views + Advance Request form
│   └── jobs/            # Supabase Edge Functions — daily fee accrual, weekly digest, aged-out warnings
├── packages/
│   ├── domain/          # Pure business logic: waterfall, fee math, allocation. No I/O.
│   ├── events/          # Event sourcing primitives: event builders, reversal helpers, cascade preview
│   ├── db/              # Supabase schema + migrations + generated types (types.ts)
│   ├── retailer-parsers/
│   │   ├── walmart/
│   │   │   ├── purchase-orders/      # Auto-detects header vs line-level
│   │   │   ├── invoices/
│   │   │   └── payments/
│   │   ├── kroger/
│   │   │   ├── purchase-orders/      # STUB — throws until Kroger PO file arrives
│   │   │   ├── invoices/
│   │   │   └── payments/
│   │   └── generic/                  # CSV template for unsupported retailers
│   ├── bank-parsers/
│   │   └── chase/                    # Note the 8-column-data/7-column-header quirk (see parser spec)
│   ├── notifications/   # Resend templates + dispatch
│   ├── money/           # Cents type, ratable allocation with deterministic tie-breaking
│   ├── dates/           # America/New_York helpers, fee-period math
│   ├── auth/            # Supabase Auth wrappers + role resolution
│   ├── api/             # Shared API types + validators at app boundaries
│   ├── ui/              # Shared shadcn/ui component library
│   └── validators/      # Zod schemas at API boundaries
├── CLAUDE.md            # Project-level context for future Claude Code sessions
└── README.md
```

**Per-package `README.md`.** Every package has its own README explaining its purpose, its public API, and any subtleties. This keeps per-turn context small and lets you reload just what you need without re-reading the whole spec.

---

## 5. Build sequencing

Don't try to build everything at once. Work in vertical slices, each producing something Derek can run and exercise. Suggested sequence:

### Phase 1A — Foundation (target: Derek can create a Client and see the empty app)
1. Monorepo scaffolding (pnpm workspaces, tsconfig base, eslint/prettier)
2. Supabase project setup and migrations 0001-0010 applied
3. `packages/money/`, `packages/dates/`, `packages/validators/` — the utility libraries
4. `packages/auth/` with role resolution
5. `apps/manager/` login + Client selection menu (empty state is fine)
6. `apps/client-portal/` login (empty state fine)

### Phase 1B — Reference data (target: Derek can set up a Client's rules)
7. Client CRUD in Manager UI
8. `Set Borrowing Base and Fee Rules` screen (creates a `rule_sets` row)
9. User invitation flow (Admin Manager only)
10. Retailer registry is seeded via migration 0008; no UI needed in Phase 1

### Phase 1C — PO ingestion (target: Derek can upload a Walmart PO file and see it)
11. `packages/retailer-parsers/walmart/purchase-orders/` — **start with the line-level parser** since it's the default; header-level as a secondary path with auto-detection
12. Generic CSV template parser
13. Kroger PO stub (throws with clear message)
14. PO Upload UI + upload summary screen
15. Purchase Order list view + filters

### Phase 1D — Advances (target: Derek can commit an advance on a PO)
16. `packages/domain/borrowing-base/` — PO and AR borrowing base calculations (read from `current_rule_set`)
17. `packages/domain/allocation/` — ratable allocation with deterministic tie-breaking (see `packages/money/` for the primitives)
18. Advance on Purchase Orders screen
19. `packages/events/` — event builders for `advance_committed`
20. Projection refresh hook

### Phase 1E — Invoices and conversion (target: Derek can upload invoices and watch PO advances convert to AR)
21. Walmart invoice parser
22. Kroger invoice parser (handles 3-category split: Warehouse → invoices, Promo Allowances → client_deductions, Non-Promo Receivable → client_deductions)
23. Invoice upload UI + split behavior for partial invoicing
24. Advance on AR screen (structurally parallel to PO advance)

### Phase 1F — Payments and waterfall (the hardest part — save for when you're warmed up)
25. `packages/bank-parsers/chase/` — watch for the header/data column offset
26. Bank statement ingestion UI
27. Walmart payment parser (multi-row-per-invoice with deduction extraction)
28. Kroger payment parser (netting-first structure — one Payment reference groups positive invoice rows and negative offsets)
29. `packages/domain/waterfall/` — Model A execution (see `01_FUNCTIONAL_SPEC.md` Invoice Level Payment Waterfall and Batch-Level Payment Logic sections). Two-pass matcher for bank→payment reconciliation.
30. Payment Review and Assignment UI
31. Remittance recording

### Phase 1G — Bad standing, cancellations, disputes (target: Derek can handle the weird cases)
32. Advances in Bad Standing UI (three conditions: aged-out, PO-over-advanced, cancelled-with-principal)
33. PO Cancellation flow — Manager-initiated primary, CSV-signaled secondary
34. Balance transfer to remediate bad-standing advances
35. Client deduction dispute UI (minimal — see `03_PARSERS.md` Resolved Decisions for exact scope)
36. Over Advanced state and notifications

### Phase 1H — Reporting and notifications (polish)
37. Reports & Exports (all 7 report types listed in the functional spec)
38. Email templates via Resend (all notification types in the functional spec)
39. Scheduled jobs in `apps/jobs/` — daily fee accrual, weekly digest, aged-out warnings

### Phase 1I — Deployment and testing
40. IONOS deployment pipeline (Derek's existing infrastructure)
41. End-to-end test: create Client → set rules → upload PO → advance → upload invoice → upload bank statement → upload retailer payments → watch waterfall → issue remittance
42. Full RLS test matrix

**Don't skip 41.** That integration path is the acceptance test for the whole Phase 1 effort.

---

## 6. Quality bars

### Code

- **TypeScript strict mode** everywhere. `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`.
- **Zod validators at every API boundary** — never trust client input shape.
- **No `any`**. If you genuinely need an escape hatch, use `unknown` and narrow.
- **Prefer explicit types over inferred** for exported functions. Internal type inference is fine.
- **No magic numbers** for financial calculations. Pull constants from `packages/domain/constants.ts` or from `rule_sets` via `current_rule_set()`.
- **Error handling is explicit**. Use `Result<T, E>` patterns or well-typed thrown errors. Don't silently swallow.

### Testing

- **pgTAP tests** for every RLS policy. See section 5 of `02_SCHEMA.md`.
- **Unit tests for domain logic**. Waterfall execution, ratable allocation, fee-period math, borrowing base calculation — every branch.
- **Parser fixtures**. Each parser ships with `happy-path.{csv|xlsx}`, `edge-cases.{csv|xlsx}`, `malformed.{csv|xlsx}`. Snapshot-compare normalized output.
- **Integration test for the end-to-end scenario** (Phase 1I step 41).

### Correctness over cleverness

The functional spec was written by someone whose reputation with investors depends on this app being right. If you're tempted to simplify a business rule because the spec seems overspecified — don't. The specificity is load-bearing. Examples of "seems overspecified but isn't":

- The two-pass payment matcher (strict exact, then fuzzy ±3 day ±$1) is NOT a nice-to-have. Derek's retailers post payments with 1-3 day bank lags; you will miss matches without it.
- The Waterfall "Model A" execution order (fee-earmarked → fee priorities 0-7 → cascade to principal priorities 1-5; principal-earmarked → principal priorities 1-5 → cascade to Fee Priority 6) is NOT arbitrary. It encodes a specific collateral protection model.
- The Advance Date vs Recorded At distinction (fee clock starts at Advance Date, not system time) matters for every fee calculation.

When in doubt, re-read the spec section that covers the rule before coding.

### Commit discipline

Small, focused commits. A commit title like `feat(walmart-parser): handle multi-row payment structure with deduction extraction` is better than `add walmart parser`. Derek will read the git log.

---

## 7. Decisions already made (don't re-litigate)

These were decided during the design phase. They are load-bearing; do not reopen without explicit confirmation from Derek:

| Area | Decision |
|---|---|
| Terminology | Sea King never uses loan vocabulary. "Advance" not "loan"/"borrow"; "fees" not "interest"; "Advance Request" not "Draw Request"; "Client" not "borrower". |
| Money storage | Integer cents, bigint, throughout. |
| Date storage | `date` for calendar dates (America/New_York), `timestamptz` for event timestamps. |
| PO uniqueness | Three-part key `(client_id, retailer_id, po_number)`. |
| Event log | Append-only, enforced at DB level. Corrections are compensating events. |
| Rule sets | Immutable snapshots. Fee rates prospective (frozen at advance creation), borrowing base retroactive (read current snapshot). |
| Payment allocation | Two independent inputs: `% to Principal` and `% to Fees`, must sum to 100%. Defaults populated from AR advance rate but editable independently. |
| Waterfall execution | "Model A" — single split at top; cascade across buckets. See functional spec's waterfall sections for the full priority lists. |
| Advance lifecycle | Two states: `committed` (recorded in app) and `funded` (wire confirmed via bank match or manual). |
| Advance identity | `advances` table stores identity + immutable parameters only. Running balances come from `mv_advance_balances` (event projection). |
| One-time fees | Polymorphic `target_type` (advance/PO/invoice/batch/client). Client-level fees get new Fee Priority 0. |
| Over Advanced | Client-level state (not per-batch). Blocks new advances, emails `overadvanced@seakingcapital.com`, auto-clears on return to compliance. |
| Aged-out warnings | 5 days before threshold, grouped by Advance Date to prevent spam. Toggleable. |
| PO Cancellation | Manager-initiated primary; retailer-CSV-signaled secondary. Cancelled POs with outstanding principal → Advances in Bad Standing → remediated via balance transfer. |
| Partial invoicing | Splits PO into still-PO + AR portions. Advances re-allocated pro-rata by value; Manager can override. |
| Payment matching | Two-pass: strict exact, then fuzzy (±3 days for Walmart and Kroger, ±1 day default). Then manual. |
| Deductions | `invoice_deductions` for invoice-specific; `client_deductions` for vendor-wide (Kroger promos, PRGX). Unioned via `v_all_deductions` view. |
| Disputes | `accepted → disputed → upheld | reversed` lifecycle on `client_deductions`. Minimal UI (Dispute button + memo; Resolve button for Admin Manager). |
| Walmart PO upload | Line-level is the default. Parser auto-detects by column presence. Full-replacement merge — incoming file wins on both header fields and lines. |
| Kroger PO | Parser is stubbed until file arrives. Invoice parser gracefully degrades with `resolved_invoice_id = NULL` and a "Re-resolve" UI action. |
| Retailers at launch | Walmart (line-level default), Kroger (invoice + payment; PO stubbed), plus generic CSV template. |
| Bank parser | Chase only in Phase 1. Known quirk: 8 data columns vs 7 header columns (CREDIT/DEBIT prefix is in col 0 but missing from header row). |
| File retention | All uploaded files retained indefinitely in Supabase Storage, linked to upload events. |
| Audit | All reference-table changes logged to `audit_log` via triggers. Financial changes logged to `ledger_events`. Two logs, two purposes. |
| Projections | Four materialized views, refreshed on `ledger_events` insert via `pg_notify` + worker, debounced to 2s intervals. Daily cross-check rebuilds from scratch to detect drift. |

---

## 8. When you get stuck

- **Spec ambiguity**: flag it, note your assumption, and ask Derek in your next response. Do not guess on business rules silently.
- **Technical constraint not covered in spec**: use your judgment, document the choice in the relevant package README.
- **Schema doesn't seem to support what the spec asks**: the schema is authoritative unless the spec says otherwise explicitly. If there's a genuine gap, propose a migration rather than working around it.
- **Something doesn't make sense**: the spec went through two rounds of heavy markup with Derek. If something reads oddly, it's probably load-bearing — re-read the surrounding context before assuming it's a typo.

---

## 9. Relationship with Derek

You're working with a founder who is also the primary user. He catches bugs in live testing, he reads your diffs, and he knows his business cold. He prefers:

- **Complete updated files over snippets.** When you modify a file, show the whole thing (or a big chunk), not five-line fragments.
- **Iterative delivery with validation between steps.** Ship Phase 1A, have Derek run it, then Phase 1B. Don't try to ship the whole thing in one go.
- **Push back honestly.** If Derek proposes something that conflicts with an invariant or a prior decision, say so. He'd rather hear "this conflicts with X, here's why" than silent compliance.
- **Plain English over jargon.** When explaining a design choice, lead with "here's what this does for your business" before "here's the technical mechanism."

---

## 10. First response checklist

When Derek kicks off the first build session, your response should:

1. Confirm you've read this file, `01_FUNCTIONAL_SPEC.md`, `02_SCHEMA.md`, and `03_PARSERS.md` in full.
2. Propose the concrete deliverables for Phase 1A (the monorepo foundation) with estimated scope.
3. Flag any spec ambiguities you noticed during the full-read pass.
4. Ask Derek for any Supabase project credentials / IONOS deployment details you need to proceed.
5. Proceed to build Phase 1A after his go-ahead.

Good luck.
