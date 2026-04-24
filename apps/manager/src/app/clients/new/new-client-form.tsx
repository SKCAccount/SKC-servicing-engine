'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { createClientAction } from './actions';

export function NewClientForm() {
  const router = useRouter();
  const [legalName, setLegalName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive' | 'paused'>('active');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const result = await createClientAction({
      legal_name: legalName,
      display_name: displayName,
      status,
    });

    if (!result.ok) {
      setError(result.error.message);
      setFieldErrors(result.error.fieldErrors ?? {});
      setBusy(false);
      return;
    }

    router.push(`/clients/${result.data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field
        id="display_name"
        label="Display name"
        hint="Shown throughout the app. Keep it short (e.g. “Acme Foods”)."
        error={fieldErrors['display_name']}
      >
        <input
          id="display_name"
          type="text"
          required
          autoFocus
          maxLength={80}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded border border-seaking-border px-3 py-2 text-sm outline-none focus:border-seaking-navy"
        />
      </Field>

      <Field
        id="legal_name"
        label="Legal name"
        hint="Full legal entity name as it appears on wire instructions and agreements."
        error={fieldErrors['legal_name']}
      >
        <input
          id="legal_name"
          type="text"
          required
          maxLength={200}
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          className="w-full rounded border border-seaking-border px-3 py-2 text-sm outline-none focus:border-seaking-navy"
        />
      </Field>

      <Field id="status" label="Status" error={fieldErrors['status']}>
        <select
          id="status"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="w-full rounded border border-seaking-border bg-white px-3 py-2 text-sm outline-none focus:border-seaking-navy"
        >
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="inactive">Inactive</option>
        </select>
      </Field>

      {error && (
        <div className="rounded bg-red-50 p-3 text-sm text-seaking-danger" role="alert">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={() => router.push('/clients')}
          disabled={busy}
          className="rounded border border-seaking-border bg-white px-4 py-2 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-seaking-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-seaking-navy-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create Client'}
        </button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string[] | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-seaking-muted">{hint}</p>}
      {error && error.length > 0 && (
        <p className="mt-1 text-xs text-seaking-danger">{error.join('; ')}</p>
      )}
    </div>
  );
}
