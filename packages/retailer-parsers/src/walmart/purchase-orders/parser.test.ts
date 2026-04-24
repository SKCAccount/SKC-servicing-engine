import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectWalmartPoFormat,
  parseWalmartPurchaseOrders,
  WalmartPoDetectionError,
} from './index';
import { parseWalmartPoHeaderLevel } from './header-level';
import { parseWalmartPoLineLevel } from './line-level';

const here = dirname(fileURLToPath(import.meta.url));
function loadFixture(name: string): string {
  return readFileSync(join(here, '__fixtures__', name), 'utf-8');
}

describe('detectWalmartPoFormat', () => {
  it('identifies header-level when no line-level columns are present', () => {
    const headers = [
      'PO#',
      'Supply chain status',
      'MABD',
      'Create date',
      'PO total each order qty',
      'Total unit cost',
      'OMS status',
    ];
    expect(detectWalmartPoFormat(headers).format).toBe('header-level');
  });

  it('identifies line-level when all four line-level columns are present', () => {
    const headers = [
      'PO#',
      'Supply chain status',
      'MABD',
      'Create date',
      'PO total each order qty',
      'Total unit cost',
      'Line number',
      'Item description',
      'VNPK order cost',
      'Line status',
    ];
    expect(detectWalmartPoFormat(headers).format).toBe('line-level');
  });

  it('rejects mixed column sets with a clear error', () => {
    const headers = [
      'PO#',
      'Supply chain status',
      'MABD',
      'Create date',
      'PO total each order qty',
      'Total unit cost',
      'Line number', // line-level column present...
      // ...but missing Item description, VNPK order cost, Line status
    ];
    expect(() => detectWalmartPoFormat(headers)).toThrow(WalmartPoDetectionError);
  });

  it('rejects a non-Walmart file (missing required column)', () => {
    const headers = ['something', 'else'];
    expect(() => detectWalmartPoFormat(headers)).toThrow(/Not a Walmart PO file/);
  });
});

describe('parseWalmartPoHeaderLevel (real-sample fixture)', () => {
  const csv = loadFixture('happy-path-header.csv');
  const result = parseWalmartPoHeaderLevel(csv);

  it('emits one row per input row', () => {
    expect(result.rows.length).toBe(result.stats.valid_rows);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('parses PO values as integer cents', () => {
    for (const row of result.rows) {
      expect(Number.isInteger(row.po_value_cents)).toBe(true);
      expect(row.po_value_cents).toBeGreaterThanOrEqual(0);
    }
  });

  it('normalizes statuses to the po_status enum values', () => {
    const expected = new Set(['active', 'closed_awaiting_invoice', 'cancelled']);
    for (const row of result.rows) {
      expect(expected).toContain(row.status);
    }
  });

  it('maps "Cancelled" rows to cancelled status AND fills cancellation fields', () => {
    const cancelled = result.rows.filter((r) => r.status === 'cancelled');
    expect(cancelled.length).toBeGreaterThan(0);
    for (const row of cancelled) {
      expect(row.cancellation_reason_category).toBe('retailer_cancelled');
      expect(row.cancellation_memo).toMatch(/Walmart-reported cancellation/);
    }
  });

  it('leaves non-cancelled rows with null cancellation fields', () => {
    const nonCancelled = result.rows.filter((r) => r.status !== 'cancelled');
    for (const row of nonCancelled) {
      expect(row.cancellation_reason_category).toBeNull();
      expect(row.cancellation_memo).toBeNull();
    }
  });

  it('maps "Closed" to closed_awaiting_invoice', () => {
    const closed = result.rows.filter((r) => r.status === 'closed_awaiting_invoice');
    expect(closed.length).toBeGreaterThan(0);
  });

  it('parses MM/DD/YYYY dates into ISO format', () => {
    for (const row of result.rows) {
      if (row.issuance_date) expect(row.issuance_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (row.requested_delivery_date)
        expect(row.requested_delivery_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('builds a readable delivery_location from the two address cells', () => {
    const withLocation = result.rows.filter((r) => r.delivery_location);
    expect(withLocation.length).toBeGreaterThan(0);
    for (const row of withLocation) {
      // Expect "CITY, ST ZIP" shape (city/state swap from source)
      expect(row.delivery_location).toMatch(/[A-Z]{2}/);
    }
  });

  it('preserves the raw Supply chain status in metadata', () => {
    for (const row of result.rows) {
      const meta = row.metadata as { supply_chain_status: string };
      expect(meta.supply_chain_status).toBeTruthy();
    }
  });

  it('reports the expected parser_version', () => {
    expect(result.parser_version).toBe('walmart-po-header/1.0.0');
  });

  it('stats are internally consistent', () => {
    expect(result.stats.total_rows_read).toBe(result.stats.valid_rows + result.stats.skipped_rows);
    expect(result.stats.warning_count).toBe(result.warnings.length);
  });
});

describe('parseWalmartPoLineLevel (real-sample fixture)', () => {
  const csv = loadFixture('happy-path-line.csv');
  const result = parseWalmartPoLineLevel(csv);

  it('emits exactly one PO record per distinct PO# in the file', () => {
    const uniquePos = new Set(result.rows.map((r) => r.po_number));
    expect(uniquePos.size).toBe(result.rows.length);
  });

  it('emits line records — one per input row', () => {
    expect(result.lines).toBeDefined();
    expect(result.lines!.length).toBe(result.stats.line_rows);
    expect(result.lines!.length).toBeGreaterThanOrEqual(result.rows.length);
  });

  it('assigns line_number correctly starting at 1 within each PO', () => {
    const byPo = new Map<string, number[]>();
    for (const line of result.lines!) {
      const arr = byPo.get(line.po_number) ?? [];
      arr.push(line.line_number);
      byPo.set(line.po_number, arr);
    }
    for (const [, lines] of byPo) {
      expect(Math.min(...lines)).toBeGreaterThanOrEqual(1);
    }
  });

  it('maps "Cancelled" line status correctly', () => {
    const cancelledLines = result.lines!.filter((l) => l.status === 'cancelled');
    expect(cancelledLines.length).toBeGreaterThan(0);
  });

  it('maps "Partially Received" line status correctly', () => {
    const partial = result.lines!.filter((l) => l.status === 'partially_received');
    expect(partial.length).toBeGreaterThan(0);
  });

  it('parses item description from line rows', () => {
    const withDesc = result.rows.filter((r) => r.item_description);
    expect(withDesc.length).toBeGreaterThan(0);
  });

  it('parser_version reflects line-level parser', () => {
    expect(result.parser_version).toBe('walmart-po-line/1.0.0');
  });
});

describe('parseWalmartPurchaseOrders (auto-detecting dispatcher)', () => {
  it('routes header-level files to the header parser', () => {
    const csv = loadFixture('happy-path-header.csv');
    const result = parseWalmartPurchaseOrders(csv);
    expect(result.parser_version).toBe('walmart-po-header/1.0.0');
    expect(result.lines).toBeUndefined();
  });

  it('routes line-level files to the line parser', () => {
    const csv = loadFixture('happy-path-line.csv');
    const result = parseWalmartPurchaseOrders(csv);
    expect(result.parser_version).toBe('walmart-po-line/1.0.0');
    expect(result.lines).toBeDefined();
  });
});

describe('parseWalmartPoHeaderLevel (malformed fixture)', () => {
  const csv = loadFixture('malformed.csv');
  const result = parseWalmartPoHeaderLevel(csv);

  it('skips row with blank PO#', () => {
    expect(result.skipped.some((s) => s.reason === 'missing_or_invalid_required_fields')).toBe(
      true,
    );
  });

  it('skips row with non-numeric PO#', () => {
    // "BADPO" fails the digit regex in parsePoNumber
    const allPoNumbers = result.rows.map((r) => r.po_number);
    expect(allPoNumbers).not.toContain('BADPO');
  });

  it('skips row with unknown Supply chain status', () => {
    const allPoNumbers = result.rows.map((r) => r.po_number);
    expect(allPoNumbers).not.toContain('1234567890');
  });

  it('accepts cancelled rows with unparseable dates (dates are optional on cancellation)', () => {
    const row9876 = result.rows.find((r) => r.po_number === '9876543210');
    expect(row9876).toBeDefined();
    expect(row9876!.status).toBe('cancelled');
    // Bad dates silently become null rather than failing the row.
    expect(row9876!.issuance_date).toBeNull();
    expect(row9876!.requested_delivery_date).toBeNull();
  });

  it('stats reflect the skips', () => {
    expect(result.stats.skipped_rows).toBeGreaterThan(0);
    expect(result.stats.total_rows_read).toBe(
      result.stats.valid_rows + result.stats.skipped_rows,
    );
  });
});
