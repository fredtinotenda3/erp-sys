-- ============================================================================
-- Production module foundations.
--
-- 1. job_number_counter: one row per organization; the service increments it
--    inside the job-creation transaction (INSERT ... ON CONFLICT DO UPDATE),
--    which row-locks it, so concurrent creates get distinct, gap-free numbers.
--
-- 2. material_requirement gets a SNAPSHOT of the item's standard unit cost
--    and currency at job-creation time (nullable: null = the item had no
--    standard cost, i.e. "unpriced" -- never a guessed number). This is what
--    lets a later variance drill-down show BOM qty x unit cost.
--
-- 3. The estimate is restructured so it can never mix currencies:
--      job_cost_estimate        -> header only (when computed, which
--                                  materials could not be priced and why)
--      job_cost_estimate_line   -> one row PER CURRENCY with the amounts
--    The old single-currency amount/currency columns on job_cost_estimate
--    are dropped. Nothing in the application ever wrote to that table, and
--    this migration REFUSES to run if it finds any rows, rather than
--    silently destroying data.
--
-- VERIFICATION after applying:
--   \d job_number_counter
--   \d job_cost_estimate_line
--   \d job_cost_estimate        -- no estimated_*_cost / currency columns
--   \d material_requirement     -- standard_unit_cost, standard_unit_cost_currency
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM job_cost_estimate) THEN
    RAISE EXCEPTION 'job_cost_estimate already contains rows; refusing to drop its amount columns. Migrate the data manually first.';
  END IF;
END $$;

CREATE TABLE job_number_counter (
  org_id      uuid PRIMARY KEY REFERENCES organization(id) ON DELETE RESTRICT,
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

ALTER TABLE material_requirement
  ADD COLUMN standard_unit_cost numeric(14,4) CHECK (standard_unit_cost IS NULL OR standard_unit_cost >= 0),
  ADD COLUMN standard_unit_cost_currency char(3) REFERENCES currency(code),
  ADD CONSTRAINT material_requirement_cost_pair
    CHECK ((standard_unit_cost IS NULL) = (standard_unit_cost_currency IS NULL));

ALTER TABLE job_cost_estimate
  DROP COLUMN estimated_material_cost,
  DROP COLUMN estimated_labour_cost,
  DROP COLUMN estimated_overhead_cost,
  DROP COLUMN currency,
  ADD COLUMN unpriced_materials jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE job_cost_estimate_line (
  org_id                  uuid NOT NULL,
  job_id                  uuid NOT NULL,
  currency                char(3) NOT NULL REFERENCES currency(code),
  estimated_material_cost numeric(14,4) NOT NULL CHECK (estimated_material_cost >= 0),
  -- Labour/overhead stay NULL = "unavailable" until a labour standard rate /
  -- overhead allocation method is approved. Never defaulted to 0.
  estimated_labour_cost   numeric(14,4),
  estimated_overhead_cost numeric(14,4),
  PRIMARY KEY (job_id, currency),
  FOREIGN KEY (org_id, job_id) REFERENCES production_job (org_id, id) ON DELETE RESTRICT
);

-- Runtime grants. Guarded so this migration also works on a database where
-- the mops_runtime role does not exist (e.g. a fresh local setup that has
-- not run Stage 1 of docs/db-roles-and-security.sql yet).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON job_number_counter TO mops_runtime;
    GRANT SELECT, INSERT ON job_cost_estimate_line TO mops_runtime;
  END IF;
END $$;
