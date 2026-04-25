/**
 * Download endpoint for the CSV-of-PO-numbers advance template.
 *
 * Spec: docs/01_FUNCTIONAL_SPEC.md §"Advancing Purchase Orders" → Secondary
 * Option. Two columns: Purchase Order Number, Retailer.
 *
 * The header is sourced from PO_NUMBERS_TEMPLATE_HEADER in
 * @seaking/retailer-parsers/advance-csv/po-numbers so the template can
 * NEVER drift from the columns the parser understands. Same pattern as
 * /api/po-template/generic.
 */

import { PO_NUMBERS_TEMPLATE_HEADER } from '@seaking/retailer-parsers/advance-csv/po-numbers';

export async function GET(): Promise<Response> {
  // Header row + a representative example row to make the file usable
  // without checking the spec. Manager deletes the example before pasting
  // their own data.
  const body =
    `${PO_NUMBERS_TEMPLATE_HEADER}\n` +
    'EXAMPLE-PO-12345,Walmart\n';

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="advance-po-numbers-template.csv"',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
