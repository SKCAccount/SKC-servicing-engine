/**
 * Kroger Purchase Order parser — STUB.
 *
 * Per 03_PARSERS.md: the Kroger PO file was not yet available at spec
 * freeze. Invoice and payment parsers are specified; PO parser is stubbed
 * until a real sample arrives. Until then, Kroger POs must be created
 * manually via the generic CSV template.
 *
 * When the real file arrives, replace this export with a real parser and
 * update `03_PARSERS.md` with the column mapping.
 */

import type { NormalizedPoRecord, ParseResult, ParserInput } from '../../types';

export const PARSER_VERSION = 'kroger-po/0.0.0-stub';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function parseKrogerPurchaseOrders(_input: ParserInput): ParseResult<NormalizedPoRecord> {
  throw new Error(
    'Kroger PO parser not yet specified. Provide a sample Kroger PO export to Derek to complete ' +
      'this parser. In the meantime, upload Kroger POs via the generic CSV template.',
  );
}
