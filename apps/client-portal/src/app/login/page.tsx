import { getCurrentAuthUser } from '@seaking/auth/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { LoginForm } from './login-form';

interface LoginPageProps {
  searchParams: Promise<{ error?: string; reason?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const user = await getCurrentAuthUser();
  if (user) {
    redirect('/');
  }

  const params = await searchParams;
  const error = params.error ?? null;
  const reason = params.reason ?? null;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-seaking-border bg-seaking-surface p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-seaking-navy">
            Sea King Capital
          </h1>
          <p className="mt-1 text-sm text-seaking-muted">Client portal sign-in</p>
        </div>

        {error && (
          <div className="mb-4 rounded bg-red-50 p-3 text-sm text-seaking-danger" role="alert">
            {error}
          </div>
        )}
        {reason === 'wrong_app' && (
          <div className="mb-4 rounded bg-amber-50 p-3 text-sm text-amber-800" role="alert">
            That account belongs to a Manager. Please sign in via the Manager app.
          </div>
        )}

        <LoginForm />

        <div className="mt-4 text-center text-sm">
          <Link href="/forgot-password" className="text-seaking-navy hover:underline">
            Forgot password?
          </Link>
        </div>
      </div>
    </main>
  );
}
