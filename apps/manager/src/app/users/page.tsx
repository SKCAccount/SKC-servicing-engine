import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isAdminManager, isManager } from '@seaking/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';

type Role = 'admin_manager' | 'operator' | 'client' | 'investor' | 'creditor';
type Status = 'active' | 'disabled';

interface UserRow {
  id: string;
  email: string;
  role: Role;
  client_id: string | null;
  status: Status;
}

interface ClientStub {
  id: string;
  display_name: string;
}

interface GrantRow {
  user_id: string;
  client_id: string;
}

const ROLE_LABELS: Record<Role, string> = {
  admin_manager: 'Admin Manager',
  operator: 'Operator',
  client: 'Client',
  investor: 'Investor',
  creditor: 'Creditor',
};

export default async function UsersPage() {
  const me = await getCurrentAuthUser();
  if (!me) redirect('/login');
  if (!isManager(me.role)) redirect('/login?reason=wrong_app');

  const supabase = await createSupabaseServerClient();

  // RLS on users scopes this correctly:
  //   users_select_self — always see yourself
  //   users_select_manager — see all managers + clients in your client scope
  const [{ data: users }, { data: clients }, { data: grants }] = await Promise.all([
    supabase
      .from('users')
      .select('id, email, role, client_id, status')
      .order('role', { ascending: true })
      .order('email', { ascending: true }),
    supabase.from('clients').select('id, display_name'),
    supabase.from('user_client_access').select('user_id, client_id'),
  ]);

  const userRows = (users ?? []) as UserRow[];
  const clientById = new Map(
    ((clients ?? []) as ClientStub[]).map((c) => [c.id, c.display_name] as const),
  );
  const grantsByUser = new Map<string, string[]>();
  for (const g of (grants ?? []) as GrantRow[]) {
    const list = grantsByUser.get(g.user_id) ?? [];
    list.push(g.client_id);
    grantsByUser.set(g.user_id, list);
  }

  const canInvite = isAdminManager(me.role);

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <Link
            href="/clients"
            className="text-sm text-seaking-muted hover:text-seaking-ink hover:underline"
          >
            ← Clients
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-seaking-navy">Users</h1>
        </div>
        {canInvite && (
          <Link
            href="/users/new"
            className="rounded bg-seaking-navy px-3 py-1.5 text-sm font-medium text-white transition hover:bg-seaking-navy-hover"
          >
            + Invite user
          </Link>
        )}
      </header>

      {userRows.length === 0 && (
        <p className="text-sm text-seaking-muted">No users visible. (This shouldn&apos;t happen — you should at least see yourself.)</p>
      )}

      {userRows.length > 0 && (
        <div className="overflow-hidden rounded border border-seaking-border bg-seaking-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-seaking-border bg-seaking-bg">
              <tr>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Client access</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-seaking-border">
              {userRows.map((u) => {
                const clientList =
                  u.role === 'client' && u.client_id
                    ? [clientById.get(u.client_id) ?? '?']
                    : (grantsByUser.get(u.id) ?? []).map((cid) => clientById.get(cid) ?? '?');
                return (
                  <tr key={u.id}>
                    <Td>
                      <div className="font-medium">{u.email}</div>
                      {u.id === me.id && (
                        <div className="text-[10px] uppercase tracking-wider text-seaking-muted">
                          you
                        </div>
                      )}
                    </Td>
                    <Td>{ROLE_LABELS[u.role]}</Td>
                    <Td>
                      {clientList.length === 0 ? (
                        <span className="text-xs italic text-seaking-muted">no grants</span>
                      ) : (
                        <span className="text-xs">{clientList.join(', ')}</span>
                      )}
                    </Td>
                    <Td>
                      <span
                        className={
                          u.status === 'active'
                            ? 'text-xs font-medium text-seaking-success'
                            : 'text-xs font-medium text-seaking-muted'
                        }
                      >
                        {u.status}
                      </span>
                    </Td>
                    <Td className="text-right">
                      {canInvite && u.id !== me.id && (
                        <Link
                          href={`/users/${u.id}`}
                          className="text-xs font-medium text-seaking-navy hover:underline"
                        >
                          Edit →
                        </Link>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-seaking-muted">
      {children}
    </th>
  );
}
function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 ${className ?? ''}`}>{children}</td>;
}
