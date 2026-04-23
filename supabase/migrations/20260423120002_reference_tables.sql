-- ============================================================================
-- 0002_reference_tables.sql
-- Stable CRUD-able entities: clients, retailers, users, rule_sets, stubs.
-- ============================================================================

-- ---------- Clients ----------
CREATE TABLE clients (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name             text NOT NULL,
  display_name           text NOT NULL,
  status                 client_status NOT NULL DEFAULT 'active',
  over_advanced_state    boolean NOT NULL DEFAULT false,
  over_advanced_since    timestamptz NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                int NOT NULL DEFAULT 1,
  CONSTRAINT clients_display_name_not_empty CHECK (length(display_name) > 0)
);

CREATE INDEX idx_clients_status ON clients(status);

-- ---------- Retailers ----------
CREATE TABLE retailers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text NOT NULL UNIQUE,
  display_name                text NOT NULL,
  bank_description_patterns   text[] NOT NULL DEFAULT '{}',
  has_standardized_parser     boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  version                     int NOT NULL DEFAULT 1
);

-- ---------- Users (extends auth.users) ----------
CREATE TABLE users (
  id                        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                     text NOT NULL,
  role                      user_role NOT NULL,
  client_id                 uuid NULL REFERENCES clients(id) ON DELETE RESTRICT,
  status                    user_status NOT NULL DEFAULT 'active',
  notification_preferences  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  version                   int NOT NULL DEFAULT 1,
  -- Client-role users must have a client_id; other roles must not.
  CONSTRAINT users_client_id_matches_role CHECK (
    (role = 'client' AND client_id IS NOT NULL) OR
    (role <> 'client' AND client_id IS NULL)
  )
);

CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_client_id ON users(client_id) WHERE client_id IS NOT NULL;

-- ---------- Manager/stub access grants ----------
CREATE TABLE user_client_access (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  granted_by  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id)
);

-- ---------- Investor / Creditor stubs (T8) ----------
CREATE TABLE investors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  contact_email  text NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1
);

CREATE TABLE creditors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  contact_email  text NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1
);

CREATE TABLE investor_client_access (
  investor_id  uuid NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  granted_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (investor_id, client_id)
);

CREATE TABLE creditor_client_access (
  creditor_id  uuid NOT NULL REFERENCES creditors(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  granted_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creditor_id, client_id)
);

-- ---------- Rule sets (immutable snapshots of fee + borrowing base + payment allocation) ----------
-- A rule_set is NEVER updated once an advance references it. To "change rules,"
-- insert a new row with a new effective_from. This is what makes "fees
-- prospective, borrowing base retroactive" clean:
--
--   * Fee calculation uses advance.rule_set_id_at_creation (frozen at creation).
--   * Borrowing base calculation uses the currently-active rule_set for the Client.
--
CREATE TABLE rule_sets (
  id                                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                              uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  effective_from                         date NOT NULL,
  effective_to                           date NULL,  -- NULL = currently active
  created_by                             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at                             timestamptz NOT NULL DEFAULT now(),

  -- Fee rules
  period_1_days                          int NOT NULL CHECK (period_1_days > 0),
  period_1_fee_rate_bps                  int NOT NULL CHECK (period_1_fee_rate_bps >= 0),
  period_2_days                          int NOT NULL CHECK (period_2_days > 0),
  period_2_fee_rate_bps                  int NOT NULL CHECK (period_2_fee_rate_bps >= 0),
  subsequent_period_days                 int NOT NULL CHECK (subsequent_period_days > 0),
  subsequent_period_fee_rate_bps         int NOT NULL CHECK (subsequent_period_fee_rate_bps >= 0),

  -- Borrowing base rules
  po_advance_rate_bps                    int NOT NULL CHECK (po_advance_rate_bps BETWEEN 0 AND 10000),
  ar_advance_rate_bps                    int NOT NULL CHECK (ar_advance_rate_bps BETWEEN 0 AND 10000),
  pre_advance_rate_bps                   int NOT NULL CHECK (pre_advance_rate_bps BETWEEN 0 AND 10000),
  ar_aged_out_days                       int NOT NULL CHECK (ar_aged_out_days > 0),
  aged_out_warning_lead_days             int NOT NULL DEFAULT 5 CHECK (aged_out_warning_lead_days >= 0),
  aged_out_warnings_enabled              boolean NOT NULL DEFAULT true,

  -- Payment allocation (independent inputs per final prompt revision)
  payment_allocation_principal_bps       int NOT NULL CHECK (payment_allocation_principal_bps BETWEEN 0 AND 10000),
  payment_allocation_fee_bps             int NOT NULL CHECK (payment_allocation_fee_bps BETWEEN 0 AND 10000),

  CONSTRAINT rule_sets_allocation_sums_100 CHECK (
    payment_allocation_principal_bps + payment_allocation_fee_bps = 10000
  ),
  CONSTRAINT rule_sets_effective_range CHECK (
    effective_to IS NULL OR effective_to > effective_from
  )
);

CREATE INDEX idx_rule_sets_client_active
  ON rule_sets(client_id) WHERE effective_to IS NULL;

-- Enforce single active rule_set per Client
CREATE UNIQUE INDEX uq_rule_sets_one_active_per_client
  ON rule_sets(client_id) WHERE effective_to IS NULL;

-- ---------- Helper: current rule_set for a Client ----------
-- SET search_path = public is CRITICAL: without it, the function's body
-- reference to `rule_sets` fails to resolve when the function is inlined
-- during CREATE MATERIALIZED VIEW (planner search_path is restricted).
CREATE OR REPLACE FUNCTION current_rule_set(p_client_id uuid)
RETURNS rule_sets
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT * FROM rule_sets
  WHERE client_id = p_client_id AND effective_to IS NULL
  LIMIT 1;
$$;

-- ---------- updated_at maintenance ----------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clients_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_retailers_updated_at BEFORE UPDATE ON retailers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_investors_updated_at BEFORE UPDATE ON investors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_creditors_updated_at BEFORE UPDATE ON creditors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
