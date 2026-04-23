/**
 * Client-side Supabase helper for Next.js App Router.
 *
 * Use in Client Components that need direct Supabase access (e.g., sign-in form,
 * real-time subscriptions). Most reads should go through Server Components
 * instead; this is here for the cases where browser-side access is genuinely
 * required.
 */

'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

// NOTE: we use a loose SupabaseClient type here in Phase 1A because the
// generated types.ts is still a placeholder. Once `pnpm db:types` has run
// against the live schema, narrow this to `SupabaseClient<Database>`.
export type SeaKingBrowserClient = SupabaseClient;

let cached: SeaKingBrowserClient | null = null;

export function getSupabaseBrowserClient(): SeaKingBrowserClient {
  if (cached) return cached;
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const anon = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  if (!url || !anon) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
        'Set them in .env.local.',
    );
  }
  const client = createBrowserClient(url, anon);
  cached = client;
  return client;
}
