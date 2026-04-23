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

Filenames on disk carry a timestamp prefix (`20260423120001_...`) so the Supabase CLI sorts them. The `0001_` descriptive prefix is preserved after the underscore for human readability.

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
