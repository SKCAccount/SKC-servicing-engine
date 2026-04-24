/**
 * Helpers shared between Walmart PO header-level and line-level parsers.
 *
 * The two Walmart PO exports share ~38 header columns. Anything that
 * parses a header-level field (dates, location, PO value, status) lives
 * here so both parsers stay in sync.
 */

import { cents, type Cents } from '@seaking/money';
import type { CancellationReason, PoStatus, ParseWarning } from '../types';
import { cell } from '../csv';
import { parseUsSlashDate } from '../dates';

/**
 * Map Walmart's Supply chain status column to our normalized po_status.
 * Returns null for unknown values — caller should emit a warning and skip.
 */
export function mapWalmartSupplyChainStatus(raw: string | null): PoStatus | null {
  if (!raw) return null;
  switch (raw.trim()) {
    case 'Open':
    case 'Receiving':
      // Receiving = partial receipt in progress; Sea King still treats this
      // as a live, active PO. The spec explicitly maps both to `active`.
      return 'active';
    case 'Closed':
      // "Closed" on Walmart's side means Walmart considers the PO complete.
      // Sea King's position isn't settled until invoices + payments arrive,
      // so we park it in closed_awaiting_invoice (enum added in 0011)
      // rather than prematurely marking it fully_invoiced.
      return 'closed_awaiting_invoice';
    case 'Cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

/** Build the delivery_location string from the two Walmart address columns. */
export function buildDeliveryLocation(
  stateCity: string | null,
  zipcode: string | null,
): string | null {
  if (!stateCity && !zipcode) return null;
  // Source format is "STATE, CITY" — surprisingly state-first.
  // Output as "CITY, STATE ZIP" for human readability.
  if (stateCity) {
    const match = stateCity.match(/^\s*([A-Za-z]{2})\s*,\s*(.+?)\s*$/);
    if (match) {
      const [, state, city] = match;
      return `${city}, ${state}${zipcode ? ` ${zipcode}` : ''}`;
    }
  }
  return `${stateCity ?? ''}${zipcode ? ` ${zipcode}` : ''}`.trim();
}

/** Parse a USD dollar amount like "1305.36" or "" into Cents or null. */
export function parseDollarCents(raw: string | null): Cents | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'nan') return null;
  const cleaned = trimmed.replace(/[$,]/g, '');
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return null;
  // round half-away-from-zero to nearest cent; Math.round does this for positives
  return cents(Math.round(num * 100));
}

/** Parse an integer quantity or null. */
export function parseInteger(raw: string | null): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const num = Number(trimmed);
  if (!Number.isInteger(num) || num < 0) return null;
  return num;
}

/** Walmart PO issuance/MABD dates are MM/DD/YYYY. */
export const parseWalmartDate = parseUsSlashDate;

/** Lookup a cell value by exact canonical header name. */
export function getCell(row: Record<string, string>, header: string): string | null {
  return cell(row[header]);
}

/**
 * When a cancelled-status row is encountered, build the cancellation memo
 * and category in the shape our schema expects.
 */
export interface CancellationFields {
  cancellation_reason_category: CancellationReason;
  cancellation_memo: string;
}

export function buildWalmartCancellation(uploadedAt: Date = new Date()): CancellationFields {
  return {
    cancellation_reason_category: 'retailer_cancelled',
    cancellation_memo:
      `Walmart-reported cancellation (SupplierOne status=Cancelled); ` +
      `source row uploaded ${uploadedAt.toISOString()}`,
  };
}

/**
 * Validate a PO# cell into a non-empty digit string.
 * Walmart's PO#s are large integers; the source parser reads them as strings,
 * but a blank or non-digit cell indicates corruption and should be dropped.
 */
export function parsePoNumber(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return null;
  return t;
}

/**
 * Cross-check: Supply chain status vs OMS status.
 * In Derek's sample they agreed on every row; mismatch emits a warning.
 */
export function crossCheckOmsStatus(
  supplyChain: string | null,
  oms: string | null,
  rowIndex: number,
): ParseWarning | null {
  if (!supplyChain || !oms) return null;
  // OMS uses different strings — Active/Cancelled correspond to
  // Open+Receiving+Closed / Cancelled respectively.
  const sc = supplyChain.trim();
  const o = oms.trim();
  const scIsActiveLike = sc === 'Open' || sc === 'Receiving' || sc === 'Closed';
  const oIsActive = o === 'Active';
  if ((scIsActiveLike && !oIsActive) || (sc === 'Cancelled' && oIsActive)) {
    return {
      row_index: rowIndex,
      code: 'walmart_status_mismatch',
      message: `Supply chain status "${sc}" does not match OMS status "${o}". Trusting Supply chain status.`,
      context: { supply_chain_status: sc, oms_status: o },
    };
  }
  return null;
}

/** Header fields parsers both layouts need. Extracted for DRY. */
export interface WalmartHeaderFields {
  po_number: string;
  po_value_cents: Cents;
  issuance_date: string | null;
  requested_delivery_date: string | null;
  delivery_location: string | null;
  quantity_ordered: number | null;
  status: PoStatus;
  status_raw: string;
  oms_status_raw: string | null;
}

/**
 * Parse the header-level fields from a row (works for both the header-only
 * file — 1 row per PO — and the line-level file — N rows per PO where the
 * header values are repeated verbatim).
 *
 * Returns null if any required field is missing/invalid. The caller emits
 * a SkippedRow for nulls.
 */
export function parseWalmartHeaderFields(
  row: Record<string, string>,
): WalmartHeaderFields | null {
  const po_number = parsePoNumber(getCell(row, 'PO#'));
  if (!po_number) return null;

  const status_raw = (getCell(row, 'Supply chain status') ?? '').trim();
  const status = mapWalmartSupplyChainStatus(status_raw);
  if (!status) return null;

  const totalUnitCost = parseDollarCents(getCell(row, 'Total unit cost'));
  // Per 03_PARSERS.md: "Total unit cost" is misleadingly named — it's the
  // total PO dollar value, not per-unit cost. Zero is allowed (cancelled
  // with no salvageable value) but negative is not.
  if (totalUnitCost === null) return null;

  const quantity_ordered = parseInteger(getCell(row, 'PO total each order qty'));
  const issuance_date = parseWalmartDate(getCell(row, 'Create date'));
  const requested_delivery_date = parseWalmartDate(getCell(row, 'MABD'));
  const delivery_location = buildDeliveryLocation(
    getCell(row, 'Destination node address: state, city'),
    getCell(row, 'Destination node address: zipcode'),
  );
  const oms_status_raw = getCell(row, 'OMS status');

  return {
    po_number,
    po_value_cents: totalUnitCost,
    issuance_date,
    requested_delivery_date,
    delivery_location,
    quantity_ordered,
    status,
    status_raw,
    oms_status_raw,
  };
}
