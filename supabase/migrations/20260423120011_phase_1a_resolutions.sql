-- ============================================================================
-- 0011_phase_1a_resolutions.sql
--
-- Resolves five Phase-1A spec ambiguities (documented in CLAUDE.md §Open
-- questions). Grouped into one migration to keep the pre-scaffold migration
-- history tight.
--
-- 1. Pre-advance `purchase_order_id` — drop NOT NULL; add conditional CHECK so
--    only pre_advance rows may omit it.
-- 2. Pre-advance borrowing base — exclude aged-out AR principal from the base.
-- 3. Invoices must have a date — ALTER COLUMN ... SET NOT NULL.
-- 4. Walmart "Closed" without invoice — add po_status value
--    `closed_awaiting_invoice`.
-- 5. One-time fee polymorphic target validation — BEFORE INSERT/UPDATE trigger
--    verifies target_id resolves against the right table.
-- ============================================================================

-- ---------- 1. Pre-advance purchase_order_id nullability ----------
-- Remove the NOT NULL, add a conditional check: only pre_advance can have NULL.
-- PO and AR advances must still point at a concrete PO.

ALTER TABLE advances
  ALTER COLUMN purchase_order_id DROP NOT NULL;

ALTER TABLE advances
  ADD CONSTRAINT advances_po_id_required_for_po_and_ar CHECK (
    (advance_type = 'pre_advance') OR (purchase_order_id IS NOT NULL)
  );

-- The "advances_ar_has_invoice" check from 0003 is unchanged; AR still
-- requires invoice_id.

-- ---------- 2. Pre-advance borrowing base — exclude aged-out ----------
-- Rewrite mv_client_position to compute pre_advance_borrowing_base from
-- the eligible-AR pool (same filter the AR borrowing base uses), not the
-- raw AR principal outstanding.

DROP MATERIALIZED VIEW mv_client_position;

CREATE MATERIALIZED VIEW mv_client_position AS
WITH
  po_outstanding AS (
    SELECT
      a.client_id,
      SUM(CASE WHEN a.advance_type = 'po'
               THEN mab.principal_outstanding_cents ELSE 0 END) AS po_principal_cents,
      SUM(CASE WHEN a.advance_type = 'ar'
               THEN mab.principal_outstanding_cents ELSE 0 END) AS ar_principal_cents,
      SUM(CASE WHEN a.advance_type = 'pre_advance'
               THEN mab.principal_outstanding_cents ELSE 0 END) AS pre_advance_principal_cents,
      SUM(mab.fees_outstanding_cents)                           AS total_fees_cents,
      -- NEW: AR principal from NON-aged-out invoices only. This is the pool
      -- the pre-advance base draws against.
      SUM(CASE
          WHEN a.advance_type = 'ar'
            AND a.invoice_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM mv_invoice_aging mia
              WHERE mia.invoice_id = a.invoice_id AND mia.is_aged_out = false
            )
          THEN mab.principal_outstanding_cents ELSE 0 END)      AS eligible_ar_principal_cents
    FROM advances a
    JOIN mv_advance_balances mab ON mab.advance_id = a.id
    WHERE a.status IN ('committed', 'funded')
    GROUP BY a.client_id
  ),
  po_values AS (
    SELECT
      po.client_id,
      SUM(po.po_value_cents) FILTER (
        WHERE po.status IN ('active', 'partially_invoiced', 'closed_awaiting_invoice')
      ) AS active_po_value_cents
    FROM purchase_orders po
    GROUP BY po.client_id
  ),
  ar_values AS (
    SELECT
      mia.client_id,
      SUM(mia.effective_invoice_value_cents) FILTER (
        WHERE mia.paid_in_full_date IS NULL AND mia.is_aged_out = false
      ) AS eligible_ar_value_cents
    FROM mv_invoice_aging mia
    GROUP BY mia.client_id
  ),
  remittance_balance AS (
    SELECT
      e.client_id,
      COALESCE(SUM(e.remittance_delta_cents), 0) AS remittance_balance_cents
    FROM ledger_events e
    WHERE e.reversed_by_event_id IS NULL
    GROUP BY e.client_id
  )
SELECT
  c.id                                                   AS client_id,
  c.display_name,
  COALESCE(po_out.po_principal_cents, 0)                 AS po_principal_outstanding_cents,
  COALESCE(po_out.ar_principal_cents, 0)                 AS ar_principal_outstanding_cents,
  COALESCE(po_out.pre_advance_principal_cents, 0)        AS pre_advance_principal_outstanding_cents,
  COALESCE(po_out.po_principal_cents, 0)
    + COALESCE(po_out.ar_principal_cents, 0)
    + COALESCE(po_out.pre_advance_principal_cents, 0)    AS total_principal_outstanding_cents,
  COALESCE(po_out.total_fees_cents, 0)                   AS total_fees_outstanding_cents,
  COALESCE(pov.active_po_value_cents, 0)                 AS active_po_value_cents,
  COALESCE(arv.eligible_ar_value_cents, 0)               AS eligible_ar_value_cents,
  -- Borrowing bases from current rule_set
  (COALESCE(pov.active_po_value_cents, 0)
    * (SELECT po_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
                                                         AS po_borrowing_base_cents,
  (COALESCE(arv.eligible_ar_value_cents, 0)
    * (SELECT ar_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
                                                         AS ar_borrowing_base_cents,
  -- Pre-advance base now uses ELIGIBLE (non-aged-out) AR principal, not raw.
  (COALESCE(po_out.eligible_ar_principal_cents, 0)
    * (SELECT pre_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
                                                         AS pre_advance_borrowing_base_cents,
  -- Available (base minus outstanding)
  GREATEST(
    (COALESCE(pov.active_po_value_cents, 0)
      * (SELECT po_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
    - COALESCE(po_out.po_principal_cents, 0),
    0
  )                                                      AS po_borrowing_base_available_cents,
  GREATEST(
    (COALESCE(arv.eligible_ar_value_cents, 0)
      * (SELECT ar_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
    - COALESCE(po_out.ar_principal_cents, 0),
    0
  )                                                      AS ar_borrowing_base_available_cents,
  GREATEST(
    (COALESCE(po_out.eligible_ar_principal_cents, 0)
      * (SELECT pre_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
    - COALESCE(po_out.pre_advance_principal_cents, 0),
    0
  )                                                      AS pre_advance_borrowing_base_available_cents,
  COALESCE(rb.remittance_balance_cents, 0)               AS remittance_balance_cents,
  -- Over Advanced: total principal > total borrowing base across all types
  (
    (COALESCE(po_out.po_principal_cents, 0)
      + COALESCE(po_out.ar_principal_cents, 0)
      + COALESCE(po_out.pre_advance_principal_cents, 0))
    >
    (
      (COALESCE(pov.active_po_value_cents, 0)
        * (SELECT po_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
      + (COALESCE(arv.eligible_ar_value_cents, 0)
        * (SELECT ar_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
      + (COALESCE(po_out.eligible_ar_principal_cents, 0)
        * (SELECT pre_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
    )
  )                                                      AS is_over_advanced
FROM clients c
LEFT JOIN po_outstanding po_out ON po_out.client_id = c.id
LEFT JOIN po_values pov         ON pov.client_id = c.id
LEFT JOIN ar_values arv         ON arv.client_id = c.id
LEFT JOIN remittance_balance rb ON rb.client_id = c.id;

CREATE UNIQUE INDEX mv_client_position_pk ON mv_client_position(client_id);

-- ---------- 3. Invoices require a date ----------
-- No existing rows yet, so SET NOT NULL is a clean promotion.

ALTER TABLE invoices
  ALTER COLUMN invoice_date SET NOT NULL;

-- ---------- 4. po_status: closed_awaiting_invoice ----------
-- Walmart sometimes marks a PO "Closed" before invoices are available to us.
-- This status captures that intermediate state so we don't wrongly show the
-- PO as still-active in advance-selection UIs while also not yet treating it
-- as fully invoiced.

ALTER TYPE po_status ADD VALUE IF NOT EXISTS 'closed_awaiting_invoice';

-- ---------- 5. One-time fee polymorphic target validation ----------
-- Verify target_id resolves against the table implied by target_type.
-- Client-level fees (target_type = 'client') have target_id = NULL; the
-- 0003 CHECK constraint already handles that case.

CREATE OR REPLACE FUNCTION validate_one_time_fee_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_exists boolean;
BEGIN
  IF NEW.target_type = 'client' THEN
    -- client-level fees have target_id = NULL enforced by 0003 check; nothing
    -- further to verify (the client_id column itself points at clients.id).
    RETURN NEW;
  END IF;

  CASE NEW.target_type
    WHEN 'advance' THEN
      SELECT EXISTS (SELECT 1 FROM advances WHERE id = NEW.target_id AND client_id = NEW.client_id)
        INTO v_exists;
    WHEN 'purchase_order' THEN
      SELECT EXISTS (SELECT 1 FROM purchase_orders WHERE id = NEW.target_id AND client_id = NEW.client_id)
        INTO v_exists;
    WHEN 'invoice' THEN
      SELECT EXISTS (
        SELECT 1 FROM invoices i
        JOIN purchase_orders po ON po.id = i.purchase_order_id
        WHERE i.id = NEW.target_id AND po.client_id = NEW.client_id
      ) INTO v_exists;
    WHEN 'batch' THEN
      SELECT EXISTS (SELECT 1 FROM batches WHERE id = NEW.target_id AND client_id = NEW.client_id)
        INTO v_exists;
    ELSE
      RAISE EXCEPTION 'Unknown one_time_fees.target_type: %', NEW.target_type;
  END CASE;

  IF NOT v_exists THEN
    RAISE EXCEPTION
      'one_time_fees.target_id % does not resolve to an existing % for client %',
      NEW.target_id, NEW.target_type, NEW.client_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_one_time_fees_validate_target
  BEFORE INSERT OR UPDATE ON one_time_fees
  FOR EACH ROW EXECUTE FUNCTION validate_one_time_fee_target();
