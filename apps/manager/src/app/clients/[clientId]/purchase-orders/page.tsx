/**
 * PO list view with filters.
 *
 * Filter state lives in URL search params so the list is bookmarkable and
 * fully server-rendered. The filter form is a plain GET form — no client
 * component, no useEffect round-trips — which keeps the page fast and
 * simple to reason about.
 *
 * Spec filters (§Advance on Purchase Orders): Batch, PO Number, Retailer,
 * Issuance Date, PO Value, Upload Date. Status added because Managers will
 * frequently want to exclude cancelled POs from the view.
 *
 * Pagination: ?page= with fixed page size of 50. Simple cursorless offset
 * pagination is fine at Phase-1 scale; we'll revisit if any Client's PO
 * count crosses ~50K.
 */

import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isManager } from '@seaking/auth';
import { displayCents } from '@seaking/ui';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { FiltersForm } from './filters-form';

const PAGE_SIZE = 50;

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
  batch: string | null; // batch_id or 'unassigned' or null
  status: string | null;
  issued_from: string | null;
  issued_to: string | null;
  value_min: number | null;
  value_max: number | null;
  uploaded_from: string | null;
  uploaded_to: string | null;
  page: number;
}

/** Parse one URL query entry. Returns null for empty. Unwraps string[] by taking first. */
function firstParam(v: string | string[] | undefined): string | null {
  if (v == null) return null;
  const s = Array.isArray(v) ? v[0] : v;
  if (s == null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

function parseFilters(sp: Record<string, string | string[] | undefined>): Filters {
  const page = Number(firstParam(sp['page']) ?? '1');
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
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
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
    supabase
      .from('retailers')
      .select('id, name, display_name')
      .order('display_name', { ascending: true }),
    supabase
      .from('batches')
      .select('id, batch_number, name')
      .eq('client_id', clientId)
      .order('batch_number', { ascending: true }),
  ]);

  if (!clientRow) notFound();
  const client = clientRow as { id: string; display_name: string };
  const retailers = (retailerList ?? []) as Array<{
    id: string;
    name: string;
    display_name: string;
  }>;
  const retailersById = new Map(retailers.map((r) => [r.id, r]));
  const batches = (batchList ?? []) as Array<{ id: string; batch_number: number; name: string }>;
  const batchesById = new Map(batches.map((b) => [b.id, b]));

  // Build the PO query with filters applied.
  let query = supabase
    .from('purchase_orders')
    .select(
      'id, po_number, status, po_value_cents, issuance_date, requested_delivery_date, delivery_location, batch_id, created_at, retailer_id',
      { count: 'exact' },
    )
    .eq('client_id', clientId);

  if (filters.q) {
    // PO numbers are opaque strings; ilike with % wrapping gives Manager
    // a substring search which matches how they usually think.
    query = query.ilike('po_number', `%${filters.q}%`);
  }
  if (filters.retailer) {
    const r = retailers.find((x) => x.name === filters.retailer);
    if (r) query = query.eq('retailer_id', r.id);
  }
  if (filters.batch === 'unassigned') {
    query = query.is('batch_id', null);
  } else if (filters.batch) {
    query = query.eq('batch_id', filters.batch);
  }
  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.issued_from) query = query.gte('issuance_date', filters.issued_from);
  if (filters.issued_to) query = query.lte('issuance_date', filters.issued_to);
  if (filters.value_min != null) query = query.gte('po_value_cents', filters.value_min);
  if (filters.value_max != null) query = query.lte('po_value_cents', filters.value_max);
  if (filters.uploaded_from) query = query.gte('created_at', `${filters.uploaded_from}T00:00:00Z`);
  if (filters.uploaded_to) query = query.lte('created_at', `${filters.uploaded_to}T23:59:59Z`);

  const offset = (filters.page - 1) * PAGE_SIZE;
  query = query
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  const { data, count, error } = await query;
  const rows = (data ?? []) as PoRow[];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
                  <Th>PO #</Th>
                  <Th>Retailer</Th>
                  <Th>Status</Th>
                  <Th>Batch</Th>
                  <Th>Issued</Th>
                  <Th>Req. Delivery</Th>
                  <Th>Location</Th>
                  <Th className="text-right">Value</Th>
                  <Th>Uploaded</Th>
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
                      <Td className="text-xs">{batch?.name ?? <span className="text-seaking-muted">—</span>}</Td>
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

          <Pagination clientId={client.id} searchParams={rawSp} page={filters.page} totalPages={totalPages} />
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
  return (
    <th className={`px-3 py-2 text-left font-semibold ${className ?? ''}`}>{children}</th>
  );
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className ?? ''}`}>{children}</td>;
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
  totalPages,
}: {
  clientId: string;
  searchParams: Record<string, string | string[] | undefined>;
  page: number;
  totalPages: number;
}) {
  function hrefWithPage(p: number): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (k === 'page') continue;
      const s = Array.isArray(v) ? v[0] : v;
      if (s) params.set(k, s);
    }
    params.set('page', String(p));
    return `/clients/${clientId}/purchase-orders?${params.toString()}`;
  }

  if (totalPages <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-between text-sm">
      <span className="text-seaking-muted">
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        {page > 1 && (
          <Link
            href={hrefWithPage(page - 1)}
            className="rounded border border-seaking-border bg-white px-3 py-1 text-sm hover:bg-seaking-bg"
          >
            ← Previous
          </Link>
        )}
        {page < totalPages && (
          <Link
            href={hrefWithPage(page + 1)}
            className="rounded border border-seaking-border bg-white px-3 py-1 text-sm hover:bg-seaking-bg"
          >
            Next →
          </Link>
        )}
      </div>
    </div>
  );
}
