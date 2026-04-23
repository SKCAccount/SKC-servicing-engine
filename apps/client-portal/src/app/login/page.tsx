import { getCurrentAuthUser } from '@seaking/auth/server';
import { redirect } from 'next/navigation';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  const user = await getCurrentAuthUser();
  if (user) {
    redirect('/');
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-seaking-border bg-seaking-surface p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-seaking-navy">
            Sea King Capital
          </h1>
          <p className="mt-1 text-sm text-seaking-muted">Client portal sign-in</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
