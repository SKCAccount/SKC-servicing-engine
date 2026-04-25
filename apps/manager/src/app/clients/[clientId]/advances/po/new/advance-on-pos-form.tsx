'use client';

/**
 * Advance-on-POs multi-step form.
 *
 * Three sections rendered top-to-bottom:
 *
 *   1. Select POs — server-paginated table with filter form, sortable
 *      columns, and a 'rows per page' selector. Selection persists across
 *      filter/sort/page changes via a Map<id, full-data> in client state:
 *      when you check a row, we copy its data into the Map so we can still
 *      render aggregate metrics and run allocation later even after the row
 *      has scrolled out of view.
 *
 *   2. Configure — advance amount (% of available OR fixed $), advance
 *      date, batch (new or existing).
 *
 *   3. Review — per-PO allocation from planPoAdvance with totals, over-
 *      advanced acknowledgement, Commit / Cancel.
 *
 * Why selection lives in client state and not URL: selection is the user's
 * shopping cart, and bookmarking a half-built advance is rarely useful.
 * Filters/sort/page DO go in the URL so the table state itself is shareable.
 */

import { displayCents } from '@seaking/ui';
import {
  cents,
  formatBpsAsPercent,
  planPoAdvance,
  summarizeSelectedPos,
  type Cents,
  type PoAdvancePlan,
  type SelectedPoForAdvance,
} from '@seaking/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  commitPoAdvanceAction,
  fetchAllMatchingPoIdsAction,
  type FetchMatchingPosFilter,
  type MatchingPoSummary,
} from './actions';
import { CsvUpload } from './csv-upload';

export interface CandidatePo {
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
  value_min_cents: number | null;
  value_max_cents: number | null;
  sort: string;
  dir: 'asc' | 'desc';
  page: number;
  page_size: number;
}

interface Props {
  clientId: string;
  poAdvanceRateBps: number | null;
  retailers: RetailerOption[];
  batches: BatchOption[];
  statuses: StatusOption[];
  pageSizeOptions: number[];
  candidates: CandidatePo[];
  totalCount: number;
  rawSearchParams: Record<string, string>;
  currentFilters: CurrentFilters;
}

type AmountMode = 'percent' | 'fixed';
type BatchMode = 'new' | 'existing';

export function AdvanceOnPosForm(props: Props) {
  const {
    clientId,
    poAdvanceRateBps,
    retailers,
    batches,
    statuses,
    pageSizeOptions,
    candidates,
    totalCount,
    rawSearchParams,
    currentFilters,
  } = props;

  const router = useRouter();

  // ---------- Selection state (Map keyed by PO id) ----------
  // We store the FULL CandidatePo so we can compute aggregates and run
  // allocation even when the row isn't visible in the current page slice.
  const [selected, setSelected] = useState<Map<string, CandidatePo>>(new Map());

  // ---------- Configure state ----------
  const [amountMode, setAmountMode] = useState<AmountMode>('percent');
  const [percentInput, setPercentInput] = useState<string>('100');
  const [fixedDollarsInput, setFixedDollarsInput] = useState<string>('');
  const [advanceDate, setAdvanceDate] = useState<string>(todayInNyIso());
  const [batchMode, setBatchMode] = useState<BatchMode>('new');
  const [existingBatchId, setExistingBatchId] = useState<string>('');

  // ---------- Commit state ----------
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledgedOver, setAcknowledgedOver] = useState(false);
  const [acknowledgedReassignment, setAcknowledgedReassignment] = useState(false);
  const [showSelectionDetail, setShowSelectionDetail] = useState(false);

  // Reset the reassignment ack whenever the destination batch changes — the
  // affected-POs set depends on the destination, and we shouldn't carry an
  // ack across a destination change.
  useEffect(() => {
    setAcknowledgedReassignment(false);
  }, [batchMode, existingBatchId]);

  // Refresh the candidate cache whenever the visible page brings in fresh
  // principal data (e.g. after navigating). Keep the Map in sync so already-
  // selected rows reflect any updated current_principal_cents from server.
  useEffect(() => {
    if (selected.size === 0) return;
    setSelected((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const c of candidates) {
        const existing = next.get(c.id);
        if (existing && existing.current_principal_cents !== c.current_principal_cents) {
          next.set(c.id, c);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [candidates, selected.size]);

  // ---------- Aggregates from the SELECTION SET (across pages) ----------
  const selectedAsAdvanceInputs: SelectedPoForAdvance[] = useMemo(() => {
    return Array.from(selected.values()).map((c) => ({
      id: c.id,
      po_value_cents: cents(c.po_value_cents),
      current_principal_cents: cents(c.current_principal_cents),
    }));
  }, [selected]);

  const summary = useMemo(
    () => summarizeSelectedPos(selectedAsAdvanceInputs, poAdvanceRateBps ?? 0),
    [selectedAsAdvanceInputs, poAdvanceRateBps],
  );

  const requestedCents: Cents | null = useMemo(() => {
    if (amountMode === 'percent') {
      const pct = Number(percentInput);
      if (!Number.isFinite(pct) || pct <= 0) return null;
      const available = summary.total_borrowing_base_available_cents as number;
      const amount = Math.round((available * pct) / 100);
      if (amount <= 0) return null;
      return cents(amount);
    }
    const dollars = Number(fixedDollarsInput);
    if (!Number.isFinite(dollars) || dollars <= 0) return null;
    return cents(Math.round(dollars * 100));
  }, [amountMode, percentInput, fixedDollarsInput, summary]);

  const plan: PoAdvancePlan | { error: string } | null = useMemo(() => {
    if (selected.size === 0) return null;
    if (poAdvanceRateBps == null) return { error: 'No active rule set.' };
    if (requestedCents == null) return null;
    try {
      return planPoAdvance(requestedCents, selectedAsAdvanceInputs, poAdvanceRateBps);
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Allocation failed.' };
    }
  }, [selected.size, poAdvanceRateBps, requestedCents, selectedAsAdvanceInputs]);

  const allocationsValid = plan != null && !('error' in plan);

  // ---------- Detect cross-batch reassignment ----------
  // A reassignment happens when a selected PO is currently in a batch and
  // the destination batch is different. New batch destination → ANY non-null
  // current_batch_id triggers. Existing batch destination → any current
  // batch that isn't the chosen one triggers.
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
  function toggleOne(po: CandidatePo) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(po.id)) next.delete(po.id);
      else next.set(po.id, po);
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
    const filterPayload: FetchMatchingPosFilter = {
      q: currentFilters.q,
      retailer_slug: currentFilters.retailer,
      batch_id: currentFilters.batch,
      status: currentFilters.status,
      value_min_cents: currentFilters.value_min_cents,
      value_max_cents: currentFilters.value_max_cents,
    };
    const result = await fetchAllMatchingPoIdsAction(clientId, filterPayload);
    if (!result.ok) {
      setSelectAllError(result.error.message);
      setSelectAllBusy(false);
      return;
    }
    setSelected((prev) => {
      const next = new Map(prev);
      for (const c of result.data.pos) {
        // Server returns MatchingPoSummary which has the same shape as
        // CandidatePo, so we can store it directly.
        next.set(c.id, c as CandidatePo);
      }
      return next;
    });
    if (result.data.truncated) {
      setSelectAllNotice(
        `Selected ${result.data.pos.length.toLocaleString('en-US')} POs. The match set has ${result.data.totalCount.toLocaleString('en-US')} total — capped at ${result.data.pos.length.toLocaleString('en-US')} per request. Narrow the filter and retry to capture the rest.`,
      );
    } else {
      setSelectAllNotice(
        `Selected all ${result.data.pos.length.toLocaleString('en-US')} matches.`,
      );
    }
    setSelectAllBusy(false);
  }

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
    return `/clients/${clientId}/advances/po/new${qs ? `?${qs}` : ''}`;
  }

  function applyFilters(payload: {
    q: string;
    retailer: string;
    batch: string;
    status: string;
    valueMin: string;
    valueMax: string;
    pageSize: string;
  }) {
    // Filter changes reset to page 1 but keep sort.
    const overrides: Record<string, string | number | null> = {
      q: payload.q || null,
      retailer: payload.retailer || null,
      batch: payload.batch || null,
      status: payload.status || null,
      valueMin: payload.valueMin || null,
      valueMax: payload.valueMax || null,
      pageSize: payload.pageSize,
      page: 1,
    };
    router.push(buildHref(overrides));
  }

  function clearFilters() {
    router.push(`/clients/${clientId}/advances/po/new`);
  }

  // ---------- Commit ----------
  async function onCommit() {
    if (!allocationsValid || !plan || 'error' in plan) return;
    if (plan.any_over_advanced && !acknowledgedOver) {
      setError(
        'One or more POs would exceed 100% of their value. Tick the acknowledgement checkbox to proceed anyway.',
      );
      return;
    }
    if (batchMode === 'existing' && !existingBatchId) {
      setError('Pick an existing batch.');
      return;
    }
    if (reassignmentRequired && !acknowledgedReassignment) {
      setError(
        'One or more selected POs are currently assigned to a different batch. Tick the batch-reassignment acknowledgement to proceed.',
      );
      return;
    }

    setBusy(true);
    setError(null);
    const result = await commitPoAdvanceAction({
      client_id: clientId,
      advance_date: advanceDate,
      existing_batch_id: batchMode === 'existing' ? existingBatchId : null,
      new_batch: batchMode === 'new',
      new_batch_name: null,
      acknowledged_over_advanced: acknowledgedOver,
      acknowledged_batch_reassignment: acknowledgedReassignment,
      allocations: plan.lines
        .filter((l) => (l.newly_assigned_cents as number) > 0)
        .map((l) => ({
          purchase_order_id: l.po_id,
          principal_cents: l.newly_assigned_cents,
        })),
    });
    if (!result.ok) {
      setError(result.error.message);
      setBusy(false);
      return;
    }
    router.push(`/clients/${clientId}?advance_committed=${result.data.advance_count}`);
    router.refresh();
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / currentFilters.page_size));
  const firstShown = totalCount === 0 ? 0 : (currentFilters.page - 1) * currentFilters.page_size + 1;
  const lastShown = Math.min(currentFilters.page * currentFilters.page_size, totalCount);

  return (
    <div className="space-y-8">
      {/* ---------- Section 1: Select POs ---------- */}
      <section>
        <SectionHeader number={1} title="Select Purchase Orders" />

        <div className="mb-3">
          <CsvUpload
            clientId={clientId}
            onAddMatches={(rows: MatchingPoSummary[]) => {
              setSelected((prev) => {
                const next = new Map(prev);
                for (const r of rows) {
                  // MatchingPoSummary is shape-compatible with CandidatePo.
                  next.set(r.id, r as CandidatePo);
                }
                return next;
              });
            }}
          />
        </div>

        <FilterForm
          retailers={retailers}
          batches={batches}
          statuses={statuses}
          pageSizeOptions={pageSizeOptions}
          initial={currentFilters}
          onApply={applyFilters}
          onClear={clearFilters}
        />

        {/* Select-all-matches banner: visible whenever the filtered set is
            larger than what's on the current page. The 'select all in view'
            checkbox in the table header still works — this is the second
            affordance for multi-page selection. */}
        {totalCount > candidates.length && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
            <span className="text-seaking-muted">
              The current filter matches{' '}
              <strong className="text-seaking-ink">
                {totalCount.toLocaleString('en-US')}
              </strong>{' '}
              POs across all pages.
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

        <div className="mt-3 overflow-hidden rounded border border-seaking-border bg-seaking-surface">
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
                <SortHeader
                  label="PO #"
                  sortKey="po_number"
                  currentSort={currentFilters.sort}
                  currentDir={currentFilters.dir}
                  buildHref={buildHref}
                />
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
                  label="Issued"
                  sortKey="issuance_date"
                  currentSort={currentFilters.sort}
                  currentDir={currentFilters.dir}
                  buildHref={buildHref}
                />
                <SortHeader
                  label="Req. Delivery"
                  sortKey="delivery_date"
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
                <Th className="text-right">Current principal</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-seaking-border">
              {candidates.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-xs text-seaking-muted">
                    No POs match the current filters.
                  </td>
                </tr>
              )}
              {candidates.map((c) => (
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
                  <td className="px-3 py-2 font-mono text-xs">{c.po_number}</td>
                  <td className="px-3 py-2 text-xs">{c.retailer_display}</td>
                  <td className="px-3 py-2 text-xs">{humanStatus(c.status)}</td>
                  <td className="px-3 py-2 text-xs">
                    {c.current_batch_label ?? <span className="text-seaking-muted">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">{c.issuance_date ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{c.requested_delivery_date ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-xs">
                    {displayCents(c.po_value_cents)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {displayCents(c.current_principal_cents)}
                  </td>
                </tr>
              ))}
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

        {/* Selection summary always visible — count + cumulative metrics + clear */}
        {selected.size > 0 && (
          <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium text-seaking-navy">
                {selected.size.toLocaleString('en-US')} PO{selected.size === 1 ? '' : 's'} selected
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
              <Stat label="Total PO value" value={displayCents(summary.total_po_value_cents)} />
              <Stat
                label="Current principal"
                value={displayCents(summary.total_current_principal_cents)}
              />
              <Stat
                label="Borrowing base available"
                value={displayCents(summary.total_borrowing_base_available_cents)}
              />
              <Stat label="Aggregate ratio" value={formatBpsAsPercent(summary.aggregate_ratio_bps)} />
            </div>
            {showSelectionDetail && (
              <div className="mt-3 max-h-64 overflow-auto rounded border border-blue-200 bg-white">
                <table className="w-full text-xs">
                  <thead className="bg-seaking-bg text-[9px] uppercase tracking-wider text-seaking-muted">
                    <tr>
                      <th className="px-2 py-1.5 text-left">PO #</th>
                      <th className="px-2 py-1.5 text-left">Retailer</th>
                      <th className="px-2 py-1.5 text-right">PO value</th>
                      <th className="px-2 py-1.5 text-right">Current principal</th>
                      <th className="w-8 px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-blue-100">
                    {Array.from(selected.values()).map((c) => (
                      <tr key={c.id}>
                        <td className="px-2 py-1 font-mono">{c.po_number}</td>
                        <td className="px-2 py-1">{c.retailer_display}</td>
                        <td className="px-2 py-1 text-right">{displayCents(c.po_value_cents)}</td>
                        <td className="px-2 py-1 text-right">
                          {displayCents(c.current_principal_cents)}
                        </td>
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

      {/* ---------- Section 2: Configure ---------- */}
      <section className={selected.size === 0 ? 'pointer-events-none opacity-50' : ''}>
        <SectionHeader number={2} title="Configure" disabled={selected.size === 0} />
        <div className="rounded-lg border border-seaking-border bg-seaking-surface p-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Amount</label>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={amountMode === 'percent'}
                    onChange={() => setAmountMode('percent')}
                  />
                  <span>Percent of available</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={percentInput}
                    onChange={(e) => setPercentInput(e.target.value)}
                    onFocus={() => setAmountMode('percent')}
                    className="w-20 rounded border border-seaking-border px-2 py-1 text-sm outline-none focus:border-seaking-navy"
                  />
                  <span className="text-xs text-seaking-muted">%</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={amountMode === 'fixed'}
                    onChange={() => setAmountMode('fixed')}
                  />
                  <span>Fixed dollar amount</span>
                  <span className="text-xs text-seaking-muted">$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={fixedDollarsInput}
                    onChange={(e) => setFixedDollarsInput(e.target.value)}
                    onFocus={() => setAmountMode('fixed')}
                    className="w-32 rounded border border-seaking-border px-2 py-1 text-sm outline-none focus:border-seaking-navy"
                  />
                </label>
              </div>
              {requestedCents != null && (
                <p className="mt-2 text-xs text-seaking-muted">
                  Resolved request: <strong>{displayCents(requestedCents)}</strong>
                </p>
              )}
            </div>

            <div>
              <label htmlFor="advance_date" className="mb-1 block text-sm font-medium">
                Advance Date
              </label>
              <input
                id="advance_date"
                type="date"
                value={advanceDate}
                onChange={(e) => setAdvanceDate(e.target.value)}
                className="w-full rounded border border-seaking-border px-3 py-1.5 text-sm outline-none focus:border-seaking-navy"
              />
              <p className="mt-1 text-xs text-seaking-muted">
                Drives fee accrual. Should equal the wire date.
              </p>
            </div>

            <div>
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
                  Selected POs will be (re)assigned to this batch on commit.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- Section 3: Review ---------- */}
      <section className={!plan || selected.size === 0 ? 'pointer-events-none opacity-50' : ''}>
        <SectionHeader number={3} title="Review and commit" disabled={!plan || selected.size === 0} />
        {plan && 'error' in plan && (
          <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-seaking-danger">
            {plan.error}
            {plan.error.includes('capacity') &&
              ' Reduce the requested amount or add more POs to the selection.'}
          </div>
        )}
        {plan && !('error' in plan) && (
          <div className="rounded-lg border border-seaking-border bg-seaking-surface p-4">
            <div className="overflow-hidden rounded border border-seaking-border">
              <table className="w-full text-sm">
                <thead className="bg-seaking-bg text-[10px] uppercase tracking-wider text-seaking-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">PO #</th>
                    <th className="px-3 py-2 text-right">PO value</th>
                    <th className="px-3 py-2 text-right">Current principal</th>
                    <th className="px-3 py-2 text-right">Current ratio</th>
                    <th className="px-3 py-2 text-right">Newly assigned</th>
                    <th className="px-3 py-2 text-right">Pro forma principal</th>
                    <th className="px-3 py-2 text-right">Pro forma ratio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-seaking-border">
                  {plan.lines.map((line) => {
                    const po = selected.get(line.po_id);
                    return (
                      <tr key={line.po_id} className={line.pro_forma_over_advanced ? 'bg-red-50' : ''}>
                        <td className="px-3 py-2 font-mono text-xs">
                          {po?.po_number ?? line.po_id}
                        </td>
                        <td className="px-3 py-2 text-right text-xs">
                          {displayCents(line.po_value_cents)}
                        </td>
                        <td className="px-3 py-2 text-right text-xs">
                          {displayCents(line.current_principal_cents)}
                        </td>
                        <td className="px-3 py-2 text-right text-xs">
                          {formatBpsAsPercent(line.current_ratio_bps)}
                        </td>
                        <td className="px-3 py-2 text-right text-xs font-medium">
                          {displayCents(line.newly_assigned_cents)}
                        </td>
                        <td className="px-3 py-2 text-right text-xs">
                          {displayCents(line.pro_forma_principal_cents)}
                        </td>
                        <td
                          className={
                            line.pro_forma_over_advanced
                              ? 'px-3 py-2 text-right text-xs font-semibold text-seaking-danger'
                              : 'px-3 py-2 text-right text-xs'
                          }
                        >
                          {formatBpsAsPercent(line.pro_forma_ratio_bps)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-seaking-bg text-xs font-semibold">
                  <tr>
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 py-2 text-right">
                      {displayCents(summary.total_po_value_cents)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {displayCents(summary.total_current_principal_cents)}
                    </td>
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2 text-right">{displayCents(plan.total_cents)}</td>
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2"></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {plan.any_over_advanced && (
              <label className="mt-3 flex items-center gap-2 rounded bg-red-50 p-3 text-sm text-seaking-danger">
                <input
                  type="checkbox"
                  checked={acknowledgedOver}
                  onChange={(e) => setAcknowledgedOver(e.target.checked)}
                  className="h-4 w-4"
                />
                <span>
                  I acknowledge that one or more POs will exceed 100% of their value after this
                  advance. They will move to <em>Advances in Bad Standing</em> for remediation.
                </span>
              </label>
            )}

            {reassignmentRequired && (
              <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-semibold">
                  Warning: {affectedReassignments.length} PO
                  {affectedReassignments.length === 1 ? ' is' : 's are'} currently assigned to a
                  different batch.
                </p>
                <p className="mt-1 text-xs">
                  Submitting this transaction will shift these POs — and all of their existing
                  advances — to the destination batch. Each PO can belong to only one batch at
                  a time. Would you still like to proceed?
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
                          {' '}
                          — {r.from_batch_label} → {r.to_batch_label}
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
                disabled={busy || !allocationsValid}
                className="rounded bg-seaking-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-seaking-navy-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy
                  ? 'Committing…'
                  : `Commit ${displayCents(plan.total_cents)} across ${plan.lines.filter((l) => (l.newly_assigned_cents as number) > 0).length} PO(s)`}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function FilterForm({
  retailers,
  batches,
  statuses,
  pageSizeOptions,
  initial,
  onApply,
  onClear,
}: {
  retailers: RetailerOption[];
  batches: BatchOption[];
  statuses: StatusOption[];
  pageSizeOptions: number[];
  initial: CurrentFilters;
  onApply: (payload: {
    q: string;
    retailer: string;
    batch: string;
    status: string;
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
        onApply({ q, retailer, batch, status, valueMin, valueMax, pageSize });
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
            <option value="">Any eligible (active / partial / closed-awaiting)</option>
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
    : sortKey === 'value' || sortKey === 'issuance_date' || sortKey === 'delivery_date'
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

function todayInNyIso(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}
