'use client';

/**
 * Advance-on-POs multi-step form.
 *
 * Three sections rendered top-to-bottom on a single page (no route hops):
 *
 *   1. Select POs (checkbox table with simple search)
 *   2. Configure (advance amount as % of available OR fixed $; advance date;
 *      batch — existing or new)
 *   3. Review (per-PO allocation from planPoAdvance, totals, Commit/Cancel)
 *
 * Allocation runs entirely client-side using @seaking/domain.planPoAdvance.
 * Server validates each line via the commit_po_advance RPC.
 *
 * State approach: plain useState. Selection lives in a Set<id>. Allocation
 * is recomputed via useMemo whenever the inputs change. No React Query / no
 * URL state — this is a single-session workflow that doesn't benefit from
 * deep-linking.
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
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { commitPoAdvanceAction } from './actions';

interface CandidatePo {
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
}

interface BatchOption {
  id: string;
  label: string;
}

interface Props {
  clientId: string;
  poAdvanceRateBps: number | null;
  batches: BatchOption[];
  candidates: CandidatePo[];
}

type AmountMode = 'percent' | 'fixed';
type BatchMode = 'new' | 'existing';

export function AdvanceOnPosForm({
  clientId,
  poAdvanceRateBps,
  batches,
  candidates,
}: Props) {
  const router = useRouter();

  // ---------- Selection state ----------
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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

  // ---------- Derived ----------
  const filteredCandidates = useMemo(() => {
    if (!search.trim()) return candidates;
    const needle = search.trim().toLowerCase();
    return candidates.filter(
      (c) =>
        c.po_number.toLowerCase().includes(needle) ||
        c.retailer_display.toLowerCase().includes(needle),
    );
  }, [candidates, search]);

  const selectedPos: SelectedPoForAdvance[] = useMemo(() => {
    return candidates
      .filter((c) => selectedIds.has(c.id))
      .map((c) => ({
        id: c.id,
        po_value_cents: cents(c.po_value_cents),
        current_principal_cents: cents(c.current_principal_cents),
      }));
  }, [candidates, selectedIds]);

  const summary = useMemo(
    () => summarizeSelectedPos(selectedPos, poAdvanceRateBps ?? 0),
    [selectedPos, poAdvanceRateBps],
  );

  /**
   * Resolve the requested advance amount in cents from whichever input mode
   * the user chose. Returns null when input is invalid (UI shows nothing
   * downstream).
   */
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

  /** Plan the allocation only when we have a valid amount + selection + rate. */
  const plan: PoAdvancePlan | { error: string } | null = useMemo(() => {
    if (selectedPos.length === 0) return null;
    if (poAdvanceRateBps == null) return { error: 'No active rule set.' };
    if (requestedCents == null) return null;
    try {
      return planPoAdvance(requestedCents, selectedPos, poAdvanceRateBps);
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Allocation failed.' };
    }
  }, [selectedPos, poAdvanceRateBps, requestedCents]);

  const allocationsValid = plan != null && !('error' in plan);

  // ---------- Selection helpers ----------
  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllInView() {
    const allInViewIds = filteredCandidates.map((c) => c.id);
    const allSelected = allInViewIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of allInViewIds) next.delete(id);
      } else {
        for (const id of allInViewIds) next.add(id);
      }
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  // ---------- Commit ----------
  async function onCommit() {
    if (!allocationsValid || !plan || 'error' in plan) return;
    if (plan.any_over_advanced && !acknowledgedOver) {
      setError('One or more POs would exceed 100% of their value. Tick the acknowledgement checkbox to proceed anyway.');
      return;
    }
    if (batchMode === 'existing' && !existingBatchId) {
      setError('Pick an existing batch.');
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

  return (
    <div className="space-y-8">
      {/* ---------- Section 1: Select POs ---------- */}
      <section>
        <SectionHeader number={1} title="Select Purchase Orders" />
        <div className="rounded-lg border border-seaking-border bg-seaking-surface p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <input
              type="search"
              placeholder="Filter by PO # or retailer…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-72 rounded border border-seaking-border px-3 py-1.5 text-sm outline-none focus:border-seaking-navy"
            />
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={toggleAllInView}
                className="rounded border border-seaking-border bg-white px-2 py-1 text-xs hover:bg-seaking-bg"
              >
                {filteredCandidates.every((c) => selectedIds.has(c.id))
                  ? 'Deselect all in view'
                  : 'Select all in view'}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="rounded border border-seaking-border bg-white px-2 py-1 text-xs hover:bg-seaking-bg"
                disabled={selectedIds.size === 0}
              >
                Clear ({selectedIds.size})
              </button>
            </div>
          </div>

          <div className="max-h-96 overflow-auto rounded border border-seaking-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-seaking-bg text-[10px] uppercase tracking-wider text-seaking-muted">
                <tr>
                  <th className="w-8 px-3 py-2"></th>
                  <th className="px-3 py-2 text-left">PO #</th>
                  <th className="px-3 py-2 text-left">Retailer</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Batch</th>
                  <th className="px-3 py-2 text-right">PO value</th>
                  <th className="px-3 py-2 text-right">Current principal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-seaking-border">
                {filteredCandidates.map((c) => (
                  <tr
                    key={c.id}
                    className={
                      selectedIds.has(c.id) ? 'bg-blue-50' : 'hover:bg-seaking-bg'
                    }
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => toggleOne(c.id)}
                        className="h-4 w-4"
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{c.po_number}</td>
                    <td className="px-3 py-2 text-xs">{c.retailer_display}</td>
                    <td className="px-3 py-2 text-xs">{c.status}</td>
                    <td className="px-3 py-2 text-xs">
                      {c.current_batch_label ?? <span className="text-seaking-muted">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-xs">{displayCents(c.po_value_cents)}</td>
                    <td className="px-3 py-2 text-right text-xs">
                      {displayCents(c.current_principal_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-2 text-xs text-seaking-muted">
            Showing {filteredCandidates.length.toLocaleString('en-US')} of{' '}
            {candidates.length.toLocaleString('en-US')} eligible POs.
          </p>
        </div>

        {selectedIds.size > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Selected" value={selectedIds.size.toString()} />
            <Stat label="Total PO value" value={displayCents(summary.total_po_value_cents)} />
            <Stat label="Current principal" value={displayCents(summary.total_current_principal_cents)} />
            <Stat label="Borrowing base available" value={displayCents(summary.total_borrowing_base_available_cents)} />
            <Stat label="Aggregate ratio" value={formatBpsAsPercent(summary.aggregate_ratio_bps)} />
          </div>
        )}
      </section>

      {/* ---------- Section 2: Configure ---------- */}
      <section className={selectedIds.size === 0 ? 'opacity-50 pointer-events-none' : ''}>
        <SectionHeader number={2} title="Configure" disabled={selectedIds.size === 0} />
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
      <section className={!plan || selectedIds.size === 0 ? 'opacity-50 pointer-events-none' : ''}>
        <SectionHeader
          number={3}
          title="Review and commit"
          disabled={!plan || selectedIds.size === 0}
        />
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
                    const po = candidates.find((c) => c.id === line.po_id);
                    return (
                      <tr
                        key={line.po_id}
                        className={line.pro_forma_over_advanced ? 'bg-red-50' : ''}
                      >
                        <td className="px-3 py-2 font-mono text-xs">{po?.po_number ?? line.po_id}</td>
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

            {error && (
              <div className="mt-3 rounded bg-red-50 p-3 text-sm text-seaking-danger" role="alert">
                {error}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => router.push(`/clients/${clientId}`)}
                disabled={busy}
                className="rounded border border-seaking-border bg-white px-4 py-2 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg disabled:opacity-50"
              >
                Cancel
              </button>
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
      <h2 className="text-sm font-semibold uppercase tracking-wider text-seaking-muted">
        {title}
      </h2>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-seaking-border bg-seaking-surface p-3">
      <div className="text-[10px] uppercase tracking-wider text-seaking-muted">{label}</div>
      <div className="mt-1 text-base font-semibold">{value}</div>
    </div>
  );
}

/** Today's date in America/New_York as ISO YYYY-MM-DD. */
function todayInNyIso(): string {
  // Use Intl.DateTimeFormat for tz-correct day boundaries without pulling in
  // Temporal in client code.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}
