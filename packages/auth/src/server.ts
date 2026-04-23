/**
 * Server-side Supabase helpers for Next.js App Router.
 *
 * These work in Server Components, Route Handlers, and Server Actions.
 * They manage the auth cookie through Next's cookies() API so Supabase
 * sessions persist across requests.
 */

import 'server-only';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { AuthUser, UserRole } from './roles';

// NOTE: loose type in Phase 1A; narrow to SupabaseClient<Database> once
// `pnpm db:types` has generated the real schema types.
export type SeaKingServerClient = SupabaseClient;

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

/**
 * Create a Supabase client for use in Server Components / Route Handlers /
 * Server Actions. Reads and writes the auth cookie via Next's cookie store.
 */
export async function createSupabaseServerClient(): Promise<SeaKingServerClient> {
  const cookieStore = await cookies();

  return createServerClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Set calls from Server Components throw; they'll work from Route
            // Handlers and Server Actions. Silently ignore the SC path; the
            // middleware refresh flow is the canonical refresher.
          }
        },
      },
    },
  );
}

/**
 * Fetch the currently-authenticated user plus their Sea King `users` row.
 * Returns `null` if not signed in or the `users` row is missing.
 */
export async function getCurrentAuthUser(): Promise<AuthUser | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: userRow, error } = await supabase
    .from('users')
    .select('id, email, role, client_id')
    .eq('id', user.id)
    .maybeSingle();

  if (error || !userRow) return null;
  const row = userRow as { id: string; email: string; role: string; client_id: string | null };

  return {
    id: row.id,
    email: row.email,
    role: row.role as UserRole,
    clientId: row.client_id,
  };
}

/**
 * Throw-on-unauthenticated guard for server actions and route handlers.
 * Redirect-friendly errors should be handled at the page level via middleware.
 */
export async function requireAuthUser(): Promise<AuthUser> {
  const user = await getCurrentAuthUser();
  if (!user) {
    throw new Error('UNAUTHENTICATED');
  }
  return user;
}
