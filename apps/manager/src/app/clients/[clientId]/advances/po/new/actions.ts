'use server';

/**
 * Server actions for the 'Advance on Purchase Orders' workflow.
 *
 * Three actions:
 *   1. fetchAllMatchingPoIdsAction — runs the same filter query the page
 *      runs (without pagination) and returns up to `hardLimit` PO summary
 *      rows so the UI can let the Manager 'Select all matches' even when
 *      they span multiple pages.
 *
 *   2. matchPosFromCsvAction — parses an uploaded two-column CSV
 *      (Purchase Order Number, Retailer) and returns matched rows
 *      (resolved against existing eligible POs) plus unmatched rows the
 *      UI can offer to re-export. Spec §"Advancing Purchase Orders"
 *      → Secondary Option.
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
import { supabaseError, zodError } from '@/lib/action-helpers';
import { revalidatePath } from 'next/cache';

/**
 * Authorize: caller is a Manager AND has access to this Client.
 * Centralized so every action shares the check.
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
  /**
   * Selected batches. Empty array = no batch filter. 'unassigned' (alongside
   * or instead of UUIDs) means "POs with no batch." Multi-select per Derek
   * 2026-04-25.
   */
  batches: string[];
  /** Selected statuses. Empty array = all eligible. */
  statuses: string[];
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
    filter.statuses.length > 0
      ? filter.statuses.filter((s) => (ELIGIBLE_STATUSES as readonly string[]).includes(s))
      : (ELIGIBLE_STATUSES as readonly string[]);

  // Helper that applies the (potentially multi-value) batch filter to a
  // PostgREST query builder. Defined inline to keep the function self-
  // contained (the typed wrapper attempt is documented as a dead end in
  // CLAUDE.md "DB / SQL pitfalls" notes — inline duplication wins).
  const applyBatchFilter = <T>(q: T): T => {
    const builder = q as unknown as {
      is: (col: string, val: null) => T;
      in: (col: string, vals: string[]) => T;
      or: (expr: string) => T;
    };
    if (filter.batches.length === 0) return q;
    const includeUnassigned = filter.batches.includes('unassigned');
    const realBatchIds = filter.batches.filter((b) => b !== 'unassigned');
    if (includeUnassigned && realBatchIds.length === 0) return builder.is('batch_id', null);
    if (!includeUnassigned && realBatchIds.length > 0) return builder.in('batch_id', realBatchIds);
    return builder.or(`batch_id.is.null,batch_id.in.(${realBatchIds.join(',')})`);
  };

  // Step 1: count first to detect truncation accurately. Same filter set.
  // Source: v_purchase_orders_with_balance — pre-joins purchase_orders to
  // a per-PO aggregate of mv_advance_balances. Eliminates the previous
  // separate-balance-fetch step that was hitting PostgREST's 1000-row
  // clamp on .in() chunks (the bug Derek hit on 2026-04-25).
  let countQ = supabase
    .from('v_purchase_orders_with_balance')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .in('status', statusList);
  if (filter.q) countQ = countQ.ilike('po_number', `%${filter.q}%`);
  if (retailerId) countQ = countQ.eq('retailer_id', retailerId);
  countQ = applyBatchFilter(countQ);
  if (filter.value_min_cents != null) countQ = countQ.gte('po_value_cents', filter.value_min_cents);
  if (filter.value_max_cents != null) countQ = countQ.lte('po_value_cents', filter.value_max_cents);

  const { count: totalCount, error: countError } = await countQ;
  if (countError) return supabaseError(countError);
  const total = totalCount ?? 0;

  // Step 2: fetch up to hardLimit rows. PostgREST clamps at 1000 per
  // response, so split into parallel page-sized requests and merge.
  const PAGE_SIZE = 1000;
  const targetCount = Math.min(total, hardLimit);
  const pageCount = targetCount > 0 ? Math.ceil(targetCount / PAGE_SIZE) : 0;

  type RawPo = {
    id: string | null;
    po_number: string | null;
    status: string | null;
    po_value_cents: number | null;
    retailer_id: string | null;
    batch_id: string | null;
    current_principal_cents: number | null;
    issuance_date: string | null;
    requested_delivery_date: string | null;
    created_at: string | null;
  };

  const rows: RawPo[] = [];
  if (pageCount > 0) {
    const pageRequests = Array.from({ length: pageCount }, (_, i) => {
      const start = i * PAGE_SIZE;
      const end = Math.min(start + PAGE_SIZE - 1, targetCount - 1);
      let pageQ = supabase
        .from('v_purchase_orders_with_balance')
        .select(
          'id, po_number, status, po_value_cents, retailer_id, batch_id, current_principal_cents, issuance_date, requested_delivery_date, created_at',
        )
        .eq('client_id', clientId)
        .in('status', statusList)
        .order('id', { ascending: true })
        .range(start, end);
      if (filter.q) pageQ = pageQ.ilike('po_number', `%${filter.q}%`);
      if (retailerId) pageQ = pageQ.eq('retailer_id', retailerId);
      pageQ = applyBatchFilter(pageQ);
      if (filter.value_min_cents != null)
        pageQ = pageQ.gte('po_value_cents', filter.value_min_cents);
      if (filter.value_max_cents != null)
        pageQ = pageQ.lte('po_value_cents', filter.value_max_cents);
      return pageQ;
    });
    const responses = await Promise.all(pageRequests);
    for (const res of responses) {
      if (res.error) return supabaseError(res.error);
      for (const row of (res.data ?? []) as RawPo[]) rows.push(row);
    }
  }

  // Step 3: pull retailer + batch labels for display joining.
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

  // The view is RLS-scoped (inherits from purchase_orders) so columns
  // aren't truly nullable in practice, but Supabase types view columns as
  // nullable. flatMap-skip rows that come back partial.
  const pos: MatchingPoSummary[] = rows.flatMap((r) => {
    if (!r.id || !r.po_number || !r.status || r.po_value_cents == null
        || !r.retailer_id || !r.created_at) {
      return [];
    }
    return [{
      id: r.id,
      po_number: r.po_number,
      retailer_id: r.retailer_id,
      retailer_display: retailerById.get(r.retailer_id) ?? '?',
      status: r.status,
      po_value_cents: r.po_value_cents,
      current_principal_cents: r.current_principal_cents ?? 0,
      current_batch_id: r.batch_id,
      current_batch_label: r.batch_id ? (batchById.get(r.batch_id) ?? null) : null,
      issuance_date: r.issuance_date,
      requested_delivery_date: r.requested_delivery_date,
      created_at: r.created_at,
    }];
  });

  return ok({
    pos,
    truncated: total > hardLimit,
    totalCount: total,
  });
}

// ============================================================================
// matchPosFromCsvAction
// ============================================================================
//
// Spec: §"Advancing Purchase Orders" → Secondary Option. Manager (or, in
// future, the Client portal) uploads a two-column CSV (Purchase Order
// Number, Retailer) listing POs they want to advance against. The action
// parses the CSV via @seaking/retailer-parsers/advance-csv/po-numbers,
// resolves each (po_number, retailer_slug) tuple to a real PO id, and
// returns:
//
//   * `matched`  — same shape as MatchingPoSummary; ready to add directly
//                  to the page's selection Map.
//   * `unmatched` — rows from the CSV that didn't resolve. UI exposes an
//                   "Export unmatched as CSV" button so the user can take
//                   the leftover work back to the Client / retailer.
//   * `skipped`  — rows the parser dropped (missing fields, etc.).
//
// Eligibility filter mirrors the table: only active / partially_invoiced /
// closed_awaiting_invoice POs match. Cancelled or fully-invoiced POs that
// match the (po_number, retailer) tuple come back as unmatched with an
// explanatory reason.
//
// Retailer resolution: case-insensitive against retailers.name OR
// retailers.display_name (same convention as the generic CSV PO upload).

import { parsePoNumbersCsv, PoNumbersHeaderError } from '@seaking/retailer-parsers/advance-csv/po-numbers';

const MATCH_ELIGIBLE_STATUSES = ['active', 'partially_invoiced', 'closed_awaiting_invoice'] as const;

export interface MatchPosCsvUnmatchedRow {
  po_number: string;
  retailer_input: string; // original retailer cell from the CSV (lowercased)
  reason: 'retailer_not_found' | 'po_not_found' | 'po_not_eligible';
  /**
   * For po_not_eligible: which status the matched PO has, so the UI can
   * give a useful message ("PO 12345 was matched but is fully_invoiced").
   */
  status?: string;
}

export async function matchPosFromCsvAction(
  clientId: string,
  csvText: string,
): Promise<
  ActionResult<{
    matched: MatchingPoSummary[];
    unmatched: MatchPosCsvUnmatchedRow[];
    skipped: Array<{ row_index: number; reason: string }>;
  }>
> {
  const authz = await authorize(clientId);
  if (!authz.ok) return authz.err;

  let parsed: ReturnType<typeof parsePoNumbersCsv>;
  try {
    parsed = parsePoNumbersCsv(csvText);
  } catch (e) {
    if (e instanceof PoNumbersHeaderError) {
      return err('BAD_REQUEST', e.message);
    }
    return err(
      'PARSE_FAILED',
      e instanceof Error ? e.message : 'Could not parse the CSV.',
    );
  }

  if (parsed.rows.length === 0 && parsed.skipped.length === 0) {
    return err('BAD_REQUEST', 'The CSV has no data rows.');
  }

  const supabase = await createSupabaseServerClient();

  // ---------- Resolve retailer slugs to retailer_ids ----------
  // Match both retailers.name AND retailers.display_name case-insensitively.
  // We pull every retailer (small table) and do the join in memory — avoids
  // N round-trips and a long URL with .or() filters.
  const { data: retailerRows, error: retailerError } = await supabase
    .from('retailers')
    .select('id, name, display_name');
  if (retailerError) return supabaseError(retailerError);
  const retailers = (retailerRows ?? []) as Array<{
    id: string;
    name: string;
    display_name: string | null;
  }>;
  const retailerSlugToId = new Map<string, string>();
  for (const r of retailers) {
    const nameSlug = r.name.toLowerCase().replace(/\s+/g, ' ').trim();
    retailerSlugToId.set(nameSlug, r.id);
    if (r.display_name) {
      const dnSlug = r.display_name.toLowerCase().replace(/\s+/g, ' ').trim();
      retailerSlugToId.set(dnSlug, r.id);
    }
  }

  // Bucket the parsed rows: those with a known retailer get a DB lookup,
  // those without surface immediately as unmatched.
  const unmatched: MatchPosCsvUnmatchedRow[] = [];
  type ResolvableRow = { po_number: string; retailer_id: string; retailer_input: string };
  const resolvable: ResolvableRow[] = [];
  for (const row of parsed.rows) {
    const retailerId = retailerSlugToId.get(row.retailer_slug);
    if (!retailerId) {
      unmatched.push({
        po_number: row.po_number,
        retailer_input: row.retailer_slug,
        reason: 'retailer_not_found',
      });
      continue;
    }
    resolvable.push({
      po_number: row.po_number,
      retailer_id: retailerId,
      retailer_input: row.retailer_slug,
    });
  }

  // ---------- DB lookup: (client_id, retailer_id, po_number) is unique ----------
  // We can't easily compose multiple OR'd compound predicates in PostgREST,
  // so we widen the query to (retailer_id IN, po_number IN) and filter the
  // result set in memory. Worst case: cross-product of the two sets, but
  // typical CSV uploads have <100 rows so this is fine.
  let matchedPoRows: Array<{
    id: string;
    po_number: string;
    retailer_id: string;
    status: string;
    po_value_cents: number;
    batch_id: string | null;
    issuance_date: string | null;
    requested_delivery_date: string | null;
    created_at: string;
  }> = [];
  if (resolvable.length > 0) {
    const retailerIdSet = new Set(resolvable.map((r) => r.retailer_id));
    const poNumberSet = new Set(resolvable.map((r) => r.po_number));

    const { data: poRows, error: poError } = await supabase
      .from('purchase_orders')
      .select(
        'id, po_number, retailer_id, status, po_value_cents, batch_id, issuance_date, requested_delivery_date, created_at',
      )
      .eq('client_id', clientId)
      .in('retailer_id', Array.from(retailerIdSet))
      .in('po_number', Array.from(poNumberSet));
    if (poError) return supabaseError(poError);
    matchedPoRows = (poRows ?? []) as typeof matchedPoRows;
  }

  // Build lookup keyed by (po_number|retailer_id) so we can attribute each
  // CSV row to a DB row (or absence of one).
  const poByKey = new Map<string, (typeof matchedPoRows)[number]>();
  for (const po of matchedPoRows) {
    poByKey.set(`${po.po_number}|${po.retailer_id}`, po);
  }

  // Walk the resolvable rows, classify into matched / unmatched / not-eligible.
  const matchedIds: string[] = [];
  for (const row of resolvable) {
    const po = poByKey.get(`${row.po_number}|${row.retailer_id}`);
    if (!po) {
      unmatched.push({
        po_number: row.po_number,
        retailer_input: row.retailer_input,
        reason: 'po_not_found',
      });
      continue;
    }
    if (!(MATCH_ELIGIBLE_STATUSES as readonly string[]).includes(po.status)) {
      unmatched.push({
        po_number: row.po_number,
        retailer_input: row.retailer_input,
        reason: 'po_not_eligible',
        status: po.status,
      });
      continue;
    }
    matchedIds.push(po.id);
  }

  // ---------- Fetch outstanding-principal + display labels ----------
  // Same parallel-pagination strategy as fetchAllMatchingPoIdsAction —
  // .in('purchase_order_id', large_array) on mv_advance_balances can hit
  // PostgREST's max-rows=1000 clamp when matched POs collectively have
  // many advances. Pull all advances for the client paginated, filter to
  // matched in memory.
  const principalByPo = new Map<string, number>();
  if (matchedIds.length > 0) {
    const matchedSet = new Set(matchedIds);

    const { count: balanceCount, error: balanceCountError } = await supabase
      .from('mv_advance_balances')
      .select('advance_id', { count: 'exact', head: true })
      .eq('client_id', clientId);
    if (balanceCountError) return supabaseError(balanceCountError);

    const balanceTotal = balanceCount ?? 0;
    const BALANCE_PAGE = 1000;
    const balancePageCount = balanceTotal > 0 ? Math.ceil(balanceTotal / BALANCE_PAGE) : 0;
    const balanceRequests = Array.from({ length: balancePageCount }, (_, i) => {
      const start = i * BALANCE_PAGE;
      const end = start + BALANCE_PAGE - 1;
      return supabase
        .from('mv_advance_balances')
        .select('purchase_order_id, principal_outstanding_cents')
        .eq('client_id', clientId)
        .order('advance_id', { ascending: true })
        .range(start, end);
    });
    const balanceResponses = await Promise.all(balanceRequests);
    for (const res of balanceResponses) {
      if (res.error) return supabaseError(res.error);
      for (const row of (res.data ?? []) as Array<{
        purchase_order_id: string | null;
        principal_outstanding_cents: number;
      }>) {
        if (!row.purchase_order_id) continue;
        if (!matchedSet.has(row.purchase_order_id)) continue;
        principalByPo.set(
          row.purchase_order_id,
          (principalByPo.get(row.purchase_order_id) ?? 0) +
            (row.principal_outstanding_cents ?? 0),
        );
      }
    }
  }

  const retailerById = new Map(retailers.map((r) => [r.id, r]));
  const { data: batchList } = await supabase
    .from('batches')
    .select('id, name')
    .eq('client_id', clientId);
  const batchById = new Map(
    ((batchList ?? []) as Array<{ id: string; name: string }>).map((b) => [b.id, b.name]),
  );

  const matched: MatchingPoSummary[] = matchedIds.flatMap((id) => {
    const po = matchedPoRows.find((p) => p.id === id);
    if (!po) return [];
    return [
      {
        id: po.id,
        po_number: po.po_number,
        retailer_id: po.retailer_id,
        retailer_display:
          retailerById.get(po.retailer_id)?.display_name ?? retailerById.get(po.retailer_id)?.name ?? '?',
        status: po.status,
        po_value_cents: po.po_value_cents,
        current_principal_cents: principalByPo.get(po.id) ?? 0,
        current_batch_id: po.batch_id,
        current_batch_label: po.batch_id ? (batchById.get(po.batch_id) ?? null) : null,
        issuance_date: po.issuance_date,
        requested_delivery_date: po.requested_delivery_date,
        created_at: po.created_at,
      },
    ];
  });

  return ok({
    matched,
    unmatched,
    skipped: parsed.skipped.map((s) => ({ row_index: s.row_index, reason: s.reason })),
  });
}
