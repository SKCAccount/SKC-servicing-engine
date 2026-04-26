/**
 * Public surface for @seaking/retailer-parsers.
 *
 * Individual parsers are exported via subpath imports
 * (e.g. import { parseWalmartPurchaseOrders } from '@seaking/retailer-parsers/walmart/purchase-orders')
 * so apps pull only what they use. This module only re-exports the shared
 * types that cross parser boundaries.
 */

export type {
  ParseContext,
  ParseResult,
  ParseWarning,
  ParserInput,
  PoStatus,
  PoLineStatus,
  CancellationReason,
  NormalizedPoRecord,
  NormalizedPoLineRecord,
  NormalizedInvoiceRecord,
  NormalizedInvoiceDeductionRecord,
  NormalizedClientDeductionRecord,
  SkippedRow,
} from './types';

export { toText } from './types';
