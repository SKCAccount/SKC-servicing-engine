import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

import {
  parseWalmartInvoices,
  WalmartInvoiceHeaderError,
  PARSER_VERSION,
} from './parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '__fixtures__');

async function loadHappyPath(): Promise<Buffer> {
  return readFile(path.join(FIXTURE_DIR, 'happy-path.xlsx'));
}

/**
 * Build a synthetic Walmart invoice XLSX in memory. Each `rows` entry is a
 * row of cell values matching the canonical 16-column header. Returns a
 * Buffer suitable for parseWalmartInvoices().
 */
async function buildXlsxFixture(rows: Array<Record<string, string | number | null>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Invoice Search Results');
  const headers = [
    'Invoice No', 'Invoice Date', 'Invoice Type', 'Invoice Due Date',
    'Process State Description', 'Source', 'PO Number', 'Store/DC Number',
    'Micro film number', 'Net Amount Due($)', 'Case Count', 'Allowances Type',
    'Allowance Desc', 'Allowance Amt', 'Vendor Number', 'Vendor Name',
  ];
  ws.addRow(headers);
  for (const row of rows) {
    ws.addRow(headers.map((h) => row[h] ?? null));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ============================================================================
// Happy path — real Walmart sample file
// ============================================================================

describe('parseWalmartInvoices — happy path (real fixture)', () => {
  it('parses without throwing', async () => {
    const buf = await loadHappyPath();
    const result = await parseWalmartInvoices(buf);
    expect(result.parser_version).toBe(PARSER_VERSION);
  });

  it('emits 8 invoices and 1 skipped row from the 9-row real export', async () => {
    // Real file has 9 data rows: 8 EDI ASCX12 invoices (rows 2-9) + 1
    // RETURN CENTER CLAIMS with $0 (row 10 → skipped).
    const buf = await loadHappyPath();
    const result = await parseWalmartInvoices(buf);
    expect(result.stats.total_rows_read).toBe(9);
    expect(result.stats.valid_invoice_rows).toBe(8);
    expect(result.stats.skipped_rows).toBe(1);
    expect(result.skipped[0]?.reason).toBe('return_center_claim_zero_dollar');
  });

  it('preserves leading zeros in display_invoice_number; strips for canonical', async () => {
    const buf = await loadHappyPath();
    const result = await parseWalmartInvoices(buf);
    const first = result.rows[0];
    expect(first?.invoice_number).toBe('8939228281'); // stripped
    expect(first?.metadata.display_invoice_number).toBe('000008939228281'); // padded
  });

  it('converts dollars-with-decimals Net Amount to integer cents', async () => {
    const buf = await loadHappyPath();
    const result = await parseWalmartInvoices(buf);
    // Row 1 in real file: Net Amount Due = 1166.4 → 116640 cents
    expect(result.rows[0]?.invoice_value_cents).toBe(116640);
  });

  it('parses MM-DD-YYYY invoice dates to ISO YYYY-MM-DD', async () => {
    const buf = await loadHappyPath();
    const result = await parseWalmartInvoices(buf);
    // Row 1: Invoice Date '03-02-2026' → '2026-03-02'
    expect(result.rows[0]?.invoice_date).toBe('2026-03-02');
    expect(result.rows[0]?.due_date).toBe('2026-05-04');
  });

  it('emits no invoice_deductions when all Allowance Amt = 0', async () => {
    const buf = await loadHappyPath();
    const result = await parseWalmartInvoices(buf);
    expect(result.stats.invoice_deduction_rows).toBe(0);
  });

  it('emits no client_deductions when no nonzero RETURN CENTER CLAIMS', async () => {
    const buf = await loadHappyPath();
    const result = await parseWalmartInvoices(buf);
    expect(result.stats.client_deduction_rows).toBe(0);
  });

  it('emits no warnings on the happy-path file', async () => {
    const buf = await loadHappyPath();
    const result = await parseWalmartInvoices(buf);
    expect(result.warnings).toEqual([]);
  });

  it('every invoice carries retailer_slug = walmart', async () => {
    const buf = await loadHappyPath();
    const result = await parseWalmartInvoices(buf);
    for (const r of result.rows) expect(r.retailer_slug).toBe('walmart');
  });

  it('captures audit metadata (microfilm, vendor, store/dc, case count)', async () => {
    const buf = await loadHappyPath();
    const result = await parseWalmartInvoices(buf);
    const first = result.rows[0];
    expect(first?.metadata.microfilm_number).toBe('275666002');
    expect(first?.metadata.vendor_name).toBe('114189920-Glenn Food Company LLC');
    expect(first?.metadata.store_dc_number).toBe('8011');
    expect(first?.metadata.case_count).toBe('54');
  });
});

// ============================================================================
// Source / Net Amount filter rules
// ============================================================================

describe('parseWalmartInvoices — RETURN CENTER CLAIMS routing', () => {
  it('skips zero-dollar claims with reason return_center_claim_zero_dollar', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000000400567216',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'RETURN CENTER CLAIMS',
      'PO Number': '0000000792',
      'Net Amount Due($)': 0,
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.rows).toHaveLength(0);
    expect(r.client_deductions).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.reason).toBe('return_center_claim_zero_dollar');
  });

  it('routes non-zero claims to client_deductions as chargebacks', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000000400567216',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'RETURN CENTER CLAIMS',
      'PO Number': '8939228281',
      'Net Amount Due($)': 250.5,
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.rows).toHaveLength(0);
    expect(r.client_deductions).toHaveLength(1);
    const cd = r.client_deductions[0]!;
    expect(cd.source_category).toBe('chargeback');
    expect(cd.source_subcategory).toBe('walmart_return_center_claim');
    expect(cd.amount_cents).toBe(25050);
    expect(cd.po_number).toBe('8939228281');
    expect(cd.memo).toContain('source PO 8939228281');
  });

  it('takes the absolute value when claim amount is negative', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000000400567216',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'RETURN CENTER CLAIMS',
      'PO Number': '8939228281',
      'Net Amount Due($)': -100.0,
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.client_deductions[0]?.amount_cents).toBe(10000);
  });
});

// ============================================================================
// Invoice Type validation
// ============================================================================

describe('parseWalmartInvoices — Invoice Type', () => {
  it('emits warning on Invoice Type ≠ "W" but still creates the invoice', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000001234567890',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'X',
      'Invoice Due Date': '05-15-2026',
      'Source': 'EDI ASCX12',
      'PO Number': '1234567890',
      'Net Amount Due($)': 500.0,
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.rows).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.code).toBe('unknown_invoice_type');
    expect(r.warnings[0]?.message).toContain('"X"');
  });
});

// ============================================================================
// Allowance Amt deduction extraction
// ============================================================================

describe('parseWalmartInvoices — Allowance Amt extraction', () => {
  it('emits one invoice_deduction per nonzero Allowance Amt', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000001234567890',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'EDI ASCX12',
      'PO Number': '1234567890',
      'Net Amount Due($)': 500.0,
      'Allowances Type': 'Promotional',
      'Allowance Desc': 'Q1 promo discount',
      'Allowance Amt': -25.50,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.rows).toHaveLength(1);
    expect(r.invoice_deductions).toHaveLength(1);
    const d = r.invoice_deductions[0]!;
    expect(d.po_number).toBe('1234567890');
    expect(d.invoice_number).toBe('1234567890');
    expect(d.category).toBe('promotional');
    expect(d.amount_cents).toBe(2550); // abs value
    expect(d.memo).toBe('Q1 promo discount');
    expect(d.known_on_date).toBe('2026-03-15');
  });

  it('falls back to a generic memo when Allowance Desc is "NA"', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000001234567890',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'EDI ASCX12',
      'PO Number': '1234567890',
      'Net Amount Due($)': 500.0,
      'Allowances Type': 'Damage Allowance',
      'Allowance Desc': 'NA',
      'Allowance Amt': -10.00,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.invoice_deductions[0]?.memo).toBe(
      'Damage Allowance deduction from invoice 1234567890',
    );
    expect(r.invoice_deductions[0]?.category).toBe('damage');
  });

  it('does NOT emit a deduction when Allowance Amt is zero', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000001234567890',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'EDI ASCX12',
      'PO Number': '1234567890',
      'Net Amount Due($)': 500.0,
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.invoice_deductions).toHaveLength(0);
  });

  it('classifies allowance types via classifyAllowanceCategory', async () => {
    const cases: Array<{ allowanceType: string; expected: string }> = [
      { allowanceType: 'Promotional', expected: 'promotional' },
      { allowanceType: 'Damage Allowance', expected: 'damage' },
      { allowanceType: 'Shortage Claim', expected: 'shortage' },
      { allowanceType: 'OTIF Fine', expected: 'otif_fine' },
      { allowanceType: 'On-Time Penalty', expected: 'otif_fine' },
      { allowanceType: 'Pricing Adjustment', expected: 'pricing' },
      { allowanceType: 'Mystery Type', expected: 'other' },
    ];
    for (const tc of cases) {
      const buf = await buildXlsxFixture([{
        'Invoice No': '000001',
        'Invoice Date': '03-15-2026',
        'Invoice Type': 'W',
        'Invoice Due Date': '05-15-2026',
        'Source': 'EDI ASCX12',
        'PO Number': '1',
        'Net Amount Due($)': 100,
        'Allowances Type': tc.allowanceType,
        'Allowance Desc': 'test',
        'Allowance Amt': -1.0,
      }]);
      const r = await parseWalmartInvoices(buf);
      expect(r.invoice_deductions[0]?.category).toBe(tc.expected);
    }
  });
});

// ============================================================================
// Per-row validation skips
// ============================================================================

describe('parseWalmartInvoices — per-row validation', () => {
  it('skips rows missing Invoice No', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'EDI ASCX12',
      'PO Number': '1234567890',
      'Net Amount Due($)': 500.0,
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.rows).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe('missing_invoice_no');
  });

  it('skips rows missing PO Number', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000001',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'EDI ASCX12',
      'PO Number': '',
      'Net Amount Due($)': 500.0,
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.rows).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe('missing_po_number');
  });

  it('skips rows with unparseable invoice date', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000001',
      'Invoice Date': 'banana',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'EDI ASCX12',
      'PO Number': '1234567890',
      'Net Amount Due($)': 500.0,
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.skipped[0]?.reason).toBe('unparseable_invoice_date');
  });

  it('skips rows with unparseable Net Amount Due', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000001',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'EDI ASCX12',
      'PO Number': '1234567890',
      'Net Amount Due($)': 'not a number',
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.skipped[0]?.reason).toBe('unparseable_net_amount');
  });

  it('skips negative Net Amount on non-RETURN-CENTER-CLAIMS rows', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000001',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'EDI ASCX12',
      'PO Number': '1234567890',
      'Net Amount Due($)': -100,
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.skipped[0]?.reason).toBe('negative_net_amount_on_invoice_row');
  });

  it('accepts a missing/blank due_date — it is optional', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000001',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '',
      'Source': 'EDI ASCX12',
      'PO Number': '1234567890',
      'Net Amount Due($)': 500.0,
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.due_date).toBeNull();
  });
});

// ============================================================================
// Header validation
// ============================================================================

describe('parseWalmartInvoices — header validation', () => {
  it('throws WalmartInvoiceHeaderError when required headers are missing', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Invoice Search Results');
    ws.addRow(['Just', 'Three', 'Headers']);
    ws.addRow(['1', '2', '3']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseWalmartInvoices(buf)).rejects.toThrow(WalmartInvoiceHeaderError);
  });

  it('lists every missing header in the error message', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Invoice Search Results');
    ws.addRow(['Invoice No', 'Source']); // missing 8 required columns
    ws.addRow(['000001', 'EDI ASCX12']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseWalmartInvoices(buf)).rejects.toThrow(/Invoice Date/);
  });

  it('canonicalizes header whitespace (trailing spaces in real export)', async () => {
    // The real export has 'Process State Description ' (trailing space) — we
    // canonicalize before lookup. Build a synthetic with that exact form to
    // confirm we still recognize it as 'Process State Description'.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Invoice Search Results');
    ws.addRow([
      'Invoice No', 'Invoice Date', 'Invoice Type', 'Invoice Due Date',
      'Process State Description ', 'Source', 'PO Number', 'Store/DC Number',
      'Micro film number', 'Net Amount Due($)', 'Case Count', 'Allowances Type',
      'Allowance Desc', 'Allowance Amt', 'Vendor Number', 'Vendor Name',
    ]);
    ws.addRow([
      '000001', '03-15-2026', 'W', '05-15-2026',
      'In Process', 'EDI ASCX12', '1234567890', 8011,
      275666002, 100.0, 1, 'NA', 'NA', 0, 114189920, 'Test',
    ]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await parseWalmartInvoices(buf);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.approval_status).toBe('In Process');
  });
});

// ============================================================================
// Multiple-row scenarios
// ============================================================================

describe('parseWalmartInvoices — mixed scenarios', () => {
  it('handles invoice + chargeback + allowance + skip in one upload', async () => {
    const buf = await buildXlsxFixture([
      // Real invoice with allowance
      {
        'Invoice No': '000001',
        'Invoice Date': '03-15-2026',
        'Invoice Type': 'W',
        'Invoice Due Date': '05-15-2026',
        'Source': 'EDI ASCX12',
        'PO Number': '1',
        'Net Amount Due($)': 1000.0,
        'Allowances Type': 'Damage Allowance',
        'Allowance Desc': 'pallet damage',
        'Allowance Amt': -50.00,
      },
      // RETURN CENTER CLAIMS chargeback
      {
        'Invoice No': '000002',
        'Invoice Date': '03-16-2026',
        'Invoice Type': 'W',
        'Invoice Due Date': '05-16-2026',
        'Source': 'RETURN CENTER CLAIMS',
        'PO Number': '2',
        'Net Amount Due($)': 75.50,
        'Allowances Type': 'NA',
        'Allowance Desc': 'NA',
        'Allowance Amt': 0,
      },
      // RETURN CENTER CLAIMS, zero — skipped
      {
        'Invoice No': '000003',
        'Invoice Date': '03-17-2026',
        'Invoice Type': 'W',
        'Invoice Due Date': '05-17-2026',
        'Source': 'RETURN CENTER CLAIMS',
        'PO Number': '3',
        'Net Amount Due($)': 0,
        'Allowances Type': 'NA',
        'Allowance Desc': 'NA',
        'Allowance Amt': 0,
      },
      // Plain invoice, no allowance
      {
        'Invoice No': '000004',
        'Invoice Date': '03-18-2026',
        'Invoice Type': 'W',
        'Invoice Due Date': '05-18-2026',
        'Source': 'EDI ASCX12',
        'PO Number': '4',
        'Net Amount Due($)': 200.0,
        'Allowances Type': 'NA',
        'Allowance Desc': 'NA',
        'Allowance Amt': 0,
      },
    ]);
    const r = await parseWalmartInvoices(buf);
    expect(r.stats).toEqual({
      total_rows_read: 4,
      valid_invoice_rows: 2,
      invoice_deduction_rows: 1,
      client_deduction_rows: 1,
      skipped_rows: 1,
      warning_count: 0,
    });
  });

  it('preserves row order in output collections', async () => {
    const buf = await buildXlsxFixture([
      { 'Invoice No': '000A', 'Invoice Date': '03-01-2026', 'Invoice Type': 'W',
        'Invoice Due Date': '05-01-2026', 'Source': 'EDI ASCX12', 'PO Number': 'A',
        'Net Amount Due($)': 100, 'Allowances Type': 'NA', 'Allowance Desc': 'NA', 'Allowance Amt': 0 },
      { 'Invoice No': '000B', 'Invoice Date': '03-02-2026', 'Invoice Type': 'W',
        'Invoice Due Date': '05-02-2026', 'Source': 'EDI ASCX12', 'PO Number': 'B',
        'Net Amount Due($)': 200, 'Allowances Type': 'NA', 'Allowance Desc': 'NA', 'Allowance Amt': 0 },
      { 'Invoice No': '000C', 'Invoice Date': '03-03-2026', 'Invoice Type': 'W',
        'Invoice Due Date': '05-03-2026', 'Source': 'EDI ASCX12', 'PO Number': 'C',
        'Net Amount Due($)': 300, 'Allowances Type': 'NA', 'Allowance Desc': 'NA', 'Allowance Amt': 0 },
    ]);
    const r = await parseWalmartInvoices(buf);
    expect(r.rows.map((x) => x.invoice_number)).toEqual(['A', 'B', 'C']);
  });
});

// ============================================================================
// Edge cases on money rounding
// ============================================================================

describe('parseWalmartInvoices — money rounding', () => {
  it('handles whole-dollar amounts cleanly', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice No': '000001',
      'Invoice Date': '03-15-2026',
      'Invoice Type': 'W',
      'Invoice Due Date': '05-15-2026',
      'Source': 'EDI ASCX12',
      'PO Number': '1',
      'Net Amount Due($)': 1000,
      'Allowances Type': 'NA',
      'Allowance Desc': 'NA',
      'Allowance Amt': 0,
    }]);
    const r = await parseWalmartInvoices(buf);
    expect(r.rows[0]?.invoice_value_cents).toBe(100000);
  });

  it('handles two-decimal cents-precise values exactly', async () => {
    // Values that ARE exactly representable in IEEE 754 (or where the
    // rounding handles common FP error gracefully).
    const cases: Array<[number, number]> = [
      [1.5, 150],
      [10.25, 1025],
      [100.99, 10099],
      [1166.4, 116640], // Walmart's actual sample value
      [0.01, 1],
    ];
    for (const [dollars, expectedCents] of cases) {
      const buf = await buildXlsxFixture([{
        'Invoice No': '000001',
        'Invoice Date': '03-15-2026',
        'Invoice Type': 'W',
        'Invoice Due Date': '05-15-2026',
        'Source': 'EDI ASCX12',
        'PO Number': '1',
        'Net Amount Due($)': dollars,
        'Allowances Type': 'NA',
        'Allowance Desc': 'NA',
        'Allowance Amt': 0,
      }]);
      const r = await parseWalmartInvoices(buf);
      expect(r.rows[0]?.invoice_value_cents, `${dollars} → cents`).toBe(expectedCents);
    }
  });

  // NB: 3+ decimal-place dollar values (e.g. 1.005) hit IEEE 754 representation
  // limits and may round either direction. Walmart invoice exports are
  // guaranteed 2-decimal precision per the APIS 2.0 schema, so this isn't a
  // realistic concern in practice. If we ever get a source that emits >2
  // decimals, we should string-parse the number to preserve precision.
});

// ============================================================================
// Input shape — ParserInput variants
// ============================================================================

describe('parseWalmartInvoices — input shapes', () => {
  it('accepts Buffer input', async () => {
    const buf = await loadHappyPath();
    expect(buf).toBeInstanceOf(Buffer);
    const r = await parseWalmartInvoices(buf);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('accepts Uint8Array input', async () => {
    const buf = await loadHappyPath();
    const u8 = new Uint8Array(buf);
    const r = await parseWalmartInvoices(u8);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('rejects string input with a clear error', async () => {
    await expect(parseWalmartInvoices('not a buffer')).rejects.toThrow(/binary input/);
  });
});
