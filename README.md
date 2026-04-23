# SKC-servicing-engine

This will be the source of truth for all financing provided by SKC. It will provide necessary information to our clients, our creditors and our investors regarding the status of all financings, past and present. It will be auditable, clear and accurate.

---

## Repository layout

- `apps/manager` — primary Manager UI (Next.js App Router).
- `apps/client-portal` — read-only Client portal + Advance Request form (Next.js App Router).
- `apps/jobs` — Supabase Edge Functions for scheduled work.
- `packages/*` — shared libraries: money, dates, validators, db (migrations + types), auth, ui, api, notifications.
- `docs/` — functional spec, schema, parser specs, ERDs.
- `supabase/migrations/` — PostgreSQL migrations applied to the linked project.

See [`CLAUDE.md`](./CLAUDE.md) for the full invariants, conventions, and pointers used by Claude Code sessions.

## Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9 (`npm install -g pnpm`)
- Git
- Supabase CLI

## First-time setup

```bash
# 1. Install dependencies
pnpm install

# 2. Fill in environment (server-side only; NEVER commit)
cp .env.example apps/manager/.env.local
cp .env.example apps/client-portal/.env.local
# Edit both with real Supabase credentials

# 3. Link Supabase (requires one-time `supabase login` first)
supabase login            # opens a browser for OAuth; generates an access token
pnpm db:link              # links this repo to the SKC Supabase project

# 4. Apply migrations
pnpm db:push

# 5. Generate typed DB client
pnpm db:types
```

## Day-to-day

```bash
pnpm dev               # both apps in parallel
pnpm dev:manager       # just the manager app (http://localhost:3000)
pnpm dev:client-portal # just the client portal (http://localhost:3001)

pnpm typecheck         # whole workspace
pnpm lint
pnpm test              # unit tests in every package
```

## Build phases

Phase 1A (current): foundation. Monorepo scaffold, migrations committed, login + empty Client Selection screen.

Phase 1B-1I: reference data, PO ingestion, advances, invoices, payments/waterfall, bad standing, reports, deploy.

See `docs/BUILD_PROMPT.md` §5 for the full sequencing.
