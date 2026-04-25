/**
 * Dashboard metrics — renders the spec's 13-metric "Main Interface" block.
 *
 * This is a presentational component. The data comes from
 * `loadClientPosition` in apps/manager/src/lib/dashboard-metrics.ts and is
 * passed in via props. Rendering is grouped by underlying concept:
 *
 *   1. Purchase Order side — value, principal, ratio, BB available
 *   2. Accounts Receivable side — value, principal, ratio, BB available
 *   3. Pre-Advance — principal, BB available
 *   4. Cross-cutting — fees, remittance payable, over-advanced flag
 *
 * Phase 1D commit 5: AR-side and pre-advance numbers will all read $0 today
 * because no invoices have been ingested yet (1E) and pre-advance creation
 * isn't built. The cards still render so the layout is stable when those
 * paths come online.
 */

import { displayCents } from '@seaking/ui';
import {
  poBorrowingRatioBps,
  arBorrowingRatioBps,
  type ClientPositionMetrics,
} from '@/lib/dashboard-metrics';

const fmtPercent = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

interface Props {
  data: ClientPositionMetrics;
}

export function DashboardMetrics({ data }: Props) {
  const poRatio = poBorrowingRatioBps(
    data.po_principal_outstanding_cents,
    data.active_po_value_cents,
  );
  const arRatio = arBorrowingRatioBps(
    data.ar_principal_outstanding_cents,
    data.eligible_ar_value_cents,
  );

  return (
    <div className="space-y-4">
      {/* Over-Advanced banner — Client-level flag per spec, surfaces above
          the metric grid regardless of the batch filter. */}
      {data.is_over_advanced && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-seaking-danger">
          <p className="font-semibold">Over Advanced</p>
          <p className="mt-1">
            This Client&rsquo;s total principal outstanding exceeds the total borrowing base by{' '}
            <strong>
              {displayCents(data.total_principal_over_borrowing_base_cents)}
            </strong>
            . New advances are blocked until the position cures.
          </p>
        </div>
      )}

      {/* PO side */}
      <MetricGroup label="Purchase Orders">
        <Metric
          label="Outstanding PO Value (Non-Invoiced)"
          value={displayCents(data.active_po_value_cents)}
          tone="neutral"
        />
        <Metric
          label="Outstanding PO Advances"
          value={displayCents(data.po_principal_outstanding_cents)}
          tone="neutral"
        />
        <Metric
          label="Current PO Borrowing Ratio"
          value={fmtPercent(poRatio)}
          tone={poRatio === 0 ? 'muted' : 'neutral'}
        />
        <Metric
          label="PO Borrowing Base Available"
          value={displayCents(data.po_borrowing_base_available_cents)}
          tone={data.po_borrowing_base_available_cents > 0 ? 'positive' : 'muted'}
        />
      </MetricGroup>

      {/* AR side */}
      <MetricGroup label="Accounts Receivable">
        <Metric
          label="Outstanding AR Value"
          value={displayCents(data.eligible_ar_value_cents)}
          tone="neutral"
        />
        <Metric
          label="Outstanding AR Advances"
          value={displayCents(data.ar_principal_outstanding_cents)}
          tone="neutral"
        />
        <Metric
          label="Current AR Borrowing Ratio"
          value={fmtPercent(arRatio)}
          tone={arRatio === 0 ? 'muted' : 'neutral'}
        />
        <Metric
          label="AR Borrowing Base Available"
          value={displayCents(data.ar_borrowing_base_available_cents)}
          tone={data.ar_borrowing_base_available_cents > 0 ? 'positive' : 'muted'}
        />
      </MetricGroup>

      {/* Pre-Advance + cross-cutting */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MetricGroup label="Pre-Advance on AR">
          <Metric
            label="Pre-Advance Principal Outstanding"
            value={displayCents(data.pre_advance_principal_outstanding_cents)}
            tone="neutral"
          />
          <Metric
            label="Pre-Advance BB Available"
            value={displayCents(data.pre_advance_borrowing_base_available_cents)}
            tone={data.pre_advance_borrowing_base_available_cents > 0 ? 'positive' : 'muted'}
          />
        </MetricGroup>
        <MetricGroup label="Other">
          <Metric
            label="Total Outstanding Fees"
            value={displayCents(data.total_fees_outstanding_cents)}
            tone={data.total_fees_outstanding_cents > 0 ? 'warning' : 'muted'}
          />
          <Metric
            label="Remittance Payable"
            value={displayCents(data.remittance_balance_cents)}
            tone={data.remittance_balance_cents > 0 ? 'positive' : 'muted'}
          />
        </MetricGroup>
      </div>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function MetricGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-seaking-muted">
        {label}
      </h3>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'neutral' | 'positive' | 'warning' | 'muted';
}) {
  const valueClass =
    tone === 'positive'
      ? 'text-seaking-success'
      : tone === 'warning'
        ? 'text-amber-700'
        : tone === 'muted'
          ? 'text-seaking-muted'
          : 'text-seaking-ink';
  return (
    <div className="rounded-lg border border-seaking-border bg-seaking-surface p-3">
      <div className="text-[10px] uppercase tracking-wider text-seaking-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
