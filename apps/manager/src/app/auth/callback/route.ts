/**
 * Supabase auth callback — handles BOTH flows the Supabase SDK emits:
 *
 *   PKCE (OAuth, future social login):
 *     ?code=<pkce-code>  →  exchangeCodeForSession(code)
 *
 *   OTP (invite, signup, recovery, magic link, email-change):
 *     ?token_hash=<hash>&type=<invite|recovery|signup|magiclink|email>
 *                        →  verifyOtp({ type, token_hash })
 *
 * Both flows end with a valid session and a redirect to the `next` query
 * param. `next` is validated against the open-redirect class: relative
 * paths only, no protocol-relative '//' prefixes, no schemes.
 *
 * Historical note: version 1 of this file only handled the PKCE `code`
 * shape, which broke invites and password resets because Supabase's
 * /auth/v1/verify endpoint appends `token_hash` + `type`, not `code`.
 * Unifying the two paths here means /auth/callback is the single
 * email-link destination for the whole auth surface.
 *
 * Smart default for `next`: when Supabase's email template doesn't
 * explicitly set `next`, we pick one based on `type` — invite →
 * /auth/set-password, recovery → /auth/reset-password. Users who click
 * a bare invite link still land on the right page even if the dashboard
 * template wasn't customized.
 */

import { createSupabaseServerClient } from '@seaking/auth/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

function safeRedirectPath(next: string | null): string {
  if (!next) return '';
  if (!next.startsWith('/')) return '';
  if (next.startsWith('//')) return ''; // protocol-relative — reject
  return next;
}

// Whitelist of OTP types we explicitly support. Passing an unexpected
// string to verifyOtp would return an error anyway; this is defense in
// depth against query-string tampering.
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

  // --- PKCE branch (OAuth, PKCE magic-link code flow) ---
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return bounceToLogin(url.origin, error.message);
    return NextResponse.redirect(new URL(nextParam || '/', url.origin));
  }

  // --- OTP branch (invite, recovery, etc.) ---
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
