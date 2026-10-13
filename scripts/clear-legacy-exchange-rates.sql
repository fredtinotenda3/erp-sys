-- One-off cleanup for databases that still hold PRE-ORGANIZATION exchange_rate
-- rows, which block migration 20261008120000_costing_and_exchange_rates.
--
-- The only way such rows normally exist is the old trigger demo in
-- docs/SETUP_COMMANDS.md (INSERT USD/ZAR 18.5 'MANUAL'). exchange_rate is
-- append-only, so the immutability trigger has to be switched off for the
-- delete. Run as mops_migrator (the table owner):
--
--   psql "<MIGRATION_DATABASE_URL>" -f scripts/clear-legacy-exchange-rates.sql
--
-- It prints the rows first and ABORTS unless every row looks like that demo
-- row, so it cannot silently destroy real rates. Do NOT run it against a
-- database that holds real recorded rates.

BEGIN;

SELECT * FROM exchange_rate;

DO $$
DECLARE
  n_total int;
  n_demo  int;
BEGIN
  -- Only meaningful before the costing migration: it adds org_id.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'exchange_rate' AND column_name = 'org_id') THEN
    RAISE EXCEPTION 'exchange_rate already has org_id: the costing migration is applied; nothing to clean up.';
  END IF;

  SELECT count(*) INTO n_total FROM exchange_rate;
  SELECT count(*) INTO n_demo
    FROM exchange_rate
   WHERE base_currency = 'USD' AND quote_currency = 'ZAR'
     AND rate = 18.5 AND source = 'MANUAL';

  IF n_total <> n_demo THEN
    RAISE EXCEPTION 'exchange_rate holds % row(s) that are not the setup-demo row; refusing to delete. Assign them to an organization manually.', n_total - n_demo;
  END IF;
END $$;

ALTER TABLE exchange_rate DISABLE TRIGGER trg_exchange_rate_immutable;
DELETE FROM exchange_rate;
ALTER TABLE exchange_rate ENABLE TRIGGER trg_exchange_rate_immutable;

COMMIT;
