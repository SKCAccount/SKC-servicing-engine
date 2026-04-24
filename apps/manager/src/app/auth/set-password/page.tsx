import { getCurrentAuthUser } from '@seaking/auth/server';
import { createSupabaseServerClient } from '@seaking/auth/server';
import { redirect } from 'next/navigation';
import { PasswordForm } from './password-form';

/**
 * First-time password-set page.
 *
 * Reached via: Supabase invite email → /auth/callback exchanges code for a
 * session → redirects here with a valid session. If someone lands here
 * without a session, bounce them to /login.
 */
export default async function SetPasswordPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) {
    redirect('/login?error=Invite%20link%20expired%20or%20already%20used');
  }

  // If a public.users row already exists, proceed normally. If not, we still
  // let them set a password; Phase 1B's invitation flow creates the users row
  // via server action, so this is only defensive.
  const seaKingUser = await getCurrentAuthUser();

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-seaking-border bg-seaking-surface p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-seaking-navy">
            Sea King Capital
          </h1>
          <p className="mt-1 text-sm text-seaking-muted">
            Welcome{seaKingUser ? `, ${seaKingUser.email}` : ''}. Choose a password to continue.
          </p>
        </div>
        <PasswordForm
          mode="set"
          redirectTo={seaKingUser ? '/clients' : '/login'}
          submitLabel="Set password"
        />
      </div>
    </main>
  );
}
