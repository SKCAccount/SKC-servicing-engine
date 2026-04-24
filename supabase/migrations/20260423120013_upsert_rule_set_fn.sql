-- ============================================================================
-- 0013_upsert_rule_set_fn.sql
--
-- Helper RPC for "Set Borrowing Base and Fee Rules".
--
-- rule_sets are IMMUTABLE snapshots (per spec: fees are frozen at advance
-- creation via advance.rule_set_id, while borrowing base rates read the
-- currently-active snapshot retroactively). To "change" rules, we close the
-- current row by setting effective_to = today, then insert a new row with
-- effective_to = NULL.
--
-- The unique index uq_rule_sets_one_active_per_client enforces that only
-- one row per client has effective_to IS NULL at any moment. So we MUST
-- close the old one before inserting the new one. If the INSERT failed and
-- we'd already closed the old row, the client would briefly have zero
-- active rule sets — a state that would break mv_client_position reads.
--
-- Wrapping this in a plpgsql function gives us atomicity: either both
-- statements commit or both roll back.
-- ============================================================================

CREATE OR REPLACE FUNCTION upsert_rule_set(
  p_client_id uuid,
  -- Fee rules
  p_period_1_days int,
  p_period_1_fee_rate_bps int,
  p_period_2_days int,
  p_period_2_fee_rate_bps int,
  p_subsequent_period_days int,
  p_subsequent_period_fee_rate_bps int,
  -- Borrowing base
  p_po_advance_rate_bps int,
  p_ar_advance_rate_bps int,
  p_pre_advance_rate_bps int,
  p_ar_aged_out_days int,
  p_aged_out_warning_lead_days int,
  p_aged_out_warnings_enabled boolean,
  -- Payment allocation (must sum to 10000)
  p_payment_allocation_principal_bps int,
  p_payment_allocation_fee_bps int
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_new_id uuid;
  v_today  date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  -- Safety: function will fail via CHECK constraint on insert if allocations
  -- don't sum to 10000, but a friendlier error helps.
  IF p_payment_allocation_principal_bps + p_payment_allocation_fee_bps <> 10000 THEN
    RAISE EXCEPTION 'Payment allocation must sum to 10000 bps (100%%); got % principal + % fees',
      p_payment_allocation_principal_bps, p_payment_allocation_fee_bps;
  END IF;

  -- Close the currently-active rule set for this Client, if any. If none
  -- exists (first-time setup), this UPDATE affects zero rows — no problem.
  UPDATE rule_sets
     SET effective_to = v_today
   WHERE client_id = p_client_id
     AND effective_to IS NULL;

  -- Insert the new active rule set. RLS is enforced by the invoker's role
  -- (rule_sets_write policy requires is_admin_manager()).
  INSERT INTO rule_sets (
    client_id, effective_from, effective_to, created_by,
    period_1_days, period_1_fee_rate_bps,
    period_2_days, period_2_fee_rate_bps,
    subsequent_period_days, subsequent_period_fee_rate_bps,
    po_advance_rate_bps, ar_advance_rate_bps, pre_advance_rate_bps,
    ar_aged_out_days, aged_out_warning_lead_days, aged_out_warnings_enabled,
    payment_allocation_principal_bps, payment_allocation_fee_bps
  ) VALUES (
    p_client_id, v_today, NULL, auth.uid(),
    p_period_1_days, p_period_1_fee_rate_bps,
    p_period_2_days, p_period_2_fee_rate_bps,
    p_subsequent_period_days, p_subsequent_period_fee_rate_bps,
    p_po_advance_rate_bps, p_ar_advance_rate_bps, p_pre_advance_rate_bps,
    p_ar_aged_out_days, p_aged_out_warning_lead_days, p_aged_out_warnings_enabled,
    p_payment_allocation_principal_bps, p_payment_allocation_fee_bps
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

-- Grant execute to authenticated users; RLS on rule_sets still applies to
-- the INSERT inside the function (because SECURITY INVOKER, not DEFINER).
GRANT EXECUTE ON FUNCTION upsert_rule_set(
  uuid, int, int, int, int, int, int,
  int, int, int, int, int, boolean,
  int, int
) TO authenticated;
