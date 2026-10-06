-- ============================================================================
-- Database roles and hardening — run in three stages, in order:
--   STAGE 1 (as a superuser)       — create the two roles, set DB ownership
--   STAGE 2 (as mops_migrator)     — run schema.sql to create all objects
--   STAGE 3 (as a superuser)       — grant mops_runtime exactly what it needs,
--                                     and add the immutability triggers
--
-- Exact command sequence is in SETUP_COMMANDS.md. This file documents WHY,
-- and is also what you actually run for stages 1 and 3.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STAGE 1 — roles and ownership (run as the postgres superuser)
-- ----------------------------------------------------------------------------
-- mops_migrator: owns every object. Used ONLY by `prisma migrate` / manual
--   DDL. Never used by the running application — if this role's credentials
--   leak, the blast radius is "can change schema," not "can read/write data
--   through the app," which is the split that actually matters.
-- mops_runtime: used by the running Next.js app. Gets exactly the DML
--   privileges each table needs, explicitly NOT UPDATE/DELETE on the four
--   immutable tables, and NOT INSERT/UPDATE/DELETE on stock_balance (written
--   only by a trigger, which runs with the privileges of the function's
--   owner regardless of which role's statement fired it).
-- ----------------------------------------------------------------------------

CREATE ROLE mops_migrator WITH LOGIN PASSWORD 'change-me-migrator-password' NOSUPERUSER CREATEDB;
CREATE ROLE mops_runtime  WITH LOGIN PASSWORD 'change-me-runtime-password'  NOSUPERUSER;

-- mops_dev must already exist (docs/SETUP_COMMANDS.md Section 1a creates it
-- owned by postgres; this re-points ownership to the migrator role).
ALTER DATABASE mops_dev OWNER TO mops_migrator;
GRANT ALL ON SCHEMA public TO mops_migrator;
GRANT CONNECT ON DATABASE mops_dev TO mops_runtime;
GRANT USAGE ON SCHEMA public TO mops_runtime;

-- ----------------------------------------------------------------------------
-- STAGE 2 — not in this file. Run docs/schema.sql connected AS mops_migrator:
--   psql -U mops_migrator -d mops_dev -f docs/schema.sql
-- (In practice, Phase 1 onward this happens via `prisma migrate deploy`
--  using MIGRATION_DATABASE_URL — see SETUP_COMMANDS.md — but the effect is
--  the same: mops_migrator owns every table, sequence, view and function.)
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- STAGE 3 — runtime grants + immutability triggers (run as superuser, AFTER
-- the schema from schema.sql exists)
-- ----------------------------------------------------------------------------

-- Tables mops_runtime may fully read/write (ordinary CRUD, Phase 1 tables
-- plus later-phase tables listed for completeness — grant only the ones
-- that actually exist in your database at the time you run this):
GRANT SELECT, INSERT, UPDATE, DELETE ON
  organization, branch, app_user, user_branch_access, user_session,
  item, bill_of_material, bom_line, customer, sales_order, sales_order_line,
  production_job, material_requirement, labour_record,
  production_stage_template, production_job_stage, quality_record,
  warehouse, job_cost_estimate
TO mops_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mops_runtime;

-- Immutable / append-only tables: SELECT + INSERT only. No UPDATE, no
-- DELETE — enforced twice over, once here via GRANT and independently via
-- the triggers below, so a future grant mistake alone can't reopen them.
GRANT SELECT, INSERT ON stock_movement, audit_log, exchange_rate, job_cost_actual TO mops_runtime;

-- stock_balance: SELECT only. It is written exclusively by
-- trg_stock_movement_before_insert, which is declared SECURITY DEFINER (see
-- schema.sql) so it runs with mops_migrator's (the function owner's)
-- privileges regardless of which role's INSERT on stock_movement fired it.
-- This is load-bearing, not incidental: a plain PL/pgSQL function defaults
-- to SECURITY INVOKER (caller's privileges), and without the SECURITY
-- DEFINER clause every INSERT on stock_movement from mops_runtime fails
-- with "permission denied for table stock_balance" — this was caught by
-- testing as mops_runtime specifically, not as superuser; see
-- ARCHITECTURE.md Phase 0 Addendum for the full writeup. The application
-- must never have a code path that writes this table directly.
GRANT SELECT ON stock_balance TO mops_runtime;

GRANT SELECT ON job_material_cost_live, job_labour_cost_live TO mops_runtime;
GRANT SELECT ON currency TO mops_runtime; -- reference data; org admins don't edit currency rows directly in V1

-- ----------------------------------------------------------------------------
-- Immutability triggers — these block UPDATE/DELETE regardless of which role
-- is connected, including mops_migrator, unless a migration explicitly
-- disables the trigger first (an intentional, auditable act, not an
-- accident). This is the "belt" to the GRANT-level "suspenders" above.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted — % is immutable/append-only. Insert an offsetting or compensating row instead.',
    TG_OP, TG_TABLE_NAME, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_movement_immutable
  BEFORE UPDATE OR DELETE ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_exchange_rate_immutable
  BEFORE UPDATE OR DELETE ON exchange_rate
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_job_cost_actual_immutable
  BEFORE UPDATE OR DELETE ON job_cost_actual
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- ----------------------------------------------------------------------------
-- Defense-in-depth note (Phase 1 hardening backlog, not applied by this
-- file): the mandatory `scope: { orgId, branchId? }` discipline threaded
-- through every server/modules/* function is the primary tenant-isolation
-- control (see ARCHITECTURE.md Section 6). Postgres Row-Level Security,
-- keyed on `current_setting('app.current_org_id')`, is worth adding on top
-- of that for the tables Phase 1 actually ships (organization, branch,
-- app_user, user_branch_access, user_session, audit_log) as a second,
-- independent layer — so a bug in one repository function can't leak
-- cross-tenant data even if the mandatory-scope discipline is violated
-- somewhere. Not included here to keep this file's scope to what Phase 0
-- approval covers; revisit when RLS is actually turned on.
