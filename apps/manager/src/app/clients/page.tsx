import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isManager } from '@seaking/auth';
import { redirect } from 'next/navigation';
import { SignOutButton } from './sign-out-button';

export default async function ClientsPage() {
  const user = await getCurrentAuthUser();
  if (!user) {
    redirect('/login');
  }
  if (!isManager(user.role)) {
    // Non-managers should not be in the Manager app at all.
    redirect('/login?reason=wrong_app');
  }

  const supabase = await createSupabaseServerClient();
  // RLS scopes this to clients the user has access to via user_client_access.
  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, display_name, status, over_advanced_state')
    .order('display_name', { ascending: true });

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-seaking-navy">
            Select a Client
          </h1>
          <p className="text-sm text-seaking-muted">
            Signed in as {user.email} · {user.role === 'admin_manager' ? 'Admin Manager' : 'Operator'}
          </p>
        </div>
        <SignOutButton />
      </header>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-seaking-danger">
          Failed to load Clients: {error.message}
          <div className="mt-1 text-xs opacity-75">
            If this is your first time setting up, the database migrations may not yet be applied.
          </div>
        </div>
      )}

      {!error && (!clients || clients.length === 0) && (
        <div className="rounded border border-dashed border-seaking-border bg-seaking-surface p-10 text-center">
          <p className="text-sm text-seaking-muted">No Clients yet.</p>
          <p className="mt-2 text-xs text-seaking-muted">
            An Admin Manager can create the first Client once Client CRUD is live (Phase 1B).
          </p>
        </div>
      )}

      {clients && clients.length > 0 && (
        <ul className="divide-y divide-seaking-border rounded border border-seaking-border bg-seaking-surface">
          {clients.map((c) => (
            <li key={c.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="font-medium">{c.display_name}</div>
                <div className="text-xs text-seaking-muted">
                  {c.status}
                  {c.over_advanced_state && ' · Over Advanced'}
                </div>
              </div>
              <a
                href={`/clients/${c.id}`}
                className="text-sm font-medium text-seaking-navy hover:underline"
              >
                Open →
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
