-- ============================================================================
-- 0001_extensions_and_enums.sql
-- Extensions and all enum types used throughout the schema.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- Users & roles ----------
CREATE TYPE user_role AS ENUM (
  'admin_manager',
  'operator',
  'client',
  'investor',
  'creditor'
);

CREATE TYPE user_status AS ENUM ('active', 'disabled');

-- ---------- Clients ----------
CREATE TYPE client_status AS ENUM ('active', 'inactive', 'paused');

-- ---------- Purchase orders ----------
CREATE TYPE po_status AS ENUM (
  'active',
  'partially_invoiced',
  'fully_invoiced',
  'cancelled',
  'written_off'
);

CREATE TYPE cancellation_reason AS ENUM (
  'shortage',
  'quality',
  'retailer_cancelled',
  'client_request',
  'other'
);

-- ---------- Advances ----------
CREATE TYPE advance_type AS ENUM ('po', 'ar', 'pre_advance');

CREATE TYPE advance_status AS ENUM (
  'committed',       -- recorded in app, not yet wired
  'funded',          -- wire confirmed
  'paid_in_full',    -- principal = 0 and fees = 0
  'transferred_out', -- moved to another advance via bad-standing remedy
  'written_off',     -- admin manager wrote off
  'reversed'         -- undone
);

-- ---------- One-time fees ----------
CREATE TYPE fee_target_type AS ENUM (
  'advance',
  'purchase_order',
  'invoice',
  'batch',
  'client'
);

-- ---------- Advance requests ----------
CREATE TYPE advance_request_status AS ENUM (
  'pending',
  'approved',
  'rejected',
  'fulfilled'
);

-- ---------- Invoice deductions ----------
CREATE TYPE deduction_category AS ENUM (
  'shortage',
  'damage',
  'otif_fine',
  'pricing',
  'promotional',
  'other'
);

-- ---------- Bank transactions ----------
CREATE TYPE bank_direction AS ENUM ('credit', 'debit');

CREATE TYPE bank_memo_class AS ENUM (
  'remittance_wire',
  'advance_funding',
  'internal_transfer',
  'unknown'
);

CREATE TYPE bank_txn_status AS ENUM (
  'unassigned',
  'matched',
  'batch_applied',
  'remittance',
  'ignored'
);

-- ---------- Payment matching ----------
CREATE TYPE match_type AS ENUM ('strict', 'fuzzy', 'manual');

CREATE TYPE payment_link_target AS ENUM ('invoice', 'batch');

-- ---------- Ledger event types ----------
CREATE TYPE ledger_event_type AS ENUM (
  'advance_committed',
  'advance_funded',
  'fee_accrued',
  'one_time_fee_assessed',
  'payment_applied_to_principal',
  'payment_applied_to_fee',
  'payment_routed_to_remittance',
  'remittance_wire_sent',
  'advance_reversed',
  'po_converted_to_ar',
  'pre_advance_converted',
  'balance_transferred_out',
  'balance_transferred_in',
  'advance_written_off',
  'po_cancelled',
  'po_cancellation_reversed'
);
