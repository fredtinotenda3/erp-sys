-- Phase 2: costing integrity.
-- Purpose (each block is independently justified; nothing here rewrites data):
--   1. job_cost_actual gets `completeness` + `evidence`: what the snapshot knew
--      and did not know at completion, frozen with it (immutability trigger
--      already forbids UPDATE, so these can never be edited afterwards).
--   2. A snapshot can only exist for a job that is completed/closed, and its
--      per-currency lines can only be written in the SAME transaction as the
--      header -- so a currency line can't be appended to a frozen snapshot later.
--   3. No ledger or labour row may be posted to a job that is no longer open
--      for work. The check takes a shared advisory lock on the job, and
--      completion takes the exclusive one, so a posting either lands before
--      the snapshot is computed (and is in it) or is refused. Without this, an
--      issue racing completion could be missing from the frozen figures.
--   4. A completed job can only move to `closed` (never reopen), enforced in the
--      database as well as in the application state machine.
--   5. job_cost_adjustment: explicit, append-only, audited corrections to a
--      frozen job. The snapshot itself is never edited.

-- 1 -------------------------------------------------------------------------
ALTER TABLE job_cost_actual
  ADD COLUMN completeness jsonb NOT NULL DEFAULT '{"legacy": true}'::jsonb,
  ADD COLUMN evidence     jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_job_finished_for_cost_snapshot() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM production_job
     WHERE org_id = NEW.org_id AND id = NEW.job_id AND status IN ('completed', 'closed')
  ) THEN
    RAISE EXCEPTION 'A cost snapshot can only be written for a completed job (job %).', NEW.job_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_job_cost_actual_requires_completed
  BEFORE INSERT ON job_cost_actual
  FOR EACH ROW EXECUTE FUNCTION assert_job_finished_for_cost_snapshot();

-- A line may only be inserted in the transaction that inserted its header
-- (xmin of the header row = this transaction). After commit, the set of
-- currency lines is closed.
CREATE OR REPLACE FUNCTION assert_cost_line_in_snapshot_transaction() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM job_cost_actual h
     WHERE h.job_id = NEW.job_id
       AND h.xmin::text = (txid_current() % 4294967296)::text
  ) THEN
    RAISE EXCEPTION 'Cost snapshot lines can only be written together with the snapshot (job %); record a cost adjustment instead.', NEW.job_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_job_cost_actual_line_same_transaction
  BEFORE INSERT ON job_cost_actual_line
  FOR EACH ROW EXECUTE FUNCTION assert_cost_line_in_snapshot_transaction();

-- 3 -------------------------------------------------------------------------
-- Advisory-lock key for a job: shared by posters, exclusive for completion.
CREATE OR REPLACE FUNCTION assert_job_open_for_posting() RETURNS trigger AS $$
DECLARE
  v_job uuid;
  v_status text;
BEGIN
  IF TG_TABLE_NAME = 'stock_movement' THEN
    IF NEW.reference_type::text <> 'production_job' OR NEW.reference_id IS NULL
       OR NEW.movement_type::text NOT IN ('production_consumption', 'material_return') THEN
      RETURN NEW;
    END IF;
    v_job := NEW.reference_id;
  ELSE
    v_job := NEW.job_id;
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended(v_job::text, 7));
  SELECT status::text INTO v_status FROM production_job WHERE id = v_job;
  IF v_status IS NOT NULL AND v_status NOT IN ('released', 'in_progress') THEN
    RAISE EXCEPTION 'Job % is "%" and no longer accepts material issues or labour.', v_job, v_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_movement_job_open
  BEFORE INSERT ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION assert_job_open_for_posting();

CREATE TRIGGER trg_labour_record_job_open
  BEFORE INSERT ON labour_record
  FOR EACH ROW EXECUTE FUNCTION assert_job_open_for_posting();

-- 4 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_job_reopen() RETURNS trigger AS $$
BEGIN
  IF OLD.status::text IN ('completed', 'closed')
     AND NEW.status::text <> OLD.status::text
     AND NOT (OLD.status::text = 'completed' AND NEW.status::text = 'closed') THEN
    RAISE EXCEPTION 'A % job cannot be reopened (its cost snapshot is final); post a cost adjustment instead.', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_production_job_no_reopen
  BEFORE UPDATE OF status ON production_job
  FOR EACH ROW EXECUTE FUNCTION prevent_job_reopen();

-- 5 -------------------------------------------------------------------------
CREATE TABLE job_cost_adjustment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  job_id            uuid NOT NULL,
  currency          char(3) NOT NULL REFERENCES currency(code),
  component         text NOT NULL CHECK (component IN ('material', 'labour')),
  -- signed: positive adds cost, negative removes it. Zero is meaningless.
  amount            numeric(14,4) NOT NULL CHECK (amount <> 0),
  reason            text NOT NULL CHECK (length(btrim(reason)) >= 10),
  client_request_id uuid,
  created_by        uuid,
  created_at        timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id, job_id) REFERENCES production_job (org_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX job_cost_adjustment_org_id_client_request_id_key ON job_cost_adjustment (org_id, client_request_id);
CREATE INDEX job_cost_adjustment_job_id_idx ON job_cost_adjustment (job_id);

CREATE TRIGGER trg_job_cost_adjustment_immutable
  BEFORE UPDATE OR DELETE ON job_cost_adjustment
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- An adjustment only makes sense against a frozen snapshot.
CREATE OR REPLACE FUNCTION assert_snapshot_exists_for_adjustment() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM job_cost_actual WHERE org_id = NEW.org_id AND job_id = NEW.job_id) THEN
    RAISE EXCEPTION 'Job % has no cost snapshot to adjust.', NEW.job_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_job_cost_adjustment_requires_snapshot
  BEFORE INSERT ON job_cost_adjustment
  FOR EACH ROW EXECUTE FUNCTION assert_snapshot_exists_for_adjustment();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT ON job_cost_adjustment TO mops_runtime;
  END IF;
END $$;
