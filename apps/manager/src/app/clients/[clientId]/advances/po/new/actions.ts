'use server';

/**
 * Server actions for the 'Advance on Purchase Orders' workflow.
 *
 * Three actions:
 *   1. fetchPoAdvanceContextAction — currently unused; reserved for the
 *      CSV-of-PO-numbers secondary entry path.
 *
 *   2. fetchAllMatchingPoIdsAction — runs the same filter query the page
 *      runs (without pagination) and returns up to `hardLimit` PO summary
 *      rows so the UI can let the Manager 'Select all matches' even when
 *      they span multiple pages.
 *
 *   3. commitPoAdvanceAction — given the planned allocation + advance date +
 *      batch choice, call the commit_po_advance RPC, then refresh
 *      projections so the dashboards see the new advance immediately.
 *
 * The allocation itself is computed CLIENT-SIDE via @seaking/domain's
 * planPoAdvance — the server doesn't recompute it. Keeping the server
 * action thin makes the math testable (domain unit tests cover it) and
 * avoids drift between what the user saw on the review screen and what
 * actually got committed. The server validates each line via the RPC's
 * built-in checks.
 */

import { createSupabaseServerClient, requireAuthUser } from '@seaking/auth/server';
import { isManager } from '@seaking/auth';
import { ok, err, type ActionResult } from '@seaking/api';
import {
  commitPoAdvanceInputSchema,
  type CommitPoAdvanceInput,
} from '@seaking/validators';
import type { Cents } from '@seaking/money';
import { cents } from '@seaking/money';
import { supabaseError, zodError } from '@/lib/action-helpers';
import { revalidatePath } from 'next/cache';

interface PoSummary {
  id: string;
  po_number: string;
  retailer_id: string;
  retailer_display: string;
  status: string;
  po_value_cents: Cents;
  current_principal_cents: Cents;
  current_batch_id: string | null;
  current_batch_label: string | null;
}

interface BatchOption {
  id: string;
  label: string;
}

export interface PoAdvanceContext {
  pos: PoSummary[];
  batches: BatchOption[];
  /** Active rule_set's PO advance rate (bps). null if no active rule set. */
  po_advance_rate_bps: number | null;
  /** True only when no rule_set exists for the Client — UI must block commit. */
  rule_set_missing: boolean;
}

/**
 * Authorize: caller is a Manager AND has access to this Client.
 * Centralized so the two actions share the check.
 */
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
    return { ok: false, err: err('FORBIDDEN', 'Only Managers can commit advances.') };
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
// fetchPoAdvanceContextAction
// ============================================================================

export async function fetchPoAdvanceContextAction(
  clientId: string,
  poIds: string[],
): Promise<ActionResult<PoAdvanceContext>> {
  if (poIds.length === 0) {
    return err('BAD_REQUEST', 'No POs selected.');
  }

  const authz = await authorize(clientId);
  if (!authz.ok) return authz.err;

  const supabase = await createSupabaseServerClient();

  // Pull POs (RLS scopes by client_id), batches, retailers, current rule_set,
  // and per-PO outstanding principal from the projection in parallel.
  const [
    { data: poRows, error: poError },
    { data: batchRows },
    { data: retailerRows },
    { data: ruleSet },
    { data: balanceRows },
  ] = await Promise.all([
    supabase
      .from('purchase_orders')
      .select('id, po_number, status, po_value_cents, retailer_id, batch_id')
      .eq('client_id', clientId)
      .in('id', poIds),
    supabase
      .from('batches')
      .select('id, name, batch_number')
      .eq('client_id', clientId)
      .order('batch_number', { ascending: true }),
    supabase.from('retailers').select('id, display_name'),
    supabase
      .from('rule_sets')
      .select('po_advance_rate_bps')
      .eq('client_id', clientId)
      .is('effective_to', null)
      .maybeSingle(),
    // Sum of currently-outstanding principal per PO. mv_advance_balances
    // groups by advance_id; we re-aggregate by purchase_order_id here.
    supabase
      .from('mv_advance_balances')
      .select('purchase_order_id, principal_outstanding_cents')
      .eq('client_id', clientId)
      .in('purchase_order_id', poIds),
  ]);

  if (poError) return supabaseError(poError);

  const retailers = (retailerRows ?? []) as Array<{ id: string; display_name: string }>;
  const retailerById = new Map(retailers.map((r) => [r.id, r.display_name]));
  const batches = (batchRows ?? []) as Array<{ id: string; name: string; batch_number: number }>;
  const batchById = new Map(batches.map((b) => [b.id, b.name]));

  // Aggregate principal per PO from the materialized view.
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

  type PoRowQuery = {
    id: string;
    po_number: string;
    status: string;
    po_value_cents: number;
    retailer_id: string;
    batch_id: string | null;
  };
  const pos: PoSummary[] = ((poRows ?? []) as PoRowQuery[]).map((p) => ({
    id: p.id,
    po_number: p.po_number,
    retailer_id: p.retailer_id,
    retailer_display: retailerById.get(p.retailer_id) ?? '?',
    status: p.status,
    po_value_cents: cents(p.po_value_cents),
    current_principal_cents: cents(principalByPo.get(p.id) ?? 0),
    current_batch_id: p.batch_id,
    current_batch_label: p.batch_id ? (batchById.get(p.batch_id) ?? null) : null,
  }));

  // Surface POs that were requested but didn't come back (e.g. wrong client,
  // since-deleted, etc.) as an error rather than a silent partial result.
  if (pos.length !== poIds.length) {
    const found = new Set(pos.map((p) => p.id));
    const missing = poIds.filter((id) => !found.has(id));
    return err(
      'PO_NOT_FOUND',
      `Could not find ${missing.length} of the selected POs (probably out of your access scope).`,
    );
  }

  const ruleSetRow = ruleSet as { po_advance_rate_bps: number } | null;
  return ok({
    pos,
    batches: batches.map((b) => ({ id: b.id, label: b.name })),
    po_advance_rate_bps: ruleSetRow?.po_advance_rate_bps ?? null,
    rule_set_missing: !ruleSetRow,
  });
}

// ============================================================================
// commitPoAdvanceAction
// ============================================================================

export interface CommitPoAdvanceResult {
  batch_id: string;
  advance_count: number;
  total_cents: number;
}

export async function commitPoAdvanceAction(
  input: CommitPoAdvanceInput & { new_batch_name: string | null },
): Promise<ActionResult<CommitPoAdvanceResult>> {
  // Strip the UI-only field before validating against the wire schema.
  const { new_batch_name, ...wire } = input;
  const parsed = commitPoAdvanceInputSchema.safeParse(wire);
  if (!parsed.success) return zodError(parsed.error);

  const authz = await authorize(parsed.data.client_id);
  if (!authz.ok) return authz.err;

  const supabase = await createSupabaseServerClient();

  // Call the RPC. It handles all validation + atomic write.
  const { data: rpcResult, error: rpcError } = await supabase.rpc('commit_po_advance', {
    p_client_id: parsed.data.client_id,
    p_advance_date: parsed.data.advance_date,
    p_existing_batch_id: parsed.data.existing_batch_id,
    p_new_batch_name: parsed.data.new_batch ? (new_batch_name ?? '') : null,
    p_allocations: parsed.data.allocations.map((a) => ({
      purchase_order_id: a.purchase_order_id,
      principal_cents: a.principal_cents,
    })),
  });
  if (rpcError) return supabaseError(rpcError);

  // Best-effort projection refresh. Don't fail the action if refresh errors —
  // the data is already committed correctly; only the dashboards lag.
  await supabase.rpc('refresh_po_projections');

  const result = rpcResult as {
    batch_id: string;
    advance_count: number;
    total_cents: number;
  };

  revalidatePath(`/clients/${parsed.data.client_id}`);
  revalidatePath(`/clients/${parsed.data.client_id}/purchase-orders`);
  revalidatePath(`/clients/${parsed.data.client_id}/advances`);

  return ok({
    batch_id: result.batch_id,
    advance_count: result.advance_count,
    total_cents: result.total_cents,
  });
}

// ============================================================================
// fetchAllMatchingPoIdsAction
// ============================================================================
//
// Runs the same filter query the Advance on POs page runs (minus pagination)
// and returns up to `hardLimit` matching PO summaries. The form merges the
// returned rows into its in-memory selection Map so the Manager can select
// thousands of POs spanning many pages without losing the per-PO data needed
// for the allocation step.
//
// hardLimit is a safety ceiling: if totalCount > hardLimit, we return
// `truncated: true` and the UI surfaces a warning. 5000 PO rows at ~200B
// each is ~1 MB over the wire, comfortably within Server Action body limits.

const ELIGIBLE_STATUSES = ['active', 'partially_invoiced', 'closed_awaiting_invoice'] as const;

export interface FetchMatchingPosFilter {
  q: string | null;
  retailer_slug: string | null;
  batch_id: string | null; // 'unassigned' string OR a UUID OR null
  status: string | null;
  value_min_cents: number | null;
  value_max_cents: number | null;
}

export interface MatchingPoSummary {
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
  created_at: string;
}

export async function fetchAllMatchingPoIdsAction(
  clientId: string,
  filter: FetchMatchingPosFilter,
  hardLimit: number = 5000,
): Promise<ActionResult<{ pos: MatchingPoSummary[]; truncated: boolean; totalCount: number }>> {
  const authz = await authorize(clientId);
  if (!authz.ok) return authz.err;

  const supabase = await createSupabaseServerClient();

  // Look up the retailer slug → id once. Skip if no filter set.
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

  // Resolve eligible statuses: caller's filter narrows down, otherwise all 3.
  const statusList =
    filter.status && (ELIGIBLE_STATUSES as readonly string[]).includes(filter.status)
      ? [filter.status]
      : (ELIGIBLE_STATUSES as readonly string[]);

  // Step 1: count first to detect truncation accurately. Same filter set.
  let countQ = supabase
    .from('purchase_orders')
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

  // Step 2: fetch up to hardLimit ids/data.
  let dataQ = supabase
    .from('purchase_orders')
    .select(
      'id, po_number, status, po_value_cents, retailer_id, batch_id, issuance_date, requested_delivery_date, created_at',
    )
    .eq('client_id', clientId)
    .in('status', statusList)
    .order('id', { ascending: true })
    .limit(hardLimit);
  if (filter.q) dataQ = dataQ.ilike('po_number', `%${filter.q}%`);
  if (retailerId) dataQ = dataQ.eq('retailer_id', retailerId);
  if (filter.batch_id === 'unassigned') dataQ = dataQ.is('batch_id', null);
  else if (filter.batch_id) dataQ = dataQ.eq('batch_id', filter.batch_id);
  if (filter.value_min_cents != null) dataQ = dataQ.gte('po_value_cents', filter.value_min_cents);
  if (filter.value_max_cents != null) dataQ = dataQ.lte('po_value_cents', filter.value_max_cents);

  const { data: poRows, error: poError } = await dataQ;
  if (poError) return supabaseError(poError);

  type RawPo = {
    id: string;
    po_number: string;
    status: string;
    po_value_cents: number;
    retailer_id: string;
    batch_id: string | null;
    issuance_date: string | null;
    requested_delivery_date: string | null;
    created_at: string;
  };
  const rows = (poRows ?? []) as RawPo[];

  // Step 3: aggregate principal per PO from mv_advance_balances. Chunk
  // the IN clause to avoid URL length limits.
  const principalByPo = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => r.id);
    const { data: balanceRows } = await supabase
      .from('mv_advance_balances')
      .select('purchase_order_id, principal_outstanding_cents')
      .eq('client_id', clientId)
      .in('purchase_order_id', chunk);
    for (const row of (balanceRows ?? []) as Array<{
      purchase_order_id: string;
      principal_outstanding_cents: number;
    }>) {
      principalByPo.set(
        row.purchase_order_id,
        (principalByPo.get(row.purchase_order_id) ?? 0) +
          (row.principal_outstanding_cents ?? 0),
      );
    }
  }

  // Step 4: pull retailer + batch labels for display joining.
  const [{ data: retailerList }, { data: batchList }] = await Promise.all([
    supabase.from('retailers').select('id, display_name'),
    supabase
      .from('batches')
      .select('id, name')
      .eq('client_id', clientId),
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

  const pos: MatchingPoSummary[] = rows.map((r) => ({
    id: r.id,
    po_number: r.po_number,
    retailer_id: r.retailer_id,
    retailer_display: retailerById.get(r.retailer_id) ?? '?',
    status: r.status,
    po_value_cents: r.po_value_cents,
    current_principal_cents: principalByPo.get(r.id) ?? 0,
    current_batch_id: r.batch_id,
    current_batch_label: r.batch_id ? (batchById.get(r.batch_id) ?? null) : null,
    issuance_date: r.issuance_date,
    requested_delivery_date: r.requested_delivery_date,
    created_at: r.created_at,
  }));

  return ok({
    pos,
    truncated: total > hardLimit,
    totalCount: total,
  });
}
