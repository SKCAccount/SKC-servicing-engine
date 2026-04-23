'use client';

import { getSupabaseBrowserClient } from '@seaking/auth/browser';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const supabase = getSupabaseBrowserClient();
      await supabase.auth.signOut();
      router.push('/login');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded border border-seaking-border bg-seaking-surface px-3 py-1.5 text-sm text-seaking-muted transition hover:text-seaking-ink disabled:opacity-50"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
