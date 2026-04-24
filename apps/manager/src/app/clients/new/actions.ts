'use server';

import { createSupabaseServerClient, requireAuthUser } from '@seaking/auth/server';
import { isAdminManager } from '@seaking/auth';
import { ok, err, type ActionResult } from '@seaking/api';
import { createClientInputSchema, type CreateClientInput } from '@seaking/validators';
import { supabaseError, zodError } from '@/lib/action-helpers';
import { revalidatePath } from 'next/cache';

interface CreatedClient {
  id: string;
  display_name: string;
}

/**
 * Insert a new `clients` row AND grant the current Admin Manager access via
 * `user_client_access`. Both writes go through the authenticated Supabase
 * client — RLS confirms the caller is an Admin Manager.
 *
 * If the user_client_access insert fails for any reason AFTER the client row
 * is created, we surface the error but leave the client in place. Cleanup is
 * a manual operation: the admin can delete the client from Supabase Studio,
 * or hit the edit page and flip status to 'inactive'. We avoid silently
 * rolling back because it could mask a real RLS misconfiguration.
 */
export async function createClientAction(
  input: CreateClientInput,
): Promise<ActionResult<CreatedClient>> {
  const parsed = createClientInputSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);

  let authUser;
  try {
    authUser = await requireAuthUser();
  } catch {
    return err('UNAUTHENTICATED', 'Please sign in again.');
  }

  if (!isAdminManager(authUser.role)) {
    return err('FORBIDDEN', 'Only Admin Managers can create Clients.');
  }

  const supabase = await createSupabaseServerClient();

  const { data: inserted, error: insertError } = await supabase
    .from('clients')
    .insert({
      legal_name: parsed.data.legal_name,
      display_name: parsed.data.display_name,
      status: parsed.data.status,
    })
    .select('id, display_name')
    .single();

  if (insertError || !inserted) {
    return supabaseError(insertError ?? { message: 'Unknown insert failure' });
  }

  const newClient = inserted as { id: string; display_name: string };

  const { error: grantError } = await supabase.from('user_client_access').insert({
    user_id: authUser.id,
    client_id: newClient.id,
    granted_by: authUser.id,
  });

  if (grantError) {
    return err(
      'PARTIAL_SUCCESS',
      `Client "${newClient.display_name}" was created, but granting you access failed: ${grantError.message}. ` +
        'You may need to add the user_client_access row manually.',
    );
  }

  revalidatePath('/clients');
  return ok(newClient);
}
