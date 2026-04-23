# @seaking/auth

Supabase Auth wrappers + role resolution for Sea King.

## Why this package exists

Next.js App Router requires server-side, browser-side, and middleware Supabase clients to be constructed differently (because of cookie handling). Wrapping them once here means apps don't each hand-roll the same boilerplate.

## Public API

### Role helpers (`@seaking/auth`)

- `UserRole` — `"admin_manager" | "operator" | "client" | "investor" | "creditor"`
- `AuthUser` — authenticated user + Sea King `users` row
- `isManager(role)`, `isAdminManager(role)`, `isOperator(role)`, `isClientUser(role)`

### Server (`@seaking/auth/server`)

- `createSupabaseServerClient()` — Supabase client for Server Components / Route Handlers / Server Actions
- `getCurrentAuthUser()` — returns `AuthUser | null`
- `requireAuthUser()` — throws `"UNAUTHENTICATED"` if no session

### Browser (`@seaking/auth/browser`)

- `getSupabaseBrowserClient()` — memoized browser client

### Middleware (`@seaking/auth/middleware`)

- `updateSession(request)` — refreshes the auth cookie

## Important

These helpers are UI conveniences. Every write that actually needs role enforcement also relies on Postgres RLS — the DB remains the source of truth. If your code path bypasses `current_user_client_ids()` checks in SQL (e.g., uses the service-role client), comment why.

## Example

```ts
// apps/manager/app/layout.tsx
import { getCurrentAuthUser } from '@seaking/auth/server';
import { redirect } from 'next/navigation';

export default async function ManagerLayout({ children }) {
  const user = await getCurrentAuthUser();
  if (!user) redirect('/login');
  return <>{children}</>;
}
```
