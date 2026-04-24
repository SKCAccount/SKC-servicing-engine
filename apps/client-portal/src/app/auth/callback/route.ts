/**
 * Supabase auth callback (Client Portal variant).
 * Logic is intentionally identical to apps/manager/src/app/auth/callback/route.ts;
 * see that file's header for the full rationale on handling both PKCE
 * (`?code=`) and OTP (`?token_hash=&type=`) flows.
 */

import { createSupabaseServerClient } from '@seaking/auth/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

function safeRedirectPath(next: string | null): string {
  if (!next) return '';
  if (!next.startsWith('/')) return '';
  if (next.startsWith('//')) return '';
  return next;
}

const ALLOWED_OTP_TYPES: ReadonlySet<EmailOtpType> = new Set<EmailOtpType>([
  'invite',
  'recovery',
  'signup',
  'magiclink',
  'email',
  'email_change',
]);

function bounceToLogin(origin: string, message: string): NextResponse {
  const loginUrl = new URL('/login', origin);
  loginUrl.searchParams.set('error', message);
  return NextResponse.redirect(loginUrl);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const typeRaw = url.searchParams.get('type');
  const nextParam = safeRedirectPath(url.searchParams.get('next'));
  const errorDescription = url.searchParams.get('error_description');

  if (errorDescription) return bounceToLogin(url.origin, errorDescription);

  const supabase = await createSupabaseServerClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return bounceToLogin(url.origin, error.message);
    return NextResponse.redirect(new URL(nextParam || '/', url.origin));
  }

  if (tokenHash && typeRaw) {
    const type = typeRaw as EmailOtpType;
    if (!ALLOWED_OTP_TYPES.has(type)) {
      return bounceToLogin(url.origin, `Unsupported confirmation type: ${typeRaw}`);
    }
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) return bounceToLogin(url.origin, error.message);

    const smartDefault =
      type === 'invite'
        ? '/auth/set-password'
        : type === 'recovery'
          ? '/auth/reset-password'
          : '/';
    return NextResponse.redirect(new URL(nextParam || smartDefault, url.origin));
  }

  return bounceToLogin(
    url.origin,
    'Missing auth parameters. The link may be malformed or already used.',
  );
}
