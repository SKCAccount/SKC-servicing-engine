/**
 * Kroger Invoice parser — Phase 1E.
 * Spec lives in 03_PARSERS.md §Kroger Invoices. Splits into three categories:
 * Warehouse → invoices, Promo Allowances → client_deductions, Non-Promo
 * Receivable → client_deductions.
 */
export const PARSER_VERSION = 'kroger-invoice/0.0.0-pending';
