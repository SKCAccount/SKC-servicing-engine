/**
 * Shared CSV parsing utility.
 *
 * Uses papaparse because Walmart's exports contain quoted fields with
 * embedded commas (e.g. `"DRKEITH , S0A0BJ3 , JUD0037 "` in the Buyer ID
 * column). A hand-rolled split(',') would destroy these.
 *
 * Header whitespace canonicalization: several Walmart columns have
 * double-spaces after the colon (`"Destination node address:  state, city"`).
 * We collapse runs of whitespace in header names so parsers can look up by
 * a clean canonical key without caring about the retailer's formatting
 * choices.
 */

import Papa from 'papaparse';

export interface CsvParseResult {
  /** Column names AFTER whitespace canonicalization. */
  headers: string[];
  /** Each row as a string->string map keyed by canonical header. */
  rows: Array<Record<string, string>>;
  /** Papa-reported errors (usually row-shape mismatches). */
  errors: Papa.ParseError[];
}

/** Collapse internal whitespace runs to a single space. */
export function canonicalizeHeader(h: string): string {
  return h.replace(/\s+/g, ' ').trim();
}

/** Trim leading/trailing whitespace from a cell value; return null for empty. */
export function cell(value: string | undefined): string | null {
  if (value == null) return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/**
 * Parse CSV text into rows keyed by canonical header name.
 * Does NOT validate semantic content — individual parsers own that.
 *
 * Line-ending defense: real-world uploads often mix CRLF (from Windows)
 * with LF (from concatenation or editing tools). Papaparse auto-detects
 * the line ending from the first occurrence and then treats inconsistent
 * ones as in-cell newlines — silently joining rows. We normalize to LF
 * before parsing and pin `newline: '\n'` to avoid that failure mode.
 */
export function parseCsv(text: string): CsvParseResult {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const result = Papa.parse<string[]>(normalized, {
    header: false,
    skipEmptyLines: 'greedy',
    newline: '\n',
  });

  if (result.data.length === 0) {
    return { headers: [], rows: [], errors: result.errors };
  }

  const rawHeaders = (result.data[0] as string[]) ?? [];
  const headers = rawHeaders.map(canonicalizeHeader);

  const rows: Array<Record<string, string>> = [];
  for (let r = 1; r < result.data.length; r++) {
    const row = result.data[r] as string[];
    if (!row) continue;
    const rec: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      rec[key] = row[c] ?? '';
    }
    rows.push(rec);
  }

  return { headers, rows, errors: result.errors };
}
