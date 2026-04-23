/**
 * Supabase client factories.
 *
 * Two flavors:
 *  - `createBrowserClient()` / `createServerClient()` — scoped to the authenticated user,
 *    RLS applies. This is the default for all user-facing reads/writes.
 *  - `createServiceRoleClient()` — SERVER ONLY. Bypasses RLS. Use exclusively for
 *    trusted background work (scheduled jobs, ledger-event inserts from server actions
 *    that have already validated permissions). Never import from client components.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// NOTE: loose type in Phase 1A. Narrow to SupabaseClient<Database> once
// `pnpm db:types` has generated the real schema types from the live DB.
export type SeaKingClient = SupabaseClient;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Client for browser contexts. Uses the anon key; RLS gates all access.
 */
export function createBrowserSupabaseClient(): SeaKingClient {
  return createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    },
  );
}

/**
 * Service-role client. Bypasses RLS. Server-only.
 * Guards against accidental browser-side usage.
 */
export function createServiceRoleClient(): SeaKingClient {
  if (typeof window !== 'undefined') {
    throw new Error(
      'createServiceRoleClient() was called in a browser context. ' +
        'Service-role operations must only happen on the server.',
    );
  }
  return createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}
