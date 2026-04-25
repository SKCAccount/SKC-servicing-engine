'use client';

/**
 * Batch filter dropdown for the per-Client dashboard.
 *
 * URL-driven: changing the selection pushes ?batch=<id> (or removes it for
 * "All Batches"). Server component re-renders with the new metrics. Same
 * pattern as the list-page filters, but compact since this is the only
 * filter on this page.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

interface BatchOption {
  id: string;
  label: string;
}

interface Props {
  batches: BatchOption[];
  currentBatchId: string | null;
}

export function DashboardBatchFilter({ batches, currentBatchId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  function onChange(value: string) {
    const params = new URLSearchParams(sp.toString());
    if (value === '') params.delete('batch');
    else params.set('batch', value);
    const qs = params.toString();
    router.push(`${pathname}${qs ? `?${qs}` : ''}`);
  }

  return (
    <label className="flex items-center gap-2 text-xs text-seaking-muted">
      <span className="font-medium uppercase tracking-wider">Filter by batch:</span>
      <select
        value={currentBatchId ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-seaking-border bg-white px-3 py-1 text-sm text-seaking-ink outline-none focus:border-seaking-navy"
      >
        <option value="">All batches</option>
        {batches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label}
          </option>
        ))}
      </select>
    </label>
  );
}
