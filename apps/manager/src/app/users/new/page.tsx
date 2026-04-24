import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isAdminManager } from '@seaking/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { InviteUserForm } from './invite-user-form';

export default async function InviteUserPage() {
  const user = await getCurrentAuthUser();
  if (!user) redirect('/login');
  if (!isAdminManager(user.role)) redirect('/users?reason=forbidden');

  const supabase = await createSupabaseServerClient();
  const { data: clients } = await supabase
    .from('clients')
    .select('id, display_name')
    .order('display_name', { ascending: true });

  return (
    <main className="mx-auto max-w-xl p-6">
      <header className="mb-6">
        <Link
          href="/users"
          className="text-sm text-seaking-muted hover:text-seaking-ink hover:underline"
        >
          ← Back to Users
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-seaking-navy">
          Invite a user
        </h1>
        <p className="mt-1 text-sm text-seaking-muted">
          An invite email is sent immediately. The invitee clicks the link, chooses a password,
          and arrives at the app ready to work.
        </p>
      </header>

      <div className="rounded-lg border border-seaking-border bg-seaking-surface p-6">
        <InviteUserForm
          clients={((clients ?? []) as { id: string; display_name: string }[]) || []}
        />
      </div>
    </main>
  );
}
