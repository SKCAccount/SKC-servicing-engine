/**
 * Client-entity input schemas.
 *
 * Mirrors the `clients` table (migration 0002). Used by server actions in
 * apps/manager and any future API endpoints.
 */

import { z } from 'zod';
import { nonEmptyStringSchema, uuidSchema } from './primitives';

export const clientStatusSchema = z.enum(['active', 'inactive', 'paused']);
export type ClientStatus = z.infer<typeof clientStatusSchema>;

/** Shape accepted by `Create Client`. */
export const createClientInputSchema = z.object({
  legal_name: nonEmptyStringSchema.max(200),
  display_name: nonEmptyStringSchema.max(80),
  status: clientStatusSchema.default('active'),
});
export type CreateClientInput = z.infer<typeof createClientInputSchema>;

/** Shape accepted by `Edit Client`. Includes the version for optimistic locking. */
export const updateClientInputSchema = z.object({
  id: uuidSchema,
  legal_name: nonEmptyStringSchema.max(200),
  display_name: nonEmptyStringSchema.max(80),
  status: clientStatusSchema,
  // The version number the user was editing against; the DB write will reject
  // if the row has been updated since.
  expected_version: z.number().int().positive(),
});
export type UpdateClientInput = z.infer<typeof updateClientInputSchema>;
