/**
 * Supabase magic-link callback (Client Portal variant).
 * Mirrors apps/manager/src/app/auth/callback/route.ts — see that file for
 * the detailed rationale on PKCE exchange and safe redirect handling.
 */

import { createSupabaseServerClient } from '@seaking/auth/server';
import { NextResponse, type NextRequest } from 'next/server';

function safeRedirectPath(next: string | null): string {
  if (!next) return '/';
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//')) return '/';
  return next;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeRedirectPath(url.searchParams.get('next'));
  const errorDescription = url.searchParams.get('error_description');

  if (errorDescription) {
    const loginUrl = new URL('/login', url.origin);
    loginUrl.searchParams.set('error', errorDescription);
    return NextResponse.redirect(loginUrl);
  }

  if (!code) {
    const loginUrl = new URL('/login', url.origin);
    loginUrl.searchParams.set('error', 'Missing code in callback URL');
    return NextResponse.redirect(loginUrl);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const loginUrl = new URL('/login', url.origin);
    loginUrl.searchParams.set('error', error.message);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
