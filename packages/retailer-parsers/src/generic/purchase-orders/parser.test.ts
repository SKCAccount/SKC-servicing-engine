import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GENERIC_PO_TEMPLATE_HEADER, parseGenericPurchaseOrders } from './index';

const here = dirname(fileURLToPath(import.meta.url));
function loadFixture(name: string): string {
  return readFileSync(join(here, '__fixtures__', name), 'utf-8');
}

describe('GENERIC_PO_TEMPLATE_HEADER', () => {
  it('lists the expected columns in the documented order (Retailer first)', () => {
    expect(GENERIC_PO_TEMPLATE_HEADER).toBe(
      'Retailer,PO Number,PO Value,Issuance Date,Requested Delivery Date,Delivery Location,' +
        'Item Description,Quantity Ordered,Unit Value,Cancellation Status,Cancellation Reason',
    );
  });
});

describe('parseGenericPurchaseOrders — happy path (multi-retailer file)', () => {
  const csv = loadFixture('happy-path.csv');
  const result = parseGenericPurchaseOrders(csv);

  it('emits one row per input row', () => {
    expect(result.rows.length).toBe(5);
    expect(result.stats.valid_rows).toBe(5);
    expect(result.stats.skipped_rows).toBe(0);
  });

  it('normalizes retailer values to lowercase slugs', () => {
    const byNumber = new Map(result.rows.map((r) => [r.po_number, r]));
    // Fixture has "Target", "target", "COSTCO", "Target", "BJs"
    expect(byNumber.get('SK-0001')!.retailer_slug).toBe('target');
    expect(byNumber.get('SK-0002')!.retailer_slug).toBe('target');
    expect(byNumber.get('SK-0003')!.retailer_slug).toBe('costco');
    expect(byNumber.get('SK-0004')!.retailer_slug).toBe('target');
    expect(byNumber.get('SK-0005')!.retailer_slug).toBe('bjs');
  });

  it('preserves multi-retailer identity on each row', () => {
    const uniqueRetailers = new Set(result.rows.map((r) => r.retailer_slug));
    expect(uniqueRetailers.size).toBe(3);
    expect(uniqueRetailers).toContain('target');
    expect(uniqueRetailers).toContain('costco');
    expect(uniqueRetailers).toContain('bjs');
  });

  it('parses PO values as integer cents', () => {
    const byNumber = new Map(result.rows.map((r) => [r.po_number, r]));
    expect(byNumber.get('SK-0001')!.po_value_cents).toBe(123456);
    expect(byNumber.get('SK-0002')!.po_value_cents).toBe(50000);
    expect(byNumber.get('SK-0003')!.po_value_cents).toBe(200000);
    expect(byNumber.get('SK-0004')!.po_value_cents).toBe(75000);
    expect(byNumber.get('SK-0005')!.po_value_cents).toBe(100000);
  });

  it('accepts both ISO and MM/DD/YYYY dates', () => {
    const byNumber = new Map(result.rows.map((r) => [r.po_number, r]));
    expect(byNumber.get('SK-0001')!.issuance_date).toBe('2026-04-15');
    expect(byNumber.get('SK-0002')!.issuance_date).toBe('2026-04-15');
  });

  it('marks cancelled rows correctly with memo', () => {
    const byNumber = new Map(result.rows.map((r) => [r.po_number, r]));
    const cancelled = byNumber.get('SK-0003')!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation_reason_category).toBe('other');
    expect(cancelled.cancellation_memo).toBe('Retailer ended the program');
  });

  it('treats partial-cancel as active with a metadata flag', () => {
    const byNumber = new Map(result.rows.map((r) => [r.po_number, r]));
    const partial = byNumber.get('SK-0004')!;
    expect(partial.status).toBe('active');
    expect(partial.cancellation_reason_category).toBeNull();
    expect((partial.metadata as { partial_cancel?: boolean }).partial_cancel).toBe(true);
  });

  it('non-cancelled rows have null cancellation fields', () => {
    for (const row of result.rows) {
      if (row.status === 'cancelled') continue;
      expect(row.cancellation_reason_category).toBeNull();
      expect(row.cancellation_memo).toBeNull();
    }
  });

  it('warns when Quantity × Unit Value disagrees with PO Value', () => {
    // SK-0001: 12 × $102.88 = $1,234.56 — no variance
    // SK-0002: 10 × $50.00 = $500.00 — no variance
    // SK-0005: 10 × $95.00 = $950.00 vs PO Value $1000.00 — WARNS
    const variance = result.warnings.filter((w) => w.code === 'generic_po_value_variance');
    expect(variance.length).toBe(1);
    expect(variance[0]!.context!['po_number']).toBe('SK-0005');
  });

  it('parses quantity and unit value as integers/cents', () => {
    const byNumber = new Map(result.rows.map((r) => [r.po_number, r]));
    const r1 = byNumber.get('SK-0001')!;
    expect(r1.quantity_ordered).toBe(12);
    expect(r1.unit_value_cents).toBe(10288);
  });

  it('parser_version reflects generic-po/1.1.0 (Retailer column change)', () => {
    expect(result.parser_version).toBe('generic-po/1.1.0');
  });
});

describe('parseGenericPurchaseOrders — case-insensitive headers', () => {
  it('accepts all column names in any case', () => {
    const csv = loadFixture('case-variant-headers.csv');
    const result = parseGenericPurchaseOrders(csv);
    expect(result.stats.valid_rows).toBe(1);
    const r = result.rows[0]!;
    expect(r.retailer_slug).toBe('target');
    expect(r.po_number).toBe('SK-A');
    expect(r.po_value_cents).toBe(10000);
    expect(r.issuance_date).toBe('2026-04-01');
  });
});

describe('parseGenericPurchaseOrders — malformed rows', () => {
  const csv = loadFixture('malformed.csv');
  const result = parseGenericPurchaseOrders(csv);

  it('skips rows missing Retailer', () => {
    expect(result.skipped.some((s) => s.reason === 'missing_retailer')).toBe(true);
  });

  it('skips rows missing PO Number', () => {
    expect(result.skipped.some((s) => s.reason === 'missing_po_number')).toBe(true);
  });

  it('skips rows missing PO Value', () => {
    expect(result.skipped.some((s) => s.reason === 'missing_or_invalid_po_value')).toBe(true);
  });

  it('skips cancelled rows that have no Cancellation Reason', () => {
    expect(result.skipped.some((s) => s.reason === 'cancelled_po_missing_reason')).toBe(true);
  });

  it('skips rows with unknown Cancellation Status', () => {
    expect(result.skipped.some((s) => s.reason === 'unknown_cancellation_status')).toBe(true);
  });

  it('skips rows whose PO Value is unparseable', () => {
    const poNumbers = result.rows.map((r) => r.po_number);
    expect(poNumbers).not.toContain('SK-103');
  });

  it('stats reflect the skips', () => {
    expect(result.stats.total_rows_read).toBe(6);
    expect(result.stats.valid_rows).toBe(0);
    expect(result.stats.skipped_rows).toBe(6);
  });
});

describe('parseGenericPurchaseOrders — missing required column', () => {
  it('throws with a clear message when Retailer/PO Value are absent', () => {
    const csv = loadFixture('missing-required-column.csv');
    // Parser iterates REQUIRED_COLUMNS in order [Retailer, PO Number, PO Value]
    // and throws on the first missing one, so "Retailer" surfaces first.
    expect(() => parseGenericPurchaseOrders(csv)).toThrow(/missing required column "Retailer"/);
  });
});
