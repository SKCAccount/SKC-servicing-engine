'use client';

/**
 * CSV-of-PO-numbers secondary entry path.
 *
 * Spec: §"Advancing Purchase Orders" → Secondary Option. Manager (or
 * Client, in their portal) uploads a two-column CSV listing the POs they
 * want to advance against. We parse it, match against eligible POs, hand
 * the matched rows back to the parent so they get added to the selection
 * Map, and surface unmatched rows with an "Export unmatched as CSV" button.
 *
 * This component is intentionally self-contained — it reports its result
 * via a callback rather than mutating shared state directly. The parent
 * (advance-on-pos-form.tsx) decides what to do with the matches.
 */

import Link from 'next/link';
import { useState, useRef } from 'react';
import {
  matchPosFromCsvAction,
  type MatchingPoSummary,
  type MatchPosCsvUnmatchedRow,
} from './actions';

interface Props {
  clientId: string;
  /** Called with the matched rows when the user clicks "Add matches to selection." */
  onAddMatches: (rows: MatchingPoSummary[]) => void;
}

export function CsvUpload({ clientId, onAddMatches }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    matched: MatchingPoSummary[];
    unmatched: MatchPosCsvUnmatchedRow[];
    skipped: Array<{ row_index: number; reason: string }>;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError('Could not read the selected file.');
      setBusy(false);
      return;
    }
    const r = await matchPosFromCsvAction(clientId, text);
    if (!r.ok) {
      setError(r.error.message);
      setBusy(false);
      return;
    }
    setResult(r.data);
    setBusy(false);
    setExpanded(true);
  }

  function reset() {
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function downloadUnmatchedCsv() {
    if (!result || result.unmatched.length === 0) return;
    const lines = ['Purchase Order Number,Retailer,Reason'];
    for (const u of result.unmatched) {
      const reasonText =
        u.reason === 'retailer_not_found'
          ? 'Retailer not registered for this Client'
          : u.reason === 'po_not_found'
            ? 'PO number does not exist'
            : `PO not eligible (status: ${u.status ?? 'unknown'})`;
      // Quote the retailer cell since it may contain commas; CSV-escape
      // any embedded quotes by doubling them.
      const escapedRetailer = `"${u.retailer_input.replace(/"/g, '""')}"`;
      const escapedReason = `"${reasonText.replace(/"/g, '""')}"`;
      lines.push(`${u.po_number},${escapedRetailer},${escapedReason}`);
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'unmatched-pos.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-lg border border-seaking-border bg-seaking-surface p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">Or upload a list of POs</p>
          <p className="mt-0.5 text-xs text-seaking-muted">
            CSV with two columns: <code className="font-mono">Purchase Order Number</code>,{' '}
            <code className="font-mono">Retailer</code>. Useful when a Client sends you the list
            of POs they want advanced.
          </p>
        </div>
        <Link
          href="/api/advance-template/po-numbers"
          className="rounded border border-seaking-border bg-white px-3 py-1.5 text-xs font-medium text-seaking-ink transition hover:bg-seaking-bg"
        >
          Download template
        </Link>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label
          className={
            busy
              ? 'inline-flex cursor-not-allowed items-center gap-2 rounded border border-seaking-border bg-seaking-bg px-3 py-1.5 text-xs font-medium text-seaking-muted'
              : 'inline-flex cursor-pointer items-center gap-2 rounded border border-seaking-border bg-white px-3 py-1.5 text-xs font-medium text-seaking-ink hover:bg-seaking-bg'
          }
        >
          {busy ? 'Reading…' : 'Choose CSV file'}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            disabled={busy}
            className="hidden"
          />
        </label>
        {result && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-seaking-muted hover:text-seaking-ink hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-seaking-danger" role="alert">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 rounded border border-seaking-border bg-white p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-x-3">
              <span className="text-seaking-muted">
                <strong className="text-seaking-success">{result.matched.length}</strong>{' '}
                matched
              </span>
              <span className="text-seaking-muted">
                <strong className={result.unmatched.length > 0 ? 'text-seaking-danger' : ''}>
                  {result.unmatched.length}
                </strong>{' '}
                unmatched
              </span>
              {result.skipped.length > 0 && (
                <span className="text-seaking-muted">
                  <strong>{result.skipped.length}</strong> skipped
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-seaking-muted hover:text-seaking-ink hover:underline"
            >
              {expanded ? 'Hide details' : 'Show details'}
            </button>
          </div>

          {expanded && (
            <div className="mt-3 space-y-3">
              {result.unmatched.length > 0 && (
                <div className="rounded border border-amber-200 bg-amber-50 p-2">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-amber-900">Unmatched rows</p>
                    <button
                      type="button"
                      onClick={downloadUnmatchedCsv}
                      className="rounded border border-amber-300 bg-white px-2 py-1 text-[10px] font-medium text-seaking-ink hover:bg-amber-100"
                    >
                      Export as CSV
                    </button>
                  </div>
                  <ul className="mt-2 max-h-40 overflow-auto rounded border border-amber-200 bg-white p-2">
                    {result.unmatched.map((u, i) => (
                      <li key={i} className="py-0.5 font-mono text-[11px]">
                        <strong>{u.po_number}</strong>{' '}
                        <span className="text-seaking-muted">/ {u.retailer_input}</span>
                        <span className="ml-1 text-seaking-danger">
                          —{' '}
                          {u.reason === 'retailer_not_found'
                            ? 'retailer not registered'
                            : u.reason === 'po_not_found'
                              ? 'PO number not on file'
                              : `PO not eligible (status: ${u.status ?? 'unknown'})`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.skipped.length > 0 && (
                <div className="rounded border border-seaking-border bg-seaking-bg p-2 text-seaking-muted">
                  <p className="font-semibold">Skipped rows</p>
                  <ul className="mt-1 list-disc pl-5">
                    {result.skipped.map((s, i) => (
                      <li key={i}>
                        Row {s.row_index}: {s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.matched.length > 0 && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => onAddMatches(result.matched)}
                    className="rounded bg-seaking-navy px-3 py-1.5 text-xs font-medium text-white transition hover:bg-seaking-navy-hover"
                  >
                    Add {result.matched.length} matched PO
                    {result.matched.length === 1 ? '' : 's'} to selection
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
