/**
 * rule_sets input schemas.
 *
 * Input uses percent (0-100) and days (int ≥ 1). Conversion to basis points
 * happens in the server action just before the RPC call, so the UI layer
 * doesn't have to think in bps.
 */

import { z } from 'zod';
import { uuidSchema } from './primitives';

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

/** A percent value 0-100 with up to 2 decimal places; stored as basis points. */
const percentSchema = z
  .number()
  .min(0)
  .max(100)
  .refine((v) => Math.round(v * 100) / 100 === v, {
    message: 'At most 2 decimal places',
  });

export const ruleSetInputSchema = z
  .object({
    client_id: uuidSchema,

    // Fee period lengths (days)
    period_1_days: positiveInt,
    period_2_days: positiveInt,
    subsequent_period_days: positiveInt,

    // Fee rates (percent; converted to bps before DB)
    period_1_fee_rate_pct: percentSchema,
    period_2_fee_rate_pct: percentSchema,
    subsequent_period_fee_rate_pct: percentSchema,

    // Borrowing base rates
    po_advance_rate_pct: percentSchema,
    ar_advance_rate_pct: percentSchema,
    pre_advance_rate_pct: percentSchema,

    // Aged-out handling
    ar_aged_out_days: positiveInt,
    aged_out_warning_lead_days: nonNegativeInt,
    aged_out_warnings_enabled: z.boolean(),

    // Payment allocation (must sum to 100)
    payment_allocation_principal_pct: percentSchema,
    payment_allocation_fee_pct: percentSchema,
  })
  .refine(
    (v) =>
      Math.round(v.payment_allocation_principal_pct * 100) +
        Math.round(v.payment_allocation_fee_pct * 100) ===
      10000,
    {
      message: 'Payment allocation % to Principal + % to Fees must sum to 100',
      path: ['payment_allocation_principal_pct'],
    },
  );

export type RuleSetInput = z.infer<typeof ruleSetInputSchema>;

/** Percent (0-100) → basis points (0-10000), rounded to the nearest integer. */
export function pctToBps(pct: number): number {
  return Math.round(pct * 100);
}

/** Basis points → percent with 2 decimal places preserved. */
export function bpsToPct(bps: number): number {
  return bps / 100;
}
