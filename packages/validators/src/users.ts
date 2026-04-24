/**
 * User-invitation and user-management input schemas.
 */

import { z } from 'zod';
import { nonEmptyStringSchema, uuidSchema } from './primitives';

export const userRoleSchema = z.enum([
  'admin_manager',
  'operator',
  'client',
  'investor',
  'creditor',
]);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Shape accepted by "Invite a user" from the Manager app. */
export const inviteUserInputSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    // Phase 1B invites are limited to the three roles that have UI.
    // Investor/Creditor are stubs — invite them directly in Supabase Studio
    // until their UI ships.
    role: z.enum(['admin_manager', 'operator', 'client']),
    // For Client role: exactly one client_id. For manager roles: zero or
    // more. Validated more strictly by `.refine` below.
    client_ids: z.array(uuidSchema),
  })
  .refine(
    (v) => {
      if (v.role === 'client') return v.client_ids.length === 1;
      // Managers may technically be invited with no grants; they'll just
      // see an empty Client Selection until an Admin grants access. That's
      // legitimate for an onboarding operator whose Client list will be
      // decided later.
      return true;
    },
    {
      message: 'Client users must be assigned to exactly one Client.',
      path: ['client_ids'],
    },
  );
export type InviteUserInput = z.infer<typeof inviteUserInputSchema>;

/** Shape accepted by "Update user" — role change, grants change, or deactivate. */
export const updateUserInputSchema = z
  .object({
    user_id: uuidSchema,
    role: z.enum(['admin_manager', 'operator', 'client']),
    client_ids: z.array(uuidSchema),
    status: z.enum(['active', 'disabled']),
    expected_version: z.number().int().positive(),
  })
  .refine(
    (v) => {
      if (v.role === 'client') return v.client_ids.length === 1;
      return true;
    },
    {
      message: 'Client users must be assigned to exactly one Client.',
      path: ['client_ids'],
    },
  );
export type UpdateUserInput = z.infer<typeof updateUserInputSchema>;

// Re-exported here but declared purely for validator-side use; runtime
// role helpers live in @seaking/auth.
export const nonEmptyDisplayName = nonEmptyStringSchema.max(80);
