/**
 * Dashboard metrics helper — produces the 13-metric block from spec §"Main
 * Interface" for either the whole Client (no batch filter) or a single
 * batch.
 *
 * Usage (server component):
 *
 *   const metrics = await loadClientPosition(supabase, clientId, batchId);
 *   <DashboardMetrics data={metrics} />
 *
 * "Unfiltered" path reads `mv_client_position` directly — it already has
 * every metric the spec lists at the Client level. Cheap (single row).
 *
 * "Per-batch" path computes the metrics inline via parallel queries
 * against purchase_orders, mv_advance_balances joined to advances, and
 * ledger_events. The query count is bounded (5 parallel queries),
 * each filtered by client_id + batch_id, so this stays fast at Phase-1
 * scale (<100 batches per Client). When per-batch metric calculation
 * becomes a hot path we can promote to a SQL view; for now the inline
 * approach keeps the schema simple.
 *
 * Over Advanced status is always Client-level per spec, so we read it
 * from mv_client_position regardless of whether a batch filter is active.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@seaking/db';

const ELIGIBLE_PO_STATUSES = [
  'active',
  'partially_invoiced',
  'closed_awaiting_invoice',
] as const;

export interface ClientPositionMetrics {
  /** PO and AR borrowing-base, principal, and ratio numbers. */
  po_principal_outstanding_cents: number;
  ar_principal_outstanding_cents: number;
  pre_advance_principal_outstanding_cents: number;

  active_po_value_cents: number;
  eligible_ar_value_cents: number;

  po_borrowing_base_cents: number;
  ar_borrowing_base_cents: number;
  pre_advance_borrowing_base_cents: number;

  po_borrowing_base_available_cents: number;
  ar_borrowing_base_available_cents: number;
  pre_advance_borrowing_base_available_cents: number;

  total_fees_outstanding_cents: number;
  remittance_balance_cents: number;

  /**
   * Always Client-level (per spec). When a batch filter is active, this
   * reflects the Client's overall state — a batch by itself can't be
   * "over advanced."
   */
  is_over_advanced: boolean;
  total_principal_over_borrowing_base_cents: number;

  /** Echoes back so the UI can label the card group. */
  scope: { kind: 'client' } | { kind: 'batch'; batch_id: string; batch_label: string };
}

/**
 * Bps-driven PO borrowing ratio shown on the dashboard. We render
 * principal / total PO value here (matching the spec's "Current PO
 * Borrowing Ratio" semantics) — NOT principal / borrowing base.
 */
export function poBorrowingRatioBps(
  poPrincipalCents: number,
  activePoValueCents: number,
): number {
  if (activePoValueCents <= 0) return 0;
  return Math.round((poPrincipalCents * 10_000) / activePoValueCents);
}

export function arBorrowingRatioBps(
  arPrincipalCents: number,
  eligibleArValueCents: number,
): number {
  if (eligibleArValueCents <= 0) return 0;
  return Math.round((arPrincipalCents * 10_000) / eligibleArValueCents);
}

// ============================================================================
// loadClientPosition
// ============================================================================

export async function loadClientPosition(
  supabase: SupabaseClient<Database>,
  clientId: string,
  batchId: string | null,
): Promise<ClientPositionMetrics | { error: string }> {
  // The Client-level Over Advanced flag is the same regardless of the batch
  // filter, so we always pull mv_client_position and reuse those two fields
  // in the per-batch return.
  const clientPositionPromise = supabase
    .from('mv_client_position')
    .select(
      'po_principal_outstanding_cents, ar_principal_outstanding_cents, pre_advance_principal_outstanding_cents, active_po_value_cents, eligible_ar_value_cents, po_borrowing_base_cents, ar_borrowing_base_cents, pre_advance_borrowing_base_cents, po_borrowing_base_available_cents, ar_borrowing_base_available_cents, pre_advance_borrowing_base_available_cents, total_fees_outstanding_cents, remittance_balance_cents, is_over_advanced',
    )
    .eq('client_id', clientId)
    .maybeSingle();

  if (batchId === null) {
    const { data, error } = await clientPositionPromise;
    if (error) return { error: error.message };
    if (!data) {
      // No projection row yet — Client has zero activity.
      return zeroMetrics({ kind: 'client' });
    }
    // Materialized-view columns come back as nullable from Supabase's
    // generated types; in practice the view always projects numbers, but
    // we coerce defensively so the metric arithmetic stays integer-safe.
    const poPrincipal = data.po_principal_outstanding_cents ?? 0;
    const arPrincipal = data.ar_principal_outstanding_cents ?? 0;
    const preAdvancePrincipal = data.pre_advance_principal_outstanding_cents ?? 0;
    const poBb = data.po_borrowing_base_cents ?? 0;
    const arBb = data.ar_borrowing_base_cents ?? 0;
    const preAdvanceBb = data.pre_advance_borrowing_base_cents ?? 0;
    const totalPrincipal = poPrincipal + arPrincipal + preAdvancePrincipal;
    const totalBb = poBb + arBb + preAdvanceBb;
    return {
      po_principal_outstanding_cents: poPrincipal,
      ar_principal_outstanding_cents: arPrincipal,
      pre_advance_principal_outstanding_cents: preAdvancePrincipal,
      active_po_value_cents: data.active_po_value_cents ?? 0,
      eligible_ar_value_cents: data.eligible_ar_value_cents ?? 0,
      po_borrowing_base_cents: poBb,
      ar_borrowing_base_cents: arBb,
      pre_advance_borrowing_base_cents: preAdvanceBb,
      po_borrowing_base_available_cents: data.po_borrowing_base_available_cents ?? 0,
      ar_borrowing_base_available_cents: data.ar_borrowing_base_available_cents ?? 0,
      pre_advance_borrowing_base_available_cents:
        data.pre_advance_borrowing_base_available_cents ?? 0,
      total_fees_outstanding_cents: data.total_fees_outstanding_cents ?? 0,
      remittance_balance_cents: data.remittance_balance_cents ?? 0,
      is_over_advanced: data.is_over_advanced ?? false,
      total_principal_over_borrowing_base_cents: Math.max(0, totalPrincipal - totalBb),
      scope: { kind: 'client' },
    };
  }

  // ---------- Per-batch path ----------
  // Run all the queries needed to assemble per-batch metrics in parallel.
  // Each is filtered by client_id + batch_id so the result sets stay small.
  const [
    clientPositionResult,
    batchRowResult,
    ruleSetResult,
    poValueResult,
    advancesResult,
    remittanceResult,
  ] = await Promise.all([
    clientPositionPromise,
    supabase
      .from('batches')
      .select('id, name')
      .eq('id', batchId)
      .eq('client_id', clientId)
      .maybeSingle(),
    supabase
      .from('rule_sets')
      .select('po_advance_rate_bps, ar_advance_rate_bps, pre_advance_rate_bps')
      .eq('client_id', clientId)
      .is('effective_to', null)
      .maybeSingle(),
    // active_po_value for this batch — outstanding (non-cancelled, non-fully-
    // invoiced) POs in this batch.
    supabase
      .from('purchase_orders')
      .select('po_value_cents')
      .eq('client_id', clientId)
      .eq('batch_id', batchId)
      .in('status', [...ELIGIBLE_PO_STATUSES]),
    // mv_advance_balances rows for advances in this batch. Join through
    // advances to get advance_type for breakdown.
    supabase
      .from('mv_advance_balances')
      .select(
        'principal_outstanding_cents, fees_outstanding_cents, advance_type',
      )
      .eq('client_id', clientId)
      .eq('batch_id', batchId),
    // remittance_balance per batch — sum of remittance_delta_cents events
    // attributed to this batch_id (positive = accumulated, negative = wired).
    supabase
      .from('ledger_events')
      .select('remittance_delta_cents')
      .eq('client_id', clientId)
      .eq('batch_id', batchId)
      .is('reversed_by_event_id', null),
  ]);

  if (clientPositionResult.error) return { error: clientPositionResult.error.message };
  if (batchRowResult.error) return { error: batchRowResult.error.message };
  if (ruleSetResult.error) return { error: ruleSetResult.error.message };
  if (poValueResult.error) return { error: poValueResult.error.message };
  if (advancesResult.error) return { error: advancesResult.error.message };
  if (remittanceResult.error) return { error: remittanceResult.error.message };

  if (!batchRowResult.data) {
    return { error: 'Batch not found.' };
  }

  // Aggregate the parallel-fetched rows.
  let activePoValueCents = 0;
  for (const row of poValueResult.data ?? []) {
    activePoValueCents += row.po_value_cents ?? 0;
  }

  let poPrincipalCents = 0;
  let arPrincipalCents = 0;
  let preAdvancePrincipalCents = 0;
  let totalFeesCents = 0;
  for (const row of advancesResult.data ?? []) {
    const principal = row.principal_outstanding_cents ?? 0;
    const fees = row.fees_outstanding_cents ?? 0;
    totalFeesCents += fees;
    if (row.advance_type === 'po') poPrincipalCents += principal;
    else if (row.advance_type === 'ar') arPrincipalCents += principal;
    else if (row.advance_type === 'pre_advance') preAdvancePrincipalCents += principal;
  }

  let remittanceBalanceCents = 0;
  for (const row of remittanceResult.data ?? []) {
    remittanceBalanceCents += row.remittance_delta_cents ?? 0;
  }

  const ruleSet = ruleSetResult.data;
  const poRateBps = ruleSet?.po_advance_rate_bps ?? 0;
  const arRateBps = ruleSet?.ar_advance_rate_bps ?? 0;
  const preAdvanceRateBps = ruleSet?.pre_advance_rate_bps ?? 0;

  // Eligible AR value per batch: 0 until invoices ship in 1E. The query that
  // would compute it requires invoices.po_id → po.batch_id joined to
  // mv_invoice_aging. Once invoices ingest, swap this for the real
  // computation. The return shape doesn't change.
  const eligibleArValueCents = 0;

  const poBbCents = Math.floor((activePoValueCents * poRateBps) / 10_000);
  const arBbCents = Math.floor((eligibleArValueCents * arRateBps) / 10_000);
  // Pre-advance BB per batch uses eligible AR principal in this batch. Until
  // 1E ships, eligible AR principal is 0 in any batch.
  const preAdvanceBbCents = Math.floor((arPrincipalCents * preAdvanceRateBps) / 10_000);

  const isOverAdvanced = clientPositionResult.data?.is_over_advanced ?? false;
  const cp = clientPositionResult.data;
  const clientTotalPrincipal = cp
    ? (cp.po_principal_outstanding_cents ?? 0)
      + (cp.ar_principal_outstanding_cents ?? 0)
      + (cp.pre_advance_principal_outstanding_cents ?? 0)
    : 0;
  const clientTotalBb = cp
    ? (cp.po_borrowing_base_cents ?? 0)
      + (cp.ar_borrowing_base_cents ?? 0)
      + (cp.pre_advance_borrowing_base_cents ?? 0)
    : 0;

  return {
    po_principal_outstanding_cents: poPrincipalCents,
    ar_principal_outstanding_cents: arPrincipalCents,
    pre_advance_principal_outstanding_cents: preAdvancePrincipalCents,
    active_po_value_cents: activePoValueCents,
    eligible_ar_value_cents: eligibleArValueCents,
    po_borrowing_base_cents: poBbCents,
    ar_borrowing_base_cents: arBbCents,
    pre_advance_borrowing_base_cents: preAdvanceBbCents,
    po_borrowing_base_available_cents: Math.max(0, poBbCents - poPrincipalCents),
    ar_borrowing_base_available_cents: Math.max(0, arBbCents - arPrincipalCents),
    pre_advance_borrowing_base_available_cents: Math.max(
      0,
      preAdvanceBbCents - preAdvancePrincipalCents,
    ),
    total_fees_outstanding_cents: totalFeesCents,
    remittance_balance_cents: remittanceBalanceCents,
    is_over_advanced: isOverAdvanced,
    total_principal_over_borrowing_base_cents: Math.max(
      0,
      clientTotalPrincipal - clientTotalBb,
    ),
    scope: {
      kind: 'batch',
      batch_id: batchRowResult.data.id,
      // batches.name is GENERATED ALWAYS but Supabase types it nullable
      // because generated columns are reported as nullable in the catalog.
      // In practice it's always present.
      batch_label: batchRowResult.data.name ?? `Batch ${batchId.slice(0, 8)}`,
    },
  };
}

function zeroMetrics(scope: ClientPositionMetrics['scope']): ClientPositionMetrics {
  return {
    po_principal_outstanding_cents: 0,
    ar_principal_outstanding_cents: 0,
    pre_advance_principal_outstanding_cents: 0,
    active_po_value_cents: 0,
    eligible_ar_value_cents: 0,
    po_borrowing_base_cents: 0,
    ar_borrowing_base_cents: 0,
    pre_advance_borrowing_base_cents: 0,
    po_borrowing_base_available_cents: 0,
    ar_borrowing_base_available_cents: 0,
    pre_advance_borrowing_base_available_cents: 0,
    total_fees_outstanding_cents: 0,
    remittance_balance_cents: 0,
    is_over_advanced: false,
    total_principal_over_borrowing_base_cents: 0,
    scope,
  };
}
