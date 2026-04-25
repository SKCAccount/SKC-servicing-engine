'use server';

/**
 * Server actions for the standalone Assign-to-Batch screen.
 *
 * Two actions:
 *
 *   1. fetchAllMatchingItemsAction — runs the same filter query the page
 *      runs (without pagination) and returns up to `hardLimit` outstanding
 *      item summaries so the UI can let the Manager 'Select all matches'
 *      across multiple pages. Pattern lifted from
 *      /advances/po/new/actions.ts.
 *
 *   2. commitReassignToBatchAction — calls the reassign_to_batch RPC.
 *      RPC handles validation + batch resolution + per-PO event emission +
 *      advance-batch-follows update atomically.
 *
 * Phase 1D commit 4 only emits PO rows. Pre-advance and invoice rows ship
 * once those creation paths exist (later phases).
 */

import { createSupabaseServerClient, requireAuthUser } from '@seaking/auth/server';
import { isManager } from '@seaking/auth';
import { ok, err, type ActionResult } from '@seaking/api';
import {
  reassignToBatchInputSchema,
  type ReassignToBatchInput,
} from '@seaking/validators';
import { supabaseError, zodError } from '@/lib/action-helpers';
import { revalidatePath } from 'next/cache';

const ELIGIBLE_STATUSES = ['active', 'partially_invoiced', 'closed_awaiting_invoice'] as const;

async function authorize(clientId: string): Promise<
  | { ok: true; user: { id: string; email: string; role: string } }
  | { ok: false; err: ActionResult<never> }
> {
  let user;
  try {
    user = await requireAuthUser();
  } catch {
    return { ok: false, err: err('UNAUTHENTICATED', 'Please sign in again.') };
  }
  if (!isManager(user.role)) {
    return { ok: false, err: err('FORBIDDEN', 'Only Managers can reassign items to batches.') };
  }
  const supabase = await createSupabaseServerClient();
  const { data: access } = await supabase
    .from('user_client_access')
    .select('client_id')
    .eq('user_id', user.id)
    .eq('client_id', clientId)
    .maybeSingle();
  if (!access) {
    return { ok: false, err: err('FORBIDDEN', 'You do not have access to this Client.') };
  }
  return { ok: true, user };
}

// ============================================================================
// fetchAllMatchingItemsAction
// ============================================================================

export interface FetchMatchingItemsFilter {
  q: string | null;
  retailer_slug: string | null;
  batch_id: string | null; // 'unassigned' OR a UUID OR null
  status: string | null;
  value_min_cents: number | null;
  value_max_cents: number | null;
}

export interface MatchingItemSummary {
  id: string; // PO id (commit 4 uses POs only)
  type: 'po_advance'; // Phase 1D commit 4: only "PO Advance" rows. Pre-Advance / AR Advance arrive later.
  po_number: string;
  retailer_id: string;
  retailer_display: string;
  status: string;
  po_value_cents: number;
  current_principal_cents: number;
  fees_outstanding_cents: number;
  current_batch_id: string | null;
  current_batch_label: string | null;
  issuance_date: string | null;
  requested_delivery_date: string | null;
  created_at: string;
}

export async function fetchAllMatchingItemsAction(
  clientId: string,
  filter: FetchMatchingItemsFilter,
  hardLimit: number = 5000,
): Promise<ActionResult<{ items: MatchingItemSummary[]; truncated: boolean; totalCount: number }>> {
  const authz = await authorize(clientId);
  if (!authz.ok) return authz.err;

  const supabase = await createSupabaseServerClient();

  // Look up retailer slug → id once if filtering.
  let retailerId: string | null = null;
  if (filter.retailer_slug) {
    const { data: r } = await supabase
      .from('retailers')
      .select('id')
      .eq('name', filter.retailer_slug)
      .maybeSingle();
    retailerId = (r as { id: string } | null)?.id ?? null;
    if (!retailerId) {
      return err('NOT_FOUND', `Retailer "${filter.retailer_slug}" is not registered.`);
    }
  }

  const statusList =
    filter.status && (ELIGIBLE_STATUSES as readonly string[]).includes(filter.status)
      ? [filter.status]
      : (ELIGIBLE_STATUSES as readonly string[]);

  // Step 1: count.
  let countQ = supabase
    .from('v_purchase_orders_with_balance')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .in('status', statusList);
  if (filter.q) countQ = countQ.ilike('po_number', `%${filter.q}%`);
  if (retailerId) countQ = countQ.eq('retailer_id', retailerId);
  if (filter.batch_id === 'unassigned') countQ = countQ.is('batch_id', null);
  else if (filter.batch_id) countQ = countQ.eq('batch_id', filter.batch_id);
  if (filter.value_min_cents != null) countQ = countQ.gte('po_value_cents', filter.value_min_cents);
  if (filter.value_max_cents != null) countQ = countQ.lte('po_value_cents', filter.value_max_cents);

  const { count: totalCount, error: countError } = await countQ;
  if (countError) return supabaseError(countError);
  const total = totalCount ?? 0;

  // Step 2: parallel-paginated fetch up to hardLimit. Same workaround as the
  // Advance on POs page for PostgREST's max-rows=1000 clamp.
  const PAGE_SIZE = 1000;
  const targetCount = Math.min(total, hardLimit);
  const pageCount = targetCount > 0 ? Math.ceil(targetCount / PAGE_SIZE) : 0;

  type RawRow = {
    id: string;
    po_number: string;
    status: string;
    po_value_cents: number;
    retailer_id: string;
    batch_id: string | null;
    current_principal_cents: number;
    fees_outstanding_cents: number;
    issuance_date: string | null;
    requested_delivery_date: string | null;
    created_at: string;
  };

  const rows: RawRow[] = [];
  if (pageCount > 0) {
    const pageRequests = Array.from({ length: pageCount }, (_, i) => {
      const start = i * PAGE_SIZE;
      const end = Math.min(start + PAGE_SIZE - 1, targetCount - 1);
      let pageQ = supabase
        .from('v_purchase_orders_with_balance')
        .select(
          'id, po_number, status, po_value_cents, retailer_id, batch_id, current_principal_cents, fees_outstanding_cents, issuance_date, requested_delivery_date, created_at',
        )
        .eq('client_id', clientId)
        .in('status', statusList)
        .order('id', { ascending: true })
        .range(start, end);
      if (filter.q) pageQ = pageQ.ilike('po_number', `%${filter.q}%`);
      if (retailerId) pageQ = pageQ.eq('retailer_id', retailerId);
      if (filter.batch_id === 'unassigned') pageQ = pageQ.is('batch_id', null);
      else if (filter.batch_id) pageQ = pageQ.eq('batch_id', filter.batch_id);
      if (filter.value_min_cents != null)
        pageQ = pageQ.gte('po_value_cents', filter.value_min_cents);
      if (filter.value_max_cents != null)
        pageQ = pageQ.lte('po_value_cents', filter.value_max_cents);
      return pageQ;
    });
    const responses = await Promise.all(pageRequests);
    for (const res of responses) {
      if (res.error) return supabaseError(res.error);
      for (const row of (res.data ?? []) as RawRow[]) rows.push(row);
    }
  }

  // Pull retailer + batch labels for display.
  const [{ data: retailerList }, { data: batchList }] = await Promise.all([
    supabase.from('retailers').select('id, display_name'),
    supabase.from('batches').select('id, name').eq('client_id', clientId),
  ]);
  const retailerById = new Map(
    ((retailerList ?? []) as Array<{ id: string; display_name: string }>).map((r) => [
      r.id,
      r.display_name,
    ]),
  );
  const batchById = new Map(
    ((batchList ?? []) as Array<{ id: string; name: string }>).map((b) => [b.id, b.name]),
  );

  const items: MatchingItemSummary[] = rows.map((r) => ({
    id: r.id,
    type: 'po_advance',
    po_number: r.po_number,
    retailer_id: r.retailer_id,
    retailer_display: retailerById.get(r.retailer_id) ?? '?',
    status: r.status,
    po_value_cents: r.po_value_cents,
    current_principal_cents: r.current_principal_cents ?? 0,
    fees_outstanding_cents: r.fees_outstanding_cents ?? 0,
    current_batch_id: r.batch_id,
    current_batch_label: r.batch_id ? (batchById.get(r.batch_id) ?? null) : null,
    issuance_date: r.issuance_date,
    requested_delivery_date: r.requested_delivery_date,
    created_at: r.created_at,
  }));

  return ok({ items, truncated: total > hardLimit, totalCount: total });
}

// ============================================================================
// commitReassignToBatchAction
// ============================================================================

export interface ReassignToBatchResult {
  batch_id: string;
  pos_reassigned: number;
  advances_reassigned: number;
  events_emitted: number;
}

export async function commitReassignToBatchAction(
  input: ReassignToBatchInput,
): Promise<ActionResult<ReassignToBatchResult>> {
  const parsed = reassignToBatchInputSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);

  const authz = await authorize(parsed.data.client_id);
  if (!authz.ok) return authz.err;

  const supabase = await createSupabaseServerClient();

  // RPC convention (matches commit_po_advance): pass exactly one of
  // p_existing_batch_id or p_new_batch_name. The non-null new_batch_name
  // value is ignored — batches.name is GENERATED ALWAYS AS 'Batch ' ||
  // batch_number so the user can't override it. We pass a sentinel string
  // when creating a new batch to signal "this branch."
  const { data: rpcResult, error: rpcError } = await supabase.rpc('reassign_to_batch', {
    p_client_id: parsed.data.client_id,
    p_po_ids: parsed.data.purchase_order_ids,
    p_existing_batch_id: parsed.data.existing_batch_id,
    p_new_batch_name: parsed.data.new_batch ? '__new__' : null,
    p_acknowledged_batch_reassignment: parsed.data.acknowledged_batch_reassignment,
  });
  if (rpcError) return supabaseError(rpcError);

  // Best-effort projection refresh — same as commit_po_advance. The
  // batch_id changes affect mv_batch_position and mv_client_position
  // (PO advance allocation across batches).
  await supabase.rpc('refresh_po_projections');

  const result = rpcResult as {
    batch_id: string;
    pos_reassigned: number;
    advances_reassigned: number;
    events_emitted: number;
  };

  revalidatePath(`/clients/${parsed.data.client_id}`);
  revalidatePath(`/clients/${parsed.data.client_id}/purchase-orders`);
  revalidatePath(`/clients/${parsed.data.client_id}/advances`);
  revalidatePath(`/clients/${parsed.data.client_id}/batches/assign`);

  return ok(result);
}
