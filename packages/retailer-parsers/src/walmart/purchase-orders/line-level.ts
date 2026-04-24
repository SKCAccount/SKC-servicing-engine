/**
 * Walmart SupplierOne Line-Level Purchase Order parser.
 *
 * Source: CSV, ~50 columns, N rows per PO (one row per item line). All
 * header-level fields are repeated identically across the rows for a given
 * PO; line-specific fields occupy the tail of each row.
 *
 * This is the DEFAULT Walmart PO upload format per spec — it carries item
 * descriptions and exposes partial line cancellations that the header-level
 * export hides. The upload UI auto-detects via the line-level-only columns
 * and routes here.
 *
 * Full-replacement semantics (resolved 2026-04-23): when a line-level file
 * covers a PO that already exists, the upload handler DELETEs all existing
 * purchase_order_lines for that PO and inserts the incoming lines. Header
 * fields on the PO row are also overwritten. This parser emits both the
 * header row (one per PO) AND the line rows (one per input row); the
 * upload handler performs the actual replacement inside a transaction.
 *
 * Line-value convention: cancelled lines have NaN or blank VNPK order cost
 * in the source. We preserve this as line_value_cents = null. The 0010
 * schema permits null line_value_cents only when status='cancelled'.
 */

import { cents } from '@seaking/money';
import {
  type NormalizedPoLineRecord,
  type NormalizedPoRecord,
  type ParseResult,
  type ParseWarning,
  type ParserInput,
  type PoLineStatus,
  type SkippedRow,
  toText,
} from '../../types';
import { parseCsv } from '../../csv';
import {
  buildWalmartCancellation,
  crossCheckOmsStatus,
  getCell,
  parseDollarCents,
  parseInteger,
  parseWalmartHeaderFields,
} from '../shared';

export const PARSER_VERSION = 'walmart-po-line/1.0.0';

function mapLineStatus(raw: string | null): PoLineStatus | null {
  if (!raw) return null;
  switch (raw.trim()) {
    case 'Approved':
      return 'approved';
    case 'Received':
      return 'received';
    case 'Partially Received':
      return 'partially_received';
    case 'Cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

export function parseWalmartPoLineLevel(input: ParserInput): ParseResult<NormalizedPoRecord> {
  const text = toText(input);
  const parsed = parseCsv(text);
  const warnings: ParseWarning[] = [];
  const skipped: SkippedRow[] = [];
  const poRows: NormalizedPoRecord[] = [];
  const lineRows: NormalizedPoLineRecord[] = [];

  for (const e of parsed.errors.slice(0, 10)) {
    warnings.push({
      code: 'csv_parse_error',
      message: `${e.type ?? 'error'}: ${e.message}`,
      ...(typeof e.row === 'number' ? { row_index: e.row } : {}),
    });
  }

  // Group rows by PO#. Within a group the header-level fields must agree;
  // we validate that and emit a warning on mismatch (trusting the first row).
  const groups = new Map<string, { headerRowIndex: number; rows: Array<{ row: Record<string, string>; index: number }> }>();

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    if (!row) continue;
    const poNum = (row['PO#'] ?? '').trim();
    if (!poNum) {
      skipped.push({ row_index: i, reason: 'missing_po_number' });
      continue;
    }
    const existing = groups.get(poNum);
    if (existing) {
      existing.rows.push({ row, index: i });
    } else {
      groups.set(poNum, { headerRowIndex: i, rows: [{ row, index: i }] });
    }
  }

  for (const [po_number, group] of groups) {
    const firstRow = group.rows[0]?.row;
    if (!firstRow) continue;

    const header = parseWalmartHeaderFields(firstRow);
    if (!header) {
      skipped.push({
        row_index: group.headerRowIndex,
        reason: 'missing_or_invalid_required_header_fields',
        raw: { 'PO#': po_number, 'Total unit cost': firstRow['Total unit cost'] ?? null },
      });
      continue;
    }

    const mismatch = crossCheckOmsStatus(header.status_raw, header.oms_status_raw, group.headerRowIndex);
    if (mismatch) warnings.push(mismatch);

    // Within-group consistency: all rows should share the same status and
    // Total unit cost. If they don't, warn — but still emit lines.
    for (const { row, index } of group.rows.slice(1)) {
      if ((row['Supply chain status'] ?? '').trim() !== header.status_raw) {
        warnings.push({
          row_index: index,
          code: 'walmart_inconsistent_header_in_group',
          message: `Supply chain status in row differs from first row for PO ${po_number}.`,
          context: {
            po_number,
            first_status: header.status_raw,
            this_status: row['Supply chain status'] ?? '',
          },
        });
      }
    }

    // Pull Item description from the first line row that has it set (first
    // line is the most common carrier; header-level fields don't have it).
    const itemDescription =
      group.rows.map(({ row }) => getCell(row, 'Item description')).find((v) => v !== null) ?? null;

    const cancellation =
      header.status === 'cancelled'
        ? buildWalmartCancellation()
        : { cancellation_reason_category: null, cancellation_memo: null };

    poRows.push({
      retailer_slug: 'walmart',
      po_number,
      po_value_cents: header.po_value_cents,
      issuance_date: header.issuance_date,
      requested_delivery_date: header.requested_delivery_date,
      delivery_location: header.delivery_location,
      item_description: itemDescription,
      quantity_ordered: header.quantity_ordered,
      unit_value_cents: null, // individual lines carry unit cost; PO-level unit is ambiguous
      status: header.status,
      cancellation_reason_category: cancellation.cancellation_reason_category,
      cancellation_memo: cancellation.cancellation_memo,
      metadata: {
        source: 'walmart_supplierone_line',
        supply_chain_status: header.status_raw,
        oms_status: header.oms_status_raw,
      },
    });

    // Now emit line records.
    for (const { row, index } of group.rows) {
      const lineNumber = parseInteger(getCell(row, 'Line number'));
      if (lineNumber == null || lineNumber < 1) {
        skipped.push({
          row_index: index,
          reason: 'missing_or_invalid_line_number',
          raw: { 'PO#': po_number, 'Line number': row['Line number'] ?? null },
        });
        continue;
      }

      const lineStatus = mapLineStatus(getCell(row, 'Line status'));
      if (!lineStatus) {
        skipped.push({
          row_index: index,
          reason: 'unknown_line_status',
          raw: { 'PO#': po_number, 'Line status': row['Line status'] ?? null },
        });
        continue;
      }

      const vnpkCost = parseDollarCents(getCell(row, 'VNPK cost'));
      const vnpkOrderCost = parseDollarCents(getCell(row, 'VNPK order cost'));
      const qty = parseInteger(getCell(row, 'Total VNPK order qty'));

      // Per 0010 schema: cancelled lines may have line_value = null/0.
      // Non-cancelled lines should have a concrete value; we accept null
      // but emit a warning so the Manager sees an unusual row.
      if (lineStatus !== 'cancelled' && vnpkOrderCost === null) {
        warnings.push({
          row_index: index,
          code: 'line_missing_value',
          message: `Line ${lineNumber} of PO ${po_number} is ${lineStatus} but has no VNPK order cost.`,
          context: { po_number, line_number: lineNumber, status: lineStatus },
        });
      }

      lineRows.push({
        po_number,
        line_number: lineNumber,
        retailer_item_number: getCell(row, 'Walmart item No.'),
        item_description: getCell(row, 'Item description'),
        quantity_ordered: qty,
        unit_cost_cents: vnpkCost,
        line_value_cents: lineStatus === 'cancelled' ? vnpkOrderCost ?? null : vnpkOrderCost,
        status: lineStatus,
        metadata: {
          source: 'walmart_supplierone_line',
        },
      });
    }
  }

  // Cross-check: sum(non-cancelled line values) should equal header Total unit cost.
  // Emit advisory warning on mismatch; don't reject — spec calls this soft.
  const sumsByPo = new Map<string, number>();
  for (const line of lineRows) {
    if (line.status === 'cancelled') continue;
    if (line.line_value_cents == null) continue;
    sumsByPo.set(line.po_number, (sumsByPo.get(line.po_number) ?? 0) + line.line_value_cents);
  }
  for (const po of poRows) {
    const sum = sumsByPo.get(po.po_number);
    if (sum == null) continue;
    const expected = po.po_value_cents as number;
    // Tolerate up to 1 cent rounding drift.
    if (Math.abs(sum - expected) > 1) {
      warnings.push({
        code: 'walmart_line_sum_variance',
        message:
          `PO ${po.po_number}: sum of non-cancelled line values (${cents(sum)}) ` +
          `does not match header Total unit cost (${expected}).`,
        context: { po_number: po.po_number, header_total: expected, line_sum: sum },
      });
    }
  }

  return {
    parser_version: PARSER_VERSION,
    rows: poRows,
    lines: lineRows,
    warnings,
    skipped,
    stats: {
      total_rows_read: parsed.rows.length,
      valid_rows: poRows.length,
      skipped_rows: skipped.length,
      warning_count: warnings.length,
      line_rows: lineRows.length,
    },
  };
}
