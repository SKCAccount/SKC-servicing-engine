/**
 * Next.js middleware helper for Supabase session refresh.
 *
 * Usage in a Next app:
 *
 * ```ts
 * // apps/manager/middleware.ts
 * import { updateSession } from '@seaking/auth/middleware';
 * import type { NextRequest } from 'next/server';
 *
 * export async function middleware(request: NextRequest) {
 *   return updateSession(request);
 * }
 *
 * export const config = {
 *   matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
 * };
 * ```
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.next({ request });

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const anon = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  if (!url || !anon) return response;

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Refresh the auth token. The result is committed via setAll above.
  await supabase.auth.getUser();

  return response;
}
