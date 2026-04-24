'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { inviteUserAction } from './actions';

type InvitableRole = 'admin_manager' | 'operator' | 'client';

interface ClientOption {
  id: string;
  display_name: string;
}

export function InviteUserForm({ clients }: { clients: ClientOption[] }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableRole>('operator');
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  function toggleClient(id: string) {
    setSelectedClientIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (role === 'client') {
          next.clear();
        }
        next.add(id);
      }
      return next;
    });
  }

  function setRoleAndResetGrants(next: InvitableRole) {
    setRole(next);
    // Clients get exactly one; reset to keep the UI honest.
    if (next === 'client') {
      setSelectedClientIds((prev) => {
        if (prev.size <= 1) return prev;
        const first = prev.values().next().value;
        return new Set(first ? [first] : []);
      });
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const result = await inviteUserAction({
      email,
      role,
      client_ids: Array.from(selectedClientIds),
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

  const needsGrants = role !== 'client';
  const grantsHint =
    role === 'client'
      ? 'Pick exactly one Client — this user will see only that Client’s data.'
      : 'Select one or more Clients this user can work with. Leave empty if you want to grant access later.';

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <Field id="email" label="Email" error={fieldErrors['email']}>
        <input
          id="email"
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded border border-seaking-border px-3 py-2 text-sm outline-none focus:border-seaking-navy"
        />
      </Field>

      <Field id="role" label="Role" error={fieldErrors['role']}>
        <select
          id="role"
          value={role}
          onChange={(e) => setRoleAndResetGrants(e.target.value as InvitableRole)}
          className="w-full rounded border border-seaking-border bg-white px-3 py-2 text-sm outline-none focus:border-seaking-navy"
        >
          <option value="admin_manager">Admin Manager — full access, can invite others</option>
          <option value="operator">Operator — record data; can&apos;t change rules or invite</option>
          <option value="client">Client — read-only portal + advance requests</option>
        </select>
      </Field>

      <div>
        <div className="mb-2 text-sm font-medium">
          Client access{role === 'client' ? '' : ' (optional)'}
        </div>
        <p className="mb-2 text-xs text-seaking-muted">{grantsHint}</p>
        {clients.length === 0 ? (
          <div className="rounded border border-dashed border-seaking-border p-4 text-xs text-seaking-muted">
            No Clients yet. Create a Client first, then return to invite the user.
          </div>
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

      {needsGrants && selectedClientIds.size === 0 && (
        <div className="rounded bg-amber-50 p-3 text-xs text-amber-900" role="status">
          Heads up — this user will see an empty Client list until you grant them access. You can
          do that later from their edit page.
        </div>
      )}

      {error && (
        <div className="rounded bg-red-50 p-3 text-sm text-seaking-danger" role="alert">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
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
          {busy ? 'Sending…' : 'Send invite'}
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
