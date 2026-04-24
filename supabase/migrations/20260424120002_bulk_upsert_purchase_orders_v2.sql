-- ============================================================================
-- 0016_bulk_upsert_purchase_orders_v2.sql
--
-- Replaces bulk_upsert_purchase_orders with a single-statement bulk
-- INSERT ... ON CONFLICT implementation. The 0015 version used a plpgsql
-- FOR loop that did a SELECT + UPDATE/INSERT per row. With ~3000 PO rows
-- + ~4400 line rows + audit triggers firing per insert, the cumulative
-- per-statement overhead exceeded Supabase's default 60-second statement
-- timeout on real Walmart uploads.
--
-- The bulk approach drops total round-trip count from O(N) to O(1) for the
-- core upsert and the same for line replacement. Audit triggers still fire
-- once per row but inside a single SQL statement that's executed C-side,
-- so per-row overhead is minimal.
--
-- Behavioral parity with v1:
--   - p_skip_duplicates = true → existing rows are not modified; new ones
--     are inserted; counts match.
--   - p_skip_duplicates = false → existing rows are overwritten; counts
--     distinguish inserted vs updated via the xmax = 0 trick.
--   - When lines are provided, we DELETE existing lines for the affected
--     POs (only the ones we actually upserted, not skipped ones) and
--     INSERT the new lines. All in the same transaction as the PO upsert.
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
  v_inserted        int := 0;
  v_updated         int := 0;
  v_skipped         int := 0;
  v_lines_replaced  int := 0;
  v_lines_inserted  int := 0;
  v_total_rows      int := 0;
  v_now             timestamptz := now();
  v_actor           uuid := auth.uid();
  v_affected_po_ids uuid[];
BEGIN
  IF jsonb_array_length(p_po_rows) = 0 THEN
    RETURN jsonb_build_object(
      'inserted', 0, 'updated', 0, 'skipped', 0,
      'lines_replaced', 0, 'lines_inserted', 0
    );
  END IF;

  v_total_rows := jsonb_array_length(p_po_rows);

  -- ---------- Bulk PO upsert ----------
  -- A single INSERT...SELECT FROM jsonb_array_elements drops 3000 round-trips
  -- to one. ON CONFLICT branches on the skip_duplicates flag.
  IF p_skip_duplicates THEN
    -- DO NOTHING: only new rows are written; existing rows untouched.
    -- RETURNING ids of new rows lets us count inserts; v_skipped =
    -- v_total_rows - inserted_count.
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
    -- DO UPDATE: existing rows overwritten. Use xmax = 0 to distinguish
    -- newly-inserted vs updated rows in a single statement (Postgres trick).
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
        -- Set cancelled_at/by only when transitioning INTO 'cancelled' state
        -- and we don't already have a cancelled_at on the existing row.
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

  -- ---------- Bulk line replacement ----------
  -- Only when the caller passed lines AND we have at least one affected PO.
  IF p_lines IS NOT NULL
     AND v_affected_po_ids IS NOT NULL
     AND array_length(v_affected_po_ids, 1) > 0
  THEN
    -- Single DELETE for all lines on affected POs.
    WITH deleted AS (
      DELETE FROM purchase_order_lines
       WHERE purchase_order_id = ANY(v_affected_po_ids)
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_lines_replaced FROM deleted;

    -- Single bulk INSERT joining lines→PO via po_number. Lines whose PO
    -- isn't in v_affected_po_ids (e.g. it was skipped due to skip_duplicates)
    -- are filtered out by the JOIN condition.
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
      WHERE po.id = ANY(v_affected_po_ids)
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_lines_inserted FROM inserted_lines;
  END IF;

  RETURN jsonb_build_object(
    'inserted',        v_inserted,
    'updated',         v_updated,
    'skipped',         v_skipped,
    'lines_replaced',  v_lines_replaced,
    'lines_inserted',  v_lines_inserted
  );
END;
$$;

-- Grant unchanged from 0015; CREATE OR REPLACE preserves existing grants.
