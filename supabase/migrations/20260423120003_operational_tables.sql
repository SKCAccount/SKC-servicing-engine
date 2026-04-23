-- ============================================================================
-- 0003_operational_tables.sql
-- POs, invoices, batches, advances, uploads, bank transactions, remittances.
-- ============================================================================

-- ---------- Batches ----------
CREATE TABLE batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  batch_number  int NOT NULL,
  name          text GENERATED ALWAYS AS ('Batch ' || batch_number::text) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,

  UNIQUE (client_id, batch_number),
  CONSTRAINT batches_batch_number_positive CHECK (batch_number > 0)
);

CREATE INDEX idx_batches_client_id ON batches(client_id);

CREATE TRIGGER trg_batches_updated_at BEFORE UPDATE ON batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Helper: next available batch_number for a Client.
CREATE OR REPLACE FUNCTION next_batch_number(p_client_id uuid)
RETURNS int
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT COALESCE(MAX(batch_number), 0) + 1
  FROM batches WHERE client_id = p_client_id;
$$;

-- ---------- Upload metadata ----------
CREATE TABLE po_uploads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  retailer_id      uuid NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  uploaded_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  source_filename  text NOT NULL,
  storage_path     text NOT NULL,           -- Supabase Storage path (retained indefinitely)
  parser_version   text NOT NULL,
  row_count        int NOT NULL DEFAULT 0,
  notes            text NULL
);
CREATE INDEX idx_po_uploads_client_id ON po_uploads(client_id);

CREATE TABLE invoice_uploads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  retailer_id      uuid NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  uploaded_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  source_filename  text NOT NULL,
  storage_path     text NOT NULL,
  parser_version   text NOT NULL,
  row_count        int NOT NULL DEFAULT 0,
  notes            text NULL
);
CREATE INDEX idx_invoice_uploads_client_id ON invoice_uploads(client_id);

CREATE TABLE bank_uploads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  uploaded_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  source_filename  text NOT NULL,
  storage_path     text NOT NULL,
  parser_version   text NOT NULL,
  statement_start  date NULL,
  statement_end    date NULL,
  row_count        int NOT NULL DEFAULT 0,
  notes            text NULL
);
CREATE INDEX idx_bank_uploads_client_id ON bank_uploads(client_id);

CREATE TABLE retailer_payment_uploads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  retailer_id      uuid NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  uploaded_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  source_filename  text NOT NULL,
  storage_path     text NOT NULL,
  parser_version   text NOT NULL,
  row_count        int NOT NULL DEFAULT 0,
  notes            text NULL
);
CREATE INDEX idx_retailer_payment_uploads_client_id ON retailer_payment_uploads(client_id);

-- ---------- Purchase Orders ----------
CREATE TABLE purchase_orders (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                       uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  retailer_id                     uuid NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  po_number                       text NOT NULL,
  batch_id                        uuid NULL REFERENCES batches(id) ON DELETE RESTRICT,
  issuance_date                   date NULL,
  requested_delivery_date         date NULL,
  delivery_location               text NULL,
  item_description                text NULL,
  quantity_ordered                int NULL,
  unit_value_cents                bigint NULL,
  po_value_cents                  bigint NOT NULL CHECK (po_value_cents >= 0),
  status                          po_status NOT NULL DEFAULT 'active',
  cancellation_reason_category    cancellation_reason NULL,
  cancellation_memo               text NULL,
  cancelled_at                    timestamptz NULL,
  cancelled_by                    uuid NULL REFERENCES users(id) ON DELETE RESTRICT,
  parent_po_id                    uuid NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  upload_id                       uuid NULL REFERENCES po_uploads(id) ON DELETE RESTRICT,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  version                         int NOT NULL DEFAULT 1,

  -- Three-part uniqueness (critical)
  UNIQUE (client_id, retailer_id, po_number),

  -- Cancellation fields are required together
  CONSTRAINT purchase_orders_cancellation_consistency CHECK (
    (status = 'cancelled' AND cancellation_reason_category IS NOT NULL AND cancellation_memo IS NOT NULL AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR
    (status <> 'cancelled')
  )
);

CREATE INDEX idx_po_client_id ON purchase_orders(client_id);
CREATE INDEX idx_po_retailer_id ON purchase_orders(retailer_id);
CREATE INDEX idx_po_batch_id ON purchase_orders(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_po_status ON purchase_orders(status);
CREATE INDEX idx_po_client_status_active ON purchase_orders(client_id, status)
  WHERE status IN ('active', 'partially_invoiced');

CREATE TRIGGER trg_po_updated_at BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Human-readable display label
CREATE OR REPLACE FUNCTION po_display_label(p_po purchase_orders, p_retailer retailers)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT p_retailer.display_name || '-' || p_po.po_number;
$$;

-- ---------- Invoices ----------
CREATE TABLE invoices (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id       uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  invoice_number          text NOT NULL,
  invoice_value_cents     bigint NOT NULL CHECK (invoice_value_cents >= 0),
  invoice_date            date NULL,
  due_date                date NULL,
  goods_delivery_date     date NULL,
  goods_delivery_location text NULL,
  approval_status         text NULL,
  item_description        text NULL,
  paid_in_full_date       date NULL,
  upload_id               uuid NULL REFERENCES invoice_uploads(id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  version                 int NOT NULL DEFAULT 1,

  UNIQUE (purchase_order_id, invoice_number)
);

CREATE INDEX idx_invoices_po_id ON invoices(purchase_order_id);
CREATE INDEX idx_invoices_open ON invoices(purchase_order_id)
  WHERE paid_in_full_date IS NULL;

CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Invoice Deductions ----------
CREATE TABLE invoice_deductions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  category          deduction_category NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  memo              text NULL,
  known_on_date     date NOT NULL,
  payment_id        uuid NULL, -- FK added in later migration to avoid circular dep
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           int NOT NULL DEFAULT 1
);

CREATE INDEX idx_deductions_invoice_id ON invoice_deductions(invoice_id);
CREATE INDEX idx_deductions_category ON invoice_deductions(category);

CREATE TRIGGER trg_deductions_updated_at BEFORE UPDATE ON invoice_deductions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Advance Requests ----------
CREATE TABLE advance_requests (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  requested_by             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_amount_cents   bigint NOT NULL CHECK (requested_amount_cents > 0),
  context_text             text NULL,
  status                   advance_request_status NOT NULL DEFAULT 'pending',
  reviewed_by              uuid NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at              timestamptz NULL,
  rejection_reason         text NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  int NOT NULL DEFAULT 1
);

CREATE INDEX idx_advance_requests_client_id ON advance_requests(client_id);
CREATE INDEX idx_advance_requests_status ON advance_requests(status);

CREATE TRIGGER trg_advance_requests_updated_at BEFORE UPDATE ON advance_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE advance_request_attachments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_request_id   uuid NOT NULL REFERENCES advance_requests(id) ON DELETE CASCADE,
  storage_path         text NOT NULL,
  filename             text NOT NULL,
  mime_type            text NOT NULL,
  size_bytes           bigint NOT NULL,
  uploaded_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachment_request_id ON advance_request_attachments(advance_request_id);

-- ---------- Advances ----------
-- Stores identity + immutable parameters. Running balances come from events.
CREATE TABLE advances (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                       uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  purchase_order_id               uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  invoice_id                      uuid NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  batch_id                        uuid NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  advance_type                    advance_type NOT NULL,
  advance_date                    date NOT NULL,
  initial_principal_cents         bigint NOT NULL CHECK (initial_principal_cents > 0),
  rule_set_id                     uuid NOT NULL REFERENCES rule_sets(id) ON DELETE RESTRICT,
  committed_at                    timestamptz NOT NULL DEFAULT now(),
  committed_by                    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  funded_at                       timestamptz NULL,
  funded_wire_number              text NULL,
  funded_by_bank_transaction_id   uuid NULL, -- FK added later; avoid circular
  status                          advance_status NOT NULL DEFAULT 'committed',
  transferred_from_advance_id     uuid NULL REFERENCES advances(id) ON DELETE RESTRICT,
  transferred_to_advance_id       uuid NULL REFERENCES advances(id) ON DELETE RESTRICT,
  advance_request_id              uuid NULL REFERENCES advance_requests(id) ON DELETE RESTRICT,
  capital_source_investor_id      uuid NULL REFERENCES investors(id) ON DELETE RESTRICT, -- Phase 2 stub
  capital_source_creditor_id      uuid NULL REFERENCES creditors(id) ON DELETE RESTRICT, -- Phase 2 stub
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  version                         int NOT NULL DEFAULT 1,

  -- Pre-advances are not tied to a specific PO at creation; require the PO reference anyway
  -- for simpler uniform structure — pre-advances use a synthetic "pre-advance placeholder" PO
  -- per batch that gets upgraded when real invoices arrive. (Alternative design was nullable
  -- purchase_order_id; this was rejected as it complicates every projection query.)

  -- AR advances require invoice_id
  CONSTRAINT advances_ar_has_invoice CHECK (
    (advance_type = 'ar' AND invoice_id IS NOT NULL) OR
    (advance_type <> 'ar')
  )
);

CREATE INDEX idx_advances_client_id ON advances(client_id);
CREATE INDEX idx_advances_po_id ON advances(purchase_order_id);
CREATE INDEX idx_advances_invoice_id ON advances(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_advances_batch_id ON advances(batch_id);
CREATE INDEX idx_advances_status ON advances(status);
CREATE INDEX idx_advances_active
  ON advances(client_id, advance_type)
  WHERE status IN ('committed', 'funded');
CREATE INDEX idx_advances_advance_date ON advances(advance_date);

CREATE TRIGGER trg_advances_updated_at BEFORE UPDATE ON advances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- One-Time Fees ----------
CREATE TABLE one_time_fees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  target_type    fee_target_type NOT NULL,
  target_id      uuid NULL,     -- FK not enforceable (polymorphic); app enforces
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  description    text NOT NULL,
  assessed_date  date NOT NULL,
  assessed_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1,

  CONSTRAINT one_time_fees_target_id_matches_type CHECK (
    (target_type = 'client' AND target_id IS NULL) OR
    (target_type <> 'client' AND target_id IS NOT NULL)
  )
);

CREATE INDEX idx_one_time_fees_client_id ON one_time_fees(client_id);
CREATE INDEX idx_one_time_fees_target ON one_time_fees(target_type, target_id);

CREATE TRIGGER trg_one_time_fees_updated_at BEFORE UPDATE ON one_time_fees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Bank Transactions ----------
CREATE TABLE bank_transactions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_upload_id              uuid NOT NULL REFERENCES bank_uploads(id) ON DELETE RESTRICT,
  client_id                   uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  posting_date                date NOT NULL,
  description                 text NOT NULL,
  amount_cents                bigint NOT NULL,
  bank_classified_type        text NOT NULL,
  direction                   bank_direction NOT NULL,
  retailer_id                 uuid NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  memo_classification         bank_memo_class NULL,
  status                      bank_txn_status NOT NULL DEFAULT 'unassigned',
  principal_only_override     boolean NOT NULL DEFAULT false,
  notes                       text NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  version                     int NOT NULL DEFAULT 1
);

CREATE INDEX idx_bank_txn_client_id ON bank_transactions(client_id);
CREATE INDEX idx_bank_txn_retailer_id ON bank_transactions(retailer_id) WHERE retailer_id IS NOT NULL;
CREATE INDEX idx_bank_txn_posting_date ON bank_transactions(posting_date);
CREATE INDEX idx_bank_txn_status ON bank_transactions(status);

CREATE TRIGGER trg_bank_txn_updated_at BEFORE UPDATE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Deferred FKs (circular dependency resolution)
ALTER TABLE advances
  ADD CONSTRAINT advances_funded_by_bank_transaction_fk
  FOREIGN KEY (funded_by_bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE RESTRICT;

-- ---------- Retailer Payment Details ----------
CREATE TABLE retailer_payment_details (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_payment_upload_id      uuid NOT NULL REFERENCES retailer_payment_uploads(id) ON DELETE RESTRICT,
  retailer_id                     uuid NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  purchase_order_number           text NOT NULL,
  invoice_number                  text NOT NULL,
  payment_date                    date NOT NULL,
  invoice_date                    date NULL,
  invoice_amount_cents            bigint NOT NULL,
  discount_cents                  bigint NOT NULL DEFAULT 0,
  deduction_cents                 bigint NOT NULL DEFAULT 0,
  paid_amount_cents               bigint NOT NULL,
  matched_bank_transaction_id     uuid NULL REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  match_type                      match_type NULL,
  resolved_invoice_id             uuid NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  version                         int NOT NULL DEFAULT 1
);

CREATE INDEX idx_retailer_pmt_upload_id ON retailer_payment_details(retailer_payment_upload_id);
CREATE INDEX idx_retailer_pmt_match_bank ON retailer_payment_details(matched_bank_transaction_id)
  WHERE matched_bank_transaction_id IS NOT NULL;
CREATE INDEX idx_retailer_pmt_resolved_invoice ON retailer_payment_details(resolved_invoice_id)
  WHERE resolved_invoice_id IS NOT NULL;
CREATE INDEX idx_retailer_pmt_group ON retailer_payment_details(retailer_id, payment_date);

CREATE TRIGGER trg_retailer_pmt_updated_at BEFORE UPDATE ON retailer_payment_details
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Payment Bank Links ----------
-- Maps a bank_transaction to the specific invoice(s) or batch(es) it pays.
-- Used by the waterfall engine to know "$X of this deposit applies to invoice Y".
CREATE TABLE payment_bank_links (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id    uuid NOT NULL REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  target_type            payment_link_target NOT NULL,
  target_id              uuid NOT NULL,     -- FK to invoices or batches, enforced in app
  amount_cents           bigint NOT NULL CHECK (amount_cents > 0),
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pmt_link_bank_txn ON payment_bank_links(bank_transaction_id);
CREATE INDEX idx_pmt_link_target ON payment_bank_links(target_type, target_id);

-- Deferred FK for invoice_deductions.payment_id
-- (Deductions are linked to the bank_transaction that revealed them, not to a payment_bank_link.)
ALTER TABLE invoice_deductions
  ADD CONSTRAINT invoice_deductions_payment_fk
  FOREIGN KEY (payment_id) REFERENCES bank_transactions(id) ON DELETE RESTRICT;

-- ---------- Remittances ----------
CREATE TABLE remittances (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  wire_amount_cents        bigint NOT NULL CHECK (wire_amount_cents > 0),
  wire_date                date NOT NULL,
  wire_tracking_number     text NOT NULL,
  notes                    text NULL,
  created_by               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  int NOT NULL DEFAULT 1
);

CREATE INDEX idx_remittances_client_id ON remittances(client_id);
CREATE INDEX idx_remittances_wire_date ON remittances(wire_date);

CREATE TRIGGER trg_remittances_updated_at BEFORE UPDATE ON remittances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
