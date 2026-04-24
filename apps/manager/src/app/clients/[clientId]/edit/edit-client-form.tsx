'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { updateClientAction } from './actions';

type Status = 'active' | 'inactive' | 'paused';

interface EditClientFormProps {
  initial: {
    id: string;
    legal_name: string;
    display_name: string;
    status: Status;
    version: number;
  };
}

export function EditClientForm({ initial }: EditClientFormProps) {
  const router = useRouter();
  const [legalName, setLegalName] = useState(initial.legal_name);
  const [displayName, setDisplayName] = useState(initial.display_name);
  const [status, setStatus] = useState<Status>(initial.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const result = await updateClientAction({
      id: initial.id,
      legal_name: legalName,
      display_name: displayName,
      status,
      expected_version: initial.version,
    });

    if (!result.ok) {
      setError(result.error.message);
      setFieldErrors(result.error.fieldErrors ?? {});
      setBusy(false);
      return;
    }

    router.push(`/clients/${initial.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="display_name" label="Display name" error={fieldErrors['display_name']}>
        <input
          id="display_name"
          type="text"
          required
          maxLength={80}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded border border-seaking-border px-3 py-2 text-sm outline-none focus:border-seaking-navy"
        />
      </Field>

      <Field id="legal_name" label="Legal name" error={fieldErrors['legal_name']}>
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
          onChange={(e) => setStatus(e.target.value as Status)}
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
          onClick={() => router.push(`/clients/${initial.id}`)}
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
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string[] | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
      {error && error.length > 0 && (
        <p className="mt-1 text-xs text-seaking-danger">{error.join('; ')}</p>
      )}
    </div>
  );
}
