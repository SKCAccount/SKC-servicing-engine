/**
 * Parser for the "CSV of PO numbers" advance secondary-entry template.
 *
 * Spec: docs/01_FUNCTIONAL_SPEC.md §"Advancing Purchase Orders" → Secondary
 * Option. Two columns: `Purchase Order Number`, `Retailer`. The Manager (or
 * the Client, in their portal) uploads a list of POs to advance against
 * instead of selecting them by hand from the table.
 *
 * Pure function: bytes in (CSV text), normalized records out. The matching
 * step against existing POs lives in the upload handler — this layer
 * doesn't touch the DB.
 *
 * Validation rules:
 *   - Required headers (case-insensitive, whitespace-collapsed): both must
 *     be present. Hard error if missing.
 *   - Rows missing either field are skipped (not hard errors) and surface
 *     in `skipped`.
 *   - Retailer is normalized to a slug (lowercased, internal whitespace
 *     collapsed). Match against retailers.name OR display_name happens at
 *     the upload-handler layer, same as the generic CSV PO template.
 *   - Duplicate (po_number, retailer_slug) rows are deduped — the user
 *     sees exactly one match per (po, retailer) pair.
 */

import { canonicalizeHeader, parseCsv, cell } from '../../csv';

/** Canonical column list. The download endpoint serves this verbatim. */
export const PO_NUMBERS_TEMPLATE_HEADER = 'Purchase Order Number,Retailer';

const REQUIRED_HEADERS = ['Purchase Order Number', 'Retailer'] as const;

export interface PoNumbersRow {
  po_number: string;
  retailer_slug: string;
}

export interface PoNumbersSkippedRow {
  /** 1-based row number in the original CSV (header row excluded). */
  row_index: number;
  reason: string;
  raw: Record<string, string>;
}

export interface ParsePoNumbersResult {
  rows: PoNumbersRow[];
  skipped: PoNumbersSkippedRow[];
}

export class PoNumbersHeaderError extends Error {
  constructor(missing: string[], got: string[]) {
    super(
      `CSV template missing required columns: ${missing.join(', ')}. Got: ${got.join(', ') || '(empty header row)'}.`,
    );
    this.name = 'PoNumbersHeaderError';
  }
}

export function parsePoNumbersCsv(text: string): ParsePoNumbersResult {
  const csv = parseCsv(text);
  const headerSet = new Set(csv.headers);

  const missing = REQUIRED_HEADERS.filter((h) => !headerSet.has(canonicalizeHeader(h)));
  if (missing.length > 0) {
    throw new PoNumbersHeaderError([...missing], csv.headers);
  }

  const rows: PoNumbersRow[] = [];
  const skipped: PoNumbersSkippedRow[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < csv.rows.length; i++) {
    const raw = csv.rows[i] as Record<string, string>;
    const rowIndex = i + 1; // human-friendly: row 1 is the first data row
    const poNumber = cell(raw['Purchase Order Number']);
    const retailerCell = cell(raw['Retailer']);

    if (!poNumber) {
      skipped.push({
        row_index: rowIndex,
        reason: 'Missing Purchase Order Number.',
        raw,
      });
      continue;
    }
    if (!retailerCell) {
      skipped.push({
        row_index: rowIndex,
        reason: 'Missing Retailer.',
        raw,
      });
      continue;
    }

    const retailer_slug = retailerCell.toLowerCase().replace(/\s+/g, ' ').trim();
    const dedupeKey = `${poNumber}|${retailer_slug}`;
    if (seen.has(dedupeKey)) {
      // Silently skip dupes — surfacing them as warnings would just be noise.
      // The Manager already saw the value on the first occurrence.
      continue;
    }
    seen.add(dedupeKey);

    rows.push({ po_number: poNumber, retailer_slug });
  }

  return { rows, skipped };
}
