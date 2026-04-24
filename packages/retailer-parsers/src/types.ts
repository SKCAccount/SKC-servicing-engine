/**
 * Shared types for all retailer parsers.
 *
 * Every parser is a pure function: bytes/string in, ParseResult out. No I/O,
 * no DB calls, no HTTP. The upload handler is responsible for persistence.
 * This keeps parsers trivially testable and cheap to re-run during the
 * "review before commit" step of the upload flow.
 *
 * File-type strategy: the parse() functions accept either a string (already
 * read to memory) OR a Buffer/Uint8Array/ArrayBuffer (raw bytes). They
 * normalize internally so the upload handler can pass whatever Next.js /
 * Supabase Storage returned without pre-processing.
 */

import type { Cents } from '@seaking/money';

/** Context provided by the upload handler to every parser call. */
export interface ParseContext {
  /** The Client this upload belongs to. Persisted on every ingested row. */
  client_id: string;
  /** Resolved retailer — set by the upload handler, not the parser. */
  retailer_id: string;
  /** Authenticated user performing the upload. */
  uploaded_by_user_id: string;
  /** The *_uploads row ID created before the parser runs. Rows link back via upload_id. */
  upload_id: string;
}

/** Non-fatal parser issue surfaced to the Manager in the upload review UI. */
export interface ParseWarning {
  /** Optional row index (0-based after the header) if row-specific. */
  row_index?: number;
  /** Short machine-readable code, e.g. 'date_anomaly', 'unknown_status'. */
  code: string;
  /** Human-readable explanation. */
  message: string;
  /** Optional raw cell context for debugging. */
  context?: Record<string, string | number | null>;
}

/** Row the parser deliberately dropped. Shown to the Manager for audit. */
export interface SkippedRow {
  row_index: number;
  reason: string;
  raw?: Record<string, string | number | null>;
}

/** Walmart PO cancellation parsing outputs these enum-matched values. */
export type CancellationReason =
  | 'shortage'
  | 'quality'
  | 'retailer_cancelled'
  | 'client_request'
  | 'other';

/** Purchase-order status normalized across retailers (matches po_status enum). */
export type PoStatus =
  | 'active'
  | 'partially_invoiced'
  | 'fully_invoiced'
  | 'closed_awaiting_invoice'
  | 'cancelled'
  | 'written_off';

/** Normalized purchase-order record emitted by any PO parser. */
export interface NormalizedPoRecord {
  /** Retailer's PO # (string to preserve any leading zeros). */
  po_number: string;
  /** Per 02_SCHEMA.md — canonical PO value in integer cents. */
  po_value_cents: Cents;
  /** ISO YYYY-MM-DD or null. */
  issuance_date: string | null;
  /** ISO YYYY-MM-DD or null. */
  requested_delivery_date: string | null;
  /** Free-text location (e.g. "WOODLAND, PA 16881"). */
  delivery_location: string | null;
  /** Free-text description from line-level source only. */
  item_description: string | null;
  /** Integer count of individual units. */
  quantity_ordered: number | null;
  /** Integer cents per unit. */
  unit_value_cents: Cents | null;
  /** Normalized status (see PoStatus). */
  status: PoStatus;
  /** Cancellation metadata — present only when status === 'cancelled'. */
  cancellation_reason_category: CancellationReason | null;
  cancellation_memo: string | null;
  /** Free-form retailer-specific payload for audit-only fields (microfilm numbers, etc). */
  metadata: Record<string, unknown>;
}

/** Normalized PO line record (emitted only by line-level parsers). */
export type PoLineStatus = 'approved' | 'received' | 'partially_received' | 'cancelled';

export interface NormalizedPoLineRecord {
  /** The PO this line belongs to (matches NormalizedPoRecord.po_number). */
  po_number: string;
  /** Per-PO sequence starting at 1. */
  line_number: number;
  /** Retailer's per-line item ID (e.g. Walmart item No.). */
  retailer_item_number: string | null;
  /** Free text from source. */
  item_description: string | null;
  /** Integer count. */
  quantity_ordered: number | null;
  /** Per-unit cost in cents. */
  unit_cost_cents: Cents | null;
  /**
   * Line total in cents. NULL only for cancelled lines whose source value is
   * NaN (Walmart convention) — the 0010 schema check allows this.
   */
  line_value_cents: Cents | null;
  /** Normalized line status. */
  status: PoLineStatus;
  /** Anything retailer-specific we want to preserve. */
  metadata: Record<string, unknown>;
}

/** Result returned by every parser. Consumed by the upload review UI. */
export interface ParseResult<TRecord = NormalizedPoRecord> {
  /** semver-ish version string, e.g. "walmart-po-header/1.0.0". */
  parser_version: string;
  /** The rows that will be persisted if the Manager clicks Commit. */
  rows: TRecord[];
  /** Optional line-level rows (Walmart line-level parser only; empty on header-level). */
  lines?: NormalizedPoLineRecord[];
  /** Non-fatal issues — Manager can still commit. */
  warnings: ParseWarning[];
  /** Rows the parser dropped — shown for transparency. */
  skipped: SkippedRow[];
  /** Summary counts for the review screen header. */
  stats: {
    total_rows_read: number;
    valid_rows: number;
    skipped_rows: number;
    warning_count: number;
    /** How many line rows were emitted (line-level parsers only). */
    line_rows?: number;
  };
}

/** Common input for every parser's parse() function. */
export type ParserInput = string | Uint8Array | ArrayBuffer | Buffer;

/** Normalize any of the accepted input shapes to a UTF-8 string. */
export function toText(input: ParserInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(input);
  if (input instanceof Uint8Array) return new TextDecoder('utf-8').decode(input);
  // Node Buffer extends Uint8Array but handle defensively:
  return new TextDecoder('utf-8').decode(Uint8Array.from(input as Uint8Array));
}
