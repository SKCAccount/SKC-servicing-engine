/**
 * Download endpoint for the Generic CSV PO template.
 *
 * The file served here is built at request time from the
 * GENERIC_PO_TEMPLATE_HEADER constant in @seaking/retailer-parsers so the
 * template can NEVER drift from the columns the parser understands.
 * Adding/removing a column in the parser automatically updates the download.
 *
 * Authentication: route is open to any authenticated user. The template
 * itself has no customer data — it's just a header row — so we don't gate
 * it by role. If someone without credentials hits it, Next's middleware
 * (apps/manager/middleware.ts) will have already short-circuited.
 */

import { GENERIC_PO_TEMPLATE_HEADER } from '@seaking/retailer-parsers/generic/purchase-orders';

export async function GET(): Promise<Response> {
  // Bare header row + trailing newline. Writing a new Excel/Sheets workbook
  // from this file produces a 1-row sheet with just the headers; the Manager
  // fills in rows 2+ with their PO data and re-saves as CSV.
  const body = `${GENERIC_PO_TEMPLATE_HEADER}\n`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      // Inline filename so browsers default to 'generic-po-template.csv' in
      // the Save dialog rather than 'generic'.
      'Content-Disposition': 'attachment; filename="generic-po-template.csv"',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
