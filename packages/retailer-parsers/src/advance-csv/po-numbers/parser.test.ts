import { describe, it, expect } from 'vitest';
import {
  parsePoNumbersCsv,
  PoNumbersHeaderError,
  PO_NUMBERS_TEMPLATE_HEADER,
} from './parser';

describe('parsePoNumbersCsv', () => {
  it('exports the canonical header', () => {
    expect(PO_NUMBERS_TEMPLATE_HEADER).toBe('Purchase Order Number,Retailer');
  });

  it('parses a simple two-row CSV', () => {
    const csv =
      'Purchase Order Number,Retailer\n' +
      '6534833343,Walmart\n' +
      '7891234567,Kroger\n';
    const result = parsePoNumbersCsv(csv);
    expect(result.rows).toEqual([
      { po_number: '6534833343', retailer_slug: 'walmart' },
      { po_number: '7891234567', retailer_slug: 'kroger' },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('lowercases and whitespace-collapses retailer names', () => {
    const csv =
      'Purchase Order Number,Retailer\n' +
      '111,Walmart Inc.\n' +
      `222,"Sam's Club"\n` +
      '333,KROGER  \n';
    const result = parsePoNumbersCsv(csv);
    expect(result.rows.map((r) => r.retailer_slug)).toEqual([
      'walmart inc.',
      "sam's club",
      'kroger',
    ]);
  });

  it('handles CRLF line endings', () => {
    const csv = 'Purchase Order Number,Retailer\r\n123,Walmart\r\n456,Kroger\r\n';
    const result = parsePoNumbersCsv(csv);
    expect(result.rows).toHaveLength(2);
  });

  it('canonicalizes header whitespace', () => {
    const csv = 'Purchase Order  Number ,Retailer\n123,Walmart\n';
    const result = parsePoNumbersCsv(csv);
    expect(result.rows).toEqual([{ po_number: '123', retailer_slug: 'walmart' }]);
  });

  it('skips rows missing a PO number, surfaces in skipped', () => {
    const csv =
      'Purchase Order Number,Retailer\n' +
      '111,Walmart\n' +
      ',Kroger\n' +
      '333,Walmart\n';
    const result = parsePoNumbersCsv(csv);
    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/Purchase Order Number/);
    expect(result.skipped[0]?.row_index).toBe(2);
  });

  it('skips rows missing a retailer', () => {
    const csv =
      'Purchase Order Number,Retailer\n' +
      '111,Walmart\n' +
      '222,\n';
    const result = parsePoNumbersCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/Retailer/);
  });

  it('dedupes (po_number, retailer_slug) pairs', () => {
    const csv =
      'Purchase Order Number,Retailer\n' +
      '111,Walmart\n' +
      '111,Walmart\n' +
      '111,WALMART\n' +
      '111,Kroger\n';
    const result = parsePoNumbersCsv(csv);
    expect(result.rows).toEqual([
      { po_number: '111', retailer_slug: 'walmart' },
      { po_number: '111', retailer_slug: 'kroger' },
    ]);
  });

  it('preserves PO numbers with leading zeros (treats as text)', () => {
    const csv = 'Purchase Order Number,Retailer\n0001234,Walmart\n';
    const result = parsePoNumbersCsv(csv);
    expect(result.rows[0]?.po_number).toBe('0001234');
  });

  it('throws PoNumbersHeaderError when required headers are missing', () => {
    const csv = 'PO,Retailer\n111,Walmart\n';
    expect(() => parsePoNumbersCsv(csv)).toThrow(PoNumbersHeaderError);
  });

  it('throws when only one of the two columns is present', () => {
    const csv = 'Purchase Order Number\n111\n';
    expect(() => parsePoNumbersCsv(csv)).toThrow(/Retailer/);
  });

  it('returns empty rows + empty skipped when only the header is present', () => {
    const csv = 'Purchase Order Number,Retailer\n';
    const result = parsePoNumbersCsv(csv);
    expect(result.rows).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
