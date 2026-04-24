import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isAdminManager, isManager } from '@seaking/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { SignOutButton } from './sign-out-button';

interface ClientRow {
  id: string;
  legal_name: string;
  display_name: string;
  status: 'active' | 'inactive' | 'paused';
  over_advanced_state: boolean;
}

export default async function ClientsPage() {
  const user = await getCurrentAuthUser();
  if (!user) {
    redirect('/login');
  }
  if (!isManager(user.role)) {
    redirect('/login?reason=wrong_app');
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('clients')
    .select('id, legal_name, display_name, status, over_advanced_state')
    .order('display_name', { ascending: true });

  const clients = (data ?? []) as ClientRow[];
  const canCreate = isAdminManager(user.role);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-seaking-navy">
            Select a Client
          </h1>
          <p className="text-sm text-seaking-muted">
            Signed in as {user.email} ·{' '}
            {user.role === 'admin_manager' ? 'Admin Manager' : 'Operator'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/users"
            className="rounded border border-seaking-border bg-white px-3 py-1.5 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg"
          >
            Users
          </Link>
          {canCreate && (
            <Link
              href="/clients/new"
              className="rounded bg-seaking-navy px-3 py-1.5 text-sm font-medium text-white transition hover:bg-seaking-navy-hover"
            >
              + New Client
            </Link>
          )}
          <SignOutButton />
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-seaking-danger">
          Failed to load Clients: {error.message}
        </div>
      )}

      {!error && clients.length === 0 && (
        <div className="rounded border border-dashed border-seaking-border bg-seaking-surface p-10 text-center">
          <p className="text-sm text-seaking-muted">No Clients yet.</p>
          {canCreate ? (
            <p className="mt-2 text-xs text-seaking-muted">
              <Link href="/clients/new" className="text-seaking-navy hover:underline">
                Create your first Client →
              </Link>
            </p>
          ) : (
            <p className="mt-2 text-xs text-seaking-muted">
              Ask your Admin Manager to grant you access to a Client.
            </p>
          )}
        </div>
      )}

      {clients.length > 0 && (
        <ul className="divide-y divide-seaking-border rounded border border-seaking-border bg-seaking-surface">
          {clients.map((c) => (
            <li key={c.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="font-medium">{c.display_name}</div>
                <div className="text-xs text-seaking-muted">
                  <span className="font-mono text-[10px] uppercase tracking-wider">{c.status}</span>
                  {c.legal_name !== c.display_name && <span> · {c.legal_name}</span>}
                  {c.over_advanced_state && (
                    <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-seaking-danger">
                      Over Advanced
                    </span>
                  )}
                </div>
              </div>
              <Link
                href={`/clients/${c.id}`}
                className="text-sm font-medium text-seaking-navy hover:underline"
              >
                Open →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
