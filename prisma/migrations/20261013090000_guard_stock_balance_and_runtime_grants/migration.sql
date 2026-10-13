-- ============================================================================
-- Close the stock_balance write path at the database level, and remove any
-- stale write grants the runtime role may have picked up.
--
-- WHY: stock_balance is a derived table. It must only ever change as a side
-- effect of inserting a stock_movement (trg_stock_movement_before_insert).
-- Until now that was enforced ONLY by a GRANT (mops_runtime has SELECT only).
-- A GRANT is an operational detail: if the grant was ever widened (an older
-- version of the setup docs, a manual fix, a re-run with the wrong role), the
-- ledger invariant "balance = sum(ledger)" silently breaks and the
-- "application role cannot update ledger rows" test fails. The other
-- append-only tables are protected twice (GRANT + trigger); stock_balance was
-- protected once. This migration gives it the second layer.
--
-- HOW: a row trigger that refuses INSERT/UPDATE/DELETE unless it is itself
-- being fired from inside another trigger (pg_trigger_depth() >= 2), i.e.
-- from trg_stock_movement_before_insert. Direct statements -- from any role,
-- including the schema owner -- run at depth 1 and are rejected.
--
-- VERIFICATION after applying (as mops_migrator, in a throwaway transaction):
--   BEGIN; UPDATE stock_balance SET quantity = quantity; ROLLBACK;
--     -- with at least one row present: ERROR ... not permitted
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'stock_balance'::regclass AND NOT tgisinternal;
-- ============================================================================

CREATE OR REPLACE FUNCTION guard_stock_balance_write() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION '% on stock_balance is not permitted — stock_balance is derived from the stock_movement ledger. Post a stock movement instead.', TG_OP;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_balance_guard ON stock_balance;
CREATE TRIGGER trg_stock_balance_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stock_balance
  FOR EACH ROW EXECUTE FUNCTION guard_stock_balance_write();

-- Remove stale write privileges from the runtime role, if it exists. Guarded
-- so the migration still works on databases where the role split has not been
-- set up (same convention as the production/costing migrations).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    REVOKE INSERT, UPDATE, DELETE ON stock_balance FROM mops_runtime;
    REVOKE UPDATE, DELETE ON stock_movement, audit_log, exchange_rate,
                            job_cost_actual, job_cost_actual_line FROM mops_runtime;
  END IF;
END $$;
