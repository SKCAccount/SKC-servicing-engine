/**
 * Standalone Assign-to-Batch screen.
 *
 * Spec source: docs/01_FUNCTIONAL_SPEC.md §"Assign Purchase Orders and
 * Invoices to a Batch."
 *
 * Mirrors the Advance on POs page: filter/sort/pagination state in URL
 * search params, server-renders the current slice, the client form keeps
 * selection state in a Map so checkboxes survive page navigations.
 *
 * Phase 1D commit 4 only emits POs into the unified table — Pre-Advance and
 * AR Advance row types arrive when those creation paths exist (later
 * phases). The Type column hardcodes "PO Advance" for now and the
 * invoice-specific columns (Invoice #, Invoice Value, Days Outstanding,
 * Expected Paid Date) render as em-dash placeholders.
 *
 * Borrowing-base columns come from v_purchase_orders_with_balance — a SQL
 * view that pre-joins purchase_orders to a per-PO aggregate of
 * mv_advance_balances. Same view will eventually back the deferred
 * "filter by current principal" affordance on the Advance on POs page.
 */

import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isManager } from '@seaking/auth';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { AssignToBatchForm, type CandidateItem } from './assign-to-batch-form';

const ELIGIBLE_STATUSES = ['active', 'partially_invoiced', 'closed_awaiting_invoice'] as const;
type EligibleStatus = (typeof ELIGIBLE_STATUSES)[number];

/**
 * Item type values render in the Type column. The full set will populate
 * once invoice ingestion (1E-3) and pre-advance creation ship — today
 * only PO Advance rows can appear, so the Type filter functionally
 * collapses to "include or exclude PO Advance," but exists for UX
 * consistency and to be future-proof.
 */
const ITEM_TYPES = ['po_advance', 'ar_advance', 'pre_advance'] as const;
type ItemType = (typeof ITEM_TYPES)[number];

const ALLOWED_PAGE_SIZES = [25, 50, 100, 250] as const;
type AllowedPageSize = (typeof ALLOWED_PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: AllowedPageSize = 50;

const SORT_COLUMNS = {
  po_number: 'po_number',
  value: 'po_value_cents',
  delivery_date: 'requested_delivery_date',
  batch: 'batch_id',
  current_principal: 'current_principal_cents',
  fees: 'fees_outstanding_cents',
} as const;
type SortKey = keyof typeof SORT_COLUMNS;

interface PageProps {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

interface Filters {
  q: string | null;
  retailer: string | null;
  batch: string | null;
  status: EligibleStatus | null;
  /** Multi-select. Empty = no filter (all types). */
  types: ItemType[];
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

  const statusRaw = firstParam(sp['status']);
  const status =
    statusRaw && (ELIGIBLE_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as EligibleStatus)
      : null;

  const typeList = parseList(firstParam(sp['type']));
  const types = typeList.filter((t): t is ItemType =>
    (ITEM_TYPES as readonly string[]).includes(t),
  );

  return {
    q: firstParam(sp['q']),
    retailer: firstParam(sp['retailer']),
    batch: firstParam(sp['batch']),
    status,
    types,
    value_min_cents: toCents(firstParam(sp['valueMin'])),
    value_max_cents: toCents(firstParam(sp['valueMax'])),
    sort,
    dir,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
    page_size,
  };
}

export default async function AssignToBatchPage({ params, searchParams }: PageProps) {
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

  // Type filter — short-circuit when 'po_advance' is excluded.
  //
  // Today the only emitted item type is 'po_advance' (PO rows from
  // v_purchase_orders_with_balance). Pre-Advance and AR Advance rows
  // come online in 1E-3 / pre-advance creation. When `filters.types`
  // is non-empty AND doesn't include 'po_advance', we know the PO query
  // would contribute zero matching rows, so skip it entirely.
  //
  // When 1E-3 lands and we add ar_advance / pre_advance row sources,
  // each source query needs an analogous gate.
  const includePoAdvance = filters.types.length === 0 || filters.types.includes('po_advance');

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

  let rows: RawRow[] | null = null;
  let totalCount: number | null = 0;
  let error: { message: string } | null = null;
  if (includePoAdvance) {
    let q = supabase
      .from('v_purchase_orders_with_balance')
      .select(
        'id, po_number, status, po_value_cents, retailer_id, batch_id, current_principal_cents, fees_outstanding_cents, issuance_date, requested_delivery_date, created_at',
        { count: 'exact' },
      )
      .eq('client_id', clientId)
      .in(
        'status',
        filters.status ? [filters.status] : (ELIGIBLE_STATUSES as readonly string[]),
      );

    if (filters.q) q = q.ilike('po_number', `%${filters.q}%`);
    if (filters.retailer) {
      const r = retailers.find((x) => x.name === filters.retailer);
      if (r) q = q.eq('retailer_id', r.id);
    }
    if (filters.batch === 'unassigned') q = q.is('batch_id', null);
    else if (filters.batch) q = q.eq('batch_id', filters.batch);
    if (filters.value_min_cents != null) q = q.gte('po_value_cents', filters.value_min_cents);
    if (filters.value_max_cents != null) q = q.lte('po_value_cents', filters.value_max_cents);

    q = q.order(SORT_COLUMNS[filters.sort], { ascending: filters.dir === 'asc', nullsFirst: false });
    q = q.order('id', { ascending: true });

    const offset = (filters.page - 1) * filters.page_size;
    q = q.range(offset, offset + filters.page_size - 1);

    const result = await q;
    rows = (result.data as RawRow[] | null) ?? null;
    totalCount = result.count;
    error = result.error;
  }
  const total = totalCount ?? 0;

  const candidates: CandidateItem[] = ((rows ?? []) as RawRow[]).map((p) => ({
    id: p.id,
    type: 'po_advance',
    po_number: p.po_number,
    retailer_id: p.retailer_id,
    retailer_display: retailerById.get(p.retailer_id)?.display_name ?? '?',
    status: p.status,
    po_value_cents: p.po_value_cents,
    current_principal_cents: p.current_principal_cents ?? 0,
    fees_outstanding_cents: p.fees_outstanding_cents ?? 0,
    current_batch_id: p.batch_id,
    current_batch_label: p.batch_id ? (batchById.get(p.batch_id) ?? null) : null,
    issuance_date: p.issuance_date,
    requested_delivery_date: p.requested_delivery_date,
    created_at: p.created_at,
  }));

  return (
    <main className="mx-auto max-w-screen-2xl p-6">
      <header className="mb-6">
        <Link
          href={`/clients/${client.id}`}
          className="text-sm text-seaking-muted hover:text-seaking-ink hover:underline"
        >
          ← Back to {client.display_name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-seaking-navy">
          Assign Items to a Batch
        </h1>
        <p className="mt-1 text-sm text-seaking-muted">
          Select outstanding purchase orders, then assign them to an existing batch or a new
          batch. Selected POs that already carry committed advances will move with their advances
          — you&rsquo;ll be asked to acknowledge before submitting.
        </p>
      </header>

      <div className="mb-4 rounded border border-blue-200 bg-blue-50 p-3 text-xs text-seaking-muted">
        <strong className="text-seaking-ink">Note:</strong> only Purchase Order rows are listed
        today. Pre-Advance and Accounts-Receivable rows arrive once their creation paths ship
        (Phase 1E).
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-seaking-danger">
          Failed to load items: {error.message}
        </div>
      )}

      <AssignToBatchForm
        clientId={client.id}
        poAdvanceRateBps={ruleSetRow?.po_advance_rate_bps ?? null}
        retailers={retailers.map((r) => ({ slug: r.name, label: r.display_name }))}
        batches={batches.map((b) => ({ id: b.id, label: b.name }))}
        statuses={(ELIGIBLE_STATUSES as readonly string[]).map((value) => ({
          value,
          label: humanizeStatus(value),
        }))}
        types={(ITEM_TYPES as readonly string[]).map((value) => ({
          value,
          label: humanizeType(value),
        }))}
        pageSizeOptions={[...ALLOWED_PAGE_SIZES]}
        candidates={candidates}
        totalCount={total}
        rawSearchParams={serializeSp(rawSp)}
        currentFilters={{
          q: filters.q,
          retailer: filters.retailer,
          batch: filters.batch,
          status: filters.status,
          types: filters.types,
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

function humanizeType(t: string): string {
  if (t === 'po_advance') return 'PO Advance';
  if (t === 'ar_advance') return 'AR Advance';
  if (t === 'pre_advance') return 'Pre-Advance';
  return t;
}

function serializeSp(sp: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (s) out[k] = s;
  }
  return out;
}
