-- ============================================================================
-- 0007_rls_policies.sql
-- Row Level Security for every user-facing table.
-- Principle: deny-by-default, scope by Client.
-- ============================================================================

-- ---------- Helper: set of client_ids the current user can access ----------
CREATE OR REPLACE FUNCTION current_user_client_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  -- Admin Manager and Operator: access granted via user_client_access
  SELECT uca.client_id
  FROM user_client_access uca
  JOIN users u ON u.id = uca.user_id
  WHERE uca.user_id = auth.uid()
    AND u.role IN ('admin_manager', 'operator')
    AND u.status = 'active'
  UNION
  -- Client role: access only to their own client_id
  SELECT u.client_id
  FROM users u
  WHERE u.id = auth.uid()
    AND u.role = 'client'
    AND u.status = 'active'
    AND u.client_id IS NOT NULL
  UNION
  -- Investor stub: via investor_client_access
  SELECT ica.client_id
  FROM investor_client_access ica
  JOIN users u ON u.id = auth.uid()
  WHERE u.role = 'investor' AND u.status = 'active'
  UNION
  -- Creditor stub
  SELECT cca.client_id
  FROM creditor_client_access cca
  JOIN users u ON u.id = auth.uid()
  WHERE u.role = 'creditor' AND u.status = 'active';
$$;

CREATE OR REPLACE FUNCTION current_user_role()
RETURNS user_role
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM users WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION is_manager()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT current_user_role() IN ('admin_manager', 'operator');
$$;

CREATE OR REPLACE FUNCTION is_admin_manager()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT current_user_role() = 'admin_manager';
$$;

CREATE OR REPLACE FUNCTION is_client_user()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT current_user_role() = 'client';
$$;

-- ---------- Enable RLS on every table ----------
ALTER TABLE clients                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE retailers                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_client_access          ENABLE ROW LEVEL SECURITY;
ALTER TABLE investors                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE creditors                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_client_access      ENABLE ROW LEVEL SECURITY;
ALTER TABLE creditor_client_access      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_sets                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_uploads                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_uploads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_uploads                ENABLE ROW LEVEL SECURITY;
ALTER TABLE retailer_payment_uploads    ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_deductions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE advance_requests            ENABLE ROW LEVEL SECURITY;
ALTER TABLE advance_request_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE advances                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_time_fees               ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE retailer_payment_details    ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_bank_links          ENABLE ROW LEVEL SECURITY;
ALTER TABLE remittances                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_events               ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log                   ENABLE ROW LEVEL SECURITY;

-- ---------- Policies ----------
-- Pattern: one SELECT policy per table scoped to current_user_client_ids().
-- Write policies exist only for tables users can write to.

-- CLIENTS
CREATE POLICY clients_select ON clients FOR SELECT
  USING (id IN (SELECT current_user_client_ids()));
CREATE POLICY clients_write ON clients FOR ALL
  USING (is_admin_manager())
  WITH CHECK (is_admin_manager());

-- RETAILERS (global read for authenticated users; admin writes only)
CREATE POLICY retailers_select ON retailers FOR SELECT
  USING (auth.uid() IS NOT NULL);
CREATE POLICY retailers_write ON retailers FOR ALL
  USING (is_admin_manager())
  WITH CHECK (is_admin_manager());

-- USERS (self-read always; Admin Managers read all in their client scope)
CREATE POLICY users_select_self ON users FOR SELECT
  USING (id = auth.uid());
CREATE POLICY users_select_manager ON users FOR SELECT
  USING (is_manager() AND (client_id IS NULL OR client_id IN (SELECT current_user_client_ids())));
CREATE POLICY users_write_admin ON users FOR ALL
  USING (is_admin_manager())
  WITH CHECK (is_admin_manager());

-- USER_CLIENT_ACCESS
CREATE POLICY uca_select ON user_client_access FOR SELECT
  USING (user_id = auth.uid() OR is_admin_manager());
CREATE POLICY uca_write ON user_client_access FOR ALL
  USING (is_admin_manager())
  WITH CHECK (is_admin_manager());

-- INVESTORS / CREDITORS (Admin Manager only; stubs)
CREATE POLICY investors_admin ON investors FOR ALL
  USING (is_admin_manager()) WITH CHECK (is_admin_manager());
CREATE POLICY creditors_admin ON creditors FOR ALL
  USING (is_admin_manager()) WITH CHECK (is_admin_manager());
CREATE POLICY ica_admin ON investor_client_access FOR ALL
  USING (is_admin_manager()) WITH CHECK (is_admin_manager());
CREATE POLICY cca_admin ON creditor_client_access FOR ALL
  USING (is_admin_manager()) WITH CHECK (is_admin_manager());

-- RULE_SETS (Client can SEE rules applying to them; only Admin Manager writes)
CREATE POLICY rule_sets_select ON rule_sets FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()));
CREATE POLICY rule_sets_write ON rule_sets FOR ALL
  USING (is_admin_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_admin_manager() AND client_id IN (SELECT current_user_client_ids()));

-- BATCHES
CREATE POLICY batches_select ON batches FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()));
CREATE POLICY batches_manager_write ON batches FOR ALL
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

-- UPLOAD METADATA (managers write, all can see their scope)
CREATE POLICY po_uploads_select ON po_uploads FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()));
CREATE POLICY po_uploads_manager_write ON po_uploads FOR ALL
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

CREATE POLICY invoice_uploads_select ON invoice_uploads FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()));
CREATE POLICY invoice_uploads_manager_write ON invoice_uploads FOR ALL
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

CREATE POLICY bank_uploads_select ON bank_uploads FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()) AND is_manager());
CREATE POLICY bank_uploads_manager_write ON bank_uploads FOR ALL
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

CREATE POLICY retailer_payment_uploads_select ON retailer_payment_uploads FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()) AND is_manager());
CREATE POLICY retailer_payment_uploads_manager_write ON retailer_payment_uploads FOR ALL
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

-- PURCHASE ORDERS
CREATE POLICY po_select ON purchase_orders FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()));
CREATE POLICY po_manager_write ON purchase_orders FOR ALL
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

-- INVOICES (inherit Client scope via parent PO)
CREATE POLICY invoices_select ON invoices FOR SELECT
  USING (
    purchase_order_id IN (
      SELECT id FROM purchase_orders
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  );
CREATE POLICY invoices_manager_write ON invoices FOR ALL
  USING (
    is_manager() AND
    purchase_order_id IN (
      SELECT id FROM purchase_orders
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  )
  WITH CHECK (
    is_manager() AND
    purchase_order_id IN (
      SELECT id FROM purchase_orders
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  );

-- INVOICE DEDUCTIONS (via parent invoice -> PO -> client)
CREATE POLICY deductions_select ON invoice_deductions FOR SELECT
  USING (
    invoice_id IN (
      SELECT i.id FROM invoices i
      JOIN purchase_orders po ON po.id = i.purchase_order_id
      WHERE po.client_id IN (SELECT current_user_client_ids())
    )
  );
CREATE POLICY deductions_manager_write ON invoice_deductions FOR ALL
  USING (
    is_manager() AND invoice_id IN (
      SELECT i.id FROM invoices i
      JOIN purchase_orders po ON po.id = i.purchase_order_id
      WHERE po.client_id IN (SELECT current_user_client_ids())
    )
  )
  WITH CHECK (
    is_manager() AND invoice_id IN (
      SELECT i.id FROM invoices i
      JOIN purchase_orders po ON po.id = i.purchase_order_id
      WHERE po.client_id IN (SELECT current_user_client_ids())
    )
  );

-- ADVANCE REQUESTS
-- Clients can INSERT their own requests. Managers can SELECT/UPDATE within scope.
CREATE POLICY advance_requests_select ON advance_requests FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()));
CREATE POLICY advance_requests_client_insert ON advance_requests FOR INSERT
  WITH CHECK (
    is_client_user()
    AND client_id IN (SELECT current_user_client_ids())
    AND requested_by = auth.uid()
  );
CREATE POLICY advance_requests_manager_update ON advance_requests FOR UPDATE
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

CREATE POLICY ara_select ON advance_request_attachments FOR SELECT
  USING (
    advance_request_id IN (
      SELECT id FROM advance_requests
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  );
CREATE POLICY ara_client_insert ON advance_request_attachments FOR INSERT
  WITH CHECK (
    is_client_user() AND advance_request_id IN (
      SELECT id FROM advance_requests WHERE client_id IN (SELECT current_user_client_ids())
    )
  );

-- ADVANCES
CREATE POLICY advances_select ON advances FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()));
CREATE POLICY advances_manager_write ON advances FOR ALL
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

-- ONE_TIME_FEES
CREATE POLICY otf_select ON one_time_fees FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()));
CREATE POLICY otf_manager_write ON one_time_fees FOR ALL
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

-- BANK TRANSACTIONS (Manager only; Clients should NEVER see our bank data)
CREATE POLICY bank_txn_select_manager ON bank_transactions FOR SELECT
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()));
CREATE POLICY bank_txn_manager_write ON bank_transactions FOR ALL
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

-- RETAILER PAYMENT DETAILS (Manager only)
CREATE POLICY rpd_select_manager ON retailer_payment_details FOR SELECT
  USING (
    is_manager() AND retailer_payment_upload_id IN (
      SELECT id FROM retailer_payment_uploads
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  );
CREATE POLICY rpd_manager_write ON retailer_payment_details FOR ALL
  USING (
    is_manager() AND retailer_payment_upload_id IN (
      SELECT id FROM retailer_payment_uploads
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  )
  WITH CHECK (
    is_manager() AND retailer_payment_upload_id IN (
      SELECT id FROM retailer_payment_uploads
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  );

-- PAYMENT BANK LINKS (Manager only)
CREATE POLICY pbl_select_manager ON payment_bank_links FOR SELECT
  USING (
    is_manager() AND bank_transaction_id IN (
      SELECT id FROM bank_transactions
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  );
CREATE POLICY pbl_manager_write ON payment_bank_links FOR ALL
  USING (
    is_manager() AND bank_transaction_id IN (
      SELECT id FROM bank_transactions
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  )
  WITH CHECK (
    is_manager() AND bank_transaction_id IN (
      SELECT id FROM bank_transactions
      WHERE client_id IN (SELECT current_user_client_ids())
    )
  );

-- REMITTANCES (Client CAN see their own; Manager writes)
CREATE POLICY remittances_select ON remittances FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()));
CREATE POLICY remittances_manager_write ON remittances FOR ALL
  USING (is_manager() AND client_id IN (SELECT current_user_client_ids()))
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));

-- LEDGER EVENTS (everyone in scope can SELECT; only Managers can INSERT; no UPDATE/DELETE possible due to trigger)
CREATE POLICY events_select ON ledger_events FOR SELECT
  USING (client_id IN (SELECT current_user_client_ids()));
CREATE POLICY events_manager_insert ON ledger_events FOR INSERT
  WITH CHECK (is_manager() AND client_id IN (SELECT current_user_client_ids()));
-- NOTE: no UPDATE/DELETE policies — the append-only trigger handles this,
-- but absence of RLS policy provides a belt-and-suspenders defense.

-- AUDIT LOG (Manager only within scope; NULL client_id = system-wide, Admin only)
CREATE POLICY audit_select_manager ON audit_log FOR SELECT
  USING (
    is_manager() AND (
      client_id IS NULL AND is_admin_manager()
      OR client_id IN (SELECT current_user_client_ids())
    )
  );
-- No write policies; audit_log is trigger-populated only.

-- ---------- Client-portal sanitized views ----------
-- Clients should not see internal fields like notes on bad-standing advances,
-- capital source attribution, etc. These views project only what Clients may see.
-- Advances: hide committed_by, funded_wire_number, transfer linkage notes.
CREATE OR REPLACE VIEW v_client_advances AS
SELECT
  a.id,
  a.client_id,
  a.purchase_order_id,
  a.invoice_id,
  a.batch_id,
  a.advance_type,
  a.advance_date,
  a.initial_principal_cents,
  a.status,
  mab.principal_outstanding_cents,
  mab.fees_outstanding_cents
FROM advances a
JOIN mv_advance_balances mab ON mab.advance_id = a.id
WHERE a.status IN ('committed', 'funded', 'paid_in_full');
-- RLS inherited from advances.

-- Bank transactions / payment matching is NEVER exposed to Clients.
-- Client sees their position at the aggregate + per-advance level only.

-- ============================================================================
-- End of RLS migration. After this runs, pgTAP tests in /tests/rls/ should
-- assert the matrix: every table, every role, every client_id combination,
-- confirm that cross-tenant reads return 0 rows and cross-tenant writes fail.
-- ============================================================================
