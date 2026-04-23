-- ============================================================================
-- 0005_projections.sql
-- Materialized views deriving current state from ledger_events + reference data.
-- Refreshed by background job on event insert; diff-audited daily.
-- ============================================================================

-- ---------- Re-assert helper functions with explicit search_path ----------
-- CREATE MATERIALIZED VIEW inlines SQL-language functions at planning time
-- using a restricted search_path; without SET search_path on the function,
-- table references inside the function body fail to resolve. Re-declare
-- `current_rule_set` and `next_batch_number` here with the fix so that any
-- existing deployment where 0002/0003 applied the broken version gets
-- patched. CREATE OR REPLACE is a no-op on clean deployments.
CREATE OR REPLACE FUNCTION current_rule_set(p_client_id uuid)
RETURNS rule_sets
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT * FROM rule_sets
  WHERE client_id = p_client_id AND effective_to IS NULL
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION next_batch_number(p_client_id uuid)
RETURNS int
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT COALESCE(MAX(batch_number), 0) + 1
  FROM batches WHERE client_id = p_client_id;
$$;

-- ---------- Per-advance running balances ----------
-- The filter `reversed_by_event_id IS NULL` automatically excludes reversed events,
-- giving clean undo semantics for free.
CREATE MATERIALIZED VIEW mv_advance_balances AS
SELECT
  a.id                                                        AS advance_id,
  a.client_id,
  a.purchase_order_id,
  a.invoice_id,
  a.batch_id,
  a.advance_type,
  a.advance_date,
  a.status,
  a.initial_principal_cents,
  a.rule_set_id,
  COALESCE(SUM(e.principal_delta_cents), 0)                   AS principal_outstanding_cents,
  COALESCE(SUM(e.fee_delta_cents), 0)                         AS fees_outstanding_cents,
  MAX(e.effective_date) FILTER (
    WHERE e.principal_delta_cents < 0
  )                                                            AS last_principal_payment_date,
  COUNT(*) FILTER (
    WHERE e.event_type IN ('fee_accrued', 'one_time_fee_assessed')
  )                                                            AS fee_accrual_count
FROM advances a
LEFT JOIN ledger_events e
  ON e.advance_id = a.id
  AND e.reversed_by_event_id IS NULL
GROUP BY a.id;

CREATE UNIQUE INDEX mv_advance_balances_pk ON mv_advance_balances(advance_id);
CREATE INDEX mv_advance_balances_client ON mv_advance_balances(client_id);
CREATE INDEX mv_advance_balances_batch ON mv_advance_balances(batch_id);

-- ---------- Per-invoice aging & eligibility ----------
CREATE MATERIALIZED VIEW mv_invoice_aging AS
WITH po_with_client AS (
  SELECT po.id AS po_id, po.client_id, po.retailer_id, po.status AS po_status
  FROM purchase_orders po
)
SELECT
  i.id                                                        AS invoice_id,
  i.purchase_order_id,
  p.client_id,
  p.retailer_id,
  i.invoice_number,
  i.invoice_value_cents,
  COALESCE(SUM(d.amount_cents), 0)                            AS deduction_cents_total,
  i.invoice_value_cents - COALESCE(SUM(d.amount_cents), 0)    AS effective_invoice_value_cents,
  i.invoice_date,
  i.due_date,
  i.paid_in_full_date,
  CASE
    WHEN i.paid_in_full_date IS NOT NULL THEN
      (i.paid_in_full_date - COALESCE(i.invoice_date, CURRENT_DATE))
    ELSE
      (CURRENT_DATE - COALESCE(i.invoice_date, CURRENT_DATE))
  END                                                          AS days_outstanding,
  CASE
    WHEN i.paid_in_full_date IS NOT NULL THEN 'paid'
    WHEN (CURRENT_DATE - COALESCE(i.invoice_date, CURRENT_DATE)) <= 0  THEN 'current'
    WHEN (CURRENT_DATE - COALESCE(i.invoice_date, CURRENT_DATE)) <= 30 THEN '1-30'
    WHEN (CURRENT_DATE - COALESCE(i.invoice_date, CURRENT_DATE)) <= 60 THEN '31-60'
    WHEN (CURRENT_DATE - COALESCE(i.invoice_date, CURRENT_DATE)) <= 90 THEN '61-90'
    ELSE '90+'
  END                                                          AS age_bucket,
  CASE
    WHEN i.paid_in_full_date IS NOT NULL THEN false
    WHEN (CURRENT_DATE - COALESCE(i.invoice_date, CURRENT_DATE))
         > (SELECT ar_aged_out_days FROM current_rule_set(p.client_id)) THEN true
    ELSE false
  END                                                          AS is_aged_out
FROM invoices i
JOIN po_with_client p ON p.po_id = i.purchase_order_id
LEFT JOIN invoice_deductions d ON d.invoice_id = i.id
GROUP BY i.id, p.client_id, p.retailer_id, p.po_status;

CREATE UNIQUE INDEX mv_invoice_aging_pk ON mv_invoice_aging(invoice_id);
CREATE INDEX mv_invoice_aging_client ON mv_invoice_aging(client_id);
CREATE INDEX mv_invoice_aging_aged_out ON mv_invoice_aging(client_id) WHERE is_aged_out = true;

-- ---------- Client-level rollup for Main Interface ----------
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
      SUM(mab.fees_outstanding_cents)                           AS total_fees_cents
    FROM advances a
    JOIN mv_advance_balances mab ON mab.advance_id = a.id
    WHERE a.status IN ('committed', 'funded')
    GROUP BY a.client_id
  ),
  po_values AS (
    SELECT
      po.client_id,
      SUM(po.po_value_cents) FILTER (
        WHERE po.status IN ('active', 'partially_invoiced')
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
  (COALESCE(po_out.ar_principal_cents, 0)
    * (SELECT pre_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
                                                         AS pre_advance_borrowing_base_cents,
  -- Available (borrowing base minus outstanding)
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
    (COALESCE(po_out.ar_principal_cents, 0)
      * (SELECT pre_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
    - COALESCE(po_out.pre_advance_principal_cents, 0),
    0
  )                                                      AS pre_advance_borrowing_base_available_cents,
  COALESCE(rb.remittance_balance_cents, 0)               AS remittance_balance_cents,
  -- Over-Advanced state: total principal outstanding > total borrowing base across all types
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
      + (COALESCE(po_out.ar_principal_cents, 0)
        * (SELECT pre_advance_rate_bps FROM current_rule_set(c.id)) / 10000)
    )
  )                                                      AS is_over_advanced
FROM clients c
LEFT JOIN po_outstanding po_out ON po_out.client_id = c.id
LEFT JOIN po_values pov         ON pov.client_id = c.id
LEFT JOIN ar_values arv         ON arv.client_id = c.id
LEFT JOIN remittance_balance rb ON rb.client_id = c.id;

CREATE UNIQUE INDEX mv_client_position_pk ON mv_client_position(client_id);

-- ---------- Per-batch rollup ----------
CREATE MATERIALIZED VIEW mv_batch_position AS
SELECT
  b.id                                                         AS batch_id,
  b.client_id,
  b.batch_number,
  b.name,
  COUNT(DISTINCT mab.advance_id) FILTER (
    WHERE mab.principal_outstanding_cents > 0
  )                                                            AS active_advance_count,
  COALESCE(SUM(mab.principal_outstanding_cents), 0)            AS principal_outstanding_cents,
  COALESCE(SUM(mab.fees_outstanding_cents), 0)                 AS fees_outstanding_cents
FROM batches b
LEFT JOIN mv_advance_balances mab ON mab.batch_id = b.id
GROUP BY b.id;

CREATE UNIQUE INDEX mv_batch_position_pk ON mv_batch_position(batch_id);
CREATE INDEX mv_batch_position_client ON mv_batch_position(client_id);

-- ---------- Refresh orchestration ----------
-- In Phase 1 we refresh all three projections on every ledger_events insert.
-- Will move to a debounced queue (pg_notify + worker) at scale.
CREATE OR REPLACE FUNCTION refresh_projections()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('refresh_projections', COALESCE(NEW.client_id::text, ''));
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_events_notify_refresh
  AFTER INSERT ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION refresh_projections();

-- The worker should run this sequence (CONCURRENTLY to avoid read locks):
--   REFRESH MATERIALIZED VIEW CONCURRENTLY mv_advance_balances;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY mv_invoice_aging;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY mv_batch_position;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY mv_client_position;
--   Then call recompute_client_over_advanced(client_id) for each affected client.
