/**
 * PO list view with filters, sortable columns, and configurable pagination.
 *
 * State lives in URL search params so the view is bookmarkable and fully
 * server-rendered. Three categories of params:
 *
 *   FILTERS — user-provided search criteria (q, retailer, batch, status,
 *             issuedFrom/To, valueMin/Max, uploadedFrom/To). Form-driven.
 *   SORT     — sort=<col>&dir=<asc|desc>. Driven by clicking column headers.
 *             Column whitelist enforced server-side (allowlist, not just
 *             SQL-escape, because Supabase order() takes a column name).
 *   PAGING   — page (1-indexed) and pageSize (allowed: 25/50/100/250).
 *
 * Default ordering: newest upload first (created_at desc).
 */

import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isManager } from '@seaking/auth';
import { displayCents } from '@seaking/ui';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { FiltersForm } from './filters-form';
import { PageJumpInput } from './page-jump';

const ALLOWED_PAGE_SIZES = [25, 50, 100, 250] as const;
type AllowedPageSize = (typeof ALLOWED_PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: AllowedPageSize = 50;

/** Whitelist of sortable columns. Maps the URL token → real DB column name. */
const SORT_COLUMNS = {
  po_number: 'po_number',
  issuance_date: 'issuance_date',
  delivery_date: 'requested_delivery_date',
  delivery_location: 'delivery_location',
  value: 'po_value_cents',
  uploaded: 'created_at',
  status: 'status',
} as const;
type SortKey = keyof typeof SORT_COLUMNS;
const DEFAULT_SORT: SortKey = 'uploaded';
const DEFAULT_DIR: 'asc' | 'desc' = 'desc';

const PO_STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  partially_invoiced: 'Partially Invoiced',
  fully_invoiced: 'Fully Invoiced',
  closed_awaiting_invoice: 'Closed — Awaiting Invoice',
  cancelled: 'Cancelled',
  written_off: 'Written Off',
};

interface PageProps {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

interface PoRow {
  id: string;
  po_number: string;
  status: string;
  po_value_cents: number;
  issuance_date: string | null;
  requested_delivery_date: string | null;
  delivery_location: string | null;
  batch_id: string | null;
  created_at: string;
  retailer_id: string;
}

interface Filters {
  q: string | null;
  retailer: string | null;
  batch: string | null;
  status: string | null;
  issued_from: string | null;
  issued_to: string | null;
  value_min: number | null;
  value_max: number | null;
  uploaded_from: string | null;
  uploaded_to: string | null;
  page: number;
  page_size: AllowedPageSize;
  sort: SortKey;
  dir: 'asc' | 'desc';
}

function firstParam(v: string | string[] | undefined): string | null {
  if (v == null) return null;
  const s = Array.isArray(v) ? v[0] : v;
  if (s == null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

function parseFilters(sp: Record<string, string | string[] | undefined>): Filters {
  const pageRaw = Number(firstParam(sp['page']) ?? '1');
  const sizeRaw = Number(firstParam(sp['pageSize']) ?? DEFAULT_PAGE_SIZE);
  const page_size = (ALLOWED_PAGE_SIZES as readonly number[]).includes(sizeRaw)
    ? (sizeRaw as AllowedPageSize)
    : DEFAULT_PAGE_SIZE;

  const sortRaw = firstParam(sp['sort']) ?? DEFAULT_SORT;
  const sort = (sortRaw in SORT_COLUMNS ? sortRaw : DEFAULT_SORT) as SortKey;
  const dirRaw = firstParam(sp['dir']);
  const dir: 'asc' | 'desc' = dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : DEFAULT_DIR;

  return {
    q: firstParam(sp['q']),
    retailer: firstParam(sp['retailer']),
    batch: firstParam(sp['batch']),
    status: firstParam(sp['status']),
    issued_from: firstParam(sp['issuedFrom']),
    issued_to: firstParam(sp['issuedTo']),
    value_min: toCents(firstParam(sp['valueMin'])),
    value_max: toCents(firstParam(sp['valueMax'])),
    uploaded_from: firstParam(sp['uploadedFrom']),
    uploaded_to: firstParam(sp['uploadedTo']),
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
    page_size,
    sort,
    dir,
  };
}

function toCents(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export default async function PoListPage({ params, searchParams }: PageProps) {
  const user = await getCurrentAuthUser();
  if (!user) redirect('/login');
  if (!isManager(user.role)) redirect('/login?reason=wrong_app');

  const { clientId } = await params;
  const rawSp = await searchParams;
  const filters = parseFilters(rawSp);

  const supabase = await createSupabaseServerClient();

  const [{ data: clientRow }, { data: retailerList }, { data: batchList }] = await Promise.all([
    supabase.from('clients').select('id, display_name').eq('id', clientId).maybeSingle(),
    supabase.from('retailers').select('id, name, display_name').order('display_name', { ascending: true }),
    supabase.from('batches').select('id, batch_number, name').eq('client_id', clientId).order('batch_number', { ascending: true }),
  ]);

  if (!clientRow) notFound();
  const client = clientRow as { id: string; display_name: string };
  const retailers = (retailerList ?? []) as Array<{ id: string; name: string; display_name: string }>;
  const retailersById = new Map(retailers.map((r) => [r.id, r]));
  const batches = (batchList ?? []) as Array<{ id: string; batch_number: number; name: string }>;
  const batchesById = new Map(batches.map((b) => [b.id, b]));

  let query = supabase
    .from('purchase_orders')
    .select(
      'id, po_number, status, po_value_cents, issuance_date, requested_delivery_date, delivery_location, batch_id, created_at, retailer_id',
      { count: 'exact' },
    )
    .eq('client_id', clientId);

  if (filters.q) query = query.ilike('po_number', `%${filters.q}%`);
  if (filters.retailer) {
    const r = retailers.find((x) => x.name === filters.retailer);
    if (r) query = query.eq('retailer_id', r.id);
  }
  if (filters.batch === 'unassigned') {
    query = query.is('batch_id', null);
  } else if (filters.batch) {
    query = query.eq('batch_id', filters.batch);
  }
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.issued_from) query = query.gte('issuance_date', filters.issued_from);
  if (filters.issued_to) query = query.lte('issuance_date', filters.issued_to);
  if (filters.value_min != null) query = query.gte('po_value_cents', filters.value_min);
  if (filters.value_max != null) query = query.lte('po_value_cents', filters.value_max);
  if (filters.uploaded_from) query = query.gte('created_at', `${filters.uploaded_from}T00:00:00Z`);
  if (filters.uploaded_to) query = query.lte('created_at', `${filters.uploaded_to}T23:59:59Z`);

  const dbColumn = SORT_COLUMNS[filters.sort];
  // nullsFirst:false means dates/locations with NULL go last on ascending sorts.
  query = query.order(dbColumn, { ascending: filters.dir === 'asc', nullsFirst: false });
  // Stable secondary sort by id so equal-sort-key rows have a deterministic order
  // across pagination.
  query = query.order('id', { ascending: true });

  const offset = (filters.page - 1) * filters.page_size;
  query = query.range(offset, offset + filters.page_size - 1);

  const { data, count, error } = await query;
  const rows = (data ?? []) as PoRow[];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / filters.page_size));

  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <Link
            href={`/clients/${client.id}`}
            className="text-sm text-seaking-muted hover:text-seaking-ink hover:underline"
          >
            ← Back to {client.display_name}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-seaking-navy">
            Purchase Orders
          </h1>
          <p className="text-sm text-seaking-muted">
            {total.toLocaleString('en-US')} total
            {hasAnyFilter(filters) ? ' matching filters' : ''}
          </p>
        </div>
        <Link
          href={`/clients/${client.id}/po-uploads/new`}
          className="rounded bg-seaking-navy px-3 py-1.5 text-sm font-medium text-white transition hover:bg-seaking-navy-hover"
        >
          + Upload POs
        </Link>
      </header>

      <FiltersForm
        clientId={client.id}
        retailers={retailers.map((r) => ({ slug: r.name, label: r.display_name }))}
        batches={batches.map((b) => ({ id: b.id, label: b.name }))}
        statuses={Object.entries(PO_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
        pageSizeOptions={[...ALLOWED_PAGE_SIZES]}
        initial={filters}
      />

      {error && (
        <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-seaking-danger">
          Failed to load purchase orders: {error.message}
        </div>
      )}

      {rows.length === 0 && !error && (
        <div className="mt-4 rounded border border-dashed border-seaking-border bg-seaking-surface p-10 text-center">
          <p className="text-sm text-seaking-muted">
            {hasAnyFilter(filters)
              ? 'No purchase orders match the current filters.'
              : 'No purchase orders yet. Upload a file to get started.'}
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="mt-4 overflow-hidden rounded border border-seaking-border bg-seaking-surface">
            <table className="w-full text-sm">
              <thead className="bg-seaking-bg text-[10px] uppercase tracking-wider text-seaking-muted">
                <tr>
                  <SortHeader
                    label="PO #"
                    sortKey="po_number"
                    currentSort={filters.sort}
                    currentDir={filters.dir}
                    rawSp={rawSp}
                    clientId={client.id}
                  />
                  <Th>Retailer</Th>
                  <SortHeader
                    label="Status"
                    sortKey="status"
                    currentSort={filters.sort}
                    currentDir={filters.dir}
                    rawSp={rawSp}
                    clientId={client.id}
                  />
                  <Th>Batch</Th>
                  <SortHeader
                    label="Issued"
                    sortKey="issuance_date"
                    currentSort={filters.sort}
                    currentDir={filters.dir}
                    rawSp={rawSp}
                    clientId={client.id}
                  />
                  <SortHeader
                    label="Req. Delivery"
                    sortKey="delivery_date"
                    currentSort={filters.sort}
                    currentDir={filters.dir}
                    rawSp={rawSp}
                    clientId={client.id}
                  />
                  <SortHeader
                    label="Location"
                    sortKey="delivery_location"
                    currentSort={filters.sort}
                    currentDir={filters.dir}
                    rawSp={rawSp}
                    clientId={client.id}
                  />
                  <SortHeader
                    label="Value"
                    sortKey="value"
                    currentSort={filters.sort}
                    currentDir={filters.dir}
                    rawSp={rawSp}
                    clientId={client.id}
                    align="right"
                  />
                  <SortHeader
                    label="Uploaded"
                    sortKey="uploaded"
                    currentSort={filters.sort}
                    currentDir={filters.dir}
                    rawSp={rawSp}
                    clientId={client.id}
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-seaking-border">
                {rows.map((r) => {
                  const retailer = retailersById.get(r.retailer_id);
                  const batch = r.batch_id ? batchesById.get(r.batch_id) : null;
                  return (
                    <tr key={r.id}>
                      <Td className="font-mono text-xs">{r.po_number}</Td>
                      <Td className="text-xs">{retailer?.display_name ?? '—'}</Td>
                      <Td className="text-xs">
                        <StatusPill status={r.status} />
                      </Td>
                      <Td className="text-xs">
                        {batch?.name ?? <span className="text-seaking-muted">—</span>}
                      </Td>
                      <Td className="text-xs">{r.issuance_date ?? '—'}</Td>
                      <Td className="text-xs">{r.requested_delivery_date ?? '—'}</Td>
                      <Td className="text-xs">{r.delivery_location ?? '—'}</Td>
                      <Td className="text-right text-xs">{displayCents(r.po_value_cents)}</Td>
                      <Td className="text-xs">{r.created_at.slice(0, 10)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            clientId={client.id}
            searchParams={rawSp}
            page={filters.page}
            pageSize={filters.page_size}
            totalPages={totalPages}
            totalRows={total}
          />
        </>
      )}
    </main>
  );
}

function hasAnyFilter(f: Filters): boolean {
  return Boolean(
    f.q ||
      f.retailer ||
      f.batch ||
      f.status ||
      f.issued_from ||
      f.issued_to ||
      f.value_min != null ||
      f.value_max != null ||
      f.uploaded_from ||
      f.uploaded_to,
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-left font-semibold ${className ?? ''}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className ?? ''}`}>{children}</td>;
}

/** Build a URL with a single param replaced (or removed when value is null). */
function urlWith(
  clientId: string,
  rawSp: Record<string, string | string[] | undefined>,
  overrides: Record<string, string | number | null>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(rawSp)) {
    if (k in overrides) continue;
    const s = Array.isArray(v) ? v[0] : v;
    if (s) params.set(k, s);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v == null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return `/clients/${clientId}/purchase-orders${qs ? `?${qs}` : ''}`;
}

function SortHeader({
  label,
  sortKey,
  currentSort,
  currentDir,
  rawSp,
  clientId,
  align,
}: {
  label: string;
  sortKey: SortKey;
  currentSort: SortKey;
  currentDir: 'asc' | 'desc';
  rawSp: Record<string, string | string[] | undefined>;
  clientId: string;
  align?: 'right';
}) {
  const isActive = sortKey === currentSort;
  // Click behavior: same column → toggle direction; different column → switch
  // and default to descending for date/value (newest/largest first feels right),
  // ascending for text (alphabetical).
  const nextDir: 'asc' | 'desc' = isActive
    ? currentDir === 'asc'
      ? 'desc'
      : 'asc'
    : sortKey === 'po_number' ||
        sortKey === 'delivery_location' ||
        sortKey === 'status'
      ? 'asc'
      : 'desc';
  const href = urlWith(clientId, rawSp, { sort: sortKey, dir: nextDir, page: 1 });

  return (
    <th className={`px-3 py-2 font-semibold ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <Link
        href={href}
        className={
          isActive
            ? 'inline-flex items-center gap-1 text-seaking-navy hover:underline'
            : 'inline-flex items-center gap-1 hover:text-seaking-ink hover:underline'
        }
      >
        {label}
        <span className="text-[8px]">
          {isActive ? (currentDir === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </Link>
    </th>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'cancelled'
      ? 'bg-red-100 text-seaking-danger'
      : status === 'written_off'
        ? 'bg-gray-200 text-seaking-muted'
        : status === 'fully_invoiced'
          ? 'bg-emerald-100 text-seaking-success'
          : status === 'closed_awaiting_invoice'
            ? 'bg-amber-100 text-amber-900'
            : 'bg-blue-100 text-seaking-navy';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}>
      {PO_STATUS_LABEL[status] ?? status}
    </span>
  );
}

function Pagination({
  clientId,
  searchParams,
  page,
  pageSize,
  totalPages,
  totalRows,
}: {
  clientId: string;
  searchParams: Record<string, string | string[] | undefined>;
  page: number;
  pageSize: number;
  totalPages: number;
  totalRows: number;
}) {
  if (totalPages <= 1) {
    return (
      <p className="mt-3 text-xs text-seaking-muted">
        Showing all {totalRows.toLocaleString('en-US')} rows.
      </p>
    );
  }
  const firstShown = (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, totalRows);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-seaking-muted">
        Showing {firstShown.toLocaleString('en-US')}–{lastShown.toLocaleString('en-US')} of{' '}
        {totalRows.toLocaleString('en-US')}
      </span>
      <div className="flex items-center gap-1">
        <PageLink
          disabled={page === 1}
          href={urlWith(clientId, searchParams, { page: 1 })}
          label="« First"
        />
        <PageLink
          disabled={page === 1}
          href={urlWith(clientId, searchParams, { page: page - 1 })}
          label="‹ Prev"
        />
        <PageJumpInput
          clientId={clientId}
          searchParams={serializeSp(searchParams)}
          currentPage={page}
          totalPages={totalPages}
        />
        <PageLink
          disabled={page === totalPages}
          href={urlWith(clientId, searchParams, { page: page + 1 })}
          label="Next ›"
        />
        <PageLink
          disabled={page === totalPages}
          href={urlWith(clientId, searchParams, { page: totalPages })}
          label="Last »"
        />
      </div>
    </div>
  );
}

function PageLink({
  href,
  label,
  disabled,
}: {
  href: string;
  label: string;
  disabled: boolean;
}) {
  if (disabled) {
    return (
      <span className="cursor-not-allowed rounded border border-seaking-border bg-seaking-bg px-2 py-1 text-xs text-seaking-muted opacity-50">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="rounded border border-seaking-border bg-white px-2 py-1 text-xs hover:bg-seaking-bg"
    >
      {label}
    </Link>
  );
}

/**
 * Reduce searchParams to a flat string→string map for passing to the
 * client-side jump component. The PageJumpInput is a 'use client' component
 * and can't take complex objects from a Server Component.
 */
function serializeSp(sp: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (s) out[k] = s;
  }
  return out;
}
