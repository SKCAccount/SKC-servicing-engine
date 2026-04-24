'use server';

import { createSupabaseServerClient, requireAuthUser } from '@seaking/auth/server';
import { isAdminManager } from '@seaking/auth';
import { ok, err, type ActionResult } from '@seaking/api';
import { ruleSetInputSchema, type RuleSetInput, pctToBps } from '@seaking/validators';
import { supabaseError, zodError } from '@/lib/action-helpers';
import { revalidatePath } from 'next/cache';

/**
 * Upsert the active rule_set for a Client.
 *
 * Delegates the actual SQL to the `upsert_rule_set` Postgres function
 * (migration 0013), which atomically closes the currently-active row
 * (effective_to = today) and inserts a new one. Atomicity is required to
 * avoid briefly violating the "at most one active rule_set per client"
 * invariant.
 */
export async function upsertRuleSetAction(
  input: RuleSetInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = ruleSetInputSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);

  let authUser;
  try {
    authUser = await requireAuthUser();
  } catch {
    return err('UNAUTHENTICATED', 'Please sign in again.');
  }
  if (!isAdminManager(authUser.role)) {
    return err('FORBIDDEN', 'Only Admin Managers can set rules.');
  }

  const p = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('upsert_rule_set', {
    p_client_id: p.client_id,
    p_period_1_days: p.period_1_days,
    p_period_1_fee_rate_bps: pctToBps(p.period_1_fee_rate_pct),
    p_period_2_days: p.period_2_days,
    p_period_2_fee_rate_bps: pctToBps(p.period_2_fee_rate_pct),
    p_subsequent_period_days: p.subsequent_period_days,
    p_subsequent_period_fee_rate_bps: pctToBps(p.subsequent_period_fee_rate_pct),
    p_po_advance_rate_bps: pctToBps(p.po_advance_rate_pct),
    p_ar_advance_rate_bps: pctToBps(p.ar_advance_rate_pct),
    p_pre_advance_rate_bps: pctToBps(p.pre_advance_rate_pct),
    p_ar_aged_out_days: p.ar_aged_out_days,
    p_aged_out_warning_lead_days: p.aged_out_warning_lead_days,
    p_aged_out_warnings_enabled: p.aged_out_warnings_enabled,
    p_payment_allocation_principal_bps: pctToBps(p.payment_allocation_principal_pct),
    p_payment_allocation_fee_bps: pctToBps(p.payment_allocation_fee_pct),
  });

  if (error) return supabaseError(error);

  revalidatePath(`/clients/${p.client_id}`);
  revalidatePath(`/clients/${p.client_id}/rules`);
  return ok({ id: String(data) });
}
