import { createSupabaseServerClient } from '@seaking/auth/server';
import { redirect } from 'next/navigation';
import { PasswordForm } from '../set-password/password-form';

/**
 * Password recovery page.
 *
 * Reached via: "Forgot password?" → email with recovery link →
 * /auth/callback exchanges code → redirects here with a valid session.
 * If someone lands here without a session, send them back to /login.
 */
export default async function ResetPasswordPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?error=Recovery%20link%20expired%20or%20already%20used');
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-seaking-border bg-seaking-surface p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-seaking-navy">
            Sea King Capital
          </h1>
          <p className="mt-1 text-sm text-seaking-muted">Choose a new password.</p>
        </div>
        <PasswordForm mode="reset" redirectTo="/clients" submitLabel="Update password" />
      </div>
    </main>
  );
}
