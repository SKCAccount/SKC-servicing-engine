/**
 * Supabase magic-link callback.
 *
 * Supabase sends invite, recovery, email-confirm, and OAuth emails with a
 * link of the form:
 *   {site_url}/auth/callback?code=<PKCE code>&next=<safe path>
 *
 * This route exchanges the code for a session, then redirects to `next`.
 * If the exchange fails, we route to /login with an error query param so
 * the user understands what happened.
 *
 * `next` is validated: only same-origin relative paths are allowed, no
 * schemes and no host redirects. This closes the open-redirect class of
 * bugs that magic-link callbacks are prone to.
 */

import { createSupabaseServerClient } from '@seaking/auth/server';
import { NextResponse, type NextRequest } from 'next/server';

function safeRedirectPath(next: string | null): string {
  // Only allow single-segment relative paths starting with '/'
  if (!next) return '/';
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//')) return '/'; // protocol-relative — reject
  return next;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeRedirectPath(url.searchParams.get('next'));
  const errorDescription = url.searchParams.get('error_description');

  // Supabase embeds errors in the query string for expired/invalid links.
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
