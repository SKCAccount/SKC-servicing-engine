-- ============================================================================
-- 0004_event_log.sql
-- The ledger_events table is the source of truth for all financial state.
-- APPEND-ONLY. No UPDATE or DELETE permitted.
-- ============================================================================

CREATE TABLE ledger_events (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  event_type              ledger_event_type NOT NULL,
  event_seq               bigint GENERATED ALWAYS AS IDENTITY,
  effective_date          date NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Relationships (nullable; set based on event_type)
  advance_id              uuid NULL REFERENCES advances(id) ON DELETE RESTRICT,
  purchase_order_id       uuid NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  invoice_id              uuid NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  batch_id                uuid NULL REFERENCES batches(id) ON DELETE RESTRICT,
  bank_transaction_id     uuid NULL REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  remittance_id           uuid NULL REFERENCES remittances(id) ON DELETE RESTRICT,
  one_time_fee_id         uuid NULL REFERENCES one_time_fees(id) ON DELETE RESTRICT,

  -- Amounts (signed; zero when not applicable)
  principal_delta_cents   bigint NOT NULL DEFAULT 0,
  fee_delta_cents         bigint NOT NULL DEFAULT 0,
  remittance_delta_cents  bigint NOT NULL DEFAULT 0,

  -- Reversal linkage
  reverses_event_id       uuid NULL REFERENCES ledger_events(id) ON DELETE RESTRICT,
  reversed_by_event_id    uuid NULL REFERENCES ledger_events(id) ON DELETE RESTRICT,

  -- Metadata: waterfall priority tag, allocation ratio snapshot, notes
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes                   text NULL
);

-- ---------- Event type invariants (DB-level enforcement) ----------
-- Every event type has required fields. These constraints stop malformed events
-- from entering the log, protecting projection integrity.

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
  END
);

-- ---------- Indexes ----------
CREATE INDEX idx_events_client_id ON ledger_events(client_id);
CREATE INDEX idx_events_event_seq ON ledger_events(event_seq);
CREATE INDEX idx_events_advance_id ON ledger_events(advance_id) WHERE advance_id IS NOT NULL;
CREATE INDEX idx_events_invoice_id ON ledger_events(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_events_po_id ON ledger_events(purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX idx_events_batch_id ON ledger_events(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_events_bank_txn_id ON ledger_events(bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;
CREATE INDEX idx_events_remittance_id ON ledger_events(remittance_id) WHERE remittance_id IS NOT NULL;
CREATE INDEX idx_events_effective_date ON ledger_events(effective_date);
CREATE INDEX idx_events_reversed ON ledger_events(reversed_by_event_id) WHERE reversed_by_event_id IS NULL;
CREATE INDEX idx_events_type ON ledger_events(event_type);

-- ---------- Maintain reversed_by_event_id back-pointer ----------
CREATE OR REPLACE FUNCTION maintain_reversal_backpointer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only applies when the inserted event reverses another
  IF NEW.reverses_event_id IS NOT NULL THEN
    UPDATE ledger_events
    SET reversed_by_event_id = NEW.id
    WHERE id = NEW.reverses_event_id
      AND reversed_by_event_id IS NULL;

    -- Refuse if target is already reversed
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Event % is already reversed or does not exist', NEW.reverses_event_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_events_reversal_backpointer
  AFTER INSERT ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION maintain_reversal_backpointer();

-- ---------- Enforce append-only at DB level ----------
-- No UPDATE or DELETE allowed on ledger_events, not even by service_role.
CREATE OR REPLACE FUNCTION prevent_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- EXCEPTION: allow the reversal-backpointer trigger to write reversed_by_event_id.
  -- That trigger runs as the table owner and bypasses this check via SECURITY DEFINER
  -- in practice; for simple cases we'll distinguish by checking if ONLY
  -- reversed_by_event_id changed.
  IF TG_OP = 'UPDATE' THEN
    IF (
      OLD.id IS DISTINCT FROM NEW.id
      OR OLD.client_id IS DISTINCT FROM NEW.client_id
      OR OLD.event_type IS DISTINCT FROM NEW.event_type
      OR OLD.event_seq IS DISTINCT FROM NEW.event_seq
      OR OLD.effective_date IS DISTINCT FROM NEW.effective_date
      OR OLD.recorded_at IS DISTINCT FROM NEW.recorded_at
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.created_by IS DISTINCT FROM NEW.created_by
      OR OLD.advance_id IS DISTINCT FROM NEW.advance_id
      OR OLD.purchase_order_id IS DISTINCT FROM NEW.purchase_order_id
      OR OLD.invoice_id IS DISTINCT FROM NEW.invoice_id
      OR OLD.batch_id IS DISTINCT FROM NEW.batch_id
      OR OLD.bank_transaction_id IS DISTINCT FROM NEW.bank_transaction_id
      OR OLD.remittance_id IS DISTINCT FROM NEW.remittance_id
      OR OLD.one_time_fee_id IS DISTINCT FROM NEW.one_time_fee_id
      OR OLD.principal_delta_cents IS DISTINCT FROM NEW.principal_delta_cents
      OR OLD.fee_delta_cents IS DISTINCT FROM NEW.fee_delta_cents
      OR OLD.remittance_delta_cents IS DISTINCT FROM NEW.remittance_delta_cents
      OR OLD.reverses_event_id IS DISTINCT FROM NEW.reverses_event_id
      OR OLD.metadata IS DISTINCT FROM NEW.metadata
      OR OLD.notes IS DISTINCT FROM NEW.notes
    ) THEN
      RAISE EXCEPTION 'ledger_events is append-only. To correct, insert a reversal event.';
    END IF;
    -- Only reversed_by_event_id changed; allow through.
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_events is append-only. DELETE is not permitted.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_events_prevent_mutation
  BEFORE UPDATE OR DELETE ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION prevent_event_mutation();

-- ---------- Over-Advanced state maintenance ----------
-- When principal changes, recompute client-level over-advanced state.
-- Runs AFTER INSERT on ledger_events when principal_delta_cents != 0.
CREATE OR REPLACE FUNCTION recompute_client_over_advanced(p_client_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_was_over boolean;
  v_is_over  boolean;
BEGIN
  SELECT over_advanced_state INTO v_was_over FROM clients WHERE id = p_client_id;

  -- Compute current state from mv_client_position (defined in 0005)
  -- During migration before mv_client_position exists, this computes NULL; guard.
  BEGIN
    SELECT is_over_advanced INTO v_is_over
    FROM mv_client_position WHERE client_id = p_client_id;
  EXCEPTION WHEN undefined_table THEN
    RETURN; -- Called before projections exist; skip.
  END;

  IF v_is_over IS NULL THEN
    RETURN;
  END IF;

  IF v_was_over IS DISTINCT FROM v_is_over THEN
    UPDATE clients SET
      over_advanced_state = v_is_over,
      over_advanced_since = CASE WHEN v_is_over THEN now() ELSE NULL END
    WHERE id = p_client_id;
    -- Notification dispatch handled by a separate channel listener in app code.
    PERFORM pg_notify(
      'client_over_advanced_change',
      json_build_object(
        'client_id', p_client_id,
        'is_over_advanced', v_is_over
      )::text
    );
  END IF;
END;
$$;
