/**
 * Generic CSV Purchase Order parser.
 *
 * For retailers Sea King hasn't built a dedicated parser for yet. The
 * Manager fills in a template CSV with the required columns and uploads
 * it via the same PO Upload UI. The upload handler knows which retailer
 * context the Manager picked (Kroger, a small regional chain, etc.) and
 * supplies it via ParseContext — the CSV itself doesn't need to name the
 * retailer because that's already set at the UI level.
 *
 * Template columns (case-insensitive, whitespace collapsed):
 *
 *   PO Number                   REQUIRED — any non-empty string
 *   PO Value                    REQUIRED — dollars like "1,234.56" or "$1,234.56"
 *   Issuance Date               optional — ISO YYYY-MM-DD or MM/DD/YYYY
 *   Requested Delivery Date     optional — same format
 *   Delivery Location           optional — free text
 *   Item Description            optional
 *   Quantity Ordered            optional — non-negative integer
 *   Unit Value                  optional — dollars
 *   Cancellation Status         optional — "active" | "cancelled" | "partial-cancel"
 *   Cancellation Reason         optional — free-text memo (REQUIRED when Cancellation Status = cancelled)
 *
 * If Cancellation Status is "cancelled", a Cancellation Reason is required.
 * "Partial-cancel" is preserved in metadata but the normalized status stays
 * 'active' because the schema doesn't model partial-cancellation at the PO
 * level (partial invoicing is the mechanism for that — see
 * 01_FUNCTIONAL_SPEC.md §Purchase Order Cancellations).
 *
 * Design notes:
 * - Column names are accepted case-insensitively ("PO number" and
 *   "po NUMBER" both work) because the generic template is hand-filled
 *   and Managers shouldn't have to remember exact casing.
 * - Cross-validation: if Quantity Ordered × Unit Value is set AND does
 *   not equal PO Value within a 1-cent rounding tolerance, we emit an
 *   advisory warning rather than rejecting. The Manager may legitimately
 *   have an overridden PO Value that isn't a perfect multiplicative of
 *   Quantity × Unit Value.
 * - PO Value is canonical. Quantity × Unit Value is treated as informational.
 */

import type {
  CancellationReason,
  NormalizedPoRecord,
  ParseResult,
  ParseWarning,
  ParserInput,
  PoStatus,
  SkippedRow,
} from '../../types';
import { toText } from '../../types';
import { parseCsv, cell, canonicalizeHeader } from '../../csv';
import { parseUsSlashDate } from '../../dates';
import { parseDollarCents, parseInteger } from '../../walmart/shared';

export const PARSER_VERSION = 'generic-po/1.0.0';

const REQUIRED_COLUMNS: readonly string[] = ['PO Number', 'PO Value'];

/** Canonical column map: lowercase-canonical → display canonical form. */
const KNOWN_COLUMNS: Record<string, string> = {
  'po number': 'PO Number',
  'po value': 'PO Value',
  'issuance date': 'Issuance Date',
  'requested delivery date': 'Requested Delivery Date',
  'delivery location': 'Delivery Location',
  'item description': 'Item Description',
  'quantity ordered': 'Quantity Ordered',
  'unit value': 'Unit Value',
  'cancellation status': 'Cancellation Status',
  'cancellation reason': 'Cancellation Reason',
};

/** Case-insensitive, whitespace-collapsed header canonicalization. */
function canonicalizeGenericHeader(raw: string): string {
  const cleaned = canonicalizeHeader(raw).toLowerCase();
  return KNOWN_COLUMNS[cleaned] ?? canonicalizeHeader(raw);
}

/** Accept ISO "YYYY-MM-DD" or US slash "MM/DD/YYYY". Returns ISO or null. */
function parseFlexibleDate(input: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return parseUsSlashDate(trimmed);
}

/** Normalize the Cancellation Status cell. Null input = active. */
function mapGenericCancellation(
  raw: string | null,
): { status: PoStatus; partial: boolean } | null {
  if (!raw) return { status: 'active', partial: false };
  const v = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (v === '' || v === 'active' || v === 'open') return { status: 'active', partial: false };
  if (v === 'cancelled' || v === 'canceled') return { status: 'cancelled', partial: false };
  if (v === 'partial-cancel' || v === 'partially-cancelled' || v === 'partial')
    return { status: 'active', partial: true };
  return null;
}

export function parseGenericPurchaseOrders(input: ParserInput): ParseResult<NormalizedPoRecord> {
  const text = toText(input);
  const parsedRaw = parseCsv(text);
  const warnings: ParseWarning[] = [];
  const skipped: SkippedRow[] = [];
  const rows: NormalizedPoRecord[] = [];

  // Canonicalize source headers into our known display form. Preserve the
  // source→canonical mapping so row lookups can find our values regardless
  // of casing the Manager used.
  const headerMap = new Map<string, string>();
  for (const h of parsedRaw.headers) {
    headerMap.set(h, canonicalizeGenericHeader(h));
  }

  const canonicalHeaders = new Set(headerMap.values());
  for (const required of REQUIRED_COLUMNS) {
    if (!canonicalHeaders.has(required)) {
      throw new Error(
        `Generic PO template is missing required column "${required}". ` +
          `Columns seen: ${parsedRaw.headers.join(', ')}`,
      );
    }
  }

  for (const e of parsedRaw.errors.slice(0, 10)) {
    warnings.push({
      code: 'csv_parse_error',
      message: `${e.type ?? 'error'}: ${e.message}`,
      ...(typeof e.row === 'number' ? { row_index: e.row } : {}),
    });
  }

  for (let i = 0; i < parsedRaw.rows.length; i++) {
    const raw = parsedRaw.rows[i];
    if (!raw) continue;

    // Rebuild the row with canonical keys.
    const row: Record<string, string> = {};
    for (const [src, dst] of headerMap) {
      const v = raw[src];
      if (v !== undefined) row[dst] = v;
    }

    const po_number = cell(row['PO Number']);
    if (!po_number) {
      skipped.push({
        row_index: i,
        reason: 'missing_po_number',
        raw: { 'PO Number': row['PO Number'] ?? null },
      });
      continue;
    }

    const po_value_cents = parseDollarCents(cell(row['PO Value']));
    if (po_value_cents === null) {
      skipped.push({
        row_index: i,
        reason: 'missing_or_invalid_po_value',
        raw: { 'PO Number': po_number, 'PO Value': row['PO Value'] ?? null },
      });
      continue;
    }

    const cancellation = mapGenericCancellation(cell(row['Cancellation Status']));
    if (!cancellation) {
      skipped.push({
        row_index: i,
        reason: 'unknown_cancellation_status',
        raw: {
          'PO Number': po_number,
          'Cancellation Status': row['Cancellation Status'] ?? null,
        },
      });
      continue;
    }

    const cancellationMemo = cell(row['Cancellation Reason']);
    if (cancellation.status === 'cancelled' && !cancellationMemo) {
      skipped.push({
        row_index: i,
        reason: 'cancelled_po_missing_reason',
        raw: { 'PO Number': po_number },
      });
      continue;
    }

    const issuance_date = parseFlexibleDate(cell(row['Issuance Date']));
    const requested_delivery_date = parseFlexibleDate(cell(row['Requested Delivery Date']));
    const delivery_location = cell(row['Delivery Location']);
    const item_description = cell(row['Item Description']);
    const quantity_ordered = parseInteger(cell(row['Quantity Ordered']));
    const unit_value_cents = parseDollarCents(cell(row['Unit Value']));

    // Advisory cross-check: Quantity × Unit Value ≈ PO Value.
    if (
      quantity_ordered != null &&
      unit_value_cents != null &&
      Math.abs(quantity_ordered * (unit_value_cents as number) - (po_value_cents as number)) > 1
    ) {
      warnings.push({
        row_index: i,
        code: 'generic_po_value_variance',
        message:
          `PO ${po_number}: Quantity × Unit Value (${quantity_ordered * (unit_value_cents as number)} cents) ` +
          `does not match PO Value (${po_value_cents as number} cents). Using PO Value as canonical.`,
        context: {
          po_number,
          quantity_ordered,
          unit_value_cents: unit_value_cents as number,
          po_value_cents: po_value_cents as number,
        },
      });
    }

    const metadata: Record<string, unknown> = { source: 'generic_csv' };
    if (cancellation.partial) metadata['partial_cancel'] = true;

    // cancellation_reason_category is 'other' for generic-CSV cancellations:
    // the Manager chose to mark it cancelled from a non-retailer source, so
    // "retailer_cancelled" doesn't apply. The memo they typed carries the
    // real context.
    const cancellationFields: {
      cancellation_reason_category: CancellationReason | null;
      cancellation_memo: string | null;
    } =
      cancellation.status === 'cancelled'
        ? {
            cancellation_reason_category: 'other',
            cancellation_memo: cancellationMemo,
          }
        : { cancellation_reason_category: null, cancellation_memo: null };

    rows.push({
      po_number,
      po_value_cents,
      issuance_date,
      requested_delivery_date,
      delivery_location,
      item_description,
      quantity_ordered,
      unit_value_cents,
      status: cancellation.status,
      cancellation_reason_category: cancellationFields.cancellation_reason_category,
      cancellation_memo: cancellationFields.cancellation_memo,
      metadata,
    });
  }

  return {
    parser_version: PARSER_VERSION,
    rows,
    warnings,
    skipped,
    stats: {
      total_rows_read: parsedRaw.rows.length,
      valid_rows: rows.length,
      skipped_rows: skipped.length,
      warning_count: warnings.length,
    },
  };
}

/**
 * The header row for the downloadable template CSV.
 * Exposed here so the upload UI (Phase 1C commit 3) can offer a
 * one-click "Download template" button generating a file with exactly
 * the headers the parser understands.
 */
export const GENERIC_PO_TEMPLATE_HEADER =
  'PO Number,PO Value,Issuance Date,Requested Delivery Date,Delivery Location,Item Description,Quantity Ordered,Unit Value,Cancellation Status,Cancellation Reason';
