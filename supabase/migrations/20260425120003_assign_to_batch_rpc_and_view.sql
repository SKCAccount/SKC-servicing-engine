-- ============================================================================
-- 0020_assign_to_batch_rpc_and_view.sql
--
-- Phase 1D commit 4 — Standalone Assign-to-Batch screen.
--
-- This migration does four things:
--
--   1. Extends the ledger_events_type_invariants CHECK with a branch for the
--      new `po_batch_reassigned` event type (added solo in 0019).
--
--   2. Creates v_purchase_orders_with_balance — a thin SQL view that joins
--      purchase_orders to a per-PO aggregation of mv_advance_balances. Used
--      by the new Assign-to-Batch list page (and unblocks the deferred
--      "filter by current principal / available borrowing base" feature on
--      the Advance on POs page).
--
--   3. Creates reassign_to_batch — the RPC backing the standalone
--      Assign-to-Batch screen. Reassigns one or more POs to a destination
--      batch (existing or new), follows them with their committed/funded
--      advances (per the rule from 0018), and emits one
--      po_batch_reassigned event per affected PO.
--
--   4. Retrofits commit_po_advance (last touched in 0018) to emit the same
--      event type whenever its own PO-reassignment branch fires. Keeps the
--      ledger story consistent across both entry points: every batch move
--      shows on the ledger, regardless of whether the user reached it via
--      "commit advance + reassign" or "assign-to-batch only."
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Extend the type-invariants CHECK
-- ----------------------------------------------------------------------------
-- po_batch_reassigned shape:
--   * purchase_order_id IS NOT NULL    — which PO moved
--   * batch_id IS NOT NULL              — destination batch
--   * principal_delta_cents = 0
--   * fee_delta_cents       = 0
--   * remittance_delta_cents = 0
--   * metadata carries from_batch_id (nullable for first-time-batched POs),
--     to_batch_id, and 'source' (commit_po_advance | reassign_to_batch).
--
-- DROP-and-readd is the safest path: ALTER TABLE ... ALTER CONSTRAINT can't
-- modify the CHECK expression in-place. The DROP + ADD runs inside one
-- transaction so no rows can sneak past during the gap.

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_invariants;

ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_invariants CHECK (
  CASE event_type
    WHEN 'advance_committed' THEN
      advance_id IS NOT NULL
      AND principal_delta_cents > 0
      AND fee_delta_cents = 0
      AND remittance_delta_cents = 0
    WHEN 'advance_funded' THEN
      advance_id IS NOT NULL
      AND principal_delta_cents = 0
      AND fee_delta_cents = 0
      AND remittance_delta_cents = 0
    WHEN 'fee_accrued' THEN
      advance_id IS NOT NULL
      AND principal_delta_cents = 0
      AND fee_delta_cents > 0
      AND remittance_delta_cents = 0
    WHEN 'one_time_fee_assessed' THEN
      one_time_fee_id IS NOT NULL
      AND principal_delta_cents = 0
      AND fee_delta_cents > 0
      AND remittance_delta_cents = 0
    WHEN 'payment_applied_to_principal' THEN
      bank_transaction_id IS NOT NULL
      AND advance_id IS NOT NULL
      AND principal_delta_cents < 0
      AND fee_delta_cents = 0
      AND remittance_delta_cents = 0
    WHEN 'payment_applied_to_fee' THEN
      bank_transaction_id IS NOT NULL
      AND principal_delta_cents = 0
      AND fee_delta_cents < 0
      AND remittance_delta_cents = 0
    WHEN 'payment_routed_to_remittance' THEN
      bank_transaction_id IS NOT NULL
      AND principal_delta_cents = 0
      AND fee_delta_cents = 0
      AND remittance_delta_cents > 0
    WHEN 'remittance_wire_sent' THEN
      remittance_id IS NOT NULL
      AND principal_delta_cents = 0
      AND fee_delta_cents = 0
      AND remittance_delta_cents < 0
    WHEN 'advance_reversed' THEN
      advance_id IS NOT NULL
      AND reverses_event_id IS NOT NULL
    WHEN 'po_converted_to_ar' THEN
      advance_id IS NOT NULL
      AND invoice_id IS NOT NULL
      AND principal_delta_cents = 0
      AND fee_delta_cents = 0
    WHEN 'pre_advance_converted' THEN
      advance_id IS NOT NULL
      AND invoice_id IS NOT NULL
      AND principal_delta_cents = 0
      AND fee_delta_cents = 0
    WHEN 'balance_transferred_out' THEN
      advance_id IS NOT NULL
      AND (principal_delta_cents < 0 OR fee_delta_cents < 0)
    WHEN 'balance_transferred_in' THEN
      advance_id IS NOT NULL
      AND (principal_delta_cents > 0 OR fee_delta_cents > 0)
    WHEN 'advance_written_off' THEN
      advance_id IS NOT NULL
    WHEN 'po_cancelled' THEN
      purchase_order_id IS NOT NULL
    WHEN 'po_cancellation_reversed' THEN
      purchase_order_id IS NOT NULL
      AND reverses_event_id IS NOT NULL
    WHEN 'po_batch_reassigned' THEN
      purchase_order_id IS NOT NULL
      AND batch_id IS NOT NULL
      AND principal_delta_cents = 0
      AND fee_delta_cents = 0
      AND remittance_delta_cents = 0
  END
);


-- ----------------------------------------------------------------------------
-- 2. v_purchase_orders_with_balance — pre-joined PO + outstanding-principal
-- ----------------------------------------------------------------------------
-- mv_advance_balances groups by advance_id, so a PO with two advances yields
-- two rows. We aggregate by purchase_order_id here and join to purchase_orders.
-- LEFT JOIN keeps POs that have no advances yet (current_principal_cents = 0).
--
-- RLS: views inherit RLS from their base tables. purchase_orders has an
-- RLS policy scoping by client_id; the LEFT JOIN against an aggregated
-- subquery doesn't add tenancy concerns because mv_advance_balances rows
-- with a foreign client_id can only attach to a purchase_orders row that's
-- already RLS-filtered out for the caller. Result: the view returns exactly
-- the same row visibility as a direct SELECT on purchase_orders.

CREATE OR REPLACE VIEW v_purchase_orders_with_balance AS
SELECT
  po.id,
  po.client_id,
  po.retailer_id,
  po.po_number,
  po.batch_id,
  po.issuance_date,
  po.requested_delivery_date,
  po.delivery_location,
  po.item_description,
  po.quantity_ordered,
  po.unit_value_cents,
  po.po_value_cents,
  po.status,
  po.cancellation_reason_category,
  po.cancellation_memo,
  po.cancelled_at,
  po.cancelled_by,
  po.parent_po_id,
  po.upload_id,
  po.created_at,
  po.updated_at,
  po.version,
  COALESCE(bal.current_principal_cents, 0) AS current_principal_cents,
  COALESCE(bal.fees_outstanding_cents,   0) AS fees_outstanding_cents
FROM purchase_orders po
LEFT JOIN (
  SELECT
    purchase_order_id,
    SUM(principal_outstanding_cents) AS current_principal_cents,
    SUM(fees_outstanding_cents)      AS fees_outstanding_cents
  FROM mv_advance_balances
  WHERE purchase_order_id IS NOT NULL
  GROUP BY purchase_order_id
) bal ON bal.purchase_order_id = po.id;

GRANT SELECT ON v_purchase_orders_with_balance TO authenticated;


-- ----------------------------------------------------------------------------
-- 3. reassign_to_batch — the standalone Assign-to-Batch RPC
-- ----------------------------------------------------------------------------
-- Inputs:
--   p_client_id                          — owning Client (RLS + sanity scope)
--   p_po_ids                             — POs to (re)assign
--   p_existing_batch_id                  — destination if existing batch
--   p_new_batch_name                     — non-NULL signals "create new batch"
--   p_acknowledged_batch_reassignment    — UI ack required when any selected
--                                          PO is currently in a different batch
--
-- Pass exactly one of p_existing_batch_id or p_new_batch_name. (Same
-- convention as commit_po_advance.) p_new_batch_name's value is ignored —
-- batches.name is GENERATED ALWAYS AS 'Batch ' || batch_number — we just
-- use NULL/non-NULL to signal which branch.
--
-- Behavior:
--   * Validates POs all belong to p_client_id.
--   * Resolves destination batch (existing or newly-created).
--   * For each PO whose batch_id != destination: UPDATE purchase_orders +
--     follow with UPDATE advances (committed/funded only; reversed/written-
--     off advances are historical and stay put), then INSERT one
--     po_batch_reassigned ledger event per affected PO with from/to in
--     metadata.
--   * Returns counts: pos_reassigned, advances_reassigned, events_emitted,
--     destination batch_id.
--
-- Atomicity: the whole RPC runs in one transaction (Postgres functions
-- always do); if any step throws, nothing persists.
--
-- ledger_events.batch_id stores the DESTINATION batch_id on the event row.
-- That mirrors how commit_po_advance stamps advance_committed events with
-- the destination batch and gives consistent batch-filtered ledger queries.

CREATE OR REPLACE FUNCTION reassign_to_batch(
  p_client_id                       uuid,
  p_po_ids                          uuid[],
  p_existing_batch_id               uuid,
  p_new_batch_name                  text,
  p_acknowledged_batch_reassignment boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_caller             uuid := auth.uid();
  v_now                timestamptz := now();
  v_batch_id           uuid;
  v_new_batch_number   int;
  v_invalid_po_count   int;
  v_affected_count     int;
  v_pos_reassigned     int := 0;
  v_advances_reassigned int := 0;
  v_events_emitted     int := 0;
  v_requires_ack       boolean;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'reassign_to_batch: must be called by an authenticated user';
  END IF;
  IF p_po_ids IS NULL OR array_length(p_po_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'reassign_to_batch: p_po_ids is empty';
  END IF;
  IF (p_existing_batch_id IS NULL) = (p_new_batch_name IS NULL) THEN
    RAISE EXCEPTION
      'reassign_to_batch: pass exactly one of p_existing_batch_id or p_new_batch_name';
  END IF;

  -- All requested POs must belong to this Client.
  SELECT COUNT(*) INTO v_invalid_po_count
    FROM unnest(p_po_ids) AS po_id
   WHERE NOT EXISTS (
     SELECT 1 FROM purchase_orders po
      WHERE po.id = po_id AND po.client_id = p_client_id
   );
  IF v_invalid_po_count > 0 THEN
    RAISE EXCEPTION
      'reassign_to_batch: % requested PO(s) do not belong to client %',
      v_invalid_po_count, p_client_id;
  END IF;

  -- Resolve / create destination batch.
  IF p_existing_batch_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM batches WHERE id = p_existing_batch_id AND client_id = p_client_id
    ) THEN
      RAISE EXCEPTION 'reassign_to_batch: batch % does not belong to client %',
        p_existing_batch_id, p_client_id;
    END IF;
    v_batch_id := p_existing_batch_id;
  ELSE
    v_new_batch_number := next_batch_number(p_client_id);
    INSERT INTO batches (client_id, batch_number)
    VALUES (p_client_id, v_new_batch_number)
    RETURNING id INTO v_batch_id;
  END IF;

  -- Ack check: if any selected PO is currently in a DIFFERENT batch,
  -- the caller must have ticked the acknowledgement.
  --   * Currently unbatched (batch_id IS NULL) POs are first-time
  --     assignments — no ack needed.
  --   * POs already in the destination batch are no-ops — also no ack
  --     needed.
  --   * Anything else is a true reassignment.
  SELECT EXISTS (
    SELECT 1 FROM purchase_orders po
     WHERE po.id = ANY(p_po_ids)
       AND po.client_id = p_client_id
       AND po.batch_id IS NOT NULL
       AND po.batch_id IS DISTINCT FROM v_batch_id
  ) INTO v_requires_ack;
  IF v_requires_ack AND NOT p_acknowledged_batch_reassignment THEN
    RAISE EXCEPTION
      'reassign_to_batch: one or more POs are currently in a different batch; user acknowledgement is required';
  END IF;

  -- Move PO rows + emit per-PO ledger events. CTE captures both
  -- the prior batch_id (so we can stamp the event metadata) and the
  -- post-update PO id.
  WITH affected AS (
    SELECT po.id AS purchase_order_id, po.batch_id AS from_batch_id
      FROM purchase_orders po
     WHERE po.id = ANY(p_po_ids)
       AND po.client_id = p_client_id
       AND po.batch_id IS DISTINCT FROM v_batch_id
  ),
  updated_pos AS (
    UPDATE purchase_orders po
       SET batch_id = v_batch_id
      FROM affected
     WHERE po.id = affected.purchase_order_id
    RETURNING po.id
  ),
  inserted_events AS (
    INSERT INTO ledger_events (
      client_id, event_type, effective_date, created_by,
      purchase_order_id, batch_id,
      principal_delta_cents, fee_delta_cents, remittance_delta_cents,
      metadata
    )
    SELECT
      p_client_id,
      'po_batch_reassigned',
      v_now::date,
      v_caller,
      affected.purchase_order_id,
      v_batch_id,
      0, 0, 0,
      jsonb_build_object(
        'source',         'reassign_to_batch',
        'from_batch_id',  affected.from_batch_id,
        'to_batch_id',    v_batch_id
      )
    FROM affected
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_pos_reassigned FROM updated_pos;

  -- Capture event-emit count from the same CTE chain. Postgres won't let us
  -- pull from two CTEs in the same enclosing SELECT after one of them has
  -- already executed (each CTE's RETURNING is consumable once), so we just
  -- use the same count — pos_reassigned == events_emitted by construction
  -- (one event per moved PO).
  v_events_emitted := v_pos_reassigned;

  -- Carry forward all committed/funded advances on the moved POs to the
  -- destination batch. Same rule as commit_po_advance v2.
  WITH moved_advances AS (
    UPDATE advances
       SET batch_id = v_batch_id
     WHERE purchase_order_id = ANY(p_po_ids)
       AND client_id = p_client_id
       AND status IN ('committed', 'funded')
       AND batch_id IS DISTINCT FROM v_batch_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_advances_reassigned FROM moved_advances;

  RETURN jsonb_build_object(
    'batch_id',              v_batch_id,
    'pos_reassigned',        v_pos_reassigned,
    'advances_reassigned',   v_advances_reassigned,
    'events_emitted',        v_events_emitted
  );
END;
$$;

GRANT EXECUTE ON FUNCTION reassign_to_batch(uuid, uuid[], uuid, text, boolean)
  TO authenticated;


-- ----------------------------------------------------------------------------
-- 4. Retrofit commit_po_advance to emit po_batch_reassigned events
-- ----------------------------------------------------------------------------
-- Same body as v2 (migration 0018) plus a new INSERT INTO ledger_events for
-- every PO whose batch actually changed. Sits alongside the existing
-- "carry advances to follow" UPDATE so the ordering is:
--
--   1. Move PO rows (UPDATE purchase_orders.batch_id)
--   2. Emit po_batch_reassigned events for each moved PO
--   3. Move follow-on advances (UPDATE advances.batch_id)
--   4. INSERT new advances + paired advance_committed events
--
-- The metadata.source field discriminates which entry path emitted the
-- event ('commit_po_advance' vs 'reassign_to_batch'), useful for audit
-- queries.

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
  v_pos_reassigned         int := 0;
  v_advances_reassigned    int := 0;
  v_reassign_events_emitted int := 0;
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

  -- ---------- Reassign POs to this batch + emit events ----------
  -- Captures from_batch_id alongside the move so we can stamp metadata.
  WITH affected AS (
    SELECT po.id AS purchase_order_id, po.batch_id AS from_batch_id
      FROM purchase_orders po
     WHERE po.id = ANY(v_po_ids)
       AND po.client_id = p_client_id
       AND po.batch_id IS DISTINCT FROM v_batch_id
  ),
  updated_pos AS (
    UPDATE purchase_orders po
       SET batch_id = v_batch_id
      FROM affected
     WHERE po.id = affected.purchase_order_id
    RETURNING po.id
  ),
  inserted_events AS (
    INSERT INTO ledger_events (
      client_id, event_type, effective_date, created_by,
      purchase_order_id, batch_id,
      principal_delta_cents, fee_delta_cents, remittance_delta_cents,
      metadata
    )
    SELECT
      p_client_id,
      'po_batch_reassigned',
      p_advance_date,
      v_committed_by,
      affected.purchase_order_id,
      v_batch_id,
      0, 0, 0,
      jsonb_build_object(
        'source',         'commit_po_advance',
        'from_batch_id',  affected.from_batch_id,
        'to_batch_id',    v_batch_id
      )
    FROM affected
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_pos_reassigned FROM updated_pos;
  v_reassign_events_emitted := v_pos_reassigned;

  -- ---------- Move existing advances on these POs to follow ----------
  -- Per spec "advance.batch_id follows PO/invoice on reassignment."
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
    'batch_id',                  v_batch_id,
    'rule_set_id',               v_rule_set_id,
    'advance_count',             array_length(v_inserted_advance_ids, 1),
    'advance_ids',               to_jsonb(v_inserted_advance_ids),
    'total_cents',               v_total_cents,
    'pos_reassigned',            v_pos_reassigned,
    'advances_reassigned',       v_advances_reassigned,
    'reassign_events_emitted',   v_reassign_events_emitted
  );
END;
$$;

-- Grants unchanged from 0017/0018 (still applies to authenticated).
