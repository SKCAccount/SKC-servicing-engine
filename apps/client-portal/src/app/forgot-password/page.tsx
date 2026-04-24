import { getCurrentAuthUser } from '@seaking/auth/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ForgotPasswordForm } from './forgot-password-form';

export default async function ForgotPasswordPage() {
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
          <p className="mt-1 text-sm text-seaking-muted">
            Enter your email and we&apos;ll send you a password reset link.
          </p>
        </div>
        <ForgotPasswordForm />
        <div className="mt-4 text-center text-sm">
          <Link href="/login" className="text-seaking-navy hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
