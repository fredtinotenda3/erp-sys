-- ============================================================================
-- Database roles and hardening — run in three stages, in order:
--   STAGE 1 (as a superuser)       — create the two roles, set DB ownership
--   STAGE 2 (as mops_migrator)     — run schema.sql (or, from Phase 1 onward,
--                                     `prisma migrate deploy`) to create all
--                                     schema objects, INCLUDING the
--                                     append-only immutability triggers —
--                                     see the note below, this changed.
--   STAGE 3 (as a superuser)       — grant mops_runtime exactly what it needs
--
-- Exact command sequence is in SETUP_COMMANDS.md. This file documents WHY,
-- and is also what you actually run for stages 1 and 3.
--
-- CHANGED 2026-10-07 (hardening pass — see docs/AUDIT_PHASE0_POSTSETUP.md's
-- "Hardening Addendum" for the full reasoning): the prevent_mutation()
-- function and its four append-only triggers (trg_stock_movement_immutable,
-- trg_audit_log_immutable, trg_exchange_rate_immutable,
-- trg_job_cost_actual_immutable) used to live in this file's old Stage 3,
-- bundled together with the GRANT statements below. They've moved to
-- prisma/migrations/20261007080000_harden_manual_constraints/migration.sql.
--
-- Why they moved: they're pure schema DDL (a function that unconditionally
-- raises on UPDATE/DELETE, and triggers wired to it) with no dependency on
-- any specific role name — they work correctly whether mops_runtime exists
-- yet or not, because they block mutation for EVERY role, including the
-- table owner. That makes them safe and appropriate to manage through the
-- versioned Prisma migration chain, same as any other schema object.
--
-- Why the GRANT statements below did NOT move: they target a specific role
-- name (mops_runtime) that this file itself is responsible for creating.
-- Baking `GRANT ... TO mops_runtime` into a Prisma migration would make
-- `prisma migrate deploy` fail outright on any database where Stage 1
-- hasn't run yet (the role wouldn't exist), and ties the schema-versioning
-- system to an operational/environment detail (the exact runtime role name)
-- that can legitimately differ across environments. Role creation and
-- role-targeted grants stay a manual, deliberate DBA step — see Section 4
-- of the Hardening Addendum for the fuller version of this argument,
-- including why role creation itself (CREATE ROLE) can never move into a
-- migration regardless: it requires a privilege (CREATEROLE, or superuser)
-- that mops_migrator is deliberately never granted.
--
-- NEON NOTE: this file's "run as the postgres superuser" instruction
-- assumes a local PostgreSQL install. On Neon there is no traditional
-- `postgres` superuser login exposed to you — run Stage 1 and Stage 3 as
-- your Neon project's default/owner role instead (the role shown in your
-- Neon console's Connection Details), which has the privileges needed to
-- create roles and grant on its own database. Confirm this empirically
-- rather than assuming it — see the Hardening Addendum's role-verification
-- query.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STAGE 1 — roles and ownership (run as your Postgres/Neon superuser-
-- equivalent role)
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
-- owned by postgres; this re-points ownership to the migrator role). On
-- Neon, substitute your actual database name for mops_dev.
ALTER DATABASE mops_dev OWNER TO mops_migrator;
GRANT ALL ON SCHEMA public TO mops_migrator;
GRANT CONNECT ON DATABASE mops_dev TO mops_runtime;
GRANT USAGE ON SCHEMA public TO mops_runtime;

-- ----------------------------------------------------------------------------
-- STAGE 2 — not in this file. Run via `prisma migrate deploy` using
-- MIGRATION_DATABASE_URL (the mops_migrator role) — see SETUP_COMMANDS.md.
-- This now includes the append-only immutability triggers (see the CHANGED
-- note at the top of this file) as well as every other schema object —
-- mops_migrator ends up owning all of it, same as before.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- STAGE 3 — runtime grants (run as your superuser-equivalent role, AFTER
-- the schema migrations — including the hardening migration — have been
-- applied)
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
-- the triggers now in the hardening migration, so a future grant mistake
-- alone can't reopen them.
GRANT SELECT, INSERT ON stock_movement, audit_log, exchange_rate, job_cost_actual TO mops_runtime;

-- stock_balance: SELECT only. It is written exclusively by
-- trg_stock_movement_before_insert, which is declared SECURITY DEFINER (see
-- the hardening migration) so it runs with mops_migrator's (the function
-- owner's) privileges regardless of which role's INSERT on stock_movement
-- fired it. This is load-bearing, not incidental: a plain PL/pgSQL function
-- defaults to SECURITY INVOKER (caller's privileges), and without the
-- SECURITY DEFINER clause every INSERT on stock_movement from mops_runtime
-- fails with "permission denied for table stock_balance" — this was caught
-- by testing as mops_runtime specifically, not as superuser; see
-- ARCHITECTURE.md's Phase 0 Addendum for the full writeup. The application
-- must never have a code path that writes this table directly.
GRANT SELECT ON stock_balance TO mops_runtime;

GRANT SELECT ON job_material_cost_live, job_labour_cost_live TO mops_runtime;
GRANT SELECT ON currency TO mops_runtime; -- reference data; org admins don't edit currency rows directly in V1

-- ----------------------------------------------------------------------------
-- The append-only immutability triggers (prevent_mutation() and its four
-- attachments on stock_movement, audit_log, exchange_rate, job_cost_actual)
-- used to be here. They now live in
-- prisma/migrations/20261007080000_harden_manual_constraints/migration.sql
-- — see the CHANGED note at the top of this file. They block UPDATE/DELETE
-- regardless of which role is connected, including mops_migrator, unless a
-- migration explicitly disables the trigger first (an intentional,
-- auditable act, not an accident) — that hasn't changed, only where the
-- DDL lives has.
-- ----------------------------------------------------------------------------

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
-- ----------------------------------------------------------------------------
