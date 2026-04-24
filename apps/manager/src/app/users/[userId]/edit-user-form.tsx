'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { updateUserAction } from './actions';

type EditableRole = 'admin_manager' | 'operator' | 'client';
type Status = 'active' | 'disabled';

interface Initial {
  user_id: string;
  email: string;
  role: EditableRole;
  status: Status;
  version: number;
  client_ids: string[];
}

interface ClientOption {
  id: string;
  display_name: string;
}

export function EditUserForm({
  initial,
  clients,
}: {
  initial: Initial;
  clients: ClientOption[];
}) {
  const router = useRouter();
  const [role, setRole] = useState<EditableRole>(initial.role);
  const [status, setStatus] = useState<Status>(initial.status);
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(
    new Set(initial.client_ids),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  function toggleClient(id: string) {
    setSelectedClientIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (role === 'client') next.clear();
        next.add(id);
      }
      return next;
    });
  }

  function setRoleAndFixGrants(next: EditableRole) {
    setRole(next);
    if (next === 'client' && selectedClientIds.size > 1) {
      const first = selectedClientIds.values().next().value;
      setSelectedClientIds(new Set(first ? [first] : []));
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const result = await updateUserAction({
      user_id: initial.user_id,
      role,
      status,
      client_ids: Array.from(selectedClientIds),
      expected_version: initial.version,
    });

    if (!result.ok) {
      setError(result.error.message);
      setFieldErrors(result.error.fieldErrors ?? {});
      setBusy(false);
      return;
    }

    router.push('/users');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          type="email"
          value={initial.email}
          disabled
          className="w-full rounded border border-seaking-border bg-seaking-bg px-3 py-2 text-sm text-seaking-muted"
        />
        <p className="mt-1 text-xs text-seaking-muted">
          To change a user&apos;s email, ask them to update it via Supabase Auth (Phase 2 UI).
        </p>
      </div>

      <Field id="role" label="Role" error={fieldErrors['role']}>
        <select
          id="role"
          value={role}
          onChange={(e) => setRoleAndFixGrants(e.target.value as EditableRole)}
          className="w-full rounded border border-seaking-border bg-white px-3 py-2 text-sm outline-none focus:border-seaking-navy"
        >
          <option value="admin_manager">Admin Manager</option>
          <option value="operator">Operator</option>
          <option value="client">Client</option>
        </select>
      </Field>

      <Field id="status" label="Status" error={fieldErrors['status']}>
        <select
          id="status"
          value={status}
          onChange={(e) => setStatus(e.target.value as Status)}
          className="w-full rounded border border-seaking-border bg-white px-3 py-2 text-sm outline-none focus:border-seaking-navy"
        >
          <option value="active">Active</option>
          <option value="disabled">Disabled — blocks sign-in but keeps history</option>
        </select>
      </Field>

      <div>
        <div className="mb-2 text-sm font-medium">Client access</div>
        {clients.length === 0 ? (
          <p className="text-xs text-seaking-muted">No Clients exist yet.</p>
        ) : (
          <div className="max-h-52 overflow-auto rounded border border-seaking-border bg-white p-2">
            {clients.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-seaking-bg"
              >
                <input
                  type={role === 'client' ? 'radio' : 'checkbox'}
                  name={role === 'client' ? 'grant' : undefined}
                  checked={selectedClientIds.has(c.id)}
                  onChange={() => toggleClient(c.id)}
                  className="h-4 w-4"
                />
                <span>{c.display_name}</span>
              </label>
            ))}
          </div>
        )}
        {fieldErrors['client_ids'] && fieldErrors['client_ids'].length > 0 && (
          <p className="mt-1 text-xs text-seaking-danger">
            {fieldErrors['client_ids'].join('; ')}
          </p>
        )}
      </div>

      {error && (
        <div className="rounded bg-red-50 p-3 text-sm text-seaking-danger" role="alert">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-seaking-border pt-4">
        <button
          type="button"
          onClick={() => router.push('/users')}
          disabled={busy}
          className="rounded border border-seaking-border bg-white px-4 py-2 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || (role === 'client' && selectedClientIds.size !== 1)}
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
