'use server';

import { createSupabaseServerClient, requireAuthUser } from '@seaking/auth/server';
import { createServiceRoleClient } from '@seaking/db';
import { isAdminManager } from '@seaking/auth';
import { ok, err, type ActionResult } from '@seaking/api';
import { updateUserInputSchema, type UpdateUserInput } from '@seaking/validators';
import { supabaseError, zodError } from '@/lib/action-helpers';
import { revalidatePath } from 'next/cache';

interface UpdatedUser {
  user_id: string;
  version: number;
}

/**
 * Update a user's role, status, and Client grants.
 *
 * Admin-only. Uses service-role for the UPDATE + DELETE + INSERT operations
 * because we need to atomically replace the user's grants. We still check
 * the inviter's access rights before accepting any client_ids in the input,
 * so service-role doesn't become a privilege-escalation vector.
 */
export async function updateUserAction(
  input: UpdateUserInput,
): Promise<ActionResult<UpdatedUser>> {
  const parsed = updateUserInputSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);

  let authUser;
  try {
    authUser = await requireAuthUser();
  } catch {
    return err('UNAUTHENTICATED', 'Please sign in again.');
  }
  if (!isAdminManager(authUser.role)) {
    return err('FORBIDDEN', 'Only Admin Managers can update users.');
  }
  if (authUser.id === parsed.data.user_id) {
    return err(
      'FORBIDDEN',
      'You cannot modify your own account here. Ask another Admin Manager to make the change.',
    );
  }

  // Verify every requested client_id is one the CALLER has access to.
  const userSupabase = await createSupabaseServerClient();
  const { data: accessRows } = await userSupabase
    .from('user_client_access')
    .select('client_id')
    .eq('user_id', authUser.id);
  const callerClientIds = new Set(
    ((accessRows ?? []) as { client_id: string }[]).map((r) => r.client_id),
  );
  for (const cid of parsed.data.client_ids) {
    if (!callerClientIds.has(cid)) {
      return err('FORBIDDEN', `You do not have access to Client ${cid}.`);
    }
  }

  const admin = createServiceRoleClient();

  // Update users row with optimistic locking.
  const { data: updated, error: updateError } = await admin
    .from('users')
    .update({
      role: parsed.data.role,
      status: parsed.data.status,
      client_id: parsed.data.role === 'client' ? parsed.data.client_ids[0] : null,
    })
    .eq('id', parsed.data.user_id)
    .eq('version', parsed.data.expected_version)
    .select('id, version')
    .maybeSingle();

  if (updateError) return supabaseError(updateError);
  if (!updated) {
    return err(
      'OPTIMISTIC_LOCK',
      'This user was updated by someone else while you were editing. Refresh and try again.',
    );
  }
  const row = updated as { id: string; version: number };

  // Replace grants if the role is a manager role. For client role, grants
  // are stored on the users.client_id column, so we clear user_client_access
  // to keep the tables consistent.
  const { error: delError } = await admin
    .from('user_client_access')
    .delete()
    .eq('user_id', parsed.data.user_id);
  if (delError) return supabaseError(delError);

  if (parsed.data.role !== 'client' && parsed.data.client_ids.length > 0) {
    const rows = parsed.data.client_ids.map((client_id) => ({
      user_id: parsed.data.user_id,
      client_id,
      granted_by: authUser.id,
    }));
    const { error: insError } = await admin.from('user_client_access').insert(rows);
    if (insError) return supabaseError(insError);
  }

  revalidatePath('/users');
  revalidatePath(`/users/${parsed.data.user_id}`);
  return ok({ user_id: row.id, version: row.version });
}
