# apps/manager

Sea King Capital — primary Manager UI.

## Running locally

```bash
# From the repo root
pnpm dev:manager
# or
pnpm -F @seaking/manager dev
```

The app runs on http://localhost:3000.

## Environment

Copy the root `.env.example` to `apps/manager/.env.local` and fill in.

Required:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only)

## Structure

```
apps/manager/
├── middleware.ts              # Supabase session refresh on every request
├── src/app/
│   ├── layout.tsx             # Root layout
│   ├── page.tsx               # Auth gate → /login or /clients
│   ├── login/
│   │   ├── page.tsx
│   │   └── login-form.tsx     # Client component
│   ├── clients/
│   │   ├── page.tsx           # Client Selection Menu (Phase 1A empty state)
│   │   └── sign-out-button.tsx
│   └── globals.css            # Tailwind v4 + Sea King theme tokens
└── next.config.ts
```

## Phase 1A scope

Login + empty Client Selection. Actual Client CRUD + the Main Interface come in Phase 1B and later.
