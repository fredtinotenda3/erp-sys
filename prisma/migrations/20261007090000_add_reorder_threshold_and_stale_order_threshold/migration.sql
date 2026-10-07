-- ============================================================================
-- Adds the two fields approved in docs/UX_UI_ARCHITECTURE.md §15.3/§15.4
-- (Phase 2 UX review, 2026-10-07):
--
--   1. item.reorder_threshold — nullable, per-item low-stock threshold.
--      Null means "no threshold set," not zero — the UI (§6.4) renders no
--      "Low" status for an item until this is explicitly set, rather than
--      defaulting to a guessed number. "Shortage" status does not depend on
--      this column at all (it's on-hand vs. remaining MaterialRequirement,
--      pure arithmetic over existing tables — see §2.15).
--
--   2. organization.stale_order_threshold_days — the number of days a
--      confirmed SalesOrder can sit with no ProductionJob created before the
--      Command Centre's "Recommended Actions" flags it (§3.4). Modeled as a
--      scalar column on organization rather than a new settings table: one
--      org-wide integer doesn't justify a new entity with its own
--      access-control surface. NOT NULL with a default so every existing and
--      future organization row has a defined value with no migration-time
--      backfill step required. This logic has no caller yet (Orders/
--      SalesOrder has no service layer — see docs/UX_UI_ARCHITECTURE.md
--      §16) but the column is cheap to add now and avoids a second
--      migration later purely to introduce it.
--
-- WHY THIS IS A NEW MIGRATION, NOT AN EDIT TO AN EARLIER ONE:
-- Same reasoning as 20261007080000_harden_manual_constraints's own header —
-- editing an already-applied migration's file changes its on-disk checksum
-- without changing what's in the database, which `prisma migrate status`
-- correctly reports as drift. Rolling forward is the safe fix.
--
-- WHY NO ROLE/GRANT STATEMENTS APPEAR HERE:
-- Both statements are plain DDL (ADD COLUMN) against tables you already own.
-- Neither needs privileges beyond normal DDL rights, regardless of whether
-- the mops_migrator/mops_runtime role split (docs/db-roles-and-security.sql)
-- is in place.
--
-- VERIFICATION — run after applying, before trusting this is done:
--   \d item           -- confirm reorder_threshold column, nullable, numeric(14,4)
--   \d organization    -- confirm stale_order_threshold_days, not null, default 3
--   SELECT stale_order_threshold_days FROM organization LIMIT 5;  -- expect 3 for existing rows
-- This migration has NOT been run against your database from this session —
-- there is no network path from this sandbox to your Neon instance. Run it
-- yourself (via `prisma migrate deploy`/`migrate dev`, or psql directly) and
-- confirm the three checks above before treating §15.3/§15.4 as shipped.
-- ============================================================================

ALTER TABLE item
  ADD COLUMN reorder_threshold numeric(14,4);

ALTER TABLE organization
  ADD COLUMN stale_order_threshold_days integer NOT NULL DEFAULT 3;
