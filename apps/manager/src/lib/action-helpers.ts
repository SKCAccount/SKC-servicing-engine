/**
 * Small helpers used by Server Actions in the Manager app.
 *
 * Normalizes errors coming out of Supabase / Zod into the shared
 * `ActionResult<T>` shape from @seaking/api, so client components can
 * destructure `{ ok, data }` | `{ ok, error }` without caring about the
 * source of the failure.
 */

import 'server-only';
import { err, type ActionError } from '@seaking/api';
import type { z } from '@seaking/validators';

/** Map a ZodError into our fieldErrors-shaped ActionError. */
export function zodError(zerr: z.ZodError): ActionError {
  const flat = zerr.flatten();
  const fieldErrors: Record<string, string[]> = {};
  for (const [key, messages] of Object.entries(flat.fieldErrors)) {
    const msgs = messages as string[] | undefined;
    if (msgs && msgs.length > 0) {
      fieldErrors[key] = msgs;
    }
  }
  const formMessage = flat.formErrors[0] ?? 'Invalid input';
  return err('VALIDATION', formMessage, fieldErrors);
}

/** Standard Supabase-error translator. Preserves the Postgres error code where available. */
export function supabaseError(e: { message: string; code?: string | undefined }): ActionError {
  return err(e.code ?? 'DB_ERROR', e.message);
}
