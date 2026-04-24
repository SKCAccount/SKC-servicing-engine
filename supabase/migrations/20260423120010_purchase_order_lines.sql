-- ============================================================================
-- 0010_purchase_order_lines.sql
-- Line-level detail for purchase orders. Primarily populated by Walmart's
-- SupplierOne line-level export, but usable for any retailer that provides
-- line items.
--
-- A purchase_order may have zero or many lines. Absence of lines does NOT
-- mean the PO is invalid — it means the source file was header-level only
-- (Walmart header export, generic CSV template) or the retailer doesn't
-- provide line detail.
--
-- Per Derek's decision (2026-04-23): Walmart line-level files are the default
-- upload; header-level fields are fully replaced by line-level upload data
-- for the POs the line-level file covers ("option A — full replacement").
-- ============================================================================

-- ---------- Line status enum ----------
CREATE TYPE po_line_status AS ENUM (
  'approved',            -- Line accepted but not yet fulfilled
  'received',            -- Fully received at destination
  'partially_received',  -- Some units received; remainder pending
  'cancelled'            -- Line cancelled; contributes $0 to PO total
);

-- ---------- purchase_order_lines ----------
CREATE TABLE purchase_order_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id        uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  -- CASCADE on delete: if a PO is hard-deleted (rare; normally we cancel or void),
  -- its lines go with it. Soft-cancellation via status='cancelled' retains lines.

  line_number              int NOT NULL CHECK (line_number > 0),
  retailer_item_number     text NULL,      -- e.g., Walmart "Walmart item No."
  item_description         text NULL,      -- Free-text from retailer feed

  quantity_ordered         int NULL CHECK (quantity_ordered IS NULL OR quantity_ordered >= 0),
  unit_cost_cents          bigint NULL CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  line_value_cents         bigint NULL CHECK (line_value_cents IS NULL OR line_value_cents >= 0),
  -- line_value_cents may be NULL for cancelled lines per Walmart's feed conventions:
  -- cancelled lines have NaN VNPK order cost, which the parser preserves as NULL.

  status                   po_line_status NOT NULL DEFAULT 'approved',
  upload_id                uuid NULL REFERENCES po_uploads(id) ON DELETE RESTRICT,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  int NOT NULL DEFAULT 1,

  -- A line number is unique within a purchase order
  UNIQUE (purchase_order_id, line_number),

  -- Cancelled lines are allowed to have NULL line_value_cents; non-cancelled lines
  -- should have a concrete value. Enforce the "non-cancelled must have value" direction
  -- as a soft validation — but do NOT fail the row on NULL in case of partial data.
  -- This is by design: the parser may ingest a row with status='approved' and
  -- line_value_cents=NULL if the source file is missing that column in a degenerate case.
  -- An application-layer warning surfaces these for Manager review.

  -- Cancelled lines MUST have line_value_cents either NULL (explicit cancel) or 0
  CONSTRAINT po_lines_cancelled_value_consistency CHECK (
    status <> 'cancelled'
    OR line_value_cents IS NULL
    OR line_value_cents = 0
  )
);

CREATE INDEX idx_po_lines_po_id ON purchase_order_lines(purchase_order_id);
CREATE INDEX idx_po_lines_status ON purchase_order_lines(status);
CREATE INDEX idx_po_lines_retailer_item ON purchase_order_lines(retailer_item_number)
  WHERE retailer_item_number IS NOT NULL;
CREATE INDEX idx_po_lines_active ON purchase_order_lines(purchase_order_id)
  WHERE status IN ('approved', 'received', 'partially_received');

-- ---------- updated_at trigger ----------
CREATE TRIGGER trg_po_lines_updated_at BEFORE UPDATE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Audit trigger ----------
-- Extracts client_id via parent PO for audit_log filtering.
-- See 0006 for the SECURITY DEFINER + search_path rationale.
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

CREATE TRIGGER trg_audit_po_lines
  AFTER INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION log_po_line_change();

-- ---------- RLS ----------
ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY po_lines_select ON purchase_order_lines FOR SELECT
  USING (
    purchase_order_id IN (
      SELECT id FROM purchase_orders
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  );

CREATE POLICY po_lines_manager_write ON purchase_order_lines FOR ALL
  USING (
    is_manager() AND purchase_order_id IN (
      SELECT id FROM purchase_orders
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  )
  WITH CHECK (
    is_manager() AND purchase_order_id IN (
      SELECT id FROM purchase_orders
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  );

-- ---------- PO value consistency check (advisory) ----------
-- When a PO has lines, the sum of non-cancelled line values should equal the
-- PO's po_value_cents. This is a soft invariant — the Walmart header total
-- already excludes cancelled line values, so it should hold naturally. The
-- check is advisory (function returns a diff; app-layer logs a warning rather
-- than a hard error).
CREATE OR REPLACE FUNCTION po_line_value_variance(p_po_id uuid)
RETURNS bigint
LANGUAGE sql STABLE
AS $$
  SELECT
    COALESCE(
      po.po_value_cents - (
        SELECT COALESCE(SUM(line_value_cents), 0)
        FROM purchase_order_lines
        WHERE purchase_order_id = p_po_id
          AND status <> 'cancelled'
      ),
      0
    )
  FROM purchase_orders po
  WHERE po.id = p_po_id;
$$;
-- Returns 0 when PO value equals sum of non-cancelled line values.
-- Non-zero → variance; app should surface to Manager for review.
