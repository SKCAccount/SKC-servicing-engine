import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isAdminManager, isManager } from '@seaking/auth';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

interface PageProps {
  params: Promise<{ clientId: string }>;
}

export default async function ClientDashboardPage({ params }: PageProps) {
  const user = await getCurrentAuthUser();
  if (!user) redirect('/login');
  if (!isManager(user.role)) redirect('/login?reason=wrong_app');

  const { clientId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: client, error } = await supabase
    .from('clients')
    .select('id, legal_name, display_name, status, over_advanced_state, version')
    .eq('id', clientId)
    .maybeSingle();

  if (error || !client) notFound();

  // rule_sets is the per-client fee + borrowing-base + payment-allocation
  // snapshot. The "current" one is the row with effective_to IS NULL.
  const { data: currentRuleSet } = await supabase
    .from('rule_sets')
    .select(
      'id, effective_from, period_1_days, period_1_fee_rate_bps, period_2_days, period_2_fee_rate_bps, subsequent_period_days, subsequent_period_fee_rate_bps, po_advance_rate_bps, ar_advance_rate_bps, pre_advance_rate_bps, ar_aged_out_days, payment_allocation_principal_bps, payment_allocation_fee_bps',
    )
    .eq('client_id', clientId)
    .is('effective_to', null)
    .maybeSingle();

  const c = client as {
    id: string;
    legal_name: string;
    display_name: string;
    status: 'active' | 'inactive' | 'paused';
    over_advanced_state: boolean;
    version: number;
  };

  const canEdit = isAdminManager(user.role);

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6">
        <Link
          href="/clients"
          className="text-sm text-seaking-muted hover:text-seaking-ink hover:underline"
        >
          ← All Clients
        </Link>
        <div className="mt-2 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-seaking-navy">
              {c.display_name}
            </h1>
            <p className="text-sm text-seaking-muted">
              <span className="font-mono text-[10px] uppercase tracking-wider">{c.status}</span>
              {c.legal_name !== c.display_name && <span> · {c.legal_name}</span>}
              {c.over_advanced_state && (
                <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-seaking-danger">
                  Over Advanced
                </span>
              )}
            </p>
          </div>
          {canEdit && (
            <div className="flex items-center gap-2">
              <Link
                href={`/clients/${c.id}/rules`}
                className="rounded border border-seaking-border bg-white px-3 py-1.5 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg"
              >
                {currentRuleSet ? 'Edit rules' : 'Set rules'}
              </Link>
              <Link
                href={`/clients/${c.id}/edit`}
                className="rounded border border-seaking-border bg-white px-3 py-1.5 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg"
              >
                Edit Client
              </Link>
            </div>
          )}
        </div>
      </header>

      {!currentRuleSet && (
        <div className="mb-6 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>No rule set configured.</strong> Before any advance can be committed, set the
          borrowing base and fee rules for this Client.
          {canEdit && (
            <>
              {' '}
              <Link
                href={`/clients/${c.id}/rules`}
                className="font-medium underline hover:no-underline"
              >
                Configure now →
              </Link>
            </>
          )}
        </div>
      )}

      {/* Main Interface actions. Most are stubs that land in their respective
          phases; PO Upload is live as of Phase 1C. */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <ActionCard
          title="Purchase Order Upload"
          description="Upload Walmart SupplierOne or Generic CSV PO data."
          href={`/clients/${c.id}/po-uploads/new`}
          phase="1C"
          live
        />
        <ActionCard
          title="Purchase Orders"
          description="Browse every PO on file for this Client with filters."
          href={`/clients/${c.id}/purchase-orders`}
          phase="1C"
          live
        />
        <ActionCard
          title="Advance on Purchase Orders"
          description="Pick POs, set amount + date, allocate ratably across the lowest borrowing ratios."
          href={`/clients/${c.id}/advances/po/new`}
          phase="1D"
          live
        />
        <ActionCard title="Invoice Upload" phase="1E" />
        <ActionCard title="Advance on Accounts Receivable" phase="1E" />
        <ActionCard title="Pre-Advance on Accounts Receivable" phase="1E" />
        <ActionCard title="Record a Payment" phase="1F" />
        <ActionCard title="Record a Remittance" phase="1F" />
        <ActionCard title="Advances in Bad Standing" phase="1G" />
        <ActionCard title="Advance Requests" phase="1B" />
        <ActionCard title="Reports & Exports" phase="1H" />
      </section>

      <p className="mt-6 text-xs text-seaking-muted">
        Borrowing-base metrics and principal-outstanding dashboard land in Phase 1D once advances
        are wired through the event log.
      </p>
    </main>
  );
}

interface ActionCardProps {
  title: string;
  description?: string;
  href?: string;
  phase: string;
  live?: boolean;
}

function ActionCard({ title, description, href, phase, live }: ActionCardProps) {
  const inner = (
    <div
      className={
        live
          ? 'flex h-full flex-col rounded-lg border border-seaking-border bg-seaking-surface p-4 transition hover:border-seaking-navy hover:shadow-sm'
          : 'flex h-full flex-col rounded-lg border border-dashed border-seaking-border bg-seaking-bg p-4 opacity-70'
      }
    >
      <div className="flex items-start justify-between">
        <div className="font-medium">{title}</div>
        <span
          className={
            live
              ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-seaking-success'
              : 'rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-seaking-muted'
          }
        >
          {live ? 'ready' : `phase ${phase}`}
        </span>
      </div>
      {description && <p className="mt-1 text-xs text-seaking-muted">{description}</p>}
    </div>
  );
  if (live && href) {
    return (
      <Link href={href} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}
