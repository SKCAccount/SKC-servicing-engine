/**
 * Kroger invoice parser — XLSX export from Kroger's vendor portal.
 *
 * Spec: docs/03_PARSERS.md §"Kroger Invoices."
 *
 * Source format (26 columns, observed in real export). The first header
 * cell carries a UTF-8 BOM (`\uFEFF`); xlsx.ts strips it during header
 * canonicalization so downstream lookups work.
 *
 * **Three-way split by `Invoice category`** — only one of the three is a
 * real invoice; the other two are Client-level deductions:
 *
 *   | Invoice category       | Sign     | PO# | Routes to            |
 *   |------------------------|----------|-----|----------------------|
 *   | Warehouse              | positive | yes | invoices             |
 *   | Promo Allowances       | negative | no  | client_deductions    |
 *   | Non-Promo Receivable   | negative | no  | client_deductions    |
 *
 * **Invoice number format** — useful for cross-validation:
 *
 *   | Shape                | Example          | Issued by | Category    |
 *   |----------------------|------------------|-----------|-------------|
 *   | Short integer (~4 d) | `1441`           | Client    | Warehouse   |
 *   | Long hyphenated      | `092-AE38942-011`| Kroger    | Promo / NPR |
 *
 * Sign consistency is enforced (positive Warehouse, negative Promo / NPR).
 * Sign inversions surface as warnings rather than hard errors so the user
 * can review uncertain rows in the upload preview.
 *
 * **Date anomaly handling** — per spec resolution: Kroger sometimes
 * reports `Invoice received date < Invoice date`. We accept both at face
 * value but warn (`kroger_date_anomaly`) so the Manager can flag.
 *
 * Routing details follow the spec table in 03_PARSERS.md §Kroger Invoices
 * verbatim. The upload handler resolves `(retailer_slug, po_number)` to
 * a `purchase_order_id` for Warehouse rows; Promo / NPR rows skip PO
 * resolution since they're Client-level.
 */

import { cents, type Cents } from '@seaking/money';

import { parseXlsx, XlsxFormatError } from '../../xlsx';
import type {
  NormalizedClientDeductionRecord,
  NormalizedInvoiceRecord,
  ParseWarning,
  ParserInput,
  SkippedRow,
} from '../../types';

export const PARSER_VERSION = 'kroger-invoices/1.0.0';

const REQUIRED_HEADERS = [
  'Invoice number',
  'Invoice category',
  'Invoice status',
  'Invoice date',
  'Invoice received date',
  'PO number',
  'Division',
  'Net invoice amount',
  'Gross invoice amount',
  'Total deduction amount',
  'Total discount amount',
  'Total paid amount',
  'Invoice type',
  'Invoice uploaded by',
  'Payment reference number',
  'Payment due date',
  'Currency',
] as const;

export class KrogerInvoiceHeaderError extends Error {
  constructor(missing: string[], got: string[]) {
    super(
      `Kroger invoice file is missing required columns: ${missing.join(', ')}. ` +
        `Got: ${got.join(', ') || '(empty header row)'}.`,
    );
    this.name = 'KrogerInvoiceHeaderError';
  }
}

export interface KrogerInvoiceParseResult {
  parser_version: string;
  rows: NormalizedInvoiceRecord[];
  /**
   * Promo Allowances + Non-Promo Receivable rows route here. Walmart's
   * RETURN CENTER CLAIMS path uses the same destination type — the schema
   * is identical, the source_category enum disambiguates downstream.
   */
  client_deductions: NormalizedClientDeductionRecord[];
  warnings: ParseWarning[];
  skipped: SkippedRow[];
  stats: {
    total_rows_read: number;
    valid_invoice_rows: number;
    promo_allowance_rows: number;
    non_promo_receivable_rows: number;
    skipped_rows: number;
    warning_count: number;
  };
}

/** Coerce a money cell from XLSX (string-encoded numeric) into integer cents. */
function parseMoneyCellCents(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return num >= 0
    ? Math.round(num * 100 + Number.EPSILON)
    : -Math.round(-num * 100 + Number.EPSILON);
}

/**
 * Split a payment reference cell (`'6938527, 101910388'` or `'7501273'`) into
 * an array of trimmed strings. Empty input → empty array.
 */
function splitPaymentRefs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Heuristic invoice-number format check.
 *   Short integer (digits only, ≤ 6 chars) → Warehouse-style.
 *   Long hyphenated (contains '-') → Promo / NPR-style.
 * Returns null when the format doesn't match either pattern (parser warns).
 */
function classifyInvoiceNumberFormat(invoiceNumber: string): 'warehouse_style' | 'promo_npr_style' | null {
  if (/^\d{1,6}$/.test(invoiceNumber)) return 'warehouse_style';
  if (invoiceNumber.includes('-')) return 'promo_npr_style';
  return null;
}

export async function parseKrogerInvoices(
  input: ParserInput,
): Promise<KrogerInvoiceParseResult> {
  let parsed;
  try {
    parsed = await parseXlsx(input);
  } catch (e) {
    if (e instanceof XlsxFormatError) throw e;
    throw e;
  }

  // ---------- Header validation ----------
  const headerSet = new Set(parsed.headers);
  const missing = REQUIRED_HEADERS.filter((h) => !headerSet.has(h));
  if (missing.length > 0) {
    throw new KrogerInvoiceHeaderError([...missing], parsed.headers);
  }

  const rows: NormalizedInvoiceRecord[] = [];
  const clientDeductions: NormalizedClientDeductionRecord[] = [];
  const warnings: ParseWarning[] = [];
  const skipped: SkippedRow[] = [];
  const totalRowsRead = parsed.rows.length;
  let promoCount = 0;
  let nprCount = 0;

  for (let i = 0; i < parsed.rows.length; i++) {
    const raw = parsed.rows[i] as Record<string, string>;
    const rowIndex = i;
    const invoiceNumber = raw['Invoice number']?.trim() ?? '';
    const category = raw['Invoice category']?.trim() ?? '';
    const status = raw['Invoice status']?.trim() ?? '';
    const invoiceDate = raw['Invoice date']?.trim() ?? '';        // ISO YYYY-MM-DD via xlsx.ts Date conversion
    const receivedDate = raw['Invoice received date']?.trim() ?? '';
    const poNumber = raw['PO number']?.trim() ?? '';
    const division = raw['Division']?.trim() ?? '';
    const location = raw['Location']?.trim() ?? '';
    const invoiceType = raw['Invoice type']?.trim() ?? '';
    const uploadedBy = raw['Invoice uploaded by']?.trim() ?? '';
    const currency = raw['Currency']?.trim() ?? '';
    const netCents = parseMoneyCellCents(raw['Net invoice amount']);
    const grossCents = parseMoneyCellCents(raw['Gross invoice amount']);
    const totalDeductionCents = parseMoneyCellCents(raw['Total deduction amount']);
    const totalDiscountCents = parseMoneyCellCents(raw['Total discount amount']);

    // ---------- Per-row validation: invoice number required ----------
    if (!invoiceNumber) {
      skipped.push({
        row_index: rowIndex,
        reason: 'missing_invoice_number',
        raw: { 'Invoice category': category },
      });
      continue;
    }
    if (netCents == null) {
      skipped.push({
        row_index: rowIndex,
        reason: 'unparseable_net_amount',
        raw: { 'Invoice number': invoiceNumber, 'Net invoice amount': raw['Net invoice amount'] ?? '' },
      });
      continue;
    }
    if (!invoiceDate) {
      skipped.push({
        row_index: rowIndex,
        reason: 'missing_invoice_date',
        raw: { 'Invoice number': invoiceNumber },
      });
      continue;
    }

    // Currency sanity (USD-only per spec; non-USD warns).
    if (currency && currency !== 'USD') {
      warnings.push({
        row_index: rowIndex,
        code: 'non_usd_currency',
        message: `Invoice ${invoiceNumber}: currency "${currency}" — Phase 1 supports USD only.`,
        context: { Currency: currency },
      });
    }

    // Date anomaly: received < invoice. Per spec resolution, accept both
    // at face value but flag for Manager review.
    if (receivedDate && invoiceDate && receivedDate < invoiceDate) {
      warnings.push({
        row_index: rowIndex,
        code: 'kroger_date_anomaly',
        message:
          `Invoice ${invoiceNumber}: invoice received date (${receivedDate}) is before ` +
          `invoice date (${invoiceDate}). Importing both at face value.`,
        context: { 'Invoice date': invoiceDate, 'Invoice received date': receivedDate },
      });
    }

    // Format-vs-category cross-check (heuristic, warning-level).
    const numberFormat = classifyInvoiceNumberFormat(invoiceNumber);
    if (numberFormat === 'warehouse_style' && category !== 'Warehouse') {
      warnings.push({
        row_index: rowIndex,
        code: 'kroger_invoice_format_category_mismatch',
        message:
          `Invoice ${invoiceNumber} looks like a Warehouse number (short integer) but is ` +
          `categorized "${category}". Routing per category; review the source.`,
      });
    } else if (numberFormat === 'promo_npr_style' && category === 'Warehouse') {
      warnings.push({
        row_index: rowIndex,
        code: 'kroger_invoice_format_category_mismatch',
        message:
          `Invoice ${invoiceNumber} looks like a Promo/NPR number (hyphenated) but is ` +
          `categorized "Warehouse". Routing per category; review the source.`,
      });
    }

    // ---------- Route by category ----------
    switch (category) {
      case 'Warehouse': {
        // Warehouse rows must have:
        //   * non-empty PO number
        //   * positive Net invoice amount
        //   * Net == Gross (no inline deductions)
        if (!poNumber) {
          skipped.push({
            row_index: rowIndex,
            reason: 'warehouse_row_missing_po_number',
            raw: { 'Invoice number': invoiceNumber, 'Invoice category': category },
          });
          continue;
        }
        if (netCents <= 0) {
          // Sign inversion on a Warehouse row → hard skip; the row is
          // suspect (could be a refund / reversal in the wrong category).
          skipped.push({
            row_index: rowIndex,
            reason: 'warehouse_row_non_positive_amount',
            raw: { 'Invoice number': invoiceNumber, 'Net invoice amount': raw['Net invoice amount'] ?? '' },
          });
          continue;
        }
        if (grossCents != null && grossCents !== netCents) {
          warnings.push({
            row_index: rowIndex,
            code: 'kroger_warehouse_gross_net_mismatch',
            message:
              `Invoice ${invoiceNumber}: Gross amount (${grossCents} cents) ≠ Net (${netCents} cents). ` +
              `Storing Net.`,
          });
        }
        if ((totalDeductionCents != null && totalDeductionCents !== 0)
          || (totalDiscountCents != null && totalDiscountCents !== 0)) {
          warnings.push({
            row_index: rowIndex,
            code: 'kroger_warehouse_inline_deduction',
            message:
              `Invoice ${invoiceNumber}: non-zero inline Total deduction / discount on a ` +
              `Warehouse row. Phase 1 expects zero; review.`,
          });
        }
        if (uploadedBy && uploadedBy !== 'KCL') {
          warnings.push({
            row_index: rowIndex,
            code: 'kroger_warehouse_uploaded_by_mismatch',
            message: `Invoice ${invoiceNumber}: uploaded by "${uploadedBy}" — expected "KCL" for Warehouse.`,
          });
        }

        rows.push({
          retailer_slug: 'kroger',
          po_number: poNumber,
          invoice_number: invoiceNumber,
          invoice_value_cents: cents(netCents) as Cents,
          invoice_date: invoiceDate,
          due_date: raw['Payment due date']?.trim() || null,
          goods_delivery_date: null, // not provided on Kroger invoices
          goods_delivery_location: division || null,
          approval_status: status || null,
          item_description: null,
          metadata: {
            kroger_received_date: receivedDate || null,
            kroger_division: division || null,
            kroger_location: location || null,
            kroger_site_number: raw['Site number']?.trim() || null,
            kroger_payment_refs: splitPaymentRefs(raw['Payment reference number']),
            kroger_invoice_type: invoiceType.toLowerCase() || null,
            kroger_uploaded_by: uploadedBy || null,
            kroger_supplier_erp_id: raw['Supplier ERP ID']?.trim() || null,
            kroger_supplier_name: raw['Supplier name']?.trim() || null,
          },
        });
        break;
      }

      case 'Promo Allowances': {
        // Promo rows must have:
        //   * empty PO number (warn if present)
        //   * negative Net (sign inverted = warning, still emit)
        if (poNumber) {
          warnings.push({
            row_index: rowIndex,
            code: 'kroger_promo_unexpected_po',
            message:
              `Promo allowance ${invoiceNumber} has PO number "${poNumber}" — expected empty. Importing.`,
          });
        }
        if (netCents > 0) {
          warnings.push({
            row_index: rowIndex,
            code: 'kroger_promo_sign_inversion',
            message:
              `Promo allowance ${invoiceNumber} has positive amount (${netCents} cents) — expected negative. Importing.`,
          });
        }
        clientDeductions.push({
          retailer_slug: 'kroger',
          source_ref: invoiceNumber,
          source_category: 'promo_allowance',
          source_subcategory: uploadedBy || 'PromoBilling',
          amount_cents: cents(Math.abs(netCents)) as Cents,
          memo: `Kroger promo allowance ${invoiceNumber}`,
          known_on_date: invoiceDate,
          po_number: poNumber || null,
          division: division || null,
          location_description: location || null,
          metadata: {
            kroger_received_date: receivedDate || null,
            kroger_invoice_status: status || null,
            kroger_invoice_type: invoiceType.toLowerCase() || null,
            kroger_supplier_erp_id: raw['Supplier ERP ID']?.trim() || null,
            kroger_supplier_name: raw['Supplier name']?.trim() || null,
          },
        });
        promoCount++;
        break;
      }

      case 'Non-Promo Receivable': {
        if (poNumber) {
          warnings.push({
            row_index: rowIndex,
            code: 'kroger_npr_unexpected_po',
            message:
              `Non-Promo Receivable ${invoiceNumber} has PO number "${poNumber}" — expected empty. Importing.`,
          });
        }
        if (netCents > 0) {
          warnings.push({
            row_index: rowIndex,
            code: 'kroger_npr_sign_inversion',
            message:
              `Non-Promo Receivable ${invoiceNumber} has positive amount (${netCents} cents) — expected negative. Importing.`,
          });
        }
        clientDeductions.push({
          retailer_slug: 'kroger',
          source_ref: invoiceNumber,
          source_category: 'non_promo_receivable',
          source_subcategory: uploadedBy || 'PRGX',
          amount_cents: cents(Math.abs(netCents)) as Cents,
          memo: `PRGX post-audit recovery ${invoiceNumber}`,
          known_on_date: invoiceDate,
          po_number: poNumber || null,
          division: division || null,
          location_description: location || null,
          metadata: {
            kroger_received_date: receivedDate || null,
            kroger_invoice_status: status || null,
            kroger_invoice_type: invoiceType.toLowerCase() || null,
            kroger_supplier_erp_id: raw['Supplier ERP ID']?.trim() || null,
            kroger_supplier_name: raw['Supplier name']?.trim() || null,
          },
        });
        nprCount++;
        break;
      }

      default: {
        // Unknown category — skip with reason rather than guess.
        skipped.push({
          row_index: rowIndex,
          reason: 'unknown_invoice_category',
          raw: { 'Invoice number': invoiceNumber, 'Invoice category': category },
        });
        break;
      }
    }
  }

  return {
    parser_version: PARSER_VERSION,
    rows,
    client_deductions: clientDeductions,
    warnings,
    skipped,
    stats: {
      total_rows_read: totalRowsRead,
      valid_invoice_rows: rows.length,
      promo_allowance_rows: promoCount,
      non_promo_receivable_rows: nprCount,
      skipped_rows: skipped.length,
      warning_count: warnings.length,
    },
  };
}
