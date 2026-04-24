'use client';

import { displayCents } from '@seaking/ui';
import type { PoUploadPreview, RetailerSlug } from '@seaking/validators';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { commitPoUploadAction, parsePoUploadAction } from './actions';

type Phase = 'choose' | 'previewing' | 'review' | 'committing' | 'done';

interface CommitSummary {
  upload_id: string;
  inserted: number;
  updated: number;
  skipped: number;
  lines_replaced: number;
  lines_inserted: number;
}

export function UploadPoForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('choose');
  const [retailer, setRetailer] = useState<RetailerSlug>('walmart');
  const [file, setFile] = useState<File | null>(null);
  const [skipDuplicates, setSkipDuplicates] = useState(false);
  const [preview, setPreview] = useState<PoUploadPreview | null>(null);
  const [commitResult, setCommitResult] = useState<CommitSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  function resetToChoose() {
    setPhase('choose');
    setPreview(null);
    setCommitResult(null);
    setError(null);
  }

  async function onPreview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file) {
      setError('Pick a file first.');
      return;
    }
    setError(null);
    setPhase('previewing');

    const fd = new FormData();
    fd.set('client_id', clientId);
    fd.set('retailer_slug', retailer);
    fd.set('skip_duplicates', String(skipDuplicates));
    fd.set('file', file);

    const result = await parsePoUploadAction(fd);
    if (!result.ok) {
      setError(result.error.message);
      setPhase('choose');
      return;
    }
    setPreview(result.data);
    setPhase('review');
  }

  async function onCommit() {
    if (!file || !preview) return;
    setError(null);
    setPhase('committing');

    const fd = new FormData();
    fd.set('client_id', clientId);
    fd.set('retailer_slug', retailer);
    fd.set('skip_duplicates', String(skipDuplicates));
    fd.set('file', file);

    const result = await commitPoUploadAction(fd);
    if (!result.ok) {
      setError(result.error.message);
      setPhase('review');
      return;
    }
    setCommitResult(result.data);
    setPhase('done');
    router.refresh();
  }

  if (phase === 'done' && commitResult) {
    return (
      <CommitDoneView
        result={commitResult}
        onUploadAnother={resetToChoose}
        onBackToClient={() => router.push(`/clients/${clientId}`)}
      />
    );
  }

  if ((phase === 'review' || phase === 'committing') && preview) {
    return (
      <ReviewView
        preview={preview}
        skipDuplicates={skipDuplicates}
        setSkipDuplicates={setSkipDuplicates}
        committing={phase === 'committing'}
        error={error}
        onCommit={onCommit}
        onCancel={resetToChoose}
      />
    );
  }

  return (
    <form onSubmit={onPreview} className="space-y-5">
      <div>
        <label htmlFor="retailer" className="mb-1 block text-sm font-medium">
          Retailer
        </label>
        <select
          id="retailer"
          value={retailer}
          onChange={(e) => setRetailer(e.target.value as RetailerSlug)}
          className="w-full rounded border border-seaking-border bg-white px-3 py-2 text-sm outline-none focus:border-seaking-navy"
        >
          <option value="walmart">Walmart (SupplierOne)</option>
          <option value="kroger">Kroger</option>
          <option value="generic">Generic CSV template</option>
        </select>
      </div>

      <div>
        <label htmlFor="file" className="mb-1 block text-sm font-medium">
          File
        </label>
        <input
          id="file"
          type="file"
          accept=".csv,text/csv"
          required
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full rounded border border-seaking-border bg-white px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-seaking-muted">CSV only for Phase 1. XLSX support lands in 1E with the invoice parsers.</p>
      </div>

      {error && (
        <div className="rounded bg-red-50 p-3 text-sm text-seaking-danger" role="alert">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push(`/clients/${clientId}`)}
          className="rounded border border-seaking-border bg-white px-4 py-2 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={phase === 'previewing' || !file}
          className="rounded bg-seaking-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-seaking-navy-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === 'previewing' ? 'Parsing…' : 'Preview'}
        </button>
      </div>
    </form>
  );
}

// ---------- Review view ----------

function ReviewView({
  preview,
  skipDuplicates,
  setSkipDuplicates,
  committing,
  error,
  onCommit,
  onCancel,
}: {
  preview: PoUploadPreview;
  skipDuplicates: boolean;
  setSkipDuplicates: (v: boolean) => void;
  committing: boolean;
  error: string | null;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-seaking-muted">
          Summary
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="New POs" value={preview.rows_to_add} />
          <Stat label="Existing (will update)" value={preview.rows_to_update} />
          <Stat label="New PO value" value={displayCents(preview.new_po_value_cents)} />
          <Stat label="Cancelled in file" value={preview.rows_cancelled} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Rows read" value={preview.total_rows_read} muted />
          <Stat label="Line-level rows" value={preview.line_rows} muted />
          <Stat label="Rows skipped" value={preview.rows_skipped} muted />
          <Stat label="Warnings" value={preview.warnings.length} muted />
        </div>
        <p className="mt-2 text-xs text-seaking-muted">
          Parser: <code>{preview.parser_version}</code>
        </p>
      </section>

      <section>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="radio"
            checked={!skipDuplicates}
            onChange={() => setSkipDuplicates(false)}
            className="h-4 w-4"
          />
          <span>
            <strong>Overwrite existing POs</strong> — incoming file wins (default).
          </span>
        </label>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="radio"
            checked={skipDuplicates}
            onChange={() => setSkipDuplicates(true)}
            className="h-4 w-4"
          />
          <span>
            <strong>Skip duplicates</strong> — keep existing values, only insert new POs.
          </span>
        </label>
      </section>

      {preview.sample_rows.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-seaking-muted">
            Sample rows ({preview.sample_rows.length} of {preview.rows_to_add + preview.rows_to_update})
          </h2>
          <div className="overflow-hidden rounded border border-seaking-border">
            <table className="w-full text-xs">
              <thead className="bg-seaking-bg text-[10px] uppercase tracking-wider text-seaking-muted">
                <tr>
                  <th className="px-3 py-1.5 text-left">PO #</th>
                  <th className="px-3 py-1.5 text-right">Value</th>
                  <th className="px-3 py-1.5 text-left">Status</th>
                  <th className="px-3 py-1.5 text-left">Issued</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-seaking-border">
                {preview.sample_rows.map((r) => (
                  <tr key={r.po_number}>
                    <td className="px-3 py-1.5 font-mono">{r.po_number}</td>
                    <td className="px-3 py-1.5 text-right">{displayCents(r.po_value_cents)}</td>
                    <td className="px-3 py-1.5">{r.status}</td>
                    <td className="px-3 py-1.5">{r.issuance_date ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {preview.warnings.length > 0 && (
        <Disclosure title={`Warnings (${preview.warnings.length})`} tone="amber">
          <ul className="divide-y divide-amber-200">
            {preview.warnings.map((w, i) => (
              <li key={i} className="py-1.5 text-xs">
                <code className="text-amber-700">{w.code}</code>{' '}
                {w.row_index !== undefined && (
                  <span className="text-seaking-muted">(row {w.row_index})</span>
                )}
                <div>{w.message}</div>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      {preview.skipped.length > 0 && (
        <Disclosure title={`Skipped rows (${preview.skipped.length})`} tone="red">
          <ul className="divide-y divide-red-200">
            {preview.skipped.map((s, i) => (
              <li key={i} className="py-1.5 text-xs">
                Row {s.row_index}: <code>{s.reason}</code>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      {error && (
        <div className="rounded bg-red-50 p-3 text-sm text-seaking-danger" role="alert">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-seaking-border pt-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={committing}
          className="rounded border border-seaking-border bg-white px-4 py-2 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={committing || (preview.rows_to_add === 0 && preview.rows_to_update === 0)}
          className="rounded bg-seaking-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-seaking-navy-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {committing ? 'Committing…' : `Commit ${preview.rows_to_add + preview.rows_to_update} POs`}
        </button>
      </div>
    </div>
  );
}

// ---------- Commit-done view ----------

function CommitDoneView({
  result,
  onUploadAnother,
  onBackToClient,
}: {
  result: CommitSummary;
  onUploadAnother: () => void;
  onBackToClient: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="rounded bg-emerald-50 p-4 text-sm text-seaking-success" role="status">
        Upload committed successfully.
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Inserted" value={result.inserted} />
        <Stat label="Updated" value={result.updated} />
        <Stat label="Skipped" value={result.skipped} />
        <Stat label="Lines replaced" value={result.lines_replaced} muted />
        <Stat label="Lines inserted" value={result.lines_inserted} muted />
      </div>
      <div className="flex justify-end gap-2 border-t border-seaking-border pt-4">
        <button
          type="button"
          onClick={onUploadAnother}
          className="rounded border border-seaking-border bg-white px-4 py-2 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg"
        >
          Upload another
        </button>
        <button
          type="button"
          onClick={onBackToClient}
          className="rounded bg-seaking-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-seaking-navy-hover"
        >
          Back to Client
        </button>
      </div>
    </div>
  );
}

// ---------- Small presentational helpers ----------

function Stat({
  label,
  value,
  muted,
}: {
  label: string;
  value: string | number;
  muted?: boolean;
}) {
  return (
    <div
      className={
        muted
          ? 'rounded border border-seaking-border bg-seaking-bg p-3'
          : 'rounded border border-seaking-border bg-seaking-surface p-3'
      }
    >
      <div className="text-[10px] uppercase tracking-wider text-seaking-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function Disclosure({
  title,
  tone,
  children,
}: {
  title: string;
  tone: 'amber' | 'red';
  children: React.ReactNode;
}) {
  const cls =
    tone === 'amber'
      ? 'border-amber-200 bg-amber-50'
      : 'border-red-200 bg-red-50';
  return (
    <details className={`rounded border ${cls} p-3`}>
      <summary className="cursor-pointer text-sm font-medium">{title}</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
