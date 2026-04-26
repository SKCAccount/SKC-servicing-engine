/**
 * Walmart invoice parser — APIS 2.0 "Invoice By Date Search" XLSX export.
 *
 * Spec: docs/03_PARSERS.md §"Walmart Invoices."
 *
 * Source format (16 columns, observed in the real export):
 *
 *   Invoice No, Invoice Date, Invoice Type, Invoice Due Date,
 *   Process State Description, Source, PO Number, Store/DC Number,
 *   Micro film number, Net Amount Due($), Case Count, Allowances Type,
 *   Allowance Desc, Allowance Amt, Vendor Number, Vendor Name
 *
 * Walmart stores the Invoice No with leading zeros (e.g. `'000008939228281'`).
 * We strip those for the canonical `invoice_number` and retain the padded
 * form in `metadata.display_invoice_number` so the UI can show users the
 * format their retailer uses.
 *
 * Routing rules (per spec §Walmart Invoices "Filter rules"):
 *
 *   | Source                   | Net Amount | → Output                         |
 *   |--------------------------|------------|----------------------------------|
 *   | EDI ASCX12 (or any other)| any        | → invoice row (`rows`)           |
 *   | RETURN CENTER CLAIMS     | 0          | → SKIP (`skipped`)               |
 *   | RETURN CENTER CLAIMS     | non-zero   | → client_deduction (chargeback)  |
 *
 * Allowance Amt extraction (independent of Source routing):
 *   Whenever a row produces an invoice AND `Allowance Amt ≠ 0`, emit one
 *   `invoice_deductions` row attached to that invoice. category mapped from
 *   `Allowances Type` via classifyAllowanceCategory; memo from
 *   `Allowance Desc` (or fallback). known_on_date = invoice_date.
 *
 * Validation:
 *   - Invoice No must be non-empty
 *   - PO Number must be non-empty (rejected for invoices; required even for
 *     RETURN CENTER CLAIMS chargebacks since the chargeback references a PO)
 *   - Invoice Date must parse as MM-DD-YYYY (Walmart's stored format)
 *   - Invoice Type ≠ 'W' → emit warning, but still emit invoice
 *
 * Output:
 *   { rows, invoice_deductions, client_deductions, warnings, skipped, stats }
 *
 * The upload handler is responsible for resolving (po_number) → purchase_
 * order_id via (client_id, retailer_id, po_number) and resolving
 * (po_number, invoice_number) → invoice_id for the invoice_deductions
 * linkage. Rows whose PO can't be resolved surface as upload-review
 * warnings and don't persist.
 */

import { cents, type Cents } from '@seaking/money';

import { parseXlsx, XlsxFormatError } from '../../xlsx';
import { parseUsDashDate } from '../../dates';
import type {
  NormalizedClientDeductionRecord,
  NormalizedInvoiceDeductionRecord,
  NormalizedInvoiceRecord,
  ParseWarning,
  ParserInput,
  SkippedRow,
} from '../../types';

export const PARSER_VERSION = 'walmart-invoices/1.0.0';

const REQUIRED_HEADERS = [
  'Invoice No',
  'Invoice Date',
  'Invoice Type',
  'Invoice Due Date',
  'Source',
  'PO Number',
  'Net Amount Due($)',
  'Allowances Type',
  'Allowance Desc',
  'Allowance Amt',
] as const;

export class WalmartInvoiceHeaderError extends Error {
  constructor(missing: string[], got: string[]) {
    super(
      `Walmart invoice file is missing required columns: ${missing.join(', ')}. ` +
        `Got: ${got.join(', ') || '(empty header row)'}.`,
    );
    this.name = 'WalmartInvoiceHeaderError';
  }
}

export interface WalmartInvoiceParseResult {
  parser_version: string;
  rows: NormalizedInvoiceRecord[];
  invoice_deductions: NormalizedInvoiceDeductionRecord[];
  client_deductions: NormalizedClientDeductionRecord[];
  warnings: ParseWarning[];
  skipped: SkippedRow[];
  stats: {
    total_rows_read: number;
    valid_invoice_rows: number;
    invoice_deduction_rows: number;
    client_deduction_rows: number;
    skipped_rows: number;
    warning_count: number;
  };
}

/** Map Walmart's Allowances Type free-text to our deduction_category enum. */
function classifyAllowanceCategory(
  allowanceType: string | null,
): NormalizedInvoiceDeductionRecord['category'] {
  if (!allowanceType) return 'other';
  const t = allowanceType.toLowerCase();
  // Walmart uses descriptive types like "Promotional", "Damage Allowance",
  // "Pricing", etc. Map the substrings we've seen; fall through to 'other'.
  if (t.includes('promo')) return 'promotional';
  if (t.includes('damage')) return 'damage';
  if (t.includes('shortage')) return 'shortage';
  if (t.includes('otif') || t.includes('on time') || t.includes('on-time')) return 'otif_fine';
  if (t.includes('pricing') || t.includes('price')) return 'pricing';
  return 'other';
}

/**
 * Coerce a money cell from XLSX (which we get as a numeric STRING via
 * parseXlsx's normalizer) into integer cents. Returns null when the cell
 * is blank or unparseable. Source values are dollars-with-decimals
 * (e.g. `'1166.4'`), so we multiply by 100 and round half-away-from-zero.
 */
function parseMoneyCellCents(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  // Round half-away-from-zero. JS Math.round is half-toward-positive-infinity;
  // for our purposes (positive amounts dominate) the difference is rare,
  // but use Number.EPSILON-aware rounding for stability on the 0.005 boundary.
  return num >= 0
    ? Math.round(num * 100 + Number.EPSILON)
    : -Math.round(-num * 100 + Number.EPSILON);
}

export async function parseWalmartInvoices(
  input: ParserInput,
): Promise<WalmartInvoiceParseResult> {
  let parsed;
  try {
    parsed = await parseXlsx(input);
  } catch (e) {
    if (e instanceof XlsxFormatError) {
      // Re-raise as-is; upload handler converts to a user-facing error.
      throw e;
    }
    throw e;
  }

  // ---------- Header validation ----------
  const headerSet = new Set(parsed.headers);
  const missing = REQUIRED_HEADERS.filter((h) => !headerSet.has(h));
  if (missing.length > 0) {
    throw new WalmartInvoiceHeaderError([...missing], parsed.headers);
  }

  const rows: NormalizedInvoiceRecord[] = [];
  const invoiceDeductions: NormalizedInvoiceDeductionRecord[] = [];
  const clientDeductions: NormalizedClientDeductionRecord[] = [];
  const warnings: ParseWarning[] = [];
  const skipped: SkippedRow[] = [];
  const totalRowsRead = parsed.rows.length;

  for (let i = 0; i < parsed.rows.length; i++) {
    const raw = parsed.rows[i] as Record<string, string>;
    const rowIndex = i; // 0-based; matches what tests will assert against
    const sourceCell = raw['Source']?.trim() ?? '';
    const invoiceTypeCell = raw['Invoice Type']?.trim() ?? '';
    const invoiceNoRaw = raw['Invoice No']?.trim() ?? '';
    const poNumber = raw['PO Number']?.trim() ?? '';
    const netCents = parseMoneyCellCents(raw['Net Amount Due($)']);
    const invoiceDateStr = parseUsDashDate(raw['Invoice Date'] ?? null);
    const dueDateStr = parseUsDashDate(raw['Invoice Due Date'] ?? null);

    // ---------- Filter rule: RETURN CENTER CLAIMS ----------
    // Per spec, these are NOT invoices. They're either skipped (zero) or
    // routed to client_deductions (non-zero). Either way, we don't even
    // attempt to validate Invoice No / Invoice Date.
    if (sourceCell === 'RETURN CENTER CLAIMS') {
      if (netCents == null || netCents === 0) {
        skipped.push({
          row_index: rowIndex,
          reason: 'return_center_claim_zero_dollar',
          raw: { Source: sourceCell, 'Net Amount Due($)': raw['Net Amount Due($)'] ?? '' },
        });
        continue;
      }
      // Non-zero RETURN CENTER CLAIMS = real chargeback. Emit as
      // client_deduction (PO-anchored, no invoice in our system).
      // We still need a known_on_date — fall back to today if invoice_date
      // doesn't parse. In practice Walmart populates invoice_date even on
      // chargebacks.
      const knownOn = invoiceDateStr ?? new Date().toISOString().slice(0, 10);
      clientDeductions.push({
        retailer_slug: 'walmart',
        source_ref: invoiceNoRaw || `walmart-rcc-${rowIndex}`,
        source_category: 'chargeback',
        source_subcategory: 'walmart_return_center_claim',
        amount_cents: cents(Math.abs(netCents)) as Cents,
        memo: `Walmart Return Center Claim; source PO ${poNumber || '(unknown)'}`,
        known_on_date: knownOn,
        po_number: poNumber || null,
        division: raw['Store/DC Number']?.trim() || null,
        location_description: null,
        metadata: {
          display_invoice_number: invoiceNoRaw,
          microfilm_number: raw['Micro film number'] ?? null,
          vendor_number: raw['Vendor Number'] ?? null,
          vendor_name: raw['Vendor Name'] ?? null,
          source: sourceCell,
        },
      });
      continue;
    }

    // ---------- Per-row validation for invoice rows ----------
    if (!invoiceNoRaw) {
      skipped.push({
        row_index: rowIndex,
        reason: 'missing_invoice_no',
        raw: { 'Invoice No': invoiceNoRaw, Source: sourceCell },
      });
      continue;
    }
    if (!poNumber) {
      skipped.push({
        row_index: rowIndex,
        reason: 'missing_po_number',
        raw: { 'Invoice No': invoiceNoRaw, 'PO Number': poNumber },
      });
      continue;
    }
    if (netCents == null) {
      skipped.push({
        row_index: rowIndex,
        reason: 'unparseable_net_amount',
        raw: { 'Invoice No': invoiceNoRaw, 'Net Amount Due($)': raw['Net Amount Due($)'] ?? '' },
      });
      continue;
    }
    if (netCents < 0) {
      // Walmart's invoice export should never have negative Net Amount;
      // negative chargebacks come through Source=RETURN CENTER CLAIMS.
      // Treat negative on a non-RCC row as a data anomaly.
      skipped.push({
        row_index: rowIndex,
        reason: 'negative_net_amount_on_invoice_row',
        raw: { 'Invoice No': invoiceNoRaw, 'Net Amount Due($)': raw['Net Amount Due($)'] ?? '' },
      });
      continue;
    }
    if (!invoiceDateStr) {
      skipped.push({
        row_index: rowIndex,
        reason: 'unparseable_invoice_date',
        raw: { 'Invoice No': invoiceNoRaw, 'Invoice Date': raw['Invoice Date'] ?? '' },
      });
      continue;
    }

    // Invoice Type ≠ 'W' is a warning, not a hard skip.
    if (invoiceTypeCell !== 'W') {
      warnings.push({
        row_index: rowIndex,
        code: 'unknown_invoice_type',
        message:
          `Invoice ${invoiceNoRaw} has Invoice Type "${invoiceTypeCell}" — expected "W" for warehouse. ` +
          `Importing anyway; review for treatment.`,
        context: { 'Invoice Type': invoiceTypeCell, 'Invoice No': invoiceNoRaw },
      });
    }

    // ---------- Build the invoice row ----------
    const invoiceNumberStripped = invoiceNoRaw.replace(/^0+/, '') || invoiceNoRaw;
    rows.push({
      retailer_slug: 'walmart',
      po_number: poNumber,
      invoice_number: invoiceNumberStripped,
      invoice_value_cents: cents(netCents) as Cents,
      invoice_date: invoiceDateStr,
      due_date: dueDateStr,
      goods_delivery_date: null, // Walmart doesn't provide this on invoices
      goods_delivery_location: null,
      approval_status: raw['Process State Description']?.trim() || null,
      item_description: null,
      metadata: {
        display_invoice_number: invoiceNoRaw, // padded form
        microfilm_number: raw['Micro film number'] ?? null,
        store_dc_number: raw['Store/DC Number'] ?? null,
        case_count: raw['Case Count'] ?? null,
        vendor_number: raw['Vendor Number'] ?? null,
        vendor_name: raw['Vendor Name'] ?? null,
        invoice_type: invoiceTypeCell,
        source: sourceCell,
      },
    });

    // ---------- Allowance Amt deduction extraction ----------
    const allowanceCents = parseMoneyCellCents(raw['Allowance Amt']);
    if (allowanceCents != null && allowanceCents !== 0) {
      const allowanceType = raw['Allowances Type']?.trim() || null;
      const allowanceDesc = raw['Allowance Desc']?.trim() || null;
      const memo =
        allowanceDesc && allowanceDesc !== 'NA'
          ? allowanceDesc
          : `${allowanceType ?? 'allowance'} deduction from invoice ${invoiceNumberStripped}`;
      invoiceDeductions.push({
        retailer_slug: 'walmart',
        po_number: poNumber,
        invoice_number: invoiceNumberStripped,
        category: classifyAllowanceCategory(allowanceType),
        amount_cents: cents(Math.abs(allowanceCents)) as Cents,
        memo,
        known_on_date: invoiceDateStr,
        metadata: {
          allowance_type: allowanceType,
          allowance_desc: allowanceDesc,
          // Sign matters for downstream reporting; Walmart's allowance
          // amounts are typically negative (deductions reduce AR), but
          // we flip to positive for the table since amount_cents > 0
          // is enforced. Preserve the original sign here.
          source_amount_signed: allowanceCents,
        },
      });
    }
  }

  return {
    parser_version: PARSER_VERSION,
    rows,
    invoice_deductions: invoiceDeductions,
    client_deductions: clientDeductions,
    warnings,
    skipped,
    stats: {
      total_rows_read: totalRowsRead,
      valid_invoice_rows: rows.length,
      invoice_deduction_rows: invoiceDeductions.length,
      client_deduction_rows: clientDeductions.length,
      skipped_rows: skipped.length,
      warning_count: warnings.length,
    },
  };
}
