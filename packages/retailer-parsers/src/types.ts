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
  /**
   * Retailer slug (matches `retailers.name`, lowercase, e.g. 'walmart').
   * Retailer-specific parsers (Walmart, Kroger) set this to their own slug
   * because the retailer is implied by the parser choice. The Generic CSV
   * parser REQUIRES a 'Retailer' column on every row and writes the
   * (case-normalized) value here — a single generic upload can span
   * multiple retailers.
   *
   * The upload handler resolves this slug to a retailer_id (matching
   * retailers.name OR retailers.display_name case-insensitively) before
   * persisting. Rows whose slug doesn't resolve are surfaced as skipped
   * with reason 'unknown_retailer' in the upload review UI.
   */
  retailer_slug: string;
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

// --------------------------------------------------------------------------
// Invoice-side types (Phase 1E)
// --------------------------------------------------------------------------

/**
 * Normalized invoice record emitted by any invoice parser.
 *
 * Matches the `invoices` table shape closely. The upload handler resolves
 * `(retailer_slug, po_number)` to a real `purchase_order_id` before
 * persisting; rows whose PO can't be found are surfaced as upload-review
 * warnings rather than emitted as orphan invoices.
 */
export interface NormalizedInvoiceRecord {
  /** Retailer slug (matches retailers.name, lowercase). */
  retailer_slug: string;
  /**
   * Retailer's PO # this invoice covers (string to preserve leading zeros).
   * Phase 1 assumes a 1:1 invoice→PO mapping; future spec resolution
   * §"Partial invoicing" may relax to N:M but doesn't change the parser
   * shape (one record per source invoice row).
   */
  po_number: string;
  /**
   * Stripped form of the invoice number — leading zeros removed. The
   * padded display form is preserved in `metadata.display_invoice_number`
   * so the UI can show users the format their retailer sees.
   */
  invoice_number: string;
  /** Per 02_SCHEMA.md — invoice value in integer cents (>= 0). */
  invoice_value_cents: Cents;
  /** ISO YYYY-MM-DD. NOT NULL per migration 0011/0012. */
  invoice_date: string;
  /** ISO YYYY-MM-DD or null. */
  due_date: string | null;
  /** ISO YYYY-MM-DD or null. */
  goods_delivery_date: string | null;
  /** Free-text location. */
  goods_delivery_location: string | null;
  /** Free-text status from source (Walmart "Process State Description", etc.). */
  approval_status: string | null;
  /** Free-text item description. */
  item_description: string | null;
  /** Free-form retailer-specific payload (microfilm number, vendor info, etc.). */
  metadata: Record<string, unknown>;
}

/**
 * Invoice-tied deduction (e.g. Walmart Allowance Amt extracted from a real
 * invoice row). Matches the `invoice_deductions` table. Resolved to a real
 * `invoice_id` by the upload handler via `(po_number, invoice_number)`.
 */
export interface NormalizedInvoiceDeductionRecord {
  retailer_slug: string;
  po_number: string;
  /** Stripped invoice number — same convention as NormalizedInvoiceRecord. */
  invoice_number: string;
  /** Maps to deduction_category enum. */
  category: 'shortage' | 'damage' | 'otif_fine' | 'pricing' | 'promotional' | 'other';
  /** Always positive cents; the sign is implicit (deductions reduce AR). */
  amount_cents: Cents;
  memo: string | null;
  /** ISO YYYY-MM-DD when the deduction was first known. NOT NULL in schema. */
  known_on_date: string;
  metadata: Record<string, unknown>;
}

/**
 * Client-level deduction, NOT tied to a specific invoice in our system. Used
 * for retailer chargebacks that arrive separate from any invoice we ingest:
 *
 *   * Walmart "RETURN CENTER CLAIMS" rows with non-zero amounts
 *   * Kroger "Promo Allowances" (Phase 1E-2)
 *   * Kroger "Non-Promo Receivable" / PRGX post-audit recoveries (1E-2)
 *
 * Matches the `client_deductions` table (migration 0009). Upload handler
 * resolves retailer_slug to retailer_id; po_number is informational only
 * (no FK in the table — the row stands alone or links via metadata).
 */
export interface NormalizedClientDeductionRecord {
  retailer_slug: string;
  /** Retailer's own ref for this deduction (e.g. Walmart Invoice No, Kroger Invoice number). */
  source_ref: string;
  /** Maps to client_deduction_source enum. */
  source_category: 'promo_allowance' | 'non_promo_receivable' | 'netting_offset' | 'chargeback' | 'other';
  /** Retailer-specific subcategory string (PromoBilling, PRGX, walmart_return_center_claim, ...). */
  source_subcategory: string | null;
  /** Always positive cents. */
  amount_cents: Cents;
  memo: string | null;
  /** ISO YYYY-MM-DD. */
  known_on_date: string;
  /** Optional originating PO number for traceability; no FK. */
  po_number: string | null;
  /** Kroger Division string ("011 - ATLANTA KMA"), Walmart store/DC, etc. */
  division: string | null;
  /** Free-text location. */
  location_description: string | null;
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
