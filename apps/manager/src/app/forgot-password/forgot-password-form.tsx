'use client';

import { getSupabaseBrowserClient } from '@seaking/auth/browser';
import { useState, type FormEvent } from 'react';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const supabase = getSupabaseBrowserClient();
      // Compute the absolute callback URL at submission time so the email
      // link returns to whichever app origin the user started from.
      const origin = window.location.origin;
      const { error: sendError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/auth/callback?next=/auth/reset-password`,
      });
      if (sendError) {
        setError(sendError.message);
        return;
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send reset email');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded bg-emerald-50 p-4 text-sm text-seaking-success" role="status">
        If an account exists for <strong>{email}</strong>, a reset link is on its way. Check your
        inbox (and spam folder).
      </div>
    );
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
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
    </form>
  );
}
