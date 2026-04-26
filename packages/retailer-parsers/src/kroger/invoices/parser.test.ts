import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

import {
  parseKrogerInvoices,
  KrogerInvoiceHeaderError,
  PARSER_VERSION,
} from './parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '__fixtures__');

async function loadHappyPath(): Promise<Buffer> {
  return readFile(path.join(FIXTURE_DIR, 'happy-path.xlsx'));
}

/**
 * Build a synthetic Kroger invoice XLSX in memory. Matches the canonical
 * 26-column header. Cell values pass through to exceljs as-is — Date
 * objects become date-typed cells.
 */
async function buildXlsxFixture(
  rows: Array<Record<string, string | number | Date | null>>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Invoice_search_results.xlsx');
  const headers = [
    'Invoice number', 'Invoice category', 'Supplier ERP ID', 'Supplier name',
    'Invoice status', 'Invoice date', 'PO number', 'Division',
    'Location', 'Site number', 'Store number (Legacy)', 'Invoice type',
    'Invoice received date', 'Invoice uploaded by', 'Net invoice amount',
    'Tax 1', 'Deductions', 'Total deduction amount', 'Total discount amount',
    'Gross invoice amount', 'Total paid amount', 'Payment reference number',
    'Payment due date', 'Payment date', 'Remittance method', 'Currency',
  ];
  ws.addRow(headers);
  for (const row of rows) {
    ws.addRow(headers.map((h) => row[h] ?? null));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ============================================================================
// Happy path — real Kroger sample file
// ============================================================================

describe('parseKrogerInvoices — happy path (real fixture)', () => {
  it('parses without throwing', async () => {
    const buf = await loadHappyPath();
    const r = await parseKrogerInvoices(buf);
    expect(r.parser_version).toBe(PARSER_VERSION);
  });

  it('produces the spec-documented row breakdown (22 Warehouse / 65 Promo / 4 NPR + 1 skipped)', async () => {
    // Spec docs claim 66 Promo Allowances rows in the sample. Empirically
    // the real fixture has ONE Promo row with an empty Net invoice amount
    // (invoice 092-A2503-75799 at row index 88) — a data anomaly that the
    // parser skips with reason 'unparseable_net_amount'. So the actual
    // breakdown is 22 / 65 / 4 with 1 skipped. The spec's 66 was a count
    // that didn't catch the anomaly; behavior is correct.
    const buf = await loadHappyPath();
    const r = await parseKrogerInvoices(buf);
    expect(r.stats.total_rows_read).toBe(92);
    expect(r.stats.valid_invoice_rows).toBe(22);
    expect(r.stats.promo_allowance_rows).toBe(65);
    expect(r.stats.non_promo_receivable_rows).toBe(4);
    expect(r.stats.skipped_rows).toBe(1);
    expect(r.skipped[0]?.reason).toBe('unparseable_net_amount');
  });

  it('strips the BOM character from the first header cell', async () => {
    // The real Kroger export prefixes the first header with \uFEFF.
    // canonicalizeXlsxHeader strips it; if it didn't, the parser would
    // throw KrogerInvoiceHeaderError because 'Invoice number' wouldn't match.
    const buf = await loadHappyPath();
    await expect(parseKrogerInvoices(buf)).resolves.toBeTruthy();
  });

  it('Warehouse rows have positive cents and a real PO number', async () => {
    const buf = await loadHappyPath();
    const r = await parseKrogerInvoices(buf);
    for (const inv of r.rows) {
      expect(inv.invoice_value_cents).toBeGreaterThan(0);
      expect(inv.po_number.length).toBeGreaterThan(0);
      expect(inv.retailer_slug).toBe('kroger');
    }
  });

  it('Promo Allowances all carry source_category = promo_allowance', async () => {
    const buf = await loadHappyPath();
    const r = await parseKrogerInvoices(buf);
    const promo = r.client_deductions.filter((d) => d.source_category === 'promo_allowance');
    expect(promo).toHaveLength(65); // see breakdown test above; 1 anomaly skipped
    for (const d of promo) {
      expect(d.amount_cents).toBeGreaterThan(0);
      expect(d.source_subcategory).toBe('PromoBilling');
      expect(d.po_number).toBeNull(); // Promo rows have no PO
    }
  });

  it('Non-Promo Receivable all carry source_category = non_promo_receivable', async () => {
    const buf = await loadHappyPath();
    const r = await parseKrogerInvoices(buf);
    const npr = r.client_deductions.filter((d) => d.source_category === 'non_promo_receivable');
    expect(npr).toHaveLength(4);
    for (const d of npr) {
      expect(d.amount_cents).toBeGreaterThan(0);
      expect(d.source_subcategory).toBe('PRGX');
      expect(d.memo).toMatch(/PRGX post-audit recovery/);
    }
  });

  it('preserves Excel-serial dates as ISO YYYY-MM-DD', async () => {
    const buf = await loadHappyPath();
    const r = await parseKrogerInvoices(buf);
    // Sample row 16 (first Warehouse): Invoice date 2026-04-14
    const warehouseInvoices = r.rows;
    const knownExample = warehouseInvoices.find((inv) => inv.invoice_number === '1441');
    expect(knownExample?.invoice_date).toBe('2026-04-14');
  });

  it('captures Kroger metadata on Warehouse invoices', async () => {
    const buf = await loadHappyPath();
    const r = await parseKrogerInvoices(buf);
    const example = r.rows.find((inv) => inv.invoice_number === '1441');
    expect(example?.metadata.kroger_division).toBe('795 - Tolleson Logistics');
    expect(example?.metadata.kroger_uploaded_by).toBe('KCL');
    expect(example?.metadata.kroger_invoice_type).toBe('standard'); // canonicalized lowercase
  });

  it('the only skipped row has a clear reason (anomalous empty Net amount)', async () => {
    // Documented inline above. The real export has one bad row at index 88.
    const buf = await loadHappyPath();
    const r = await parseKrogerInvoices(buf);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.row_index).toBe(88);
    expect(r.skipped[0]?.reason).toBe('unparseable_net_amount');
  });
});

// ============================================================================
// Three-way category routing
// ============================================================================

describe('parseKrogerInvoices — category routing', () => {
  it('routes Warehouse → invoices with positive amount + PO', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1441',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Division': '795 - Tolleson Logistics',
      'Net invoice amount': 13363.2,
      'Gross invoice amount': 13363.2,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'STANDARD',
      'Invoice uploaded by': 'KCL',
      'Payment reference number': '',
      'Payment due date': '',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.rows).toHaveLength(1);
    expect(r.client_deductions).toHaveLength(0);
    expect(r.rows[0]?.invoice_value_cents).toBe(1336320);
  });

  it('routes Promo Allowances → client_deductions with promo_allowance category', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '092-AE38942-011',
      'Invoice category': 'Promo Allowances',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 20)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 21)),
      'PO number': '',
      'Division': '011 - ATLANTA KMA',
      'Net invoice amount': -735.9,
      'Gross invoice amount': -735.9,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'PromoBilling',
      'Payment reference number': '',
      'Payment due date': '',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.rows).toHaveLength(0);
    expect(r.client_deductions).toHaveLength(1);
    const d = r.client_deductions[0]!;
    expect(d.source_category).toBe('promo_allowance');
    expect(d.amount_cents).toBe(73590); // abs value
    expect(d.po_number).toBeNull();
    expect(d.division).toBe('011 - ATLANTA KMA');
  });

  it('routes Non-Promo Receivable → client_deductions with non_promo_receivable category', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '092-R5H7035-620',
      'Invoice category': 'Non-Promo Receivable',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 9, 3)),
      'Invoice received date': new Date(Date.UTC(2026, 11, 3)),
      'PO number': '',
      'Division': '092 - REGIONAL ACCOUNTING SERVICES CENTE',
      'Net invoice amount': -1441.55,
      'Gross invoice amount': -1441.55,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'PRGX',
      'Payment reference number': '',
      'Payment due date': '',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.client_deductions).toHaveLength(1);
    const d = r.client_deductions[0]!;
    expect(d.source_category).toBe('non_promo_receivable');
    expect(d.source_subcategory).toBe('PRGX');
    expect(d.amount_cents).toBe(144155);
  });

  it('skips unknown categories with a clear reason', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1234',
      'Invoice category': 'Unknown Category Xyz',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Net invoice amount': 100,
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.skipped[0]?.reason).toBe('unknown_invoice_category');
  });
});

// ============================================================================
// Sign and category cross-checks (warnings)
// ============================================================================

describe('parseKrogerInvoices — sign / category warnings', () => {
  it('warns on Promo with positive amount (sign inversion)', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '092-X-001',
      'Invoice category': 'Promo Allowances',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 20)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 21)),
      'PO number': '',
      'Division': '011 - ATLANTA KMA',
      'Net invoice amount': 100, // POSITIVE — wrong sign
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'PromoBilling',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.warnings.some((w) => w.code === 'kroger_promo_sign_inversion')).toBe(true);
    expect(r.client_deductions).toHaveLength(1); // still emits
  });

  it('skips Warehouse with negative amount', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1441',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Net invoice amount': -100, // NEGATIVE on Warehouse
      'Gross invoice amount': -100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.rows).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe('warehouse_row_non_positive_amount');
  });

  it('skips Warehouse with missing PO number', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1441',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '',
      'Net invoice amount': 100,
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.skipped[0]?.reason).toBe('warehouse_row_missing_po_number');
  });

  it('warns on Promo with PO number present', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '092-X-001',
      'Invoice category': 'Promo Allowances',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 20)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 21)),
      'PO number': 'SHOULD-BE-EMPTY',
      'Division': '011 - ATLANTA KMA',
      'Net invoice amount': -100,
      'Gross invoice amount': -100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'PromoBilling',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.warnings.some((w) => w.code === 'kroger_promo_unexpected_po')).toBe(true);
    // PO is preserved for traceability even when unexpected.
    expect(r.client_deductions[0]?.po_number).toBe('SHOULD-BE-EMPTY');
  });

  it('warns on Warehouse with non-KCL uploaded_by', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1441',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Net invoice amount': 100,
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'OtherSource',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.warnings.some((w) => w.code === 'kroger_warehouse_uploaded_by_mismatch')).toBe(true);
    expect(r.rows).toHaveLength(1); // still emits
  });

  it('warns on Warehouse with Gross ≠ Net', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1441',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Net invoice amount': 100,
      'Gross invoice amount': 110, // mismatch
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.warnings.some((w) => w.code === 'kroger_warehouse_gross_net_mismatch')).toBe(true);
  });

  it('warns when invoice_number format and category disagree', async () => {
    // Long hyphenated number with Warehouse category → mismatch warning.
    const buf = await buildXlsxFixture([{
      'Invoice number': '092-X-001',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Net invoice amount': 100,
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.warnings.some((w) => w.code === 'kroger_invoice_format_category_mismatch')).toBe(true);
  });
});

// ============================================================================
// Date anomaly + currency
// ============================================================================

describe('parseKrogerInvoices — date / currency warnings', () => {
  it('warns on invoice_received_date < invoice_date but still emits', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1441',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 20)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 14)), // BEFORE invoice date
      'PO number': '67700',
      'Net invoice amount': 100,
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.warnings.some((w) => w.code === 'kroger_date_anomaly')).toBe(true);
    expect(r.rows).toHaveLength(1);
  });

  it('warns on non-USD currency', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1441',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Net invoice amount': 100,
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Currency': 'CAD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.warnings.some((w) => w.code === 'non_usd_currency')).toBe(true);
  });
});

// ============================================================================
// Header validation
// ============================================================================

describe('parseKrogerInvoices — header validation', () => {
  it('throws KrogerInvoiceHeaderError on missing required headers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Invoice_search_results.xlsx');
    ws.addRow(['Just', 'Three', 'Cols']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseKrogerInvoices(buf)).rejects.toThrow(KrogerInvoiceHeaderError);
  });

  it('handles BOM on synthetic header (defensive)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('test');
    const headers = [
      '\uFEFFInvoice number', 'Invoice category', 'Supplier ERP ID', 'Supplier name',
      'Invoice status', 'Invoice date', 'PO number', 'Division',
      'Location', 'Site number', 'Store number (Legacy)', 'Invoice type',
      'Invoice received date', 'Invoice uploaded by', 'Net invoice amount',
      'Tax 1', 'Deductions', 'Total deduction amount', 'Total discount amount',
      'Gross invoice amount', 'Total paid amount', 'Payment reference number',
      'Payment due date', 'Payment date', 'Remittance method', 'Currency',
    ];
    ws.addRow(headers);
    ws.addRow([
      '1441', 'Warehouse', '3123705', 'Test',
      'Approved', new Date(Date.UTC(2026, 3, 14)), '67700', '795',
      '', '', '', 'STANDARD',
      new Date(Date.UTC(2026, 3, 15)), 'KCL', 100,
      0, '', 0, 0,
      100, 0, '',
      '', '', '', 'USD',
    ]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await parseKrogerInvoices(buf);
    expect(r.rows).toHaveLength(1);
  });
});

// ============================================================================
// Per-row validation
// ============================================================================

describe('parseKrogerInvoices — per-row validation', () => {
  it('skips rows missing Invoice number', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Net invoice amount': 100,
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.skipped[0]?.reason).toBe('missing_invoice_number');
  });

  it('skips rows with unparseable Net invoice amount', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1441',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Net invoice amount': 'banana',
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.skipped[0]?.reason).toBe('unparseable_net_amount');
  });

  it('skips rows missing Invoice date', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1441',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': '', // missing
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Net invoice amount': 100,
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.skipped[0]?.reason).toBe('missing_invoice_date');
  });
});

// ============================================================================
// Payment reference parsing
// ============================================================================

describe('parseKrogerInvoices — Payment reference number', () => {
  it('splits comma-separated payment refs into an array', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1441',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Net invoice amount': 100,
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Payment reference number': '6938527, 101910388',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.rows[0]?.metadata.kroger_payment_refs).toEqual(['6938527', '101910388']);
  });

  it('returns empty array when payment ref is blank', async () => {
    const buf = await buildXlsxFixture([{
      'Invoice number': '1441',
      'Invoice category': 'Warehouse',
      'Invoice status': 'Approved',
      'Invoice date': new Date(Date.UTC(2026, 3, 14)),
      'Invoice received date': new Date(Date.UTC(2026, 3, 15)),
      'PO number': '67700',
      'Net invoice amount': 100,
      'Gross invoice amount': 100,
      'Total deduction amount': 0,
      'Total discount amount': 0,
      'Total paid amount': 0,
      'Invoice type': 'Standard',
      'Invoice uploaded by': 'KCL',
      'Payment reference number': '',
      'Currency': 'USD',
    }]);
    const r = await parseKrogerInvoices(buf);
    expect(r.rows[0]?.metadata.kroger_payment_refs).toEqual([]);
  });
});
