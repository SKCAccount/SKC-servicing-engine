import { getCurrentAuthUser } from '@seaking/auth/server';
import { isAdminManager } from '@seaking/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { NewClientForm } from './new-client-form';

export default async function NewClientPage() {
  const user = await getCurrentAuthUser();
  if (!user) redirect('/login');
  if (!isAdminManager(user.role)) {
    redirect('/clients?reason=forbidden');
  }

  return (
    <main className="mx-auto max-w-xl p-6">
      <header className="mb-6">
        <Link
          href="/clients"
          className="text-sm text-seaking-muted hover:text-seaking-ink hover:underline"
        >
          ← Back to Clients
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-seaking-navy">
          New Client
        </h1>
        <p className="mt-1 text-sm text-seaking-muted">
          Create a Client record. You&apos;ll automatically be granted access. Borrowing base and
          fee rules are set separately after creation.
        </p>
      </header>

      <div className="rounded-lg border border-seaking-border bg-seaking-surface p-6">
        <NewClientForm />
      </div>
    </main>
  );
}
