'use client';

import { getSupabaseBrowserClient } from '@seaking/auth/browser';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const supabase = getSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) {
        setError(signInError.message);
        return;
      }
      router.push('/clients');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded border border-seaking-border px-3 py-2 text-sm outline-none focus:border-seaking-navy"
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded border border-seaking-border px-3 py-2 text-sm outline-none focus:border-seaking-navy"
        />
      </div>

      {error && (
        <div className="rounded bg-red-50 p-3 text-sm text-seaking-danger" role="alert">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-seaking-navy py-2 text-sm font-medium text-white transition-colors hover:bg-seaking-navy-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
