-- ============================================================================
-- 0006_audit_log.sql
-- Logs every INSERT/UPDATE/DELETE on reference tables.
-- Financial events go to ledger_events; THIS log is for non-financial edits
-- (a user's email changed, a retailer's bank pattern was updated, etc.).
-- ============================================================================

CREATE TABLE audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name   text NOT NULL,
  row_id       uuid NOT NULL,
  operation    text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  changed_by   uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  "before"     jsonb NULL,
  "after"      jsonb NULL,
  client_id    uuid NULL   -- extracted for RLS filter; NULL = system-wide change
);

CREATE INDEX idx_audit_log_table_row ON audit_log(table_name, row_id);
CREATE INDEX idx_audit_log_changed_at ON audit_log(changed_at);
CREATE INDEX idx_audit_log_client_id ON audit_log(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX idx_audit_log_changed_by ON audit_log(changed_by) WHERE changed_by IS NOT NULL;

-- ---------- Audit trigger function ----------
-- Extracts client_id from the row if it has one, so RLS can filter audit rows per-Client.
--
-- SECURITY DEFINER is required: audit_log has RLS enabled with NO insert
-- policy (writes are trigger-populated only). Without SECURITY DEFINER, the
-- trigger would run as the caller and their INSERT into audit_log would be
-- blocked by RLS. Running as the owning role (supabase postgres) lets the
-- trigger bypass RLS just for the audit write.
--
-- SET search_path = public locks the function's relation resolution so it
-- can't be hijacked by a caller with a mutable search_path (a standard
-- SECURITY DEFINER hardening step).
CREATE OR REPLACE FUNCTION log_reference_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_id uuid;
  v_before    jsonb;
  v_after     jsonb;
  v_row_id    uuid;
  v_changed_by uuid;
BEGIN
  -- Determine actor: use auth.uid() when available, NULL for system/migration changes.
  BEGIN
    v_changed_by := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_changed_by := NULL;
  END;

  IF TG_OP = 'INSERT' THEN
    v_before  := NULL;
    v_after   := to_jsonb(NEW);
    v_row_id  := NEW.id;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before  := to_jsonb(OLD);
    v_after   := to_jsonb(NEW);
    v_row_id  := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_before  := to_jsonb(OLD);
    v_after   := NULL;
    v_row_id  := OLD.id;
  END IF;

  -- Extract client_id from either before/after row, if present.
  BEGIN
    v_client_id := COALESCE((v_after->>'client_id')::uuid, (v_before->>'client_id')::uuid);
  EXCEPTION WHEN OTHERS THEN
    v_client_id := NULL;
  END;

  INSERT INTO audit_log (table_name, row_id, operation, changed_by, before, after, client_id)
  VALUES (TG_TABLE_NAME, v_row_id, TG_OP, v_changed_by, v_before, v_after, v_client_id);

  -- For DELETE, return OLD; otherwise NEW.
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

-- ---------- Attach audit triggers to every reference table ----------
CREATE TRIGGER trg_audit_clients AFTER INSERT OR UPDATE OR DELETE ON clients
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_retailers AFTER INSERT OR UPDATE OR DELETE ON retailers
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_users AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_investors AFTER INSERT OR UPDATE OR DELETE ON investors
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_creditors AFTER INSERT OR UPDATE OR DELETE ON creditors
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_rule_sets AFTER INSERT OR UPDATE OR DELETE ON rule_sets
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_batches AFTER INSERT OR UPDATE OR DELETE ON batches
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_purchase_orders AFTER INSERT OR UPDATE OR DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_invoices AFTER INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_invoice_deductions AFTER INSERT OR UPDATE OR DELETE ON invoice_deductions
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_advances AFTER INSERT OR UPDATE OR DELETE ON advances
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_one_time_fees AFTER INSERT OR UPDATE OR DELETE ON one_time_fees
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_advance_requests AFTER INSERT OR UPDATE OR DELETE ON advance_requests
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_bank_transactions AFTER INSERT OR UPDATE OR DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
CREATE TRIGGER trg_audit_remittances AFTER INSERT OR UPDATE OR DELETE ON remittances
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();
