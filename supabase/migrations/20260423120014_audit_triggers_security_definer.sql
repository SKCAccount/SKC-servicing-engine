-- ============================================================================
-- 0014_audit_triggers_security_definer.sql
--
-- Fix: INSERT into clients (and any other reference table) failed with
--   "new row violates row-level security policy for table audit_log"
-- because the audit trigger `log_reference_change()` runs as the caller by
-- default, and audit_log has RLS enabled with NO insert policy (writes are
-- trigger-populated only).
--
-- Standard fix: mark the audit trigger functions SECURITY DEFINER so they
-- execute with the function owner's privileges. Audit writes then bypass
-- RLS just for the insert into audit_log, while the outer user's operation
-- (insert into clients, etc.) still enforces RLS normally.
--
-- Also: pin SET search_path = public to prevent any future caller from
-- hijacking function resolution via a mutable search_path (standard
-- SECURITY DEFINER hardening).
--
-- Migrations 0006 and 0010 are updated in the repo for fresh installs;
-- THIS migration patches existing deployments.
-- ============================================================================

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

  BEGIN
    v_client_id := COALESCE((v_after->>'client_id')::uuid, (v_before->>'client_id')::uuid);
  EXCEPTION WHEN OTHERS THEN
    v_client_id := NULL;
  END;

  INSERT INTO audit_log (table_name, row_id, operation, changed_by, before, after, client_id)
  VALUES (TG_TABLE_NAME, v_row_id, TG_OP, v_changed_by, v_before, v_after, v_client_id);

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION log_po_line_change()
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
  v_po_id     uuid;
BEGIN
  BEGIN
    v_changed_by := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_changed_by := NULL;
  END;

  IF TG_OP = 'INSERT' THEN
    v_before := NULL;
    v_after  := to_jsonb(NEW);
    v_row_id := NEW.id;
    v_po_id  := NEW.purchase_order_id;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    v_row_id := NEW.id;
    v_po_id  := NEW.purchase_order_id;
  ELSIF TG_OP = 'DELETE' THEN
    v_before := to_jsonb(OLD);
    v_after  := NULL;
    v_row_id := OLD.id;
    v_po_id  := OLD.purchase_order_id;
  END IF;

  SELECT client_id INTO v_client_id FROM purchase_orders WHERE id = v_po_id;

  INSERT INTO audit_log (table_name, row_id, operation, changed_by, before, after, client_id)
  VALUES ('purchase_order_lines', v_row_id, TG_OP, v_changed_by, v_before, v_after, v_client_id);

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
