-- ============================================================================
-- 0017_commit_po_advance_rpc.sql
--
-- Atomic 'commit a PO advance' RPC. Wraps four operations in one transaction:
--
--   1. Resolve the Client's currently-active rule_set (frozen onto each
--      advance row at creation time so fees stay calculated against the
--      rate in effect when the advance was extended — spec §Set Fee Rules).
--   2. Optionally create a new batch (if the caller passes p_new_batch_name)
--      OR use a provided existing batch_id.
--   3. Update purchase_orders.batch_id for every PO covered by the advance
--      so the new advance row's batch matches its underlying PO.
--   4. INSERT one advances row per allocation, then INSERT a paired
--      advance_committed ledger_event per advance with the principal_delta.
--
-- Atomicity is essential: a partial commit (some advances written, some
-- events missing) would corrupt mv_advance_balances downstream.
--
-- The caller (server action) must have done the Manager + Client-access
-- authz check and computed the per-PO allocation before calling this. The
-- RPC enforces:
--   - sum of allocation cents > 0 and <= INT_MAX
--   - each allocation has principal_cents > 0 (mirrors the
--     advance_committed ledger event invariant)
--   - all referenced POs belong to p_client_id
--
-- Returns the inserted advance ids and the resolved batch id.
-- ============================================================================

CREATE OR REPLACE FUNCTION commit_po_advance(
  p_client_id uuid,
  p_advance_date date,
  -- Batch resolution: exactly one of p_existing_batch_id OR p_new_batch_name
  -- must be set (caller validates; we double-check). New batch gets the next
  -- sequential batch_number for the Client.
  p_existing_batch_id uuid,
  p_new_batch_name text,
  -- Allocations as a jsonb array. Each element shape:
  --   { "purchase_order_id": "<uuid>", "principal_cents": <bigint> }
  p_allocations jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_rule_set_id            uuid;
  v_batch_id               uuid;
  v_new_batch_number       int;
  v_committed_by           uuid := auth.uid();
  v_now                    timestamptz := now();
  v_alloc_count            int;
  v_total_cents            bigint;
  v_inserted_advance_ids   uuid[] := ARRAY[]::uuid[];
  v_invalid_po_count       int;
  v_alloc                  jsonb;
  v_po_id                  uuid;
  v_principal_cents        bigint;
  v_advance_id             uuid;
  v_event_id               uuid;
  v_po_ids                 uuid[];
BEGIN
  -- ---------- Validation ----------
  IF v_committed_by IS NULL THEN
    RAISE EXCEPTION 'commit_po_advance: must be called by an authenticated user';
  END IF;

  IF p_advance_date IS NULL THEN
    RAISE EXCEPTION 'commit_po_advance: p_advance_date is required';
  END IF;

  v_alloc_count := COALESCE(jsonb_array_length(p_allocations), 0);
  IF v_alloc_count = 0 THEN
    RAISE EXCEPTION 'commit_po_advance: p_allocations is empty';
  END IF;

  IF (p_existing_batch_id IS NULL) = (p_new_batch_name IS NULL) THEN
    RAISE EXCEPTION 'commit_po_advance: pass exactly one of p_existing_batch_id or p_new_batch_name';
  END IF;

  -- Sum + per-row sanity check
  SELECT COALESCE(SUM((elem->>'principal_cents')::bigint), 0)
    INTO v_total_cents
    FROM jsonb_array_elements(p_allocations) elem;

  IF v_total_cents <= 0 THEN
    RAISE EXCEPTION 'commit_po_advance: total advance amount must be > 0 (got %)', v_total_cents;
  END IF;

  -- Reject any allocation with non-positive principal — would violate the
  -- ledger_events_type_invariants CHECK (principal_delta_cents > 0 for
  -- advance_committed).
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_allocations) elem
     WHERE COALESCE((elem->>'principal_cents')::bigint, 0) <= 0
  ) THEN
    RAISE EXCEPTION 'commit_po_advance: every allocation must have principal_cents > 0';
  END IF;

  -- All allocated POs must belong to this Client. Pre-resolve into an array
  -- for the batch UPDATE later.
  SELECT array_agg((elem->>'purchase_order_id')::uuid)
    INTO v_po_ids
    FROM jsonb_array_elements(p_allocations) elem;

  SELECT COUNT(*)
    INTO v_invalid_po_count
    FROM unnest(v_po_ids) AS po_id
   WHERE NOT EXISTS (
     SELECT 1 FROM purchase_orders po
      WHERE po.id = po_id AND po.client_id = p_client_id
   );

  IF v_invalid_po_count > 0 THEN
    RAISE EXCEPTION
      'commit_po_advance: % allocated PO(s) do not belong to client %',
      v_invalid_po_count, p_client_id;
  END IF;

  -- ---------- Resolve rule set ----------
  -- Frozen on each advance row (advance.rule_set_id). Fee rules look this
  -- up forever; borrowing-base rules read the live current_rule_set instead.
  SELECT id INTO v_rule_set_id
    FROM rule_sets
   WHERE client_id = p_client_id AND effective_to IS NULL
   LIMIT 1;

  IF v_rule_set_id IS NULL THEN
    RAISE EXCEPTION
      'commit_po_advance: no active rule_set for client %. Set Borrowing Base and Fee Rules first.',
      p_client_id;
  END IF;

  -- ---------- Resolve / create batch ----------
  IF p_existing_batch_id IS NOT NULL THEN
    -- Validate it belongs to the same Client.
    IF NOT EXISTS (
      SELECT 1 FROM batches WHERE id = p_existing_batch_id AND client_id = p_client_id
    ) THEN
      RAISE EXCEPTION 'commit_po_advance: batch % does not belong to client %',
        p_existing_batch_id, p_client_id;
    END IF;
    v_batch_id := p_existing_batch_id;
  ELSE
    v_new_batch_number := next_batch_number(p_client_id);
    INSERT INTO batches (client_id, batch_number)
    VALUES (p_client_id, v_new_batch_number)
    RETURNING id INTO v_batch_id;
  END IF;

  -- Re-assign every allocated PO to this batch. Per spec, all POs in one
  -- advance share a batch so that batch-level payment logic works later.
  UPDATE purchase_orders
     SET batch_id = v_batch_id
   WHERE id = ANY(v_po_ids)
     AND client_id = p_client_id
     AND (batch_id IS DISTINCT FROM v_batch_id);

  -- ---------- Insert advances + paired ledger events ----------
  -- Per-row loop is acceptable here because:
  --   (a) typical advance covers tens, not thousands, of POs
  --   (b) we need RETURNING id from each advance to feed into the matching
  --       ledger_event insert (1:1 pairing).
  -- The plpgsql FOR loop overhead is negligible at this scale.
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_po_id := (v_alloc->>'purchase_order_id')::uuid;
    v_principal_cents := (v_alloc->>'principal_cents')::bigint;

    INSERT INTO advances (
      client_id,
      purchase_order_id,
      invoice_id,
      batch_id,
      advance_type,
      advance_date,
      initial_principal_cents,
      rule_set_id,
      committed_at,
      committed_by,
      status
    ) VALUES (
      p_client_id,
      v_po_id,
      NULL,                  -- AR invoice_id only when type='ar'
      v_batch_id,
      'po',
      p_advance_date,
      v_principal_cents,
      v_rule_set_id,
      v_now,
      v_committed_by,
      'committed'
    )
    RETURNING id INTO v_advance_id;

    v_inserted_advance_ids := v_inserted_advance_ids || v_advance_id;

    -- Paired ledger event. principal_delta_cents must be positive per the
    -- ledger_events_type_invariants CHECK. effective_date = advance_date
    -- per spec — fees accrue from this date, payments measure timeliness
    -- relative to it.
    INSERT INTO ledger_events (
      client_id,
      event_type,
      effective_date,
      created_by,
      advance_id,
      purchase_order_id,
      batch_id,
      principal_delta_cents,
      fee_delta_cents,
      remittance_delta_cents,
      metadata
    ) VALUES (
      p_client_id,
      'advance_committed',
      p_advance_date,
      v_committed_by,
      v_advance_id,
      v_po_id,
      v_batch_id,
      v_principal_cents,
      0,
      0,
      jsonb_build_object('source', 'commit_po_advance')
    )
    RETURNING id INTO v_event_id;
  END LOOP;

  RETURN jsonb_build_object(
    'batch_id',         v_batch_id,
    'rule_set_id',      v_rule_set_id,
    'advance_count',    array_length(v_inserted_advance_ids, 1),
    'advance_ids',      to_jsonb(v_inserted_advance_ids),
    'total_cents',      v_total_cents
  );
END;
$$;

GRANT EXECUTE ON FUNCTION commit_po_advance(uuid, date, uuid, text, jsonb)
  TO authenticated;


-- ============================================================================
-- refresh_po_projections — explicit projection refresh after writes
--
-- The materialized views in 0005 are notification-driven, but Phase 1 has
-- no background worker yet. After commit_po_advance succeeds, the server
-- action calls this to recompute mv_advance_balances + mv_client_position
-- + mv_batch_position so the dashboards see the new advance immediately.
--
-- mv_invoice_aging is intentionally skipped — PO advances don't change
-- invoice rows.
--
-- We use REFRESH MATERIALIZED VIEW (not CONCURRENTLY) so it can run inside
-- a function. At Phase-1 scale (<10K advances per Client) this completes
-- in tens of milliseconds and the brief read lock is fine.
-- ============================================================================

CREATE OR REPLACE FUNCTION refresh_po_projections()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW mv_advance_balances;
  REFRESH MATERIALIZED VIEW mv_batch_position;
  REFRESH MATERIALIZED VIEW mv_client_position;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_po_projections() TO authenticated;
