/**
 * Walmart SupplierOne Header-Level Purchase Order parser.
 *
 * Source: CSV, 38 columns, 1 row per PO. Used when a Manager uploads more
 * than 1,000 POs at once (Walmart's line-level export is capped at 1,000).
 *
 * Line-level is the preferred default — it carries Item description and
 * exposes partial line cancellations. This header-level path remains as
 * a fallback, auto-detected by the dispatcher when line-level-only columns
 * are absent.
 *
 * Per resolved decision 2026-04-23: "full replacement" merge. The upload
 * handler DELETEs purchase_order_lines for any PO covered by the incoming
 * file before inserting. This parser doesn't participate in that — it
 * just emits normalized header records.
 *
 * Output: NormalizedPoRecord[] with lines=undefined. The upload handler
 * understands 'undefined lines' to mean "don't touch purchase_order_lines".
 */

import {
  type NormalizedPoRecord,
  type ParseResult,
  type ParseWarning,
  type ParserInput,
  type SkippedRow,
  toText,
} from '../../types';
import { parseCsv } from '../../csv';
import {
  buildWalmartCancellation,
  crossCheckOmsStatus,
  parseWalmartHeaderFields,
} from '../shared';

export const PARSER_VERSION = 'walmart-po-header/1.0.0';

/** Canonical header set (post whitespace canonicalization) that signals header-level. */
export const HEADER_LEVEL_REQUIRED_COLUMNS: readonly string[] = [
  'PO#',
  'Supply chain status',
  'MABD',
  'Create date',
  'PO total each order qty',
  'Total unit cost',
];

/** Columns present ONLY in the line-level export — used by the dispatcher to distinguish. */
export const LINE_LEVEL_ONLY_COLUMNS: readonly string[] = [
  'Line number',
  'Item description',
  'VNPK order cost',
  'Line status',
];

export function parseWalmartPoHeaderLevel(
  input: ParserInput,
): ParseResult<NormalizedPoRecord> {
  const text = toText(input);
  const parsed = parseCsv(text);
  const warnings: ParseWarning[] = [];
  const skipped: SkippedRow[] = [];
  const rows: NormalizedPoRecord[] = [];

  // Surface Papa errors before we start — they frequently indicate ragged rows.
  for (const e of parsed.errors.slice(0, 10)) {
    warnings.push({
      code: 'csv_parse_error',
      message: `${e.type ?? 'error'}: ${e.message}`,
      ...(typeof e.row === 'number' ? { row_index: e.row } : {}),
    });
  }

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    if (!row) continue;
    const header = parseWalmartHeaderFields(row);
    if (!header) {
      skipped.push({
        row_index: i,
        reason: 'missing_or_invalid_required_fields',
        raw: {
          'PO#': row['PO#'] ?? null,
          'Supply chain status': row['Supply chain status'] ?? null,
          'Total unit cost': row['Total unit cost'] ?? null,
        },
      });
      continue;
    }

    // Warn-and-keep on OMS mismatch.
    const mismatch = crossCheckOmsStatus(header.status_raw, header.oms_status_raw, i);
    if (mismatch) warnings.push(mismatch);

    // Assemble cancellation fields only when the PO is cancelled.
    const cancellation =
      header.status === 'cancelled'
        ? buildWalmartCancellation()
        : { cancellation_reason_category: null, cancellation_memo: null };

    rows.push({
      retailer_slug: 'walmart',
      po_number: header.po_number,
      po_value_cents: header.po_value_cents,
      issuance_date: header.issuance_date,
      requested_delivery_date: header.requested_delivery_date,
      delivery_location: header.delivery_location,
      // Header-level export does NOT carry item description.
      item_description: null,
      quantity_ordered: header.quantity_ordered,
      unit_value_cents: null,
      status: header.status,
      cancellation_reason_category: cancellation.cancellation_reason_category,
      cancellation_memo: cancellation.cancellation_memo,
      metadata: {
        source: 'walmart_supplierone_header',
        supply_chain_status: header.status_raw,
        oms_status: header.oms_status_raw,
      },
    });
  }

  return {
    parser_version: PARSER_VERSION,
    rows,
    warnings,
    skipped,
    stats: {
      total_rows_read: parsed.rows.length,
      valid_rows: rows.length,
      skipped_rows: skipped.length,
      warning_count: warnings.length,
    },
  };
}
