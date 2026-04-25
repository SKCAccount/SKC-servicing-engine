-- ============================================================================
-- 0021_per_underlying_floor_bb.sql
--
-- Per Derek's clarification (2026-04-25): each underlying's contribution to
-- the borrowing base is `floor(value × rate / 10000)`, computed PER
-- underlying before summing. The previous mv_client_position projection
-- did `SUM(value) × rate / 10000`, which has two problems:
--
--   (1) SUM(bigint) returns numeric in Postgres, so the resulting
--       borrowing-base columns carry fractional cents. Those propagate
--       through Supabase JS as floats, eventually surfacing in the UI as
--       garbage like "$2,013,695.72.59999999403954" because formatDollars'
--       `value % 100` operates on a float.
--
--   (2) Aggregate-then-multiply lets the effective per-PO advance rate
--       creep over the cap by fractional pennies × N POs. The
--       Advance-on-POs leveling math could then push individual POs above
--       100% × rate_cap after a full-room allocation.
--
-- Fix: rebuild mv_client_position to floor each underlying's BB
-- contribution before summing, with explicit ::bigint casts. Same change
-- applied to AR and pre-advance bases.
--
-- formatDollars now defensively floors at the JS boundary too as a belt-
-- and-suspenders against future drift, but the SQL is the real fix.
-- ============================================================================

DROP MATERIALIZED VIEW mv_client_position;

CREATE MATERIALIZED VIEW mv_client_position AS
WITH
  -- Per-Client active rule_set rates. LATERAL join so each Client's rule
  -- set is visible to the per-row calculations below without repeating the
  -- scalar subquery dozens of times.
  client_rates AS (
    SELECT
      c.id AS client_id,
      COALESCE(rs.po_advance_rate_bps, 0)         AS po_advance_rate_bps,
      COALESCE(rs.ar_advance_rate_bps, 0)         AS ar_advance_rate_bps,
      COALESCE(rs.pre_advance_rate_bps, 0)        AS pre_advance_rate_bps
    FROM clients c
    LEFT JOIN LATERAL current_rule_set(c.id) rs ON true
  ),
  po_outstanding AS (
    SELECT
      a.client_id,
      SUM(CASE WHEN a.advance_type = 'po'
               THEN mab.principal_outstanding_cents ELSE 0 END)::bigint AS po_principal_cents,
      SUM(CASE WHEN a.advance_type = 'ar'
               THEN mab.principal_outstanding_cents ELSE 0 END)::bigint AS ar_principal_cents,
      SUM(CASE WHEN a.advance_type = 'pre_advance'
               THEN mab.principal_outstanding_cents ELSE 0 END)::bigint AS pre_advance_principal_cents,
      SUM(mab.fees_outstanding_cents)::bigint                            AS total_fees_cents,
      -- AR principal from NON-aged-out invoices only — the pool the
      -- pre-advance base draws against.
      SUM(CASE
          WHEN a.advance_type = 'ar'
            AND a.invoice_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM mv_invoice_aging mia
              WHERE mia.invoice_id = a.invoice_id AND mia.is_aged_out = false
            )
          THEN mab.principal_outstanding_cents ELSE 0 END)::bigint       AS eligible_ar_principal_cents
    FROM advances a
    JOIN mv_advance_balances mab ON mab.advance_id = a.id
    WHERE a.status IN ('committed', 'funded')
    GROUP BY a.client_id
  ),
  -- Per-PO borrowing base is FLOORED per row before summing. This guarantees
  -- the projection's po_borrowing_base_cents column is a clean integer and
  -- never exceeds Σ(per-PO floored BB).
  po_values AS (
    SELECT
      po.client_id,
      SUM(po.po_value_cents) FILTER (
        WHERE po.status IN ('active', 'partially_invoiced', 'closed_awaiting_invoice')
      )::bigint AS active_po_value_cents,
      COALESCE(SUM(
        FLOOR(po.po_value_cents::numeric * cr.po_advance_rate_bps / 10000)
      ) FILTER (
        WHERE po.status IN ('active', 'partially_invoiced', 'closed_awaiting_invoice')
      ), 0)::bigint AS po_borrowing_base_cents
    FROM purchase_orders po
    JOIN client_rates cr ON cr.client_id = po.client_id
    GROUP BY po.client_id
  ),
  -- Per-invoice AR borrowing base FLOORED per row. Same idea.
  ar_values AS (
    SELECT
      mia.client_id,
      SUM(mia.effective_invoice_value_cents) FILTER (
        WHERE mia.paid_in_full_date IS NULL AND mia.is_aged_out = false
      )::bigint AS eligible_ar_value_cents,
      COALESCE(SUM(
        FLOOR(mia.effective_invoice_value_cents::numeric * cr.ar_advance_rate_bps / 10000)
      ) FILTER (
        WHERE mia.paid_in_full_date IS NULL AND mia.is_aged_out = false
      ), 0)::bigint AS ar_borrowing_base_cents
    FROM mv_invoice_aging mia
    JOIN client_rates cr ON cr.client_id = mia.client_id
    GROUP BY mia.client_id
  ),
  remittance_balance AS (
    SELECT
      e.client_id,
      COALESCE(SUM(e.remittance_delta_cents), 0)::bigint AS remittance_balance_cents
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
  (COALESCE(po_out.po_principal_cents, 0)
    + COALESCE(po_out.ar_principal_cents, 0)
    + COALESCE(po_out.pre_advance_principal_cents, 0))::bigint   AS total_principal_outstanding_cents,
  COALESCE(po_out.total_fees_cents, 0)                   AS total_fees_outstanding_cents,
  COALESCE(pov.active_po_value_cents, 0)                 AS active_po_value_cents,
  COALESCE(arv.eligible_ar_value_cents, 0)               AS eligible_ar_value_cents,
  -- Borrowing bases — per-underlying floored sums.
  COALESCE(pov.po_borrowing_base_cents, 0)               AS po_borrowing_base_cents,
  COALESCE(arv.ar_borrowing_base_cents, 0)               AS ar_borrowing_base_cents,
  -- Pre-advance base = floor(eligible_ar_principal × rate / 10000). One
  -- value per Client (eligible_ar_principal already aggregated), so a
  -- single floor is correct; equivalent to per-row floor when there's only
  -- one row.
  COALESCE(
    FLOOR(po_out.eligible_ar_principal_cents::numeric * cr.pre_advance_rate_bps / 10000),
    0
  )::bigint                                              AS pre_advance_borrowing_base_cents,
  -- Available = base − outstanding, floored at 0.
  GREATEST(
    COALESCE(pov.po_borrowing_base_cents, 0)
      - COALESCE(po_out.po_principal_cents, 0),
    0
  )::bigint                                              AS po_borrowing_base_available_cents,
  GREATEST(
    COALESCE(arv.ar_borrowing_base_cents, 0)
      - COALESCE(po_out.ar_principal_cents, 0),
    0
  )::bigint                                              AS ar_borrowing_base_available_cents,
  GREATEST(
    COALESCE(
      FLOOR(po_out.eligible_ar_principal_cents::numeric * cr.pre_advance_rate_bps / 10000),
      0
    )::bigint - COALESCE(po_out.pre_advance_principal_cents, 0),
    0
  )::bigint                                              AS pre_advance_borrowing_base_available_cents,
  COALESCE(rb.remittance_balance_cents, 0)               AS remittance_balance_cents,
  -- Over Advanced: total principal > total borrowing base across all types.
  -- All inputs are bigint after the floor + cast pipeline above.
  (
    (COALESCE(po_out.po_principal_cents, 0)
      + COALESCE(po_out.ar_principal_cents, 0)
      + COALESCE(po_out.pre_advance_principal_cents, 0))
    >
    (
      COALESCE(pov.po_borrowing_base_cents, 0)
      + COALESCE(arv.ar_borrowing_base_cents, 0)
      + COALESCE(
          FLOOR(po_out.eligible_ar_principal_cents::numeric * cr.pre_advance_rate_bps / 10000),
          0
        )::bigint
    )
  )                                                      AS is_over_advanced
FROM clients c
JOIN client_rates cr            ON cr.client_id = c.id
LEFT JOIN po_outstanding po_out ON po_out.client_id = c.id
LEFT JOIN po_values pov         ON pov.client_id = c.id
LEFT JOIN ar_values arv         ON arv.client_id = c.id
LEFT JOIN remittance_balance rb ON rb.client_id = c.id;

CREATE UNIQUE INDEX mv_client_position_pk ON mv_client_position(client_id);

-- Refresh once so the new schema picks up immediately.
REFRESH MATERIALIZED VIEW mv_client_position;
