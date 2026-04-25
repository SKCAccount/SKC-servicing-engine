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

## Routes

```
apps/manager/
├── middleware.ts                                # Supabase session refresh on every request
├── next.config.ts                               # Workspace transpile list + 50 MB bodySizeLimit for uploads
├── src/
│   ├── lib/action-helpers.ts                    # zodError + supabaseError → ActionResult mappers
│   └── app/
│       ├── layout.tsx
│       ├── page.tsx                             # Auth gate → /login or /clients
│       ├── globals.css                          # Tailwind v4 + Sea King theme tokens
│       ├── login/                               # Email + password sign-in (1B)
│       ├── forgot-password/                     # Triggers Supabase reset email (1B)
│       ├── auth/
│       │   ├── callback/route.ts                # Handles BOTH PKCE code and OTP token_hash flows (1B)
│       │   ├── set-password/                    # First-time invite landing
│       │   └── reset-password/                  # Recovery landing
│       ├── clients/
│       │   ├── page.tsx                         # Client Selection Menu, RLS-scoped
│       │   ├── sign-out-button.tsx
│       │   ├── new/                             # Create Client (Admin Manager only) (1B)
│       │   └── [clientId]/
│       │       ├── page.tsx                     # Per-Client dashboard with action cards
│       │       ├── edit/                        # Edit Client (1B)
│       │       ├── rules/                       # Borrowing-base + Fee Rules editor (1B)
│       │       ├── po-uploads/new/              # PO Upload flow (Walmart + generic CSV) (1C)
│       │       ├── purchase-orders/             # PO list with filter/sort/pagination (1C)
│       │       └── advances/po/new/             # Advance on POs (1D)
│       ├── users/
│       │   ├── page.tsx                         # Users list (1B)
│       │   ├── new/                             # Invite user (1B)
│       │   └── [userId]/                        # Edit user role/status/grants (1B)
│       └── api/
│           └── po-template/generic/route.ts     # Downloadable Generic CSV PO template
```

## Patterns to know about

- **List pages** (`/clients/[id]/purchase-orders`, `/clients/[id]/advances/po/new`) follow the conventions documented in `CLAUDE.md` §"List-page UX conventions": URL-driven filter/sort/pagination, server-side sort whitelist, client-side `Map<id, fullData>` for selection that survives URL navigations.
- **Server Actions** all return `ActionResult<T>` from `@seaking/api`. Use `zodError` / `supabaseError` from `src/lib/action-helpers.ts` to translate framework errors into the shared shape.
- **Auth callback** (`/auth/callback/route.ts`) handles both PKCE (`?code=`) and OTP (`?token_hash=&type=`) flows. Invites and password resets use the OTP path; OAuth (future) uses PKCE.
- **Optimistic locking** via `expected_version` on every update server action. See e.g. `clients/[clientId]/edit/actions.ts`.
