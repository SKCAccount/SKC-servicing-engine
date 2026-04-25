-- ============================================================================
-- 0018_commit_po_advance_v2_advance_batch_follows.sql
--
-- Fixes a real data-consistency bug discovered while testing two-step
-- advances on the same PO:
--
--   * PO X gets a 50% advance committed under Batch 2.
--   * Then PO X gets a second advance committed under Batch 3 (new batch).
--   * commit_po_advance v1 (migration 0017) updated purchase_orders.batch_id
--     to Batch 3 but did NOT update the existing advance row's batch_id.
--   * Result: PO X displays in Batch 3 with $X+$Y principal in the per-PO
--     rollup, but mv_batch_position shows the old advance still living in
--     Batch 2 (no PO matching) and the new advance in Batch 3 (PO matches).
--     Batch-level views become internally inconsistent.
--
-- Per spec (02_SCHEMA.md §advances): "Batch at creation; follows PO/invoice
-- on reassignment". When a PO moves batches, every active advance on that
-- PO should move with it so batch-level payment math (Phase 1F) sees a
-- coherent grouping.
--
-- Fix: after the PO batch UPDATE, run an UPDATE on advances setting
-- batch_id = v_batch_id for every advance on the affected POs whose batch
-- isn't already the destination. status filter excludes
-- reversed/written-off advances (those are historical and should not move).
--
-- ledger_events.batch_id is left unchanged — that table is append-only and
-- stores the batch each event was emitted under, which is a true historical
-- fact even after the PO has moved.
-- ============================================================================

CREATE OR REPLACE FUNCTION commit_po_advance(
  p_client_id uuid,
  p_advance_date date,
  p_existing_batch_id uuid,
  p_new_batch_name text,
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
  v_pos_reassigned         int;
  v_advances_reassigned    int;
BEGIN
  -- ---------- Validation (unchanged from v1) ----------
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

  SELECT COALESCE(SUM((elem->>'principal_cents')::bigint), 0)
    INTO v_total_cents
    FROM jsonb_array_elements(p_allocations) elem;
  IF v_total_cents <= 0 THEN
    RAISE EXCEPTION 'commit_po_advance: total advance amount must be > 0 (got %)', v_total_cents;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_allocations) elem
     WHERE COALESCE((elem->>'principal_cents')::bigint, 0) <= 0
  ) THEN
    RAISE EXCEPTION 'commit_po_advance: every allocation must have principal_cents > 0';
  END IF;

  SELECT array_agg((elem->>'purchase_order_id')::uuid)
    INTO v_po_ids
    FROM jsonb_array_elements(p_allocations) elem;

  SELECT COUNT(*) INTO v_invalid_po_count
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

  -- ---------- Reassign POs to this batch ----------
  WITH moved AS (
    UPDATE purchase_orders
       SET batch_id = v_batch_id
     WHERE id = ANY(v_po_ids)
       AND client_id = p_client_id
       AND (batch_id IS DISTINCT FROM v_batch_id)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_pos_reassigned FROM moved;

  -- ---------- NEW IN v2: move existing advances on these POs to follow ----------
  -- The advance.batch_id field per spec "follows PO/invoice on reassignment".
  -- v1 omitted this; existing advances on a moved PO got stranded in their
  -- old batch, breaking mv_batch_position rollups.
  --
  -- status filter: only carry committed/funded advances. Reversed and
  -- written-off advances are historical artifacts that should not move
  -- (they're already excluded from active rollups anyway via
  -- `reversed_by_event_id IS NULL` filtering on events).
  WITH moved AS (
    UPDATE advances
       SET batch_id = v_batch_id
     WHERE purchase_order_id = ANY(v_po_ids)
       AND client_id = p_client_id
       AND status IN ('committed', 'funded')
       AND batch_id IS DISTINCT FROM v_batch_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_advances_reassigned FROM moved;

  -- ---------- Insert advances + paired ledger events ----------
  -- (Unchanged from v1 — per-row loop is fine at typical advance scale.)
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_po_id := (v_alloc->>'purchase_order_id')::uuid;
    v_principal_cents := (v_alloc->>'principal_cents')::bigint;

    INSERT INTO advances (
      client_id, purchase_order_id, invoice_id, batch_id,
      advance_type, advance_date, initial_principal_cents, rule_set_id,
      committed_at, committed_by, status
    ) VALUES (
      p_client_id, v_po_id, NULL, v_batch_id,
      'po', p_advance_date, v_principal_cents, v_rule_set_id,
      v_now, v_committed_by, 'committed'
    )
    RETURNING id INTO v_advance_id;

    v_inserted_advance_ids := v_inserted_advance_ids || v_advance_id;

    INSERT INTO ledger_events (
      client_id, event_type, effective_date, created_by,
      advance_id, purchase_order_id, batch_id,
      principal_delta_cents, fee_delta_cents, remittance_delta_cents,
      metadata
    ) VALUES (
      p_client_id, 'advance_committed', p_advance_date, v_committed_by,
      v_advance_id, v_po_id, v_batch_id,
      v_principal_cents, 0, 0,
      jsonb_build_object('source', 'commit_po_advance')
    )
    RETURNING id INTO v_event_id;
  END LOOP;

  RETURN jsonb_build_object(
    'batch_id',              v_batch_id,
    'rule_set_id',           v_rule_set_id,
    'advance_count',         array_length(v_inserted_advance_ids, 1),
    'advance_ids',           to_jsonb(v_inserted_advance_ids),
    'total_cents',           v_total_cents,
    'pos_reassigned',        v_pos_reassigned,
    'advances_reassigned',   v_advances_reassigned
  );
END;
$$;

-- Grants unchanged.
