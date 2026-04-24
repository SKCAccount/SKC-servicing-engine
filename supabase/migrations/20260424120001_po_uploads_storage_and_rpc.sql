-- ============================================================================
-- 0015_po_uploads_storage_and_rpc.sql
--
-- Enables the Phase 1C PO Upload workflow:
--   1. A private Supabase Storage bucket 'po-uploads' for retained source
--      files (per 01_FUNCTIONAL_SPEC.md §Purchase Order Upload Methodology:
--      "The original uploaded file is retained indefinitely in Supabase
--      Storage for audit purposes, linked to the upload event in the ledger.").
--   2. An RPC bulk_upsert_purchase_orders() that does the atomic upsert for
--      a whole batch of POs PLUS the full-replacement of purchase_order_lines
--      for any PO the incoming file covers.
--
-- The RPC is the right tool here because:
--   - Supabase JS has no multi-statement transaction primitive.
--   - Line-level uploads demand full replacement (DELETE + INSERT lines) in
--     the same transaction as the PO upsert. Otherwise a crash between the
--     two leaves a PO with no lines visible to concurrent readers.
--   - Running per-row loops over the Supabase JS client is N round-trips;
--     a server-side RPC over a jsonb payload is one round-trip.
-- ============================================================================

-- ---------- Storage bucket ----------
-- Created as not-public; server-side code uses the service role to read/write.
-- RLS on storage.objects is the Supabase default; we don't add app-level
-- policies because Phase 1 only accesses uploads server-side.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('po-uploads', 'po-uploads', false, 52428800)  -- 50 MB
ON CONFLICT (id) DO NOTHING;

-- ---------- bulk_upsert_purchase_orders ----------
-- Params:
--   p_client_id          — Client context for RLS + three-part key
--   p_retailer_id        — Retailer context for three-part key
--   p_upload_id          — The po_uploads row this batch is linked to
--   p_po_rows            — jsonb array of PO objects
--   p_lines              — jsonb array of line objects (or NULL for header-only uploads)
--   p_skip_duplicates    — true = skip rows whose PO already exists; false = overwrite
--
-- jsonb shapes (matching NormalizedPoRecord / NormalizedPoLineRecord):
--   po: {
--     po_number, po_value_cents, issuance_date, requested_delivery_date,
--     delivery_location, item_description, quantity_ordered, unit_value_cents,
--     status, cancellation_reason_category, cancellation_memo, metadata
--   }
--   line: {
--     po_number,  -- used to resolve purchase_order_id
--     line_number, retailer_item_number, item_description,
--     quantity_ordered, unit_cost_cents, line_value_cents, status, metadata
--   }
--
-- Returns a jsonb summary:
--   { inserted: int, updated: int, skipped: int, lines_replaced: int, lines_inserted: int }
--
-- SECURITY INVOKER: the RPC runs as the caller. RLS on purchase_orders and
-- purchase_order_lines enforces Client scope — same policies as direct writes.
-- ----------------------------------------------------------------------------
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
  v_po_obj              jsonb;
  v_line_obj            jsonb;
  v_po_number           text;
  v_existing_id         uuid;
  v_po_id               uuid;
  v_cancelled_at        timestamptz;
  v_cancelled_by        uuid;
  v_inserted            int := 0;
  v_updated             int := 0;
  v_skipped             int := 0;
  v_lines_replaced      int := 0;
  v_lines_inserted      int := 0;
  v_affected_po_ids     uuid[] := ARRAY[]::uuid[];
  v_status              text;
BEGIN
  -- Walk each PO, insert or update as appropriate.
  FOR v_po_obj IN SELECT * FROM jsonb_array_elements(p_po_rows)
  LOOP
    v_po_number := v_po_obj->>'po_number';
    v_status    := v_po_obj->>'status';

    -- Look up existing row via the three-part key.
    SELECT id INTO v_existing_id
      FROM purchase_orders
     WHERE client_id = p_client_id
       AND retailer_id = p_retailer_id
       AND po_number = v_po_number;

    -- Cancellation metadata: only populate when status moves TO 'cancelled'
    -- and the row didn't already carry it. cancelled_at/by use now()/auth.uid().
    v_cancelled_at := CASE WHEN v_status = 'cancelled' THEN now() ELSE NULL END;
    v_cancelled_by := CASE WHEN v_status = 'cancelled' THEN auth.uid() ELSE NULL END;

    IF v_existing_id IS NOT NULL THEN
      IF p_skip_duplicates THEN
        v_skipped := v_skipped + 1;
        -- Still include this PO in the set whose lines may be replaced?
        -- No — if we're skipping the PO, we also skip its lines.
        CONTINUE;
      END IF;

      UPDATE purchase_orders
         SET po_value_cents                = (v_po_obj->>'po_value_cents')::bigint,
             issuance_date                 = NULLIF(v_po_obj->>'issuance_date','')::date,
             requested_delivery_date       = NULLIF(v_po_obj->>'requested_delivery_date','')::date,
             delivery_location             = NULLIF(v_po_obj->>'delivery_location',''),
             item_description              = NULLIF(v_po_obj->>'item_description',''),
             quantity_ordered              = NULLIF(v_po_obj->>'quantity_ordered','')::int,
             unit_value_cents              = NULLIF(v_po_obj->>'unit_value_cents','')::bigint,
             status                        = v_status::po_status,
             cancellation_reason_category  = NULLIF(v_po_obj->>'cancellation_reason_category','')::cancellation_reason,
             cancellation_memo             = NULLIF(v_po_obj->>'cancellation_memo',''),
             cancelled_at                  = CASE
                                               WHEN v_status = 'cancelled'
                                                 AND cancelled_at IS NULL
                                               THEN now()
                                               WHEN v_status <> 'cancelled'
                                               THEN NULL
                                               ELSE cancelled_at
                                             END,
             cancelled_by                  = CASE
                                               WHEN v_status = 'cancelled'
                                                 AND cancelled_by IS NULL
                                               THEN auth.uid()
                                               WHEN v_status <> 'cancelled'
                                               THEN NULL
                                               ELSE cancelled_by
                                             END,
             upload_id                     = p_upload_id
       WHERE id = v_existing_id;

      v_po_id  := v_existing_id;
      v_updated := v_updated + 1;
    ELSE
      INSERT INTO purchase_orders (
        client_id, retailer_id, po_number,
        po_value_cents, issuance_date, requested_delivery_date,
        delivery_location, item_description,
        quantity_ordered, unit_value_cents,
        status, cancellation_reason_category, cancellation_memo,
        cancelled_at, cancelled_by, upload_id
      ) VALUES (
        p_client_id, p_retailer_id, v_po_number,
        (v_po_obj->>'po_value_cents')::bigint,
        NULLIF(v_po_obj->>'issuance_date','')::date,
        NULLIF(v_po_obj->>'requested_delivery_date','')::date,
        NULLIF(v_po_obj->>'delivery_location',''),
        NULLIF(v_po_obj->>'item_description',''),
        NULLIF(v_po_obj->>'quantity_ordered','')::int,
        NULLIF(v_po_obj->>'unit_value_cents','')::bigint,
        v_status::po_status,
        NULLIF(v_po_obj->>'cancellation_reason_category','')::cancellation_reason,
        NULLIF(v_po_obj->>'cancellation_memo',''),
        v_cancelled_at, v_cancelled_by, p_upload_id
      )
      RETURNING id INTO v_po_id;

      v_inserted := v_inserted + 1;
    END IF;

    v_affected_po_ids := v_affected_po_ids || v_po_id;
  END LOOP;

  -- Line-level full-replacement. Only runs when the caller passed lines.
  -- We DELETE lines only for POs we just upserted (not for POs that were
  -- skipped above) — that's what v_affected_po_ids is for.
  IF p_lines IS NOT NULL AND array_length(v_affected_po_ids, 1) IS NOT NULL THEN
    WITH deleted AS (
      DELETE FROM purchase_order_lines
       WHERE purchase_order_id = ANY (v_affected_po_ids)
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_lines_replaced FROM deleted;

    FOR v_line_obj IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      -- Resolve purchase_order_id for this line via po_number.
      SELECT id INTO v_po_id
        FROM purchase_orders
       WHERE client_id = p_client_id
         AND retailer_id = p_retailer_id
         AND po_number = v_line_obj->>'po_number';

      -- If the PO was skipped (skip_duplicates), we don't write its lines.
      IF v_po_id IS NULL OR NOT (v_po_id = ANY (v_affected_po_ids)) THEN
        CONTINUE;
      END IF;

      INSERT INTO purchase_order_lines (
        purchase_order_id, line_number,
        retailer_item_number, item_description,
        quantity_ordered, unit_cost_cents, line_value_cents,
        status, upload_id
      ) VALUES (
        v_po_id,
        (v_line_obj->>'line_number')::int,
        NULLIF(v_line_obj->>'retailer_item_number',''),
        NULLIF(v_line_obj->>'item_description',''),
        NULLIF(v_line_obj->>'quantity_ordered','')::int,
        NULLIF(v_line_obj->>'unit_cost_cents','')::bigint,
        NULLIF(v_line_obj->>'line_value_cents','')::bigint,
        (v_line_obj->>'status')::po_line_status,
        p_upload_id
      );
      v_lines_inserted := v_lines_inserted + 1;
    END LOOP;
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

-- Grant execute to authenticated users. RLS on the underlying tables still
-- enforces Client scope (SECURITY INVOKER).
GRANT EXECUTE ON FUNCTION bulk_upsert_purchase_orders(uuid, uuid, uuid, jsonb, jsonb, boolean)
  TO authenticated;
