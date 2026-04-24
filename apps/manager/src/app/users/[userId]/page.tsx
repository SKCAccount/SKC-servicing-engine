import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isAdminManager } from '@seaking/auth';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { EditUserForm } from './edit-user-form';

interface PageProps {
  params: Promise<{ userId: string }>;
}

export default async function EditUserPage({ params }: PageProps) {
  const me = await getCurrentAuthUser();
  if (!me) redirect('/login');
  if (!isAdminManager(me.role)) redirect('/users?reason=forbidden');

  const { userId } = await params;
  if (userId === me.id) {
    // The edit flow forbids self-editing (to prevent lock-out); send them
    // back with a note instead of an ambiguous 404.
    redirect('/users?reason=self_edit');
  }

  const supabase = await createSupabaseServerClient();
  const [{ data: userRow }, { data: clients }, { data: grants }] = await Promise.all([
    supabase
      .from('users')
      .select('id, email, role, client_id, status, version')
      .eq('id', userId)
      .maybeSingle(),
    supabase.from('clients').select('id, display_name').order('display_name', { ascending: true }),
    supabase.from('user_client_access').select('client_id').eq('user_id', userId),
  ]);

  if (!userRow) notFound();
  const target = userRow as {
    id: string;
    email: string;
    role: 'admin_manager' | 'operator' | 'client' | 'investor' | 'creditor';
    client_id: string | null;
    status: 'active' | 'disabled';
    version: number;
  };

  // Phase 1B only edits invitable roles; investors/creditors should be
  // managed in Supabase Studio until their UI lands.
  if (target.role === 'investor' || target.role === 'creditor') {
    return (
      <main className="mx-auto max-w-xl p-6">
        <Link
          href="/users"
          className="text-sm text-seaking-muted hover:text-seaking-ink hover:underline"
        >
          ← Back to Users
        </Link>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-seaking-navy">
          {target.email}
        </h1>
        <div className="mt-4 rounded bg-amber-50 p-4 text-sm text-amber-900">
          Investor/Creditor users are stubbed in Phase 1. Manage them via Supabase Studio until
          their dedicated UI ships.
        </div>
      </main>
    );
  }

  const initialClientIds =
    target.role === 'client'
      ? target.client_id
        ? [target.client_id]
        : []
      : ((grants ?? []) as { client_id: string }[]).map((g) => g.client_id);

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
          {target.email}
        </h1>
      </header>

      <div className="rounded-lg border border-seaking-border bg-seaking-surface p-6">
        <EditUserForm
          initial={{
            user_id: target.id,
            email: target.email,
            role: target.role as 'admin_manager' | 'operator' | 'client',
            status: target.status,
            version: target.version,
            client_ids: initialClientIds,
          }}
          clients={((clients ?? []) as { id: string; display_name: string }[]) || []}
        />
      </div>
    </main>
  );
}
