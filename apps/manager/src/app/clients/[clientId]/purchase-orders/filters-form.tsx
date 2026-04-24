'use client';

/**
 * PO list filter form.
 *
 * A plain GET form that submits to the same route, appending the URL query
 * string. The page re-renders server-side with the filters applied. Kept as
 * a client component only for the conditional 'Clear all' behavior and the
 * unassigned-batch selector — neither requires useState persistence across
 * renders, so state lives entirely in the controlled inputs.
 */

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

interface FiltersFormProps {
  clientId: string;
  retailers: Array<{ slug: string; label: string }>;
  batches: Array<{ id: string; label: string }>;
  statuses: Array<{ value: string; label: string }>;
  pageSizeOptions: number[];
  initial: {
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
    page_size: number;
    sort: string;
    dir: string;
  };
}

export function FiltersForm({
  clientId,
  retailers,
  batches,
  statuses,
  pageSizeOptions,
  initial,
}: FiltersFormProps) {
  const router = useRouter();
  const [q, setQ] = useState(initial.q ?? '');
  const [retailer, setRetailer] = useState(initial.retailer ?? '');
  const [batch, setBatch] = useState(initial.batch ?? '');
  const [status, setStatus] = useState(initial.status ?? '');
  const [issuedFrom, setIssuedFrom] = useState(initial.issued_from ?? '');
  const [issuedTo, setIssuedTo] = useState(initial.issued_to ?? '');
  const [valueMin, setValueMin] = useState(initial.value_min != null ? (initial.value_min / 100).toString() : '');
  const [valueMax, setValueMax] = useState(initial.value_max != null ? (initial.value_max / 100).toString() : '');
  const [uploadedFrom, setUploadedFrom] = useState(initial.uploaded_from ?? '');
  const [uploadedTo, setUploadedTo] = useState(initial.uploaded_to ?? '');
  const [pageSize, setPageSize] = useState(String(initial.page_size));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (retailer) params.set('retailer', retailer);
    if (batch) params.set('batch', batch);
    if (status) params.set('status', status);
    if (issuedFrom) params.set('issuedFrom', issuedFrom);
    if (issuedTo) params.set('issuedTo', issuedTo);
    if (valueMin) params.set('valueMin', valueMin);
    if (valueMax) params.set('valueMax', valueMax);
    if (uploadedFrom) params.set('uploadedFrom', uploadedFrom);
    if (uploadedTo) params.set('uploadedTo', uploadedTo);
    if (pageSize) params.set('pageSize', pageSize);
    // Preserve sort across filter changes (filters reset to page 1, but
    // keep the user's chosen sort).
    if (initial.sort) params.set('sort', initial.sort);
    if (initial.dir) params.set('dir', initial.dir);
    const qs = params.toString();
    router.push(`/clients/${clientId}/purchase-orders${qs ? `?${qs}` : ''}`);
  }

  function clearAll() {
    setQ('');
    setRetailer('');
    setBatch('');
    setStatus('');
    setIssuedFrom('');
    setIssuedTo('');
    setValueMin('');
    setValueMax('');
    setUploadedFrom('');
    setUploadedTo('');
    router.push(`/clients/${clientId}/purchase-orders`);
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border border-seaking-border bg-seaking-surface p-4"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="PO number">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="substring match"
            className="w-full rounded border border-seaking-border px-3 py-1.5 text-sm outline-none focus:border-seaking-navy"
          />
        </Field>

        <Field label="Retailer">
          <select
            value={retailer}
            onChange={(e) => setRetailer(e.target.value)}
            className="w-full rounded border border-seaking-border bg-white px-3 py-1.5 text-sm outline-none focus:border-seaking-navy"
          >
            <option value="">Any</option>
            {retailers.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Batch">
          <select
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
            className="w-full rounded border border-seaking-border bg-white px-3 py-1.5 text-sm outline-none focus:border-seaking-navy"
          >
            <option value="">Any</option>
            <option value="unassigned">Unassigned</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Status">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full rounded border border-seaking-border bg-white px-3 py-1.5 text-sm outline-none focus:border-seaking-navy"
          >
            <option value="">Any</option>
            {statuses.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Issuance date">
          <div className="flex gap-2">
            <input
              type="date"
              value={issuedFrom}
              onChange={(e) => setIssuedFrom(e.target.value)}
              className="w-full rounded border border-seaking-border px-2 py-1.5 text-xs outline-none focus:border-seaking-navy"
            />
            <input
              type="date"
              value={issuedTo}
              onChange={(e) => setIssuedTo(e.target.value)}
              className="w-full rounded border border-seaking-border px-2 py-1.5 text-xs outline-none focus:border-seaking-navy"
            />
          </div>
        </Field>

        <Field label="Upload date">
          <div className="flex gap-2">
            <input
              type="date"
              value={uploadedFrom}
              onChange={(e) => setUploadedFrom(e.target.value)}
              className="w-full rounded border border-seaking-border px-2 py-1.5 text-xs outline-none focus:border-seaking-navy"
            />
            <input
              type="date"
              value={uploadedTo}
              onChange={(e) => setUploadedTo(e.target.value)}
              className="w-full rounded border border-seaking-border px-2 py-1.5 text-xs outline-none focus:border-seaking-navy"
            />
          </div>
        </Field>

        <Field label="PO value ($)">
          <div className="flex gap-2">
            <input
              type="number"
              min="0"
              step="0.01"
              value={valueMin}
              onChange={(e) => setValueMin(e.target.value)}
              placeholder="min"
              className="w-full rounded border border-seaking-border px-2 py-1.5 text-xs outline-none focus:border-seaking-navy"
            />
            <input
              type="number"
              min="0"
              step="0.01"
              value={valueMax}
              onChange={(e) => setValueMax(e.target.value)}
              placeholder="max"
              className="w-full rounded border border-seaking-border px-2 py-1.5 text-xs outline-none focus:border-seaking-navy"
            />
          </div>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-2">
        <Field label="Rows per page">
          <select
            value={pageSize}
            onChange={(e) => setPageSize(e.target.value)}
            className="rounded border border-seaking-border bg-white px-2 py-1.5 text-sm outline-none focus:border-seaking-navy"
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={clearAll}
            className="rounded border border-seaking-border bg-white px-3 py-1.5 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg"
          >
            Clear
          </button>
          <button
            type="submit"
            className="rounded bg-seaking-navy px-3 py-1.5 text-sm font-medium text-white transition hover:bg-seaking-navy-hover"
          >
            Apply
          </button>
        </div>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-seaking-muted">
        {label}
      </div>
      {children}
    </div>
  );
}
