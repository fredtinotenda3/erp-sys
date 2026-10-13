-- ============================================================================
-- Costing & currency.
--
-- 1. exchange_rate becomes ORGANIZATION-SCOPED (adds org_id). It was designed
--    as platform-wide, which would let one tenant's finance user change the
--    cost figures of every other tenant -- a tenant-isolation hole.
--
-- 2. job_cost_actual (completion snapshot) was single-currency. It becomes a
--    header (revenue basis) and the amounts move to job_cost_actual_line, one
--    row per currency, so a snapshot can never mix currencies. The stored
--    generated gross_profit column is dropped: profit is only meaningful when
--    cost and revenue share a currency, so it is derived on read.
--
-- Nothing in the application ever wrote to exchange_rate or job_cost_actual
-- before this release. The migration REFUSES to run if either already has
-- rows, rather than silently destroying or mis-scoping data.
--
-- VERIFICATION after applying:
--   \d exchange_rate            -- org_id NOT NULL
--   \d job_cost_actual          -- org_id, job_id, revenue, revenue_currency, snapshotted_at
--   \d job_cost_actual_line
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'job_cost_actual_line'::regclass AND NOT tgisinternal;
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM exchange_rate) THEN
    RAISE EXCEPTION 'exchange_rate already contains rows; cannot add org_id automatically. Assign them to an organization manually first.';
  END IF;
  IF EXISTS (SELECT 1 FROM job_cost_actual) THEN
    RAISE EXCEPTION 'job_cost_actual already contains rows; refusing to drop its single-currency columns.';
  END IF;
END $$;

-- 1. exchange_rate: org scope ------------------------------------------------
ALTER TABLE exchange_rate
  ADD COLUMN org_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  ADD CONSTRAINT exchange_rate_distinct_currencies CHECK (base_currency <> quote_currency);
CREATE INDEX idx_exchange_rate_org_lookup
  ON exchange_rate (org_id, base_currency, quote_currency, source, as_of_date DESC);

-- 2. job_cost_actual: header only ---------------------------------------------
ALTER TABLE job_cost_actual DROP COLUMN gross_profit;
ALTER TABLE job_cost_actual
  DROP COLUMN actual_material_cost,
  DROP COLUMN actual_labour_cost,
  DROP COLUMN actual_overhead_cost,
  DROP COLUMN currency,
  DROP COLUMN exchange_rate_id,
  ADD COLUMN revenue_currency char(3) REFERENCES currency(code),
  ADD CONSTRAINT job_cost_actual_revenue_pair CHECK ((revenue IS NULL) = (revenue_currency IS NULL));

CREATE TABLE job_cost_actual_line (
  org_id               uuid NOT NULL,
  job_id               uuid NOT NULL,
  currency             char(3) NOT NULL REFERENCES currency(code),
  actual_material_cost numeric(14,4) NOT NULL CHECK (actual_material_cost >= 0),
  actual_labour_cost   numeric(14,4) CHECK (actual_labour_cost IS NULL OR actual_labour_cost >= 0),
  actual_overhead_cost numeric(14,4),
  PRIMARY KEY (job_id, currency),
  FOREIGN KEY (org_id, job_id) REFERENCES production_job (org_id, id) ON DELETE RESTRICT
);

-- Same immutability guarantee as the header: written once at completion.
CREATE TRIGGER trg_job_cost_actual_line_immutable
  BEFORE UPDATE OR DELETE ON job_cost_actual_line
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT ON job_cost_actual_line TO mops_runtime;
  END IF;
END $$;
