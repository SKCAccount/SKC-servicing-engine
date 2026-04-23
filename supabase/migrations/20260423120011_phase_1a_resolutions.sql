-- ============================================================================
-- 0011_phase_1a_resolutions.sql  (part 1 of 2)
--
-- ALTER TYPE ... ADD VALUE must commit in its own transaction before any
-- later statement can USE the new value. Supabase wraps each migration file
-- in a transaction, so this migration is intentionally tiny: it contains ONLY
-- the enum addition. The rest of the Phase 1A resolutions (pre-advance PO
-- nullability, mv_client_position rebuild, invoices.invoice_date NOT NULL,
-- one_time_fees target validation trigger) lives in 0012.
--
-- Background: when `mv_client_position` filters purchase_orders on
-- `status IN ('active', 'partially_invoiced', 'closed_awaiting_invoice')`,
-- the parser used for WHERE-IN enum literals needs `closed_awaiting_invoice`
-- to already exist in the enum's committed catalog. That only happens after
-- this migration commits.
-- ============================================================================

ALTER TYPE po_status ADD VALUE IF NOT EXISTS 'closed_awaiting_invoice';
