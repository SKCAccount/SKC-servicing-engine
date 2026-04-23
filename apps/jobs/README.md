# apps/jobs

Supabase Edge Functions for scheduled and event-driven work.

Phase 1A: scaffolding only. Functions arrive over Phase 1C-1H:

- `daily-fee-accrual` — runs at 01:00 America/New_York; emits `fee_accrued` events for any advance crossing into a new period.
- `aged-out-warning` — runs daily; emails Manager 5 days before any invoice ages out. Groups by Advance Date to prevent spam.
- `weekly-digest` — Monday mornings; per-Client activity summary.
- `refresh-projections` — triggered on `ledger_events` insert via pg_notify; debounced refresh of `mv_advance_balances`, `mv_client_position`, `mv_invoice_aging`, `mv_batch_position`.
- `projection-drift-check` — daily; rebuilds `mv_advance_balances` from scratch and diffs against the live view. Alerts on drift.

## Structure (once built)

```
apps/jobs/
├── supabase/
│   └── functions/
│       ├── daily-fee-accrual/
│       │   ├── index.ts
│       │   └── deno.json
│       ├── aged-out-warning/
│       ├── weekly-digest/
│       ├── refresh-projections/
│       └── projection-drift-check/
└── README.md
```

Each function is Deno-native (Supabase Edge runtime). Deploy via `supabase functions deploy <name>`.
