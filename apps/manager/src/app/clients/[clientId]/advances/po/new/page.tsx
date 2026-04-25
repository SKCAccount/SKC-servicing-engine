/**
 * 'Advance on Purchase Orders' — entry page.
 *
 * Loads the candidate POs (active or partially-invoiced or
 * closed_awaiting_invoice; cancelled and written_off excluded per spec
 * §Advancing Purchase Orders: 'Cancelled purchase orders are excluded
 * from this list by default'). The client form drives the rest:
 * checkbox selection, configure (amount/date/batch), preview allocation,
 * confirm.
 *
 * For Phase 1D commit 3: in-app selection only (no CSV-of-PO-numbers
 * upload yet — that's the secondary path; the primary path is the
 * checkbox table).
 */

import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isManager } from '@seaking/auth';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { AdvanceOnPosForm } from './advance-on-pos-form';

interface PageProps {
  params: Promise<{ clientId: string }>;
}

interface CandidatePo {
  id: string;
  po_number: string;
  retailer_id: string;
  retailer_display: string;
  status: string;
  po_value_cents: number;
  current_principal_cents: number;
  current_batch_id: string | null;
  current_batch_label: string | null;
  issuance_date: string | null;
  requested_delivery_date: string | null;
}

export default async function NewPoAdvancePage({ params }: PageProps) {
  const user = await getCurrentAuthUser();
  if (!user) redirect('/login');
  if (!isManager(user.role)) redirect('/login?reason=wrong_app');

  const { clientId } = await params;
  const supabase = await createSupabaseServerClient();

  const [{ data: clientRow }, { data: ruleSet }, { data: poRows }, { data: balanceRows }, { data: retailerRows }, { data: batchRows }] = await Promise.all([
    supabase.from('clients').select('id, display_name').eq('id', clientId).maybeSingle(),
    supabase
      .from('rule_sets')
      .select('po_advance_rate_bps')
      .eq('client_id', clientId)
      .is('effective_to', null)
      .maybeSingle(),
    // Eligible POs: active and partially_invoiced. Closed-awaiting-invoice
    // is also eligible per the schema (a closed PO with no invoice yet may
    // still need an advance), but the spec defers that decision to the
    // Manager's filter. We include it; cancelled/written_off/fully_invoiced
    // are excluded.
    supabase
      .from('purchase_orders')
      .select('id, po_number, status, po_value_cents, retailer_id, batch_id, issuance_date, requested_delivery_date')
      .eq('client_id', clientId)
      .in('status', ['active', 'partially_invoiced', 'closed_awaiting_invoice'])
      .order('po_number', { ascending: true })
      .limit(2000),
    // Per-PO outstanding principal from the balance projection.
    supabase
      .from('mv_advance_balances')
      .select('purchase_order_id, principal_outstanding_cents')
      .eq('client_id', clientId),
    supabase.from('retailers').select('id, display_name'),
    supabase
      .from('batches')
      .select('id, name, batch_number')
      .eq('client_id', clientId)
      .order('batch_number', { ascending: true }),
  ]);

  if (!clientRow) notFound();
  const client = clientRow as { id: string; display_name: string };
  const ruleSetRow = ruleSet as { po_advance_rate_bps: number } | null;

  const retailers = (retailerRows ?? []) as Array<{ id: string; display_name: string }>;
  const retailerById = new Map(retailers.map((r) => [r.id, r.display_name]));
  const batches = (batchRows ?? []) as Array<{ id: string; name: string; batch_number: number }>;
  const batchById = new Map(batches.map((b) => [b.id, b.name]));

  // Aggregate principal per PO (sum across all advance series on that PO).
  const principalByPo = new Map<string, number>();
  for (const row of (balanceRows ?? []) as Array<{
    purchase_order_id: string;
    principal_outstanding_cents: number;
  }>) {
    principalByPo.set(
      row.purchase_order_id,
      (principalByPo.get(row.purchase_order_id) ?? 0) + (row.principal_outstanding_cents ?? 0),
    );
  }

  type RawPo = {
    id: string;
    po_number: string;
    status: string;
    po_value_cents: number;
    retailer_id: string;
    batch_id: string | null;
    issuance_date: string | null;
    requested_delivery_date: string | null;
  };
  const candidates: CandidatePo[] = ((poRows ?? []) as RawPo[]).map((p) => ({
    id: p.id,
    po_number: p.po_number,
    retailer_id: p.retailer_id,
    retailer_display: retailerById.get(p.retailer_id) ?? '?',
    status: p.status,
    po_value_cents: p.po_value_cents,
    current_principal_cents: principalByPo.get(p.id) ?? 0,
    current_batch_id: p.batch_id,
    current_batch_label: p.batch_id ? (batchById.get(p.batch_id) ?? null) : null,
    issuance_date: p.issuance_date,
    requested_delivery_date: p.requested_delivery_date,
  }));

  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="mb-6">
        <Link
          href={`/clients/${client.id}`}
          className="text-sm text-seaking-muted hover:text-seaking-ink hover:underline"
        >
          ← Back to {client.display_name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-seaking-navy">
          Advance on Purchase Orders
        </h1>
        <p className="mt-1 text-sm text-seaking-muted">
          Pick the POs to advance against, set an amount and date, review the per-PO allocation,
          then commit. The Advance Date drives fee accrual.
        </p>
      </header>

      {!ruleSetRow && (
        <div className="mb-4 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>No rule set configured.</strong> Set the Borrowing Base and Fee Rules for this
          Client before committing an advance.{' '}
          <Link href={`/clients/${client.id}/rules`} className="font-medium underline">
            Configure now →
          </Link>
        </div>
      )}

      {candidates.length === 0 ? (
        <div className="rounded border border-dashed border-seaking-border bg-seaking-surface p-10 text-center">
          <p className="text-sm text-seaking-muted">
            No eligible POs found. Active and partially-invoiced POs appear here.
          </p>
        </div>
      ) : (
        <AdvanceOnPosForm
          clientId={client.id}
          poAdvanceRateBps={ruleSetRow?.po_advance_rate_bps ?? null}
          batches={batches.map((b) => ({ id: b.id, label: b.name }))}
          candidates={candidates}
        />
      )}
    </main>
  );
}
