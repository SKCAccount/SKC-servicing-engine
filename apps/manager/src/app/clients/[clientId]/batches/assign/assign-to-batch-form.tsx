'use client';

/**
 * Assign-to-Batch form — two-section layout:
 *
 *   1. Select Items — server-paginated table with filter/sort/page-size
 *      controls. Selection persists in a Map<id, full-data> so checkboxes
 *      survive across page navigations.
 *
 *   2. Choose destination + commit — pick existing batch OR new batch,
 *      review the affected-reassignment list, ack if needed, submit.
 *
 * Selection-state shape and "select all matches" pattern are lifted from
 * /advances/po/new/advance-on-pos-form.tsx so the two pages feel identical.
 */

import { displayCents } from '@seaking/ui';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  commitReassignToBatchAction,
  fetchAllMatchingItemsAction,
  type FetchMatchingItemsFilter,
  type MatchingItemSummary,
} from './actions';

export interface CandidateItem {
  id: string;
  type: 'po_advance'; // Phase 1D commit 4 only.
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

interface BatchOption {
  id: string;
  label: string;
}
interface RetailerOption {
  slug: string;
  label: string;
}
interface StatusOption {
  value: string;
  label: string;
}

interface CurrentFilters {
  q: string | null;
  retailer: string | null;
  batch: string | null;
  status: string | null;
  /** Multi-select. Empty = no filter (all types). */
  types: string[];
  value_min_cents: number | null;
  value_max_cents: number | null;
  sort: string;
  dir: 'asc' | 'desc';
  page: number;
  page_size: number;
}

interface TypeOption {
  value: string;
  label: string;
}

interface Props {
  clientId: string;
  poAdvanceRateBps: number | null;
  retailers: RetailerOption[];
  batches: BatchOption[];
  statuses: StatusOption[];
  types: TypeOption[];
  pageSizeOptions: number[];
  candidates: CandidateItem[];
  totalCount: number;
  rawSearchParams: Record<string, string>;
  currentFilters: CurrentFilters;
}

type BatchMode = 'new' | 'existing';

export function AssignToBatchForm(props: Props) {
  const {
    clientId,
    poAdvanceRateBps,
    retailers,
    batches,
    statuses,
    types,
    pageSizeOptions,
    candidates,
    totalCount,
    rawSearchParams,
    currentFilters,
  } = props;

  const router = useRouter();

  // ---------- Selection state ----------
  const [selected, setSelected] = useState<Map<string, CandidateItem>>(new Map());

  // ---------- Destination state ----------
  const [batchMode, setBatchMode] = useState<BatchMode>('new');
  const [existingBatchId, setExistingBatchId] = useState<string>('');

  // ---------- Commit state ----------
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledgedReassignment, setAcknowledgedReassignment] = useState(false);
  const [showSelectionDetail, setShowSelectionDetail] = useState(false);

  // Reset reassignment ack when the destination changes — the affected set
  // depends on the destination, so the ack must be re-confirmed.
  useEffect(() => {
    setAcknowledgedReassignment(false);
  }, [batchMode, existingBatchId]);

  // Refresh in-Map row data when the visible page brings in a fresher copy.
  useEffect(() => {
    if (selected.size === 0) return;
    setSelected((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const c of candidates) {
        const existing = next.get(c.id);
        if (
          existing &&
          (existing.current_principal_cents !== c.current_principal_cents ||
            existing.current_batch_id !== c.current_batch_id ||
            existing.current_batch_label !== c.current_batch_label)
        ) {
          next.set(c.id, c);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [candidates, selected.size]);

  // ---------- Detect cross-batch reassignment ----------
  const affectedReassignments: Array<{
    po_number: string;
    from_batch_label: string;
    to_batch_label: string;
  }> = useMemo(() => {
    if (selected.size === 0) return [];
    const destinationLabel = batchMode === 'new'
      ? 'a new batch'
      : (batches.find((b) => b.id === existingBatchId)?.label ?? '(pick a batch)');
    const out: Array<{
      po_number: string;
      from_batch_label: string;
      to_batch_label: string;
    }> = [];
    for (const c of selected.values()) {
      if (c.current_batch_id == null) continue; // first-time assignment, no warning
      if (batchMode === 'existing' && c.current_batch_id === existingBatchId) continue;
      out.push({
        po_number: c.po_number,
        from_batch_label: c.current_batch_label ?? '(unknown batch)',
        to_batch_label: destinationLabel,
      });
    }
    return out;
  }, [selected, batchMode, existingBatchId, batches]);

  const reassignmentRequired = affectedReassignments.length > 0;

  // ---------- Selection helpers ----------
  function toggleOne(item: CandidateItem) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }
  function toggleAllInView() {
    const allInViewSelected = candidates.every((c) => selected.has(c.id));
    setSelected((prev) => {
      const next = new Map(prev);
      if (allInViewSelected) {
        for (const c of candidates) next.delete(c.id);
      } else {
        for (const c of candidates) next.set(c.id, c);
      }
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Map());
  }
  function removeFromSelection(id: string) {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  // ---------- Select-all-matches across pages ----------
  const [selectAllBusy, setSelectAllBusy] = useState(false);
  const [selectAllError, setSelectAllError] = useState<string | null>(null);
  const [selectAllNotice, setSelectAllNotice] = useState<string | null>(null);

  async function selectAllMatches() {
    setSelectAllBusy(true);
    setSelectAllError(null);
    setSelectAllNotice(null);
    const filterPayload: FetchMatchingItemsFilter = {
      q: currentFilters.q,
      retailer_slug: currentFilters.retailer,
      batch_id: currentFilters.batch,
      status: currentFilters.status,
      types: currentFilters.types,
      value_min_cents: currentFilters.value_min_cents,
      value_max_cents: currentFilters.value_max_cents,
    };
    const result = await fetchAllMatchingItemsAction(clientId, filterPayload);
    if (!result.ok) {
      setSelectAllError(result.error.message);
      setSelectAllBusy(false);
      return;
    }
    setSelected((prev) => {
      const next = new Map(prev);
      for (const item of result.data.items) {
        next.set(item.id, summaryToCandidate(item));
      }
      return next;
    });
    if (result.data.truncated) {
      setSelectAllNotice(
        `Selected ${result.data.items.length.toLocaleString('en-US')} items. The match set has ${result.data.totalCount.toLocaleString('en-US')} total — capped at ${result.data.items.length.toLocaleString('en-US')} per request. Narrow the filter and retry to capture the rest.`,
      );
    } else {
      setSelectAllNotice(
        `Selected all ${result.data.items.length.toLocaleString('en-US')} matches.`,
      );
    }
    setSelectAllBusy(false);
  }

  // ---------- Aggregates from the SELECTION SET (across pages) ----------
  const summary = useMemo(() => {
    let totalValueCents = 0;
    let totalCurrentPrincipalCents = 0;
    let totalFeesCents = 0;
    let totalBorrowingBaseCents = 0;
    for (const c of selected.values()) {
      totalValueCents += c.po_value_cents;
      totalCurrentPrincipalCents += c.current_principal_cents;
      totalFeesCents += c.fees_outstanding_cents;
      if (poAdvanceRateBps != null) {
        // Per-PO borrowing base = po_value * po_advance_rate_bps / 10000.
        // Floor to cents.
        totalBorrowingBaseCents += Math.floor(
          (c.po_value_cents * poAdvanceRateBps) / 10_000,
        );
      }
    }
    const totalAvailableCents = Math.max(
      0,
      totalBorrowingBaseCents - totalCurrentPrincipalCents,
    );
    return {
      count: selected.size,
      totalValueCents,
      totalCurrentPrincipalCents,
      totalFeesCents,
      totalBorrowingBaseCents,
      totalAvailableCents,
    };
  }, [selected, poAdvanceRateBps]);

  // ---------- URL navigation helpers ----------
  function buildHref(overrides: Record<string, string | number | null>): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(rawSearchParams)) {
      if (k in overrides) continue;
      if (v) params.set(k, v);
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (v == null || v === '') continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    return `/clients/${clientId}/batches/assign${qs ? `?${qs}` : ''}`;
  }

  function applyFilters(payload: {
    q: string;
    retailer: string;
    batch: string;
    status: string;
    types: string[];
    valueMin: string;
    valueMax: string;
    pageSize: string;
  }) {
    const overrides: Record<string, string | number | null> = {
      q: payload.q || null,
      retailer: payload.retailer || null,
      batch: payload.batch || null,
      status: payload.status || null,
      type: payload.types.length > 0 ? payload.types.join(',') : null,
      valueMin: payload.valueMin || null,
      valueMax: payload.valueMax || null,
      pageSize: payload.pageSize,
      page: 1,
    };
    router.push(buildHref(overrides));
  }
  function clearFilters() {
    router.push(`/clients/${clientId}/batches/assign`);
  }

  // ---------- Commit ----------
  async function onCommit() {
    if (selected.size === 0) return;
    if (batchMode === 'existing' && !existingBatchId) {
      setError('Pick an existing batch.');
      return;
    }
    if (reassignmentRequired && !acknowledgedReassignment) {
      setError(
        'One or more selected items are currently in a different batch. Tick the acknowledgement to proceed.',
      );
      return;
    }

    setBusy(true);
    setError(null);
    const result = await commitReassignToBatchAction({
      client_id: clientId,
      purchase_order_ids: Array.from(selected.keys()),
      existing_batch_id: batchMode === 'existing' ? existingBatchId : null,
      new_batch: batchMode === 'new',
      acknowledged_batch_reassignment: acknowledgedReassignment,
    });
    if (!result.ok) {
      setError(result.error.message);
      setBusy(false);
      return;
    }
    router.push(
      `/clients/${clientId}?batch_assigned=${result.data.pos_reassigned}&batch_id=${result.data.batch_id}`,
    );
    router.refresh();
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / currentFilters.page_size));
  const firstShown = totalCount === 0 ? 0 : (currentFilters.page - 1) * currentFilters.page_size + 1;
  const lastShown = Math.min(currentFilters.page * currentFilters.page_size, totalCount);

  return (
    <div className="space-y-8">
      {/* ---------- Section 1: Select items ---------- */}
      <section>
        <SectionHeader number={1} title="Select Items" />

        <FilterForm
          retailers={retailers}
          batches={batches}
          statuses={statuses}
          types={types}
          pageSizeOptions={pageSizeOptions}
          initial={currentFilters}
          onApply={applyFilters}
          onClear={clearFilters}
        />

        {totalCount > candidates.length && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
            <span className="text-seaking-muted">
              The current filter matches{' '}
              <strong className="text-seaking-ink">
                {totalCount.toLocaleString('en-US')}
              </strong>{' '}
              items across all pages.
            </span>
            <button
              type="button"
              onClick={selectAllMatches}
              disabled={selectAllBusy}
              className="rounded bg-seaking-navy px-3 py-1 text-xs font-medium text-white transition hover:bg-seaking-navy-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {selectAllBusy
                ? 'Loading…'
                : `Select all ${totalCount.toLocaleString('en-US')} matches`}
            </button>
          </div>
        )}

        {selectAllNotice && (
          <div
            className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-seaking-success"
            role="status"
          >
            {selectAllNotice}
          </div>
        )}

        {selectAllError && (
          <div
            className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-seaking-danger"
            role="alert"
          >
            {selectAllError}
          </div>
        )}

        <div className="mt-3 overflow-x-auto rounded border border-seaking-border bg-seaking-surface">
          <table className="w-full text-sm">
            <thead className="bg-seaking-bg text-[10px] uppercase tracking-wider text-seaking-muted">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={candidates.length > 0 && candidates.every((c) => selected.has(c.id))}
                    onChange={toggleAllInView}
                    className="h-4 w-4"
                    aria-label="Toggle all rows in view"
                  />
                </th>
                <Th>Type</Th>
                <SortHeader
                  label="PO #"
                  sortKey="po_number"
                  currentSort={currentFilters.sort}
                  currentDir={currentFilters.dir}
                  buildHref={buildHref}
                />
                <Th>Invoice #</Th>
                <Th>Retailer</Th>
                <Th>Status</Th>
                <SortHeader
                  label="Batch"
                  sortKey="batch"
                  currentSort={currentFilters.sort}
                  currentDir={currentFilters.dir}
                  buildHref={buildHref}
                />
                <SortHeader
                  label="PO value"
                  sortKey="value"
                  align="right"
                  currentSort={currentFilters.sort}
                  currentDir={currentFilters.dir}
                  buildHref={buildHref}
                />
                <Th className="text-right">Inv. value</Th>
                <Th className="text-right">Borrowing base</Th>
                <Th className="text-right">Available BB</Th>
                <SortHeader
                  label="Accrued fees"
                  sortKey="fees"
                  align="right"
                  currentSort={currentFilters.sort}
                  currentDir={currentFilters.dir}
                  buildHref={buildHref}
                />
                <SortHeader
                  label="Delivery"
                  sortKey="delivery_date"
                  currentSort={currentFilters.sort}
                  currentDir={currentFilters.dir}
                  buildHref={buildHref}
                />
                <Th>Days outstanding</Th>
                <Th>Expected paid</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-seaking-border">
              {candidates.length === 0 && (
                <tr>
                  <td colSpan={15} className="px-3 py-8 text-center text-xs text-seaking-muted">
                    No items match the current filters.
                  </td>
                </tr>
              )}
              {candidates.map((c) => {
                const borrowingBaseCents =
                  poAdvanceRateBps == null
                    ? 0
                    : Math.floor((c.po_value_cents * poAdvanceRateBps) / 10_000);
                const availableCents = Math.max(
                  0,
                  borrowingBaseCents - c.current_principal_cents,
                );
                return (
                  <tr
                    key={c.id}
                    className={selected.has(c.id) ? 'bg-blue-50' : 'hover:bg-seaking-bg'}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggleOne(c)}
                        className="h-4 w-4"
                      />
                    </td>
                    <td className="px-3 py-2 text-xs">{humanType(c.type)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{c.po_number}</td>
                    <td className="px-3 py-2 text-xs text-seaking-muted">—</td>
                    <td className="px-3 py-2 text-xs">{c.retailer_display}</td>
                    <td className="px-3 py-2 text-xs">{humanStatus(c.status)}</td>
                    <td className="px-3 py-2 text-xs">
                      {c.current_batch_label ?? <span className="text-seaking-muted">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-xs">
                      {displayCents(c.po_value_cents)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-seaking-muted">—</td>
                    <td className="px-3 py-2 text-right text-xs">
                      {poAdvanceRateBps == null ? '—' : displayCents(borrowingBaseCents)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs">
                      {poAdvanceRateBps == null ? '—' : displayCents(availableCents)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs">
                      {displayCents(c.fees_outstanding_cents)}
                    </td>
                    <td className="px-3 py-2 text-xs">{c.requested_delivery_date ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-seaking-muted">—</td>
                    <td className="px-3 py-2 text-xs text-seaking-muted">—</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Pagination
          buildHref={buildHref}
          page={currentFilters.page}
          totalPages={totalPages}
          firstShown={firstShown}
          lastShown={lastShown}
          totalRows={totalCount}
        />

        {/* Selection summary */}
        {selected.size > 0 && (
          <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium text-seaking-navy">
                {selected.size.toLocaleString('en-US')} item
                {selected.size === 1 ? '' : 's'} selected
                {' '}
                <button
                  type="button"
                  onClick={() => setShowSelectionDetail((v) => !v)}
                  className="ml-1 text-xs font-normal text-seaking-navy underline hover:no-underline"
                >
                  {showSelectionDetail ? 'Hide list' : 'Show list'}
                </button>
              </div>
              <button
                type="button"
                onClick={clearSelection}
                className="text-xs text-seaking-muted hover:text-seaking-ink hover:underline"
              >
                Clear selection
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Total PO value" value={displayCents(summary.totalValueCents)} />
              <Stat
                label="Current principal"
                value={displayCents(summary.totalCurrentPrincipalCents)}
              />
              <Stat
                label="Borrowing base"
                value={
                  poAdvanceRateBps == null
                    ? '—'
                    : displayCents(summary.totalBorrowingBaseCents)
                }
              />
              <Stat label="Accrued fees" value={displayCents(summary.totalFeesCents)} />
            </div>
            {showSelectionDetail && (
              <div className="mt-3 max-h-64 overflow-auto rounded border border-blue-200 bg-white">
                <table className="w-full text-xs">
                  <thead className="bg-seaking-bg text-[9px] uppercase tracking-wider text-seaking-muted">
                    <tr>
                      <th className="px-2 py-1.5 text-left">PO #</th>
                      <th className="px-2 py-1.5 text-left">Retailer</th>
                      <th className="px-2 py-1.5 text-left">Current batch</th>
                      <th className="px-2 py-1.5 text-right">PO value</th>
                      <th className="w-8 px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-blue-100">
                    {Array.from(selected.values()).map((c) => (
                      <tr key={c.id}>
                        <td className="px-2 py-1 font-mono">{c.po_number}</td>
                        <td className="px-2 py-1">{c.retailer_display}</td>
                        <td className="px-2 py-1 text-seaking-muted">
                          {c.current_batch_label ?? 'Unassigned'}
                        </td>
                        <td className="px-2 py-1 text-right">{displayCents(c.po_value_cents)}</td>
                        <td className="px-2 py-1 text-right">
                          <button
                            type="button"
                            onClick={() => removeFromSelection(c.id)}
                            className="text-seaking-danger hover:underline"
                            aria-label={`Remove ${c.po_number} from selection`}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ---------- Section 2: Choose destination + commit ---------- */}
      <section className={selected.size === 0 ? 'pointer-events-none opacity-50' : ''}>
        <SectionHeader number={2} title="Destination batch and commit" disabled={selected.size === 0} />

        <div className="rounded-lg border border-seaking-border bg-seaking-surface p-4">
          <label className="mb-1 block text-sm font-medium">Batch</label>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={batchMode === 'new'}
                onChange={() => setBatchMode('new')}
              />
              <span>New batch (next sequential number)</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={batchMode === 'existing'}
                onChange={() => setBatchMode('existing')}
              />
              <span>Existing batch:</span>
              <select
                value={existingBatchId}
                onChange={(e) => {
                  setExistingBatchId(e.target.value);
                  if (e.target.value) setBatchMode('existing');
                }}
                onFocus={() => setBatchMode('existing')}
                className="rounded border border-seaking-border bg-white px-2 py-1 text-sm outline-none focus:border-seaking-navy"
                disabled={batches.length === 0}
              >
                <option value="">Pick…</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-seaking-muted">
              Selected items will be assigned to this batch on commit. POs that already have
              committed advances will move with their advances.
            </p>
          </div>

          {reassignmentRequired && (
            <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-semibold">
                Warning: {affectedReassignments.length} PO
                {affectedReassignments.length === 1 ? ' is' : 's are'} currently assigned to a
                different batch.
              </p>
              <p className="mt-1 text-xs">
                Submitting will shift these POs — and all of their existing committed/funded
                advances — to the destination batch. Each PO can belong to only one batch at a
                time. Are you sure you want to proceed? Some purchase orders selected have
                already been assigned to a different batch.
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs underline">
                  Show affected POs
                </summary>
                <ul className="mt-2 max-h-40 overflow-auto rounded border border-amber-200 bg-white p-2 text-xs">
                  {affectedReassignments.map((r, i) => (
                    <li key={i} className="py-0.5">
                      <span className="font-mono">{r.po_number}</span>
                      <span className="text-seaking-muted">
                        {' '}— {r.from_batch_label} → {r.to_batch_label}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
              <label className="mt-3 flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={acknowledgedReassignment}
                  onChange={(e) => setAcknowledgedReassignment(e.target.checked)}
                  className="h-4 w-4"
                />
                <span>I acknowledge the batch reassignment and want to proceed.</span>
              </label>
            </div>
          )}

          {error && (
            <div className="mt-3 rounded bg-red-50 p-3 text-sm text-seaking-danger" role="alert">
              {error}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Link
              href={`/clients/${clientId}`}
              className="rounded border border-seaking-border bg-white px-4 py-2 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg"
            >
              Cancel
            </Link>
            <button
              type="button"
              onClick={onCommit}
              disabled={busy || selected.size === 0}
              className="rounded bg-seaking-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-seaking-navy-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy
                ? 'Submitting…'
                : `Assign ${selected.size.toLocaleString('en-US')} item${selected.size === 1 ? '' : 's'} to batch`}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function summaryToCandidate(s: MatchingItemSummary): CandidateItem {
  return {
    id: s.id,
    type: s.type,
    po_number: s.po_number,
    retailer_id: s.retailer_id,
    retailer_display: s.retailer_display,
    status: s.status,
    po_value_cents: s.po_value_cents,
    current_principal_cents: s.current_principal_cents,
    fees_outstanding_cents: s.fees_outstanding_cents,
    current_batch_id: s.current_batch_id,
    current_batch_label: s.current_batch_label,
    issuance_date: s.issuance_date,
    requested_delivery_date: s.requested_delivery_date,
    created_at: s.created_at,
  };
}

// ============================================================================
// Sub-components — same shape as advance-on-pos-form.tsx
// ============================================================================

function FilterForm({
  retailers,
  batches,
  statuses,
  types,
  pageSizeOptions,
  initial,
  onApply,
  onClear,
}: {
  retailers: RetailerOption[];
  batches: BatchOption[];
  statuses: StatusOption[];
  types: TypeOption[];
  pageSizeOptions: number[];
  initial: CurrentFilters;
  onApply: (payload: {
    q: string;
    retailer: string;
    batch: string;
    status: string;
    types: string[];
    valueMin: string;
    valueMax: string;
    pageSize: string;
  }) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState(initial.q ?? '');
  const [retailer, setRetailer] = useState(initial.retailer ?? '');
  const [batch, setBatch] = useState(initial.batch ?? '');
  const [status, setStatus] = useState(initial.status ?? '');
  const [selTypes, setSelTypes] = useState<string[]>(initial.types);
  const [valueMin, setValueMin] = useState(
    initial.value_min_cents != null ? (initial.value_min_cents / 100).toString() : '',
  );
  const [valueMax, setValueMax] = useState(
    initial.value_max_cents != null ? (initial.value_max_cents / 100).toString() : '',
  );
  const [pageSize, setPageSize] = useState(String(initial.page_size));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onApply({ q, retailer, batch, status, types: selTypes, valueMin, valueMax, pageSize });
      }}
      className="rounded-lg border border-seaking-border bg-seaking-surface p-4"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FFieldFor label="PO number">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="substring"
            className="w-full rounded border border-seaking-border px-3 py-1.5 text-sm outline-none focus:border-seaking-navy"
          />
        </FFieldFor>
        <FFieldFor label="Type (Cmd/Ctrl-click for multi)">
          <select
            multiple
            value={selTypes}
            onChange={(e) =>
              setSelTypes(Array.from(e.target.selectedOptions).map((o) => o.value))
            }
            size={3}
            className="w-full rounded border border-seaking-border bg-white px-2 py-1 text-sm outline-none focus:border-seaking-navy"
          >
            {types.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {selTypes.length === 0 && (
            <p className="mt-1 text-[10px] text-seaking-muted">No selection = all types</p>
          )}
        </FFieldFor>
        <FFieldFor label="Retailer">
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
        </FFieldFor>
        <FFieldFor label="Batch">
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
        </FFieldFor>
        <FFieldFor label="Status">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full rounded border border-seaking-border bg-white px-3 py-1.5 text-sm outline-none focus:border-seaking-navy"
          >
            <option value="">Any outstanding (active / partial / closed-awaiting)</option>
            {statuses.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </FFieldFor>
        <FFieldFor label="PO value ($)">
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
        </FFieldFor>
        <FFieldFor label="Rows per page">
          <select
            value={pageSize}
            onChange={(e) => setPageSize(e.target.value)}
            className="w-full rounded border border-seaking-border bg-white px-3 py-1.5 text-sm outline-none focus:border-seaking-navy"
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </FFieldFor>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClear}
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
    </form>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 text-left font-semibold ${className ?? ''}`}>{children}</th>
  );
}

function SortHeader({
  label,
  sortKey,
  currentSort,
  currentDir,
  buildHref,
  align,
}: {
  label: string;
  sortKey: string;
  currentSort: string;
  currentDir: 'asc' | 'desc';
  buildHref: (overrides: Record<string, string | number | null>) => string;
  align?: 'right';
}) {
  const isActive = sortKey === currentSort;
  const nextDir: 'asc' | 'desc' = isActive
    ? currentDir === 'asc'
      ? 'desc'
      : 'asc'
    : sortKey === 'value' || sortKey === 'fees' || sortKey === 'current_principal'
      ? 'desc'
      : 'asc';
  const href = buildHref({ sort: sortKey, dir: nextDir, page: 1 });

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

function Pagination({
  buildHref,
  page,
  totalPages,
  firstShown,
  lastShown,
  totalRows,
}: {
  buildHref: (overrides: Record<string, string | number | null>) => string;
  page: number;
  totalPages: number;
  firstShown: number;
  lastShown: number;
  totalRows: number;
}) {
  if (totalRows === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-seaking-muted">
      <span>
        Showing {firstShown.toLocaleString('en-US')}–{lastShown.toLocaleString('en-US')} of{' '}
        {totalRows.toLocaleString('en-US')}
      </span>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <PageBtn href={buildHref({ page: 1 })} disabled={page === 1} label="« First" />
          <PageBtn href={buildHref({ page: page - 1 })} disabled={page === 1} label="‹ Prev" />
          <span className="px-2">
            Page {page.toLocaleString('en-US')} of {totalPages.toLocaleString('en-US')}
          </span>
          <PageBtn
            href={buildHref({ page: page + 1 })}
            disabled={page === totalPages}
            label="Next ›"
          />
          <PageBtn
            href={buildHref({ page: totalPages })}
            disabled={page === totalPages}
            label="Last »"
          />
        </div>
      )}
    </div>
  );
}

function PageBtn({ href, disabled, label }: { href: string; disabled: boolean; label: string }) {
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

function SectionHeader({
  number,
  title,
  disabled,
}: {
  number: number;
  title: string;
  disabled?: boolean;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span
        className={
          disabled
            ? 'flex h-6 w-6 items-center justify-center rounded-full bg-seaking-border text-xs font-semibold text-seaking-muted'
            : 'flex h-6 w-6 items-center justify-center rounded-full bg-seaking-navy text-xs font-semibold text-white'
        }
      >
        {number}
      </span>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-seaking-muted">{title}</h2>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-blue-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-wider text-seaking-muted">{label}</div>
      <div className="mt-1 text-base font-semibold">{value}</div>
    </div>
  );
}

function FFieldFor({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-seaking-muted">
        {label}
      </div>
      {children}
    </div>
  );
}

function humanStatus(s: string): string {
  if (s === 'active') return 'Active';
  if (s === 'partially_invoiced') return 'Partially Invoiced';
  if (s === 'closed_awaiting_invoice') return 'Closed — Awaiting Invoice';
  return s;
}

function humanType(t: 'po_advance'): string {
  if (t === 'po_advance') return 'PO Advance';
  return t;
}
