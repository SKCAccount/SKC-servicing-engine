'use server';

/**
 * Server actions for the 'Advance on Purchase Orders' workflow.
 *
 * Two actions:
 *   1. fetchPoAdvanceContextAction — given a list of selected PO ids, return
 *      the data the configure/review steps need: aggregate metrics, current
 *      principal per PO, existing batches, the active rule_set's PO advance
 *      rate. No writes.
 *
 *   2. commitPoAdvanceAction — given the planned allocation + advance date +
 *      batch choice, call the commit_po_advance RPC, then refresh
 *      projections so the dashboards see the new advance immediately.
 *
 * The allocation itself is computed CLIENT-SIDE via @seaking/domain's
 * planPoAdvance — the server doesn't recompute it. Why: keeping the server
 * action thin makes the math testable (domain unit tests cover it) and
 * avoids drift between what the user saw on the review screen and what
 * actually got committed. The server validates each line via the RPC's
 * built-in checks (positive principal, PO belongs to client).
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
