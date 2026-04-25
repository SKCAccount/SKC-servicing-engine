import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isAdminManager, isManager } from '@seaking/auth';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { loadClientPosition } from '@/lib/dashboard-metrics';
import { DashboardMetrics } from './dashboard-metrics';
import { DashboardBatchFilter } from './dashboard-batch-filter';

interface PageProps {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(v: string | string[] | undefined): string | null {
  if (v == null) return null;
  const s = Array.isArray(v) ? v[0] : v;
  if (s == null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

export default async function ClientDashboardPage({ params, searchParams }: PageProps) {
  const user = await getCurrentAuthUser();
  if (!user) redirect('/login');
  if (!isManager(user.role)) redirect('/login?reason=wrong_app');

  const { clientId } = await params;
  const sp = await searchParams;
  const batchFilterId = firstParam(sp['batch']);

  const supabase = await createSupabaseServerClient();

  const [
    { data: client, error },
    { data: currentRuleSet },
    { data: batchRows },
    metricsResult,
  ] = await Promise.all([
    supabase
      .from('clients')
      .select('id, legal_name, display_name, status, over_advanced_state, version')
      .eq('id', clientId)
      .maybeSingle(),
    supabase
      .from('rule_sets')
      .select(
        'id, effective_from, period_1_days, period_1_fee_rate_bps, period_2_days, period_2_fee_rate_bps, subsequent_period_days, subsequent_period_fee_rate_bps, po_advance_rate_bps, ar_advance_rate_bps, pre_advance_rate_bps, ar_aged_out_days, payment_allocation_principal_bps, payment_allocation_fee_bps',
      )
      .eq('client_id', clientId)
      .is('effective_to', null)
      .maybeSingle(),
    supabase
      .from('batches')
      .select('id, name, batch_number')
      .eq('client_id', clientId)
      .order('batch_number', { ascending: false }),
    loadClientPosition(supabase, clientId, batchFilterId),
  ]);

  if (error || !client) notFound();

  const c = client as {
    id: string;
    legal_name: string;
    display_name: string;
    status: 'active' | 'inactive' | 'paused';
    over_advanced_state: boolean;
    version: number;
  };

  const batches = (batchRows ?? []) as Array<{
    id: string;
    name: string;
    batch_number: number;
  }>;
  const canEdit = isAdminManager(user.role);

  const metricsError = 'error' in metricsResult ? metricsResult.error : null;
  const metrics = 'error' in metricsResult ? null : metricsResult;

  return (
    <main className="mx-auto max-w-screen-2xl p-6">
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

      {/* ---------- Position metrics ---------- */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-seaking-muted">
            Position
            {metrics?.scope.kind === 'batch' && (
              <span className="ml-2 normal-case text-seaking-ink">
                — {metrics.scope.batch_label}
              </span>
            )}
          </h2>
          {batches.length > 0 && (
            <DashboardBatchFilter
              batches={batches.map((b) => ({ id: b.id, label: b.name }))}
              currentBatchId={batchFilterId}
            />
          )}
        </div>

        {metricsError && (
          <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-seaking-danger">
            Failed to load position metrics: {metricsError}
          </div>
        )}

        {metrics && <DashboardMetrics data={metrics} />}
      </section>

      {/* ---------- Action cards ---------- */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-seaking-muted">
          Actions
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
          <ActionCard
            title="Assign Items to a Batch"
            description="Move outstanding POs (and later invoices + pre-advances) to an existing or new batch."
            href={`/clients/${c.id}/batches/assign`}
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
        </div>
      </section>
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
