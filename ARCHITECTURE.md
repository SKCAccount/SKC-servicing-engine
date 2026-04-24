# Architecture

This document describes how the pieces of `sea-king-capital-servicing-engine` fit together. It's meant to be read after [`CLAUDE.md`](./CLAUDE.md), which covers the non-negotiable invariants. This document covers the **how** — module layering, auth flow, data flow, server/client boundaries, and the conventions that keep Claude Code sessions productive.

If you're modifying an area, read the relevant section here plus the package-level `README.md`, and you'll have enough context to avoid breaking something subtle.

---

## 0. One-page mental model

```
                   ┌──────────────────────────────────────────────┐
                   │  Users (Admin Manager / Operator / Client)   │
                   └────────────┬─────────────────────────────────┘
                                │ HTTP
                   ┌────────────▼─────────────┐   ┌─────────────────────────┐
                   │   apps/manager (Next)    │   │  apps/client-portal     │
                   │   apps/client-portal     │   │  (Next, read-only UI)   │
                   │   App Router + SSR       │   │                         │
                   └────────────┬─────────────┘   └────────────┬────────────┘
                                │                              │
                                │  Supabase SSR client (user)  │
                                │  + Service-role client       │
                                │  (server-only, admin ops)    │
                                ▼                              ▼
                   ┌───────────────────────────────────────────────┐
                   │              Supabase Postgres                │
                   │  ┌─────────────────────────────────────────┐  │
                   │  │ Reference tables (clients, users,       │  │
                   │  │   rule_sets, purchase_orders, ...)      │  │
                   │  │ ← Every write triggers audit_log        │  │
                   │  │                                         │  │
                   │  │ ledger_events (APPEND-ONLY)             │  │
                   │  │ ← Source of truth for financial state   │  │
                   │  │                                         │  │
                   │  │ mv_advance_balances,                    │  │
                   │  │ mv_client_position,                     │  │
                   │  │ mv_invoice_aging,                       │  │
                   │  │ mv_batch_position                       │  │
                   │  │ ← Projections derived from ledger       │  │
                   │  └─────────────────────────────────────────┘  │
                   │  RLS enforces tenancy on every read/write     │
                   └───────────────────────────────────────────────┘
                                ▲
                                │ Deno runtime
                   ┌────────────┴─────────────┐
                   │   apps/jobs (Edge Fns)   │
                   │   Scheduled: fee         │
                   │   accrual, aged-out      │
                   │   warning, weekly digest │
                   └──────────────────────────┘
```

The **event log** (`ledger_events`) is the system's heart. Every financial state is derivable from it. Reference data (who the Clients are, what rules apply) lives in mutable tables because it's not financial — but every change to it goes to `audit_log` via trigger.

---

## 1. Monorepo layout

```
sea-king-capital-servicing-engine/
├── apps/
│   ├── manager/         — Next.js App Router, Manager UI (port 3000 dev)
│   ├── client-portal/   — Next.js App Router, Client UI  (port 3001 dev)
│   └── jobs/            — Supabase Edge Functions (placeholder in 1A/B)
├── packages/            — Shared libraries (all TS strict)
│   ├── money/           — Cents type, ratable allocation
│   ├── dates/           — America/NY helpers, fee-period math
│   ├── validators/      — Zod schemas for API boundaries
│   ├── db/              — Supabase client factories
│   ├── auth/            — Supabase Auth wrappers + role helpers
│   ├── ui/              — cn() + money formatters + (future) shadcn components
│   ├── api/             — ActionResult<T> primitive
│   └── notifications/   — Resend stub (Phase 1H expands)
├── supabase/
│   ├── config.toml      — Supabase CLI config (major_version = 17)
│   └── migrations/      — Timestamped .sql files applied by `pnpm db:push`
├── docs/                — Spec documents (read-only; don't edit)
└── tests/               — pgTAP (future), E2E (future)
```

### Dependency direction (enforced by absence of cross-imports)

```
apps  ───►  packages  ────────►  @supabase/*
            (money, dates,       (external)
             validators are
             pure — no I/O)
          ▲
          │
  packages/ui        packages/auth        packages/db
  (React, no         (@supabase/ssr)      (@supabase/supabase-js)
   server imports)
```

- `apps/*` can import any `packages/*`.
- `packages/money`, `packages/dates`, `packages/validators` are **pure** — no I/O, no React. Tests need no mocks.
- `packages/ui` is React. Never imports from `packages/auth` (keeps UI tree-shakable in any app).
- `packages/auth` has two entry points: `./server` (needs `next/headers`) and `./browser` (needs `'use client'`). The main `packages/auth` module re-exports only the pure role helpers — consumers import directly from `/server` or `/browser` to keep bundles clean.
- `packages/db` exposes `createBrowserSupabaseClient` (anon key, RLS) and `createServiceRoleClient` (service key, bypasses RLS, server-only). Server-only guard is runtime-enforced.

---

## 2. Authentication flow

Supabase Auth is the identity provider. Application authorization (what role you have, which Clients you can see) lives in our `users` and `user_client_access` tables. RLS is the enforcement point for every data access.

### The two email-link flows

Supabase emits two different link shapes depending on the auth event:

| Source | Query shape | Verification method |
|---|---|---|
| OAuth / PKCE magic-link | `?code=...` | `supabase.auth.exchangeCodeForSession(code)` |
| Invite, password recovery, signup confirm, magic-link (non-PKCE) | `?token_hash=...&type=invite\|recovery\|...` | `supabase.auth.verifyOtp({ type, token_hash })` |

The `/auth/callback` route in both apps handles **both** shapes in one handler (it branches on which params are present). Both flows end with a session cookie and a redirect to a `next` path. When `next` isn't explicitly set on an OTP link (some email templates drop query string appendages), the handler picks a smart default: `invite → /auth/set-password`, `recovery → /auth/reset-password`.

### End-to-end invite flow

```
1. Admin Manager fills form on /users/new
2. Server action inviteUserAction:
   a. Authorizes caller (is_admin_manager + client_ids ⊆ caller's grants)
   b. createServiceRoleClient()
   c. supabase.auth.admin.inviteUserByEmail(email, { redirectTo: ORIGIN/auth/callback })
   d. Insert public.users row (role, client_id for Client role)
   e. If manager role: insert user_client_access rows
3. Supabase sends email with {{ .ConfirmationURL }}
4. User clicks → Supabase /auth/v1/verify verifies token
5. Supabase 302s to {redirectTo}?token_hash=...&type=invite
6. /auth/callback: verifyOtp({ type: 'invite', token_hash })
7. Session cookie set → redirect to /auth/set-password
8. /auth/set-password: user enters password, supabase.auth.updateUser({ password })
9. Redirect to /clients (manager) or / (client portal)
```

The invite flow deliberately uses service role ONLY for step 2c-e; steps 1 and 2a-b are authorized through the user's own session.

### End-to-end password-reset flow

```
1. User enters email on /forgot-password
2. supabase.auth.resetPasswordForEmail(email, { redirectTo: ORIGIN/auth/callback })
3. Supabase sends email → user clicks → /auth/v1/verify → redirect
4. /auth/callback: verifyOtp({ type: 'recovery', token_hash })
5. Session set → redirect to /auth/reset-password
6. User enters new password, supabase.auth.updateUser({ password })
7. Redirect to /clients or /
```

### Required Supabase Dashboard config

Settings that only live in the Supabase dashboard (not in code):

- **Authentication → URL Configuration → Site URL** — canonical production URL of the Manager app. Set to `http://localhost:3000` for dev.
- **Authentication → URL Configuration → Redirect URLs** — allowlist. Include:
  - `http://localhost:3000/auth/callback`
  - `http://localhost:3001/auth/callback`
  - Production equivalents when deployed

Without this allowlist, both `inviteUserByEmail` and `resetPasswordForEmail` return errors because Supabase refuses to embed a non-allowlisted `redirectTo`.

### Role resolution

```
auth.users.id  (Supabase Auth)
        │
        ▼
public.users  (role, client_id for client role, status)
        │
        ├── role = 'admin_manager' | 'operator'
        │   └── access scoped via user_client_access (M:N)
        │
        └── role = 'client'
            └── access = users.client_id (single Client)
```

SQL helpers in migration 0007 that RLS policies use:

- `current_user_client_ids()` — set of client_ids the caller can see
- `is_manager()` — true for admin_manager or operator
- `is_admin_manager()`
- `is_client_user()`

TypeScript mirrors in `@seaking/auth`: `isManager(role)`, `isAdminManager(role)`, etc. These are **convenience** helpers only; the DB's RLS policies remain the true gate.

---

## 3. Data flow for a typical write

Server Actions are the primary write path. Pattern used by every mutation in apps/manager:

```ts
'use server';

export async function someAction(input: SomeInput): Promise<ActionResult<Output>> {
  // 1. Validate shape with Zod
  const parsed = someInputSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);

  // 2. Authenticate the caller
  let authUser;
  try { authUser = await requireAuthUser(); }
  catch { return err('UNAUTHENTICATED', 'Please sign in again.'); }

  // 3. Authorize — check role and (for multi-tenant ops) scope
  if (!isAdminManager(authUser.role)) {
    return err('FORBIDDEN', 'Only Admin Managers can ...');
  }

  // 4. Execute via user-scoped supabase client (RLS applies) OR
  //    service-role client (bypasses RLS — only for admin operations
  //    that have already passed steps 2-3)
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('...').update({ ... }).eq(...).select('...').single();
  if (error) return supabaseError(error);

  // 5. Revalidate affected paths so server components refetch
  revalidatePath('/clients');
  return ok(data);
}
```

`ActionResult<T>` is a discriminated union — `{ ok: true, data }` or `{ ok: false, error }`. Client components `await someAction(...)` and branch on `result.ok`. No unhandled exceptions cross the network boundary.

### Optimistic locking

Every mutable table has a `version integer` column. The `set_updated_at()` trigger increments it on UPDATE. Edit-form server actions include `version = expected_version` in the WHERE clause:

```ts
.update({ ...fields })
.eq('id', id)
.eq('version', expected_version)
.select().maybeSingle();

if (!updated) return err('OPTIMISTIC_LOCK', '...');
```

Zero-row matches mean another session modified the row between form load and submit. The UI surfaces an error telling the user to refresh.

### rule_sets are an exception (immutable snapshot pattern)

`rule_sets` is never UPDATEd. To "change" rules, a new row is inserted and the old one gets `effective_to = today`. The `upsert_rule_set` SQL function (migration 0013) does both atomically.

This pattern is required because:
- Fee rates must be frozen per-advance (stored via `advance.rule_set_id`). Re-running fee math with today's rates would break audit.
- Borrowing base rates are read retroactively (via `current_rule_set(client_id)` which picks the row with `effective_to IS NULL`).

---

## 4. The ledger (when we get there)

_Pending Phase 1D onward. Notes here for planning._

Every financial mutation inserts a row into `ledger_events`. The table is append-only (enforced by trigger — not even `service_role` can UPDATE or DELETE). Corrections are compensating events: insert a new row with `reverses_event_id = <original>`, and the projection views filter it out via `reversed_by_event_id IS NULL`.

Events carry three signed amounts — `principal_delta_cents`, `fee_delta_cents`, `remittance_delta_cents` — plus nullable FKs to advance_id, invoice_id, batch_id, bank_transaction_id, remittance_id, one_time_fee_id. A CHECK constraint per event type asserts which amounts and FKs are required (see migration 0004's `ledger_events_type_invariants`).

Four materialized views (`mv_advance_balances`, `mv_client_position`, `mv_invoice_aging`, `mv_batch_position`) derive current state. They're refreshed on insert via `pg_notify` + a debounced worker. A daily drift-check rebuilds them from scratch and alerts on mismatch.

---

## 5. Conventions that matter

### Money and dates

- **Every monetary value** flows through `@seaking/money`. Cents type; arithmetic is integer; conversion to `$X,XXX.XX` only at the UI boundary via `displayCents()`.
- **Every business date** flows through `@seaking/dates`. `CalendarDate` is `Temporal.PlainDate` anchored to `America/New_York`. No `new Date()` for business logic — ever. Event timestamps use `timestamptz` and are only for ordering.

### Validation at every boundary

Every Server Action starts with `schema.safeParse(input)`. Zod errors get mapped to `ActionError.fieldErrors` so forms can display per-field feedback. Server-side validation is the only validation that matters — client-side hints exist for UX only.

### RLS is load-bearing, not decorative

Every table has RLS enabled. Every policy has a matching assertion in what will become the pgTAP test suite (Phase 1I). When you add a table or view, add its policy in the same migration. When you use the service-role client, comment why — it's never a default choice.

### SECURITY DEFINER functions

A SQL function that writes to a table with RLS enabled but no INSERT policy (like `audit_log`) needs `SECURITY DEFINER` + explicit `SET search_path = public`. See migration 0014 for the pattern. Same applies to `current_rule_set` and `next_batch_number` — they get `SET search_path` because they're referenced from materialized views whose planner runs with a restricted search path.

### File headers

Every non-trivial file starts with a comment block explaining:
1. **Why** this file exists (its purpose in the larger system)
2. **What it does** (public API surface)
3. **Gotchas** (anything a fresh-eyes reader would need)

Per-turn Claude Code sessions read these first and skip the rest. Keep them honest.

### Commits

Conventional Commits scoped by package or feature. Examples from the log:

- `feat(clients): Client CRUD for Admin Manager`
- `fix(db): audit triggers need SECURITY DEFINER to bypass RLS`
- `feat(auth): complete invite + password-reset flows in both apps`

The bodies describe **why** the change was made, not just what. Future sessions read the log to reconstruct decision history.

---

## 6. App-specific notes

### apps/manager

Primary Manager UI. Routes built so far:

- `/login` — Supabase Auth sign-in
- `/forgot-password` — sends recovery email
- `/auth/callback` — PKCE/OTP landing (see §2)
- `/auth/set-password` — first-time password set
- `/auth/reset-password` — post-recovery password change
- `/clients` — list (RLS-scoped)
- `/clients/new` — Admin-only creation
- `/clients/[clientId]` — per-Client dashboard stub (Main Interface lands in 1C)
- `/clients/[clientId]/edit` — Admin-only, optimistic locked
- `/clients/[clientId]/rules` — Admin-only Borrowing Base + Fee Rules editor
- `/users` — roster + grants table
- `/users/new` — Admin-only invite
- `/users/[userId]` — Admin-only edit (self-edit blocked)

Middleware (`apps/manager/middleware.ts`) runs `updateSession` on every non-static request to refresh auth cookies.

### apps/client-portal

Read-only portal + future advance-request submission. Mirrors the auth routes above with `redirectTo` defaults pointing at `/` instead of `/clients`. No CRUD in Phase 1B — ships in 1H when the portal data views land.

### apps/jobs

Empty in Phase 1B. Edge functions arrive in 1C-1H: `daily-fee-accrual`, `aged-out-warning`, `weekly-digest`, `refresh-projections`, `projection-drift-check`.

---

## 7. Operational runbook

### Apply migrations

```bash
pnpm db:push                     # push any un-applied migrations
pnpm db:types                    # regenerate packages/db/src/types.ts
git add packages/db/src/types.ts
git commit -m "chore(db): regenerate types after <migration>"
```

### Add a server action to an existing page

1. Create `actions.ts` next to the page — add `'use server'` at the top.
2. Define the input schema in `packages/validators/src/<domain>.ts` and re-export from `packages/validators/src/index.ts`.
3. Write the action following the 5-step pattern from §3.
4. Import into the page's client form via a regular ES import — Next wires it up.
5. Add `revalidatePath()` for any route whose data the action changes.

### Add a new route

- Page: `apps/<app>/src/app/<path>/page.tsx` — server component unless you explicitly need `'use client'`.
- Server logic (redirects, gating): fetch `getCurrentAuthUser()` + role check at the top.
- Data fetch: `createSupabaseServerClient()` — RLS applies.
- Forms: use `'use client'` in a separate file (co-located with the page).
- Mutations: Server Action in `actions.ts`.
- Every page with auth-guarded content is marked dynamic by Next's `cookies()` call.

### When in doubt

- RLS is broken → run the query as `postgres` in Studio's SQL editor; if it works there but not in the app, it's a policy issue.
- Migration rolled back → check whether it used `ALTER TYPE ... ADD VALUE` in the same transaction as a statement that uses the value (split into two migrations).
- Function "relation does not exist" from a view → add `SET search_path = public` to the function definition.
- Email link bounces to `/login` with no error → check Supabase dashboard redirect allowlist.
