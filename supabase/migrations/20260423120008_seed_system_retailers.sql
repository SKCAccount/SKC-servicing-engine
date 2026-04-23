-- ============================================================================
-- 0008_seed_system_retailers.sql
-- Seed the retailer registry with Walmart and Kroger using the description
-- patterns observed in Phase 1 Chase bank statements.
--
-- Run this in every environment (dev, staging, prod). Idempotent via ON CONFLICT.
-- ============================================================================

INSERT INTO retailers (name, display_name, bank_description_patterns, has_standardized_parser)
VALUES
  ('walmart', 'Walmart', ARRAY['Walmart Inc.'], true),
  ('kroger',  'Kroger',  ARRAY['Kroger', 'KROGER CO'], true),
  ('generic', 'Generic Retailer', ARRAY[]::text[], false)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  bank_description_patterns = EXCLUDED.bank_description_patterns,
  has_standardized_parser = EXCLUDED.has_standardized_parser;

-- Note: Kroger's actual bank description pattern will be finalized when the
-- Kroger sample payment CSV and Chase bank data are reviewed together. The
-- placeholders above are best guesses and SHOULD be updated by the parser
-- team when the real data arrives.
