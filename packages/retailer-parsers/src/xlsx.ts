/**
 * Shared XLSX parsing utility — the parallel of csv.ts for binary formats.
 *
 * Uses `exceljs` because it's the cleanest API for the read-side of XLSX
 * in Node + actively maintained (sheetjs's `xlsx` OSS branch is on legacy
 * status). Reading-only — parsers never write XLSX.
 *
 * Output shape mirrors parseCsv: rows keyed by canonical header. Cell
 * values are normalized to strings so downstream parsers can use a single
 * code path regardless of whether the source was CSV (strings only) or
 * XLSX (rich type system). Specifically:
 *
 *   * Numbers (e.g. `1166.4` for a money cell) → `'1166.4'`. The parser
 *     decides whether to multiply-by-100 + round, depending on whether
 *     the cell represents dollars or cents.
 *   * Dates (cells formatted as date in Excel) → ISO `'YYYY-MM-DD'`.
 *     Excel stores dates as serial numbers; exceljs converts them on
 *     read based on the cell format. We further normalize to ISO so the
 *     parsers don't need to handle Date objects.
 *   * Date-strings (cells stored as text like `'03-02-2026'`) →
 *     pass-through unchanged. The Walmart invoice export uses this format
 *     (its dates are stored as text, not Excel-typed).
 *   * Booleans → 'true' / 'false'.
 *   * Formula results → the cached value (exceljs gives `cell.result`).
 *   * Hyperlinks → the display text.
 *   * Rich text → concatenated runs.
 *   * null / undefined / blank → ''.
 *
 * Header whitespace canonicalization mirrors csv.ts (trailing/leading
 * spaces trimmed; internal runs collapsed). The Walmart Invoice export
 * has e.g. `'Process State Description '` with trailing space — that
 * becomes `'Process State Description'`.
 *
 * The `parseXlsx` function is async because exceljs's `xlsx.load` is
 * Promise-based. Parsers expose a Promise<ParseResult> public surface
 * accordingly.
 */

import ExcelJS, { type CellValue, type Worksheet } from 'exceljs';

import type { ParserInput } from './types';

export interface XlsxParseResult {
  /** Sheet name actually consumed (first sheet by default, or the named one). */
  sheet_name: string;
  /** Column names AFTER whitespace canonicalization. */
  headers: string[];
  /** Each data row keyed by canonical header. */
  rows: Array<Record<string, string>>;
}

export interface XlsxParseOptions {
  /**
   * Read this named sheet instead of the first one. Most retailer exports
   * have a single sheet so this stays unset; included for parsers that
   * need to assert against an expected sheet name.
   */
  sheet_name?: string;
}

/**
 * Collapse internal whitespace runs to a single space; trim ends; strip
 * UTF-8 BOM. The BOM stripping matters: Kroger's invoice export emits a
 * `\uFEFF` prefix on the first header cell (likely from the upstream
 * source that wrote the XLSX). exceljs preserves cell text as-is, so the
 * raw header `'\uFEFFInvoice number'` would never match `'Invoice number'`
 * unless we strip it here.
 */
export function canonicalizeXlsxHeader(h: string): string {
  return h.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim();
}

/** Trim leading/trailing whitespace from a cell value; return null for empty. */
export function xlsxCell(value: string | undefined): string | null {
  if (value == null) return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/** Normalize an exceljs cell value to a string. See file header for the rules. */
function valueToString(v: CellValue): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) {
    // ISO YYYY-MM-DD (date-only). exceljs returns Date in UTC for date-typed
    // cells; we discard the time component since invoice/PO/payment dates
    // are calendar dates, not timestamps.
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // exceljs CellValue union covers more shapes:
  if (typeof v === 'object') {
    // Rich text: { richText: [{ text: '...' }, ...] }
    if ('richText' in v && Array.isArray(v.richText)) {
      return v.richText.map((r) => r.text).join('');
    }
    // Formula: { formula: '...', result: <CellValue> }
    if ('result' in v) {
      return valueToString(v.result as CellValue);
    }
    // Hyperlink: { text: '...', hyperlink: '...' }
    if ('text' in v && typeof v.text === 'string') {
      return v.text;
    }
    // Error: { error: '#REF!' } — propagate as text so parsers can detect.
    if ('error' in v && typeof v.error === 'string') {
      return v.error;
    }
  }
  // Fallback: best-effort String() coercion. Anything we don't recognize is
  // either a brand-new cell type or a bug in this normalizer.
  return String(v);
}

function inputToBuffer(input: ParserInput): Buffer | ArrayBuffer {
  if (typeof input === 'string') {
    // CSV-style input was passed to an XLSX parser — won't decode. Throw a
    // useful error rather than letting exceljs surface a confusing one.
    throw new XlsxFormatError(
      'parseXlsx received a string; expected binary input (Buffer / Uint8Array / ArrayBuffer).',
    );
  }
  if (input instanceof ArrayBuffer) return input;
  if (input instanceof Uint8Array) {
    // Buffer.from copies into a fresh ArrayBuffer if needed; exceljs accepts it.
    return Buffer.from(input);
  }
  // Already a Buffer (Node) or compatible — pass through.
  return input as Buffer;
}

export class XlsxFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxFormatError';
  }
}

/**
 * Parse an XLSX byte stream into rows keyed by canonical header.
 *
 * Throws XlsxFormatError when the input isn't binary or when the workbook
 * has no readable sheet. Individual parsers wrap or rethrow as their own
 * error types so the upload-review UI can show a clean message.
 */
export async function parseXlsx(
  input: ParserInput,
  options: XlsxParseOptions = {},
): Promise<XlsxParseResult> {
  const buffer = inputToBuffer(input);

  const wb = new ExcelJS.Workbook();
  // exceljs's load() accepts ArrayBuffer or Buffer.
  await wb.xlsx.load(buffer as ArrayBuffer);

  let ws: Worksheet | undefined;
  if (options.sheet_name) {
    ws = wb.getWorksheet(options.sheet_name);
    if (!ws) {
      throw new XlsxFormatError(
        `Sheet "${options.sheet_name}" not found. Available sheets: ${wb.worksheets.map((w) => w.name).join(', ')}`,
      );
    }
  } else {
    ws = wb.worksheets[0];
    if (!ws) {
      throw new XlsxFormatError('Workbook contains no sheets.');
    }
  }

  // Read header row. exceljs is 1-indexed; `getRow(1)` is the first row.
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  // We iterate by column count rather than .eachCell to keep empty header
  // cells in the right column position (otherwise sparse rows shift).
  for (let c = 1; c <= ws.columnCount; c++) {
    const raw = headerRow.getCell(c).value;
    headers[c - 1] = canonicalizeXlsxHeader(valueToString(raw));
  }

  // Read data rows.
  const rows: Array<Record<string, string>> = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    // Skip entirely-empty rows (common at the end of exports).
    let hasContent = false;
    const rec: Record<string, string> = {};
    for (let c = 1; c <= ws.columnCount; c++) {
      const key = headers[c - 1];
      if (!key) continue;
      const cellValue = valueToString(row.getCell(c).value);
      rec[key] = cellValue;
      if (cellValue !== '') hasContent = true;
    }
    if (hasContent) rows.push(rec);
  }

  return {
    sheet_name: ws.name,
    headers,
    rows,
  };
}
