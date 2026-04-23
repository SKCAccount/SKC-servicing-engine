import { getCurrentAuthUser } from '@seaking/auth/server';
import { isClientUser } from '@seaking/auth';
import { redirect } from 'next/navigation';

export default async function Home() {
  const user = await getCurrentAuthUser();
  if (!user) {
    redirect('/login');
  }
  if (!isClientUser(user.role)) {
    // Managers should use the Manager app.
    redirect('/login?reason=wrong_app');
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-seaking-navy">
          Sea King Capital
        </h1>
        <p className="text-sm text-seaking-muted">Signed in as {user.email}</p>
      </header>

      <section className="rounded border border-dashed border-seaking-border bg-seaking-surface p-10 text-center">
        <p className="text-sm text-seaking-muted">
          Your account is ready. The portal unlocks in Phase 1H.
        </p>
        <p className="mt-2 text-xs text-seaking-muted">
          You&apos;ll be able to review your batches, invoices, remittances, and submit advance requests.
        </p>
      </section>
    </main>
  );
}
