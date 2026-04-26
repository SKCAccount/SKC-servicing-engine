-- ============================================================================
-- 0022_po_cancellation_events.sql
--
-- Per Derek's clarification (2026-04-25, post-1D doc-reconciliation):
-- "If a PO transitions from an outstanding status to a cancelled status
-- (which has an impact on borrowing base) due to an upload, this should
-- probably be on the ledger. This way we can trace back by the ledger
-- when balance changed."
--
-- Today, when a Walmart upload (or generic-CSV upload) flips an existing
-- PO's status from 'active' / 'partially_invoiced' / 'closed_awaiting_invoice'
-- to 'cancelled' via bulk_upsert_purchase_orders, the change happens
-- correctly:
--   * purchase_orders.status overwrites via ON CONFLICT DO UPDATE
--   * cancelled_at + cancelled_by stamped via the same statement
--   * audit_log captures the row diff (before/after JSON)
--   * mv_client_position drops the PO from active_po_value_cents → BB drops
--
-- What's missing: a `po_cancelled` row in `ledger_events` recording that
-- this status transition is the cause of the BB drop. Per Derek's
-- principle, balance-affecting changes belong on the ledger so the
-- timeline can be reconstructed from events alone.
--
-- This migration extends bulk_upsert_purchase_orders to emit:
--   * `po_cancelled` for every PO that transitions FROM a non-cancelled
--     status INTO 'cancelled' as part of this upload (one event per PO).
--   * `po_cancellation_reversed` for every PO that transitions FROM
--     'cancelled' BACK to a non-cancelled status — but only when there's
--     an existing unreversed po_cancelled event to reference (the CHECK
--     constraint requires reverses_event_id NOT NULL). For legacy
--     cancellations that predate this migration, the reverse direction
--     gets audit_log only — same trade as before the change. The
--     maintain_reversal_backpointer trigger automatically updates the
--     original event's reversed_by_event_id.
--
-- Cases NOT emitting events:
--   * NEW PO uploaded with status='cancelled' on first appearance — the
--     PO never contributed to BB, so no balance change to record.
--   * Re-upsert of an already-cancelled PO with status still 'cancelled' —
--     no transition, no event. Field-level changes (memo updates etc.)
--     still go to audit_log.
--   * skip_duplicates=true mode — no UPDATEs happen, so no transitions.
--
-- Implementation: the existing INSERT … ON CONFLICT can't return both
-- old-state and new-state from the same statement, so we capture the
-- pre-upsert status of incoming POs in a jsonb map (one short SELECT,
-- indexed by client_id+retailer_id+po_number), then after the upsert
-- compares each post-state status against the captured prior status to
-- detect transitions.
-- ============================================================================

CREATE OR REPLACE FUNCTION bulk_upsert_purchase_orders(
  p_client_id uuid,
  p_retailer_id uuid,
  p_upload_id uuid,
  p_po_rows jsonb,
  p_lines jsonb,
  p_skip_duplicates boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_inserted                int := 0;
  v_updated                 int := 0;
  v_skipped                 int := 0;
  v_lines_replaced          int := 0;
  v_lines_inserted          int := 0;
  v_total_rows              int := 0;
  v_now                     timestamptz := now();
  v_actor                   uuid := auth.uid();
  v_affected_po_ids         uuid[];
  -- Pre-upsert status snapshot keyed by po_number (text) → prior_status (text).
  v_pre_state               jsonb;
  v_po_cancelled_events     int := 0;
  v_po_uncancelled_events   int := 0;
BEGIN
  IF jsonb_array_length(p_po_rows) = 0 THEN
    RETURN jsonb_build_object(
      'inserted', 0, 'updated', 0, 'skipped', 0,
      'lines_replaced', 0, 'lines_inserted', 0,
      'po_cancelled_events', 0, 'po_uncancelled_events', 0
    );
  END IF;
  v_total_rows := jsonb_array_length(p_po_rows);

  -- ---------- Step 0: capture pre-upsert status of any existing rows ----------
  -- Only POs that already exist for this (client, retailer) appear here.
  -- New POs aren't represented; their absence in v_pre_state is the signal
  -- that "this is a first-appearance row, no transition to track."
  SELECT COALESCE(
    jsonb_object_agg(po.po_number, po.status::text),
    '{}'::jsonb
  )
    INTO v_pre_state
    FROM purchase_orders po
   WHERE po.client_id = p_client_id
     AND po.retailer_id = p_retailer_id
     AND po.po_number IN (
       SELECT elem->>'po_number' FROM jsonb_array_elements(p_po_rows) elem
     );

  -- ---------- Step 1: perform the upsert (unchanged from v2) ----------
  IF p_skip_duplicates THEN
    WITH new_rows AS (
      INSERT INTO purchase_orders (
        client_id, retailer_id, po_number,
        po_value_cents, issuance_date, requested_delivery_date,
        delivery_location, item_description,
        quantity_ordered, unit_value_cents,
        status, cancellation_reason_category, cancellation_memo,
        cancelled_at, cancelled_by, upload_id
      )
      SELECT
        p_client_id, p_retailer_id, elem->>'po_number',
        (elem->>'po_value_cents')::bigint,
        NULLIF(elem->>'issuance_date', '')::date,
        NULLIF(elem->>'requested_delivery_date', '')::date,
        NULLIF(elem->>'delivery_location', ''),
        NULLIF(elem->>'item_description', ''),
        NULLIF(elem->>'quantity_ordered', '')::int,
        NULLIF(elem->>'unit_value_cents', '')::bigint,
        (elem->>'status')::po_status,
        NULLIF(elem->>'cancellation_reason_category', '')::cancellation_reason,
        NULLIF(elem->>'cancellation_memo', ''),
        CASE WHEN elem->>'status' = 'cancelled' THEN v_now ELSE NULL END,
        CASE WHEN elem->>'status' = 'cancelled' THEN v_actor ELSE NULL END,
        p_upload_id
      FROM jsonb_array_elements(p_po_rows) AS elem
      ON CONFLICT (client_id, retailer_id, po_number) DO NOTHING
      RETURNING id
    )
    SELECT array_agg(id), COUNT(*) INTO v_affected_po_ids, v_inserted FROM new_rows;
    v_skipped := v_total_rows - v_inserted;
  ELSE
    WITH upserted AS (
      INSERT INTO purchase_orders (
        client_id, retailer_id, po_number,
        po_value_cents, issuance_date, requested_delivery_date,
        delivery_location, item_description,
        quantity_ordered, unit_value_cents,
        status, cancellation_reason_category, cancellation_memo,
        cancelled_at, cancelled_by, upload_id
      )
      SELECT
        p_client_id, p_retailer_id, elem->>'po_number',
        (elem->>'po_value_cents')::bigint,
        NULLIF(elem->>'issuance_date', '')::date,
        NULLIF(elem->>'requested_delivery_date', '')::date,
        NULLIF(elem->>'delivery_location', ''),
        NULLIF(elem->>'item_description', ''),
        NULLIF(elem->>'quantity_ordered', '')::int,
        NULLIF(elem->>'unit_value_cents', '')::bigint,
        (elem->>'status')::po_status,
        NULLIF(elem->>'cancellation_reason_category', '')::cancellation_reason,
        NULLIF(elem->>'cancellation_memo', ''),
        CASE WHEN elem->>'status' = 'cancelled' THEN v_now ELSE NULL END,
        CASE WHEN elem->>'status' = 'cancelled' THEN v_actor ELSE NULL END,
        p_upload_id
      FROM jsonb_array_elements(p_po_rows) AS elem
      ON CONFLICT (client_id, retailer_id, po_number) DO UPDATE SET
        po_value_cents               = EXCLUDED.po_value_cents,
        issuance_date                = EXCLUDED.issuance_date,
        requested_delivery_date      = EXCLUDED.requested_delivery_date,
        delivery_location            = EXCLUDED.delivery_location,
        item_description             = EXCLUDED.item_description,
        quantity_ordered             = EXCLUDED.quantity_ordered,
        unit_value_cents             = EXCLUDED.unit_value_cents,
        status                       = EXCLUDED.status,
        cancellation_reason_category = EXCLUDED.cancellation_reason_category,
        cancellation_memo            = EXCLUDED.cancellation_memo,
        cancelled_at = CASE
          WHEN EXCLUDED.status = 'cancelled' AND purchase_orders.cancelled_at IS NULL THEN v_now
          WHEN EXCLUDED.status <> 'cancelled' THEN NULL
          ELSE purchase_orders.cancelled_at
        END,
        cancelled_by = CASE
          WHEN EXCLUDED.status = 'cancelled' AND purchase_orders.cancelled_by IS NULL THEN v_actor
          WHEN EXCLUDED.status <> 'cancelled' THEN NULL
          ELSE purchase_orders.cancelled_by
        END,
        upload_id = p_upload_id
      RETURNING id, (xmax = 0) AS was_inserted
    )
    SELECT
      array_agg(id),
      COUNT(*) FILTER (WHERE was_inserted),
      COUNT(*) FILTER (WHERE NOT was_inserted)
    INTO v_affected_po_ids, v_inserted, v_updated
    FROM upserted;
  END IF;

  -- ---------- Step 2: emit po_cancelled events for transitions INTO cancelled ----------
  -- Only fires under skip_duplicates=false (otherwise no UPDATEs happened).
  -- A row transitions INTO cancelled when:
  --   * It existed before (v_pre_state has its po_number)
  --   * Its prior status was something other than 'cancelled'
  --   * Its post-upsert status IS 'cancelled'
  IF NOT p_skip_duplicates AND v_affected_po_ids IS NOT NULL THEN
    WITH transitions AS (
      INSERT INTO ledger_events (
        client_id, event_type, effective_date, created_by,
        purchase_order_id,
        principal_delta_cents, fee_delta_cents, remittance_delta_cents,
        metadata
      )
      SELECT
        p_client_id,
        'po_cancelled',
        v_now::date,
        v_actor,
        po.id,
        0, 0, 0,
        jsonb_build_object(
          'source',                       'bulk_upsert_purchase_orders',
          'upload_id',                    p_upload_id,
          'prior_status',                 v_pre_state ->> po.po_number,
          'cancellation_reason_category', po.cancellation_reason_category,
          'cancellation_memo',            po.cancellation_memo
        )
      FROM purchase_orders po
      WHERE po.id = ANY(v_affected_po_ids)
        AND po.status = 'cancelled'
        AND v_pre_state ? po.po_number                       -- existed before
        AND (v_pre_state ->> po.po_number) <> 'cancelled'    -- transition
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_po_cancelled_events FROM transitions;

    -- ---------- Step 3: emit po_cancellation_reversed for the reverse direction ----------
    -- A row transitions OUT of cancelled when:
    --   * It existed before with prior status = 'cancelled'
    --   * Its post-upsert status is NOT 'cancelled'
    --   * AND we have a prior unreversed po_cancelled event to reference
    --     (the CHECK constraint requires reverses_event_id NOT NULL).
    --
    -- For POs that were cancelled BEFORE migration 0022 shipped, no prior
    -- po_cancelled event exists; in that legacy case we do NOT emit a
    -- reversal event (would violate CHECK). audit_log captures the change
    -- as before. Same trade as before the new emitter shipped.
    WITH reversals AS (
      INSERT INTO ledger_events (
        client_id, event_type, effective_date, created_by,
        purchase_order_id, reverses_event_id,
        principal_delta_cents, fee_delta_cents, remittance_delta_cents,
        metadata
      )
      SELECT
        p_client_id,
        'po_cancellation_reversed',
        v_now::date,
        v_actor,
        po.id,
        prior_event.id,
        0, 0, 0,
        jsonb_build_object(
          'source',     'bulk_upsert_purchase_orders',
          'upload_id',  p_upload_id,
          'new_status', po.status::text
        )
      FROM purchase_orders po
      JOIN LATERAL (
        SELECT le.id
          FROM ledger_events le
         WHERE le.purchase_order_id = po.id
           AND le.event_type = 'po_cancelled'
           AND le.reversed_by_event_id IS NULL
         ORDER BY le.event_seq DESC
         LIMIT 1
      ) AS prior_event ON true
      WHERE po.id = ANY(v_affected_po_ids)
        AND po.status <> 'cancelled'
        AND v_pre_state ? po.po_number
        AND (v_pre_state ->> po.po_number) = 'cancelled'
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_po_uncancelled_events FROM reversals;
  END IF;

  -- ---------- Step 4: bulk line replacement (unchanged from v2) ----------
  IF p_lines IS NOT NULL
     AND v_affected_po_ids IS NOT NULL
     AND array_length(v_affected_po_ids, 1) > 0
  THEN
    WITH deleted AS (
      DELETE FROM purchase_order_lines
       WHERE purchase_order_id = ANY(v_affected_po_ids)
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_lines_replaced FROM deleted;

    WITH inserted_lines AS (
      INSERT INTO purchase_order_lines (
        purchase_order_id, line_number,
        retailer_item_number, item_description,
        quantity_ordered, unit_cost_cents, line_value_cents,
        status, upload_id
      )
      SELECT
        po.id,
        (elem->>'line_number')::int,
        NULLIF(elem->>'retailer_item_number', ''),
        NULLIF(elem->>'item_description', ''),
        NULLIF(elem->>'quantity_ordered', '')::int,
        NULLIF(elem->>'unit_cost_cents', '')::bigint,
        NULLIF(elem->>'line_value_cents', '')::bigint,
        (elem->>'status')::po_line_status,
        p_upload_id
      FROM jsonb_array_elements(p_lines) AS elem
      JOIN purchase_orders po
        ON po.client_id = p_client_id
       AND po.retailer_id = p_retailer_id
       AND po.po_number = elem->>'po_number'
       AND po.id = ANY(v_affected_po_ids)
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_lines_inserted FROM inserted_lines;
  END IF;

  RETURN jsonb_build_object(
    'inserted',              v_inserted,
    'updated',               v_updated,
    'skipped',               v_skipped,
    'lines_replaced',        v_lines_replaced,
    'lines_inserted',        v_lines_inserted,
    'po_cancelled_events',   v_po_cancelled_events,
    'po_uncancelled_events', v_po_uncancelled_events
  );
END;
$$;
