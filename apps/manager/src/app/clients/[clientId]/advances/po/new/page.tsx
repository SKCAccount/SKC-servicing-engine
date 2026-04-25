/**
 * 'Advance on Purchase Orders' — entry page.
 *
 * Mirrors the PO list page pattern: filter/sort/pagination state lives in
 * URL search params, server-renders the current slice. The client form
 * (advance-on-pos-form.tsx) keeps selection state in a Map keyed by PO id
 * so checkboxes survive across page navigations and filter changes.
 *
 * Eligibility filter: active / partially_invoiced / closed_awaiting_invoice.
 * Cancelled and written_off POs are excluded per spec §Advancing Purchase
 * Orders. The Manager can also narrow further with a status filter.
 */

import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isManager } from '@seaking/auth';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { AdvanceOnPosForm, type CandidatePo } from './advance-on-pos-form';

const ELIGIBLE_STATUSES = ['active', 'partially_invoiced', 'closed_awaiting_invoice'] as const;
type EligibleStatus = (typeof ELIGIBLE_STATUSES)[number];

const ALLOWED_PAGE_SIZES = [25, 50, 100, 250] as const;
type AllowedPageSize = (typeof ALLOWED_PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: AllowedPageSize = 50;

const SORT_COLUMNS = {
  po_number: 'po_number',
  value: 'po_value_cents',
  issuance_date: 'issuance_date',
  delivery_date: 'requested_delivery_date',
  batch: 'batch_id',
  uploaded: 'created_at',
  // Sortable since the page now reads from v_purchase_orders_with_balance
  // (which exposes per-PO outstanding principal). Per Derek 2026-04-25.
  current_principal: 'current_principal_cents',
} as const;
type SortKey = keyof typeof SORT_COLUMNS;

interface PageProps {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

interface Filters {
  q: string | null;
  retailer: string | null;
  /**
   * Selected batches. Empty array = no batch filter. Special token
   * 'unassigned' (alongside or instead of UUIDs) means "POs with no batch."
   * URL: ?batch=id1,id2,unassigned. Multi-select per Derek 2026-04-25.
   */
  batches: string[];
  /** Selected statuses. Empty array = all eligible. Multi-select. */
  statuses: EligibleStatus[];
  value_min_cents: number | null;
  value_max_cents: number | null;
  sort: SortKey;
  dir: 'asc' | 'desc';
  page: number;
  page_size: AllowedPageSize;
}

function firstParam(v: string | string[] | undefined): string | null {
  if (v == null) return null;
  const s = Array.isArray(v) ? v[0] : v;
  if (s == null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function toCents(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function parseFilters(sp: Record<string, string | string[] | undefined>): Filters {
  const sortRaw = firstParam(sp['sort']) ?? 'po_number';
  const sort = (sortRaw in SORT_COLUMNS ? sortRaw : 'po_number') as SortKey;
  const dirRaw = firstParam(sp['dir']);
  const dir: 'asc' | 'desc' = dirRaw === 'desc' ? 'desc' : 'asc';

  const pageRaw = Number(firstParam(sp['page']) ?? '1');
  const sizeRaw = Number(firstParam(sp['pageSize']) ?? DEFAULT_PAGE_SIZE);
  const page_size = (ALLOWED_PAGE_SIZES as readonly number[]).includes(sizeRaw)
    ? (sizeRaw as AllowedPageSize)
    : DEFAULT_PAGE_SIZE;

  const statusList = parseList(firstParam(sp['status']));
  const statuses = statusList.filter((s): s is EligibleStatus =>
    (ELIGIBLE_STATUSES as readonly string[]).includes(s),
  );
  const batches = parseList(firstParam(sp['batch']));

  return {
    q: firstParam(sp['q']),
    retailer: firstParam(sp['retailer']),
    batches,
    statuses,
    value_min_cents: toCents(firstParam(sp['valueMin'])),
    value_max_cents: toCents(firstParam(sp['valueMax'])),
    sort,
    dir,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
    page_size,
  };
}

export default async function NewPoAdvancePage({ params, searchParams }: PageProps) {
  const user = await getCurrentAuthUser();
  if (!user) redirect('/login');
  if (!isManager(user.role)) redirect('/login?reason=wrong_app');

  const { clientId } = await params;
  const rawSp = await searchParams;
  const filters = parseFilters(rawSp);

  const supabase = await createSupabaseServerClient();

  const [{ data: clientRow }, { data: ruleSet }, { data: retailerRows }, { data: batchRows }] =
    await Promise.all([
      supabase.from('clients').select('id, display_name').eq('id', clientId).maybeSingle(),
      supabase
        .from('rule_sets')
        .select('po_advance_rate_bps')
        .eq('client_id', clientId)
        .is('effective_to', null)
        .maybeSingle(),
      supabase
        .from('retailers')
        .select('id, name, display_name')
        .order('display_name', { ascending: true }),
      supabase
        .from('batches')
        .select('id, name, batch_number')
        .eq('client_id', clientId)
        .order('batch_number', { ascending: true }),
    ]);

  if (!clientRow) notFound();
  const client = clientRow as { id: string; display_name: string };
  const ruleSetRow = ruleSet as { po_advance_rate_bps: number } | null;
  const retailers = (retailerRows ?? []) as Array<{
    id: string;
    name: string;
    display_name: string;
  }>;
  const batches = (batchRows ?? []) as Array<{
    id: string;
    name: string;
    batch_number: number;
  }>;
  const retailerById = new Map(retailers.map((r) => [r.id, r]));
  const batchById = new Map(batches.map((b) => [b.id, b.name]));

  // Build the PO query with filters/sort/page applied. Reads from
  // v_purchase_orders_with_balance (which pre-joins purchase_orders to a
  // per-PO aggregate of mv_advance_balances) so we can server-side sort
  // on current_principal_cents without a separate fetch + in-memory merge.
  const statusFilterList: string[] =
    filters.statuses.length > 0
      ? filters.statuses
      : [...ELIGIBLE_STATUSES];

  let q = supabase
    .from('v_purchase_orders_with_balance')
    .select(
      'id, po_number, status, po_value_cents, retailer_id, batch_id, current_principal_cents, issuance_date, requested_delivery_date, created_at',
      { count: 'exact' },
    )
    .eq('client_id', clientId)
    .in('status', statusFilterList);

  if (filters.q) q = q.ilike('po_number', `%${filters.q}%`);
  if (filters.retailer) {
    const r = retailers.find((x) => x.name === filters.retailer);
    if (r) q = q.eq('retailer_id', r.id);
  }
  // Multi-batch filter. 'unassigned' means batch_id IS NULL; UUIDs are
  // real batches. Combinations use PostgREST's .or() to express
  // (batch_id IS NULL) OR (batch_id IN (...)).
  if (filters.batches.length > 0) {
    const includeUnassigned = filters.batches.includes('unassigned');
    const realBatchIds = filters.batches.filter((b) => b !== 'unassigned');
    if (includeUnassigned && realBatchIds.length === 0) {
      q = q.is('batch_id', null);
    } else if (!includeUnassigned && realBatchIds.length > 0) {
      q = q.in('batch_id', realBatchIds);
    } else if (includeUnassigned && realBatchIds.length > 0) {
      q = q.or(`batch_id.is.null,batch_id.in.(${realBatchIds.join(',')})`);
    }
  }
  if (filters.value_min_cents != null) q = q.gte('po_value_cents', filters.value_min_cents);
  if (filters.value_max_cents != null) q = q.lte('po_value_cents', filters.value_max_cents);

  q = q.order(SORT_COLUMNS[filters.sort], { ascending: filters.dir === 'asc', nullsFirst: false });
  q = q.order('id', { ascending: true });

  const offset = (filters.page - 1) * filters.page_size;
  q = q.range(offset, offset + filters.page_size - 1);

  const { data: poRows, count: totalCount, error } = await q;
  const total = totalCount ?? 0;

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
  const candidates: CandidatePo[] = ((poRows ?? []) as RawPo[]).flatMap((p) => {
    if (!p.id || !p.po_number || !p.status || p.po_value_cents == null
        || !p.retailer_id || !p.created_at) {
      // The view is RLS-scoped so columns aren't truly nullable in practice,
      // but Supabase types view columns as nullable. Skip any partial row.
      return [];
    }
    return [{
      id: p.id,
      po_number: p.po_number,
      retailer_id: p.retailer_id,
      retailer_display: retailerById.get(p.retailer_id)?.display_name ?? '?',
      status: p.status,
      po_value_cents: p.po_value_cents,
      current_principal_cents: p.current_principal_cents ?? 0,
      current_batch_id: p.batch_id,
      current_batch_label: p.batch_id ? (batchById.get(p.batch_id) ?? null) : null,
      issuance_date: p.issuance_date,
      requested_delivery_date: p.requested_delivery_date,
      created_at: p.created_at,
    }];
  });

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

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-seaking-danger">
          Failed to load purchase orders: {error.message}
        </div>
      )}

      <AdvanceOnPosForm
        clientId={client.id}
        poAdvanceRateBps={ruleSetRow?.po_advance_rate_bps ?? null}
        retailers={retailers.map((r) => ({ slug: r.name, label: r.display_name }))}
        batches={batches.map((b) => ({ id: b.id, label: b.name }))}
        statuses={(ELIGIBLE_STATUSES as readonly string[]).map((value) => ({
          value,
          label: humanizeStatus(value),
        }))}
        pageSizeOptions={[...ALLOWED_PAGE_SIZES]}
        candidates={candidates}
        totalCount={total}
        rawSearchParams={serializeSp(rawSp)}
        currentFilters={{
          q: filters.q,
          retailer: filters.retailer,
          batches: filters.batches,
          statuses: filters.statuses,
          value_min_cents: filters.value_min_cents,
          value_max_cents: filters.value_max_cents,
          sort: filters.sort,
          dir: filters.dir,
          page: filters.page,
          page_size: filters.page_size,
        }}
      />
    </main>
  );
}

function humanizeStatus(s: string): string {
  if (s === 'active') return 'Active';
  if (s === 'partially_invoiced') return 'Partially Invoiced';
  if (s === 'closed_awaiting_invoice') return 'Closed — Awaiting Invoice';
  return s;
}

function serializeSp(sp: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (s) out[k] = s;
  }
  return out;
}
