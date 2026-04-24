'use server';

import { createSupabaseServerClient, requireAuthUser } from '@seaking/auth/server';
import { isAdminManager } from '@seaking/auth';
import { ok, err, type ActionResult } from '@seaking/api';
import { updateClientInputSchema, type UpdateClientInput } from '@seaking/validators';
import { supabaseError, zodError } from '@/lib/action-helpers';
import { revalidatePath } from 'next/cache';

interface UpdatedClient {
  id: string;
  version: number;
}

/**
 * Update a client row with optimistic locking.
 *
 * We include `version = expected_version` in the WHERE clause. If another
 * admin updated the row in the meantime (bumping version), zero rows match
 * and we return OPTIMISTIC_LOCK so the UI can fetch the current state and
 * show the user what changed.
 *
 * The `set_updated_at` trigger increments `version` on every UPDATE.
 */
export async function updateClientAction(
  input: UpdateClientInput,
): Promise<ActionResult<UpdatedClient>> {
  const parsed = updateClientInputSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);

  let authUser;
  try {
    authUser = await requireAuthUser();
  } catch {
    return err('UNAUTHENTICATED', 'Please sign in again.');
  }

  if (!isAdminManager(authUser.role)) {
    return err('FORBIDDEN', 'Only Admin Managers can edit Clients.');
  }

  const supabase = await createSupabaseServerClient();

  const { data: updated, error: updateError } = await supabase
    .from('clients')
    .update({
      legal_name: parsed.data.legal_name,
      display_name: parsed.data.display_name,
      status: parsed.data.status,
    })
    .eq('id', parsed.data.id)
    .eq('version', parsed.data.expected_version)
    .select('id, version')
    .maybeSingle();

  if (updateError) {
    return supabaseError(updateError);
  }
  if (!updated) {
    return err(
      'OPTIMISTIC_LOCK',
      'This Client was updated by someone else while you were editing. Refresh to see the latest values, then re-apply your changes.',
    );
  }

  const row = updated as { id: string; version: number };

  revalidatePath('/clients');
  revalidatePath(`/clients/${row.id}`);
  return ok(row);
}
