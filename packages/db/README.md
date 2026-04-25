# @seaking/db

Database access for Sea King Capital.

## What's in here

- `src/client.ts` — Supabase client factories (browser + service role).
- `src/types.ts` — generated TypeScript types from the live schema. **Regenerate after every migration.**
- The migration files themselves live at the repo root in `supabase/migrations/` so the Supabase CLI picks them up automatically.

## Migrations

Migrations live at `<repo-root>/supabase/migrations/` (not inside this package) because that's the Supabase CLI convention and it lets `supabase db push` run without configuration tricks.

Current migrations:

| Prefix | File | Purpose |
|---|---|---|
| `0001` | `extensions_and_enums` | `uuid-ossp`, `pgcrypto`, all enum types |
| `0002` | `reference_tables` | clients, retailers, users, rule_sets, stubs |
| `0003` | `operational_tables` | POs, invoices, batches, advances, uploads, bank txns, remittances |
| `0004` | `event_log` | `ledger_events` — APPEND-ONLY, enforced by trigger |
| `0005` | `projections` | Materialized views derived from ledger |
| `0006` | `audit_log` | Change log for reference tables (non-financial) |
| `0007` | `rls_policies` | Row-Level Security on every table |
| `0008` | `seed_system_retailers` | Walmart, Kroger, generic |
| `0009` | `client_deductions` | Client-level deductions (Kroger promos, PRGX) |
| `0010` | `purchase_order_lines` | Line-level PO detail (Walmart SupplierOne) |
| `0011` | `phase_1a_resolutions` | Enum-only: adds `closed_awaiting_invoice` to `po_status`. Split from 0012 because `ALTER TYPE … ADD VALUE` must commit before later statements use the new value. |
| `0012` | `phase_1a_resolutions_part2` | Pre-advance `purchase_order_id` nullability, `mv_client_position` rebuild (eligible-AR pre-advance pool), `invoices.invoice_date NOT NULL`, one-time-fee polymorphic-target validation trigger. |
| `0013` | `upsert_rule_set_fn` | RPC for the rules editor: atomically closes the active rule_set and inserts a new one. |
| `0014` | `audit_triggers_security_definer` | Mark `log_reference_change` and `log_po_line_change` as SECURITY DEFINER + `SET search_path = public` so they bypass `audit_log` RLS for the trigger insert. |
| `0015` | `po_uploads_storage_and_rpc` | Creates the `po-uploads` Storage bucket and the `bulk_upsert_purchase_orders` RPC (v1). |
| `0016` | `bulk_upsert_purchase_orders_v2` | Replaces the per-row plpgsql FOR loop with single-statement `INSERT … ON CONFLICT` over `jsonb_array_elements`. Required to stay under Supabase's 60-second statement timeout. |
| `0017` | `commit_po_advance_rpc` | RPC for the Advance on POs commit: resolves rule_set + batch, reassigns POs, inserts advances + paired `advance_committed` ledger events. Plus `refresh_po_projections` helper. |
| `0018` | `commit_po_advance_v2_advance_batch_follows` | Fixes a bug where existing advances on a reassigned PO got stranded in the old batch. v2 also UPDATEs `advances.batch_id` for committed/funded advances on the affected POs (per spec: advance batch follows PO). |

Filenames on disk carry a timestamp prefix (`20260423120001_...`) so the Supabase CLI sorts them. The `0001_` descriptive prefix is preserved after the underscore for human readability.

See `CLAUDE.md` §"DB / SQL pitfalls" for the recurring traps that motivated several of these (search_path, SECURITY DEFINER, ALTER TYPE in own migration, bulk INSERT vs per-row plpgsql).

## Rules

- **`ledger_events` is append-only.** DB triggers enforce this. Do not write code that tries to UPDATE or DELETE events. For corrections, insert a compensating event with `reverses_event_id` set.
- **Every mutable table has `version`.** Include it in UPDATE `WHERE` clauses to enable optimistic locking.
- **RLS is on everywhere.** Queries that need to bypass it must go through `createServiceRoleClient()` and justify why in a comment.

## Usage

```ts
import { createBrowserSupabaseClient } from '@seaking/db';

const supabase = createBrowserSupabaseClient();
const { data, error } = await supabase.from('clients').select('*');
```

For server actions needing elevated access:

```ts
import { createServiceRoleClient } from '@seaking/db';
import 'server-only'; // next-safe-action pattern

const admin = createServiceRoleClient();
```

## Regenerating types

After every migration:

```bash
pnpm db:types
```

This writes `src/types.ts` from the live schema. Commit the regenerated file.
