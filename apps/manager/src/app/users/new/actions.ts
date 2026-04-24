'use server';

import { createSupabaseServerClient, requireAuthUser } from '@seaking/auth/server';
import { createServiceRoleClient } from '@seaking/db';
import { isAdminManager } from '@seaking/auth';
import { ok, err, type ActionResult } from '@seaking/api';
import { inviteUserInputSchema, type InviteUserInput } from '@seaking/validators';
import { supabaseError, zodError } from '@/lib/action-helpers';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

interface InvitedUser {
  user_id: string;
  email: string;
}

/**
 * Invite a new user and seed their Sea King application row.
 *
 * Steps (NOT a SQL transaction — Supabase Auth lives outside the DB):
 *   1. Authorize: caller must be Admin Manager.
 *   2. Defense-in-depth: verify every requested client_id is one the
 *      inviter actually has access to. Service-role operations that
 *      follow would otherwise bypass RLS and let a compromised session
 *      grant access to arbitrary Clients.
 *   3. Service-role call: supabase.auth.admin.inviteUserByEmail(email).
 *      Creates the auth.users row and sends the invite email via Supabase
 *      Auth's built-in mailer. `redirectTo` returns the invitee to
 *      /auth/callback, which exchanges the code and sends them to
 *      /auth/set-password.
 *   4. Insert public.users row (role + client_id for client role).
 *   5. For manager roles: insert user_client_access rows for each
 *      selected client. granted_by = inviter.
 *
 * Partial failure handling: if step 3 succeeds but step 4 or 5 fails, the
 * auth user exists without a Sea King row. We surface the error and log
 * enough context for the admin to finish setup manually (or re-invite).
 * We avoid auto-deleting the auth user on partial failure because the
 * invitee may have already clicked the email link by the time we notice.
 */
export async function inviteUserAction(
  input: InviteUserInput,
): Promise<ActionResult<InvitedUser>> {
  const parsed = inviteUserInputSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);

  let authUser;
  try {
    authUser = await requireAuthUser();
  } catch {
    return err('UNAUTHENTICATED', 'Please sign in again.');
  }
  if (!isAdminManager(authUser.role)) {
    return err('FORBIDDEN', 'Only Admin Managers can invite users.');
  }

  // Defense-in-depth: make sure the inviter can grant access to every client
  // they're asking to grant. Without this, a compromised admin session could
  // leak another tenant's data through the grants table.
  const userSupabase = await createSupabaseServerClient();
  const { data: accessRows } = await userSupabase
    .from('user_client_access')
    .select('client_id')
    .eq('user_id', authUser.id);

  const inviterClientIds = new Set(
    ((accessRows ?? []) as { client_id: string }[]).map((r) => r.client_id),
  );
  for (const cid of parsed.data.client_ids) {
    if (!inviterClientIds.has(cid)) {
      return err(
        'FORBIDDEN',
        `You do not have access to Client ${cid}, so you cannot grant it to a new user.`,
      );
    }
  }

  // Determine the callback URL for the invite email. Use the request's own
  // host so invites from localhost dev, staging, and prod all resolve
  // correctly without per-env config.
  const hdrs = await headers();
  const host = hdrs.get('host') ?? 'localhost:3000';
  const proto = hdrs.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const origin = `${proto}://${host}`;
  const redirectTo = `${origin}/auth/callback?next=/auth/set-password`;

  // 1. Send the invite via service-role admin API.
  const admin = createServiceRoleClient();
  const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
    parsed.data.email,
    { redirectTo },
  );
  if (inviteError || !inviteData?.user) {
    return supabaseError(inviteError ?? { message: 'Unknown invite failure' });
  }
  const newAuthUserId = inviteData.user.id;

  // 2. Insert the public.users row.
  const { error: userInsertError } = await admin.from('users').insert({
    id: newAuthUserId,
    email: parsed.data.email,
    role: parsed.data.role,
    client_id: parsed.data.role === 'client' ? parsed.data.client_ids[0] : null,
    status: 'active',
  });
  if (userInsertError) {
    return err(
      'PARTIAL_SUCCESS',
      `Invite email sent to ${parsed.data.email}, but creating their app record failed: ${userInsertError.message}. ` +
        `You can finish setup in Supabase Studio by inserting the public.users row manually.`,
    );
  }

  // 3. For manager roles: insert user_client_access rows.
  if (parsed.data.role !== 'client' && parsed.data.client_ids.length > 0) {
    const grantRows = parsed.data.client_ids.map((client_id) => ({
      user_id: newAuthUserId,
      client_id,
      granted_by: authUser.id,
    }));
    const { error: grantError } = await admin.from('user_client_access').insert(grantRows);
    if (grantError) {
      return err(
        'PARTIAL_SUCCESS',
        `User created, but granting Client access failed: ${grantError.message}. ` +
          `You can grant access manually from the user's edit page.`,
      );
    }
  }

  revalidatePath('/users');
  return ok({ user_id: newAuthUserId, email: parsed.data.email });
}
