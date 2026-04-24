import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isAdminManager } from '@seaking/auth';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { EditClientForm } from './edit-client-form';

interface PageProps {
  params: Promise<{ clientId: string }>;
}

export default async function EditClientPage({ params }: PageProps) {
  const user = await getCurrentAuthUser();
  if (!user) redirect('/login');
  if (!isAdminManager(user.role)) redirect(`/clients?reason=forbidden`);

  const { clientId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('clients')
    .select('id, legal_name, display_name, status, version')
    .eq('id', clientId)
    .maybeSingle();

  if (error || !data) notFound();
  const client = data as {
    id: string;
    legal_name: string;
    display_name: string;
    status: 'active' | 'inactive' | 'paused';
    version: number;
  };

  return (
    <main className="mx-auto max-w-xl p-6">
      <header className="mb-6">
        <Link
          href={`/clients/${client.id}`}
          className="text-sm text-seaking-muted hover:text-seaking-ink hover:underline"
        >
          ← Back to {client.display_name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-seaking-navy">
          Edit Client
        </h1>
      </header>

      <div className="rounded-lg border border-seaking-border bg-seaking-surface p-6">
        <EditClientForm
          initial={{
            id: client.id,
            legal_name: client.legal_name,
            display_name: client.display_name,
            status: client.status,
            version: client.version,
          }}
        />
      </div>

      <p className="mt-4 text-xs text-seaking-muted">
        Setting status to <em>Inactive</em> hides this Client from active workflows but preserves
        all historical data. To reactivate, edit again and set status to <em>Active</em>.
      </p>
    </main>
  );
}
