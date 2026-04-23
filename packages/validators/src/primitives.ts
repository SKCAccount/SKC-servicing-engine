/**
 * Shared Zod primitives for Sea King API boundaries.
 *
 * Use these everywhere a server action, route handler, or Edge Function
 * accepts input. Never trust the shape of incoming data without validation.
 */

import { z } from 'zod';

/** ISO calendar date "YYYY-MM-DD". */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be "YYYY-MM-DD"');

/** Non-negative integer cents. */
export const centsSchema = z.number().int().nonnegative();

/** Signed integer cents (for ledger deltas). */
export const signedCentsSchema = z.number().int();

/** Basis points (0-10000 for rates that are percentages). */
export const bpsSchema = z.number().int().min(0).max(10000);

/** UUID v4/v7. */
export const uuidSchema = z.string().uuid();

/** Non-empty trimmed string. */
export const nonEmptyStringSchema = z
  .string()
  .trim()
  .min(1, 'cannot be empty');
