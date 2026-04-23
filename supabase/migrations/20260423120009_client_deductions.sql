-- ============================================================================
-- 0009_client_deductions.sql
-- Client-level deductions that are NOT tied to a specific invoice.
--
-- Addition to support retailers (notably Kroger) that assess promotional
-- allowances, post-audit recoveries (e.g. via PRGX), and other net-against-
-- payment charges that are tied to the Client broadly rather than to a
-- specific purchase order or invoice.
--
-- These are distinct from `invoice_deductions`, which require a specific
-- invoice target. Both types are surfaced together in the Deductions Report.
-- ============================================================================

-- ---------- Status enum ----------
-- A client_deduction may be disputed by the Client (common with PRGX recoveries).
-- The state transitions are: accepted → (optional) disputed → (resolved: upheld | reversed).
CREATE TYPE client_deduction_status AS ENUM (
  'accepted',        -- Default on ingestion; the deduction is real, netted against payment
  'disputed',        -- Manager or Client has filed a dispute with the retailer
  'upheld',          -- Dispute concluded; deduction stands
  'reversed'         -- Dispute concluded; retailer credited the amount back (typically shows up as a positive retailer_payment row in a later period)
);

-- ---------- Source category enum ----------
-- Broader than invoice_deductions.category because the drivers are different.
CREATE TYPE client_deduction_source AS ENUM (
  'promo_allowance',         -- Kroger "Promo Allowances" category
  'non_promo_receivable',    -- Kroger "Non-Promo Receivable" (PRGX post-audit)
  'netting_offset',          -- Generic net-against payment offset
  'chargeback',              -- Retailer-initiated chargeback not tied to a specific invoice
  'other'
);

-- ---------- Table ----------
CREATE TABLE client_deductions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                 uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  retailer_id               uuid NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,

  -- Source identifiers: the retailer's own reference for this deduction.
  -- For Kroger this is the Invoice number (e.g. '092-AE38942-011' for promo rows).
  source_ref                text NOT NULL,
  source_category           client_deduction_source NOT NULL,
  source_subcategory        text NULL,  -- retailer-specific; e.g. 'PromoBilling' vs 'PRGX'

  -- Financial data (stored positive; this is a debit to the Client's receivables)
  amount_cents              bigint NOT NULL CHECK (amount_cents > 0),

  -- Contextual fields from the source file; useful for reports and dispute prep
  division                  text NULL,  -- Kroger Division field, e.g. '011 - ATLANTA KMA'
  location_description      text NULL,
  memo                      text NULL,

  -- Dates
  known_on_date             date NOT NULL,  -- When we became aware (typically the Invoice date or upload date)
  source_invoice_date       date NULL,      -- Retailer's reported invoice date for this deduction

  -- Status / lifecycle
  status                    client_deduction_status NOT NULL DEFAULT 'accepted',
  disputed_at               timestamptz NULL,
  disputed_by               uuid NULL REFERENCES users(id) ON DELETE RESTRICT,
  dispute_memo              text NULL,
  resolved_at               timestamptz NULL,
  resolved_by               uuid NULL REFERENCES users(id) ON DELETE RESTRICT,
  resolution_memo           text NULL,
  reversed_by_bank_txn_id   uuid NULL REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  -- If the retailer reverses the deduction by sending back the money, this links
  -- to the bank transaction that reflects the credit. Used in reports to show
  -- successful dispute outcomes.

  -- Linkage to source payment context (Kroger: Payment reference number)
  -- When the deduction was netted against a specific Kroger payment reference,
  -- this field captures that reference for reporting. The `payment_bank_links`
  -- table still owns the bank → payment mapping; this field is for explaining
  -- "which wire netted this deduction" without joining through.
  netted_in_payment_ref     text NULL,
  resolved_by_bank_upload_id uuid NULL REFERENCES bank_uploads(id) ON DELETE RESTRICT,

  -- Upload provenance
  upload_id                 uuid NULL REFERENCES invoice_uploads(id) ON DELETE RESTRICT,
  -- NOTE: client_deductions are ingested via the invoice upload parser for Kroger
  -- (they come in the same file as Warehouse invoices). If a different source
  -- emerges later (e.g. a dedicated chargeback feed), this FK becomes nullable
  -- and a parallel FK is added.

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  version                   int NOT NULL DEFAULT 1,

  -- Uniqueness: a single retailer reference maps to at most one deduction per client.
  -- Re-uploading the same source file does not create duplicates.
  CONSTRAINT client_deductions_unique_source UNIQUE (client_id, retailer_id, source_ref),

  -- Status transition consistency
  CONSTRAINT client_deductions_disputed_consistency CHECK (
    (status = 'accepted' AND disputed_at IS NULL AND resolved_at IS NULL)
    OR
    (status = 'disputed' AND disputed_at IS NOT NULL AND resolved_at IS NULL AND reversed_by_bank_txn_id IS NULL)
    OR
    (status = 'upheld' AND disputed_at IS NOT NULL AND resolved_at IS NOT NULL AND reversed_by_bank_txn_id IS NULL)
    OR
    (status = 'reversed' AND disputed_at IS NOT NULL AND resolved_at IS NOT NULL AND reversed_by_bank_txn_id IS NOT NULL)
  )
);

CREATE INDEX idx_client_deductions_client_id ON client_deductions(client_id);
CREATE INDEX idx_client_deductions_retailer_id ON client_deductions(retailer_id);
CREATE INDEX idx_client_deductions_status ON client_deductions(status);
CREATE INDEX idx_client_deductions_known_on_date ON client_deductions(known_on_date);
CREATE INDEX idx_client_deductions_netted_ref ON client_deductions(netted_in_payment_ref)
  WHERE netted_in_payment_ref IS NOT NULL;

-- ---------- updated_at trigger ----------
CREATE TRIGGER trg_client_deductions_updated_at BEFORE UPDATE ON client_deductions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Audit log trigger ----------
CREATE TRIGGER trg_audit_client_deductions
  AFTER INSERT OR UPDATE OR DELETE ON client_deductions
  FOR EACH ROW EXECUTE FUNCTION log_reference_change();

-- ---------- RLS ----------
ALTER TABLE client_deductions ENABLE ROW LEVEL SECURITY;

CREATE POLICY client_deductions_select ON client_deductions FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()));

CREATE POLICY client_deductions_manager_write ON client_deductions FOR ALL
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

-- ---------- Projection: deductions report ----------
-- A unioned view of invoice_deductions + client_deductions for the
-- Deductions Report. Exposed as a view so the report query is a single
-- SELECT regardless of source table.
CREATE OR REPLACE VIEW v_all_deductions AS
  SELECT
    'invoice'::text AS deduction_level,
    id_ AS id,
    client_id,
    retailer_id,
    NULL::text AS source_category_client,
    category::text AS category_invoice,
    amount_cents,
    known_on_date,
    memo,
    'accepted'::text AS status,
    created_at
  FROM (
    SELECT
      id_d.id AS id_,
      po.client_id,
      po.retailer_id,
      id_d.category,
      id_d.amount_cents,
      id_d.known_on_date,
      id_d.memo,
      id_d.created_at
    FROM invoice_deductions id_d
    JOIN invoices i ON i.id = id_d.invoice_id
    JOIN purchase_orders po ON po.id = i.purchase_order_id
  ) invd
  UNION ALL
  SELECT
    'client'::text AS deduction_level,
    id AS id,
    client_id,
    retailer_id,
    source_category::text AS source_category_client,
    NULL::text AS category_invoice,
    amount_cents,
    known_on_date,
    memo,
    status::text AS status,
    created_at
  FROM client_deductions;

-- RLS for the view is inherited from the underlying tables.
