/**
 * Walmart Purchase Order parser — auto-detecting dispatcher.
 *
 * Per 03_PARSERS.md: the upload UI presents ONE "Upload Walmart POs" button.
 * This dispatcher reads the header row, decides which variant it is (header
 * or line level), and routes to the corresponding parser. Ambiguous column
 * sets are rejected with a clear error so the Manager knows the file is
 * malformed rather than silently picking the wrong path.
 *
 * Detection rule (per spec):
 *  - All four line-level columns present → line-level
 *  - None of the four line-level columns present → header-level
 *  - Some present, some missing → hard error (mixed column set)
 *
 * Line-level-only columns: Line number, Item description, VNPK order cost,
 * Line status. Header-level parser doesn't know about these.
 */

import { parseCsv, canonicalizeHeader } from '../../csv';
import type { NormalizedPoRecord, ParseResult, ParserInput } from '../../types';
import { toText } from '../../types';
import {
  parseWalmartPoHeaderLevel,
  HEADER_LEVEL_REQUIRED_COLUMNS,
  LINE_LEVEL_ONLY_COLUMNS,
} from './header-level';
import { parseWalmartPoLineLevel } from './line-level';

export type WalmartPoFormat = 'header-level' | 'line-level';

export interface DetectionResult {
  format: WalmartPoFormat;
  /** Columns that made the detector pick this format. */
  signal_columns: string[];
}

export class WalmartPoDetectionError extends Error {
  public readonly observed_columns: string[];
  constructor(message: string, observed_columns: string[]) {
    super(message);
    this.name = 'WalmartPoDetectionError';
    this.observed_columns = observed_columns;
  }
}

/**
 * Inspect a header row and decide which parser to use. Throws
 * WalmartPoDetectionError if the column set is mixed or incomplete.
 */
export function detectWalmartPoFormat(headers: readonly string[]): DetectionResult {
  const canonical = new Set(headers.map((h) => canonicalizeHeader(h)));

  // Baseline: the shared header columns must all be present, else this
  // isn't a Walmart PO file at all.
  for (const required of HEADER_LEVEL_REQUIRED_COLUMNS) {
    if (!canonical.has(required)) {
      throw new WalmartPoDetectionError(
        `Not a Walmart PO file: missing required column "${required}".`,
        [...canonical],
      );
    }
  }

  const lineLevelPresent = LINE_LEVEL_ONLY_COLUMNS.filter((c) => canonical.has(c));
  const lineLevelMissing = LINE_LEVEL_ONLY_COLUMNS.filter((c) => !canonical.has(c));

  if (lineLevelPresent.length === LINE_LEVEL_ONLY_COLUMNS.length) {
    return { format: 'line-level', signal_columns: lineLevelPresent };
  }
  if (lineLevelPresent.length === 0) {
    return { format: 'header-level', signal_columns: [...HEADER_LEVEL_REQUIRED_COLUMNS] };
  }

  throw new WalmartPoDetectionError(
    `Walmart PO file has a mixed column set — expected either all header-only columns ` +
      `or header+line columns. ` +
      `Line-level columns present: ${lineLevelPresent.join(', ')}. ` +
      `Line-level columns missing: ${lineLevelMissing.join(', ')}.`,
    [...canonical],
  );
}

/**
 * Top-level Walmart PO parser. Auto-detects format and routes.
 * The upload UI calls this; downstream code does not need to know which
 * variant was used (other than inspecting `result.lines` to decide
 * whether to rewrite purchase_order_lines).
 */
export function parseWalmartPurchaseOrders(input: ParserInput): ParseResult<NormalizedPoRecord> {
  const text = toText(input);
  const peek = parseCsv(text);
  const detection = detectWalmartPoFormat(peek.headers);

  if (detection.format === 'line-level') {
    return parseWalmartPoLineLevel(text);
  }
  return parseWalmartPoHeaderLevel(text);
}

export { parseWalmartPoHeaderLevel, parseWalmartPoLineLevel };
