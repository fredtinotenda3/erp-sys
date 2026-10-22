-- Phase 3: shop-floor execution and quality control.
--
-- Builds on the scaffolding from the first migration (production_job_stage,
-- quality_record) rather than creating parallel tables. Nothing here rewrites
-- existing rows; new CHECKs are NOT VALID so they bind every NEW or UPDATED row
-- without scanning legacy data (those tables had no application code before
-- this phase, so they are expected to be empty).
--
--  1. production_job_stage: planned dates, work centre, inspection requirement,
--     blocked reason; legal-transition and "stage is final once completed"
--     guards; a stage can only change while its job is open for work.
--  2. production_output: append-only good / scrap / rework quantities.
--  3. production_output_void: append-only, reasoned reversal of a mistaken entry.
--  4. quality_record: becomes the inspection result (inspector, outcome),
--     append-only.
--  5. quality_disposition: append-only, authorised decision on rejected units.
--  All shop-floor writes reuse Phase 2's job-open trigger and advisory lock, so
--  none can land after a job completes and none can be missing from its snapshot.

-- 1 -------------------------------------------------------------------------
ALTER TABLE production_job_stage
  ADD COLUMN planned_start        timestamp(3),
  ADD COLUMN planned_end          timestamp(3),
  ADD COLUMN work_centre          text,
  ADD COLUMN requires_inspection  boolean NOT NULL DEFAULT false,
  ADD COLUMN blocked_reason       text,
  ADD COLUMN blocked_at           timestamp(3),
  ADD COLUMN blocked_by           uuid,
  ADD COLUMN created_at           timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX production_job_stage_job_id_sequence_key ON production_job_stage (job_id, sequence);

ALTER TABLE production_job_stage
  ADD CONSTRAINT production_job_stage_sequence_positive CHECK (sequence > 0) NOT VALID,
  ADD CONSTRAINT production_job_stage_name_present CHECK (length(btrim(stage_name)) > 0) NOT VALID,
  ADD CONSTRAINT production_job_stage_planned_order CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end >= planned_start) NOT VALID,
  ADD CONSTRAINT production_job_stage_status_dates CHECK (
    (status = 'pending'     AND started_at IS NULL     AND completed_at IS NULL) OR
    (status = 'in_progress' AND started_at IS NOT NULL AND completed_at IS NULL) OR
    (status = 'completed'   AND started_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at)
  ) NOT VALID,
  ADD CONSTRAINT production_job_stage_blocked_consistent CHECK (
    (blocked_reason IS NULL) = (blocked_at IS NULL)
    AND (blocked_reason IS NULL OR (status <> 'completed' AND length(btrim(blocked_reason)) >= 3))
  ) NOT VALID;

CREATE OR REPLACE FUNCTION guard_job_stage_change() RETURNS trigger AS $$
DECLARE
  v_job uuid;
  v_status text;
BEGIN
  v_job := COALESCE(NEW.job_id, OLD.job_id);
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(v_job::text, 7));
  SELECT status::text INTO v_status FROM production_job WHERE id = v_job;

  IF TG_OP = 'INSERT' THEN
    IF v_status IN ('completed', 'closed', 'cancelled') THEN
      RAISE EXCEPTION 'Job % is "%": its stages can no longer be defined.', v_job, v_status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'Only a stage that has not started can be removed.' USING ERRCODE = 'check_violation';
    END IF;
    IF v_status IN ('completed', 'closed', 'cancelled') THEN
      RAISE EXCEPTION 'Job % is "%": its stages can no longer change.', v_job, v_status USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF NEW.org_id <> OLD.org_id OR NEW.job_id <> OLD.job_id THEN
    RAISE EXCEPTION 'A stage cannot be moved to another job.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'A completed stage is final.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_status IN ('completed', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'Job % is "%": its stages can no longer change.', v_job, v_status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status = 'in_progress') OR (OLD.status = 'in_progress' AND NEW.status = 'completed')) THEN
      RAISE EXCEPTION 'Illegal stage transition % -> %.', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Doing work (status or block changes) needs a job that is open for work.
  IF (NEW.status <> OLD.status OR NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason)
     AND v_status NOT IN ('released', 'in_progress') THEN
    RAISE EXCEPTION 'Job % is "%" and does not accept shop-floor work.', v_job, v_status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_production_job_stage_guard
  BEFORE INSERT OR UPDATE OR DELETE ON production_job_stage
  FOR EACH ROW EXECUTE FUNCTION guard_job_stage_change();

-- 4 (before 2/3: output references the inspection) ---------------------------
ALTER TABLE quality_record
  ADD COLUMN inspector_user_id uuid,
  ADD COLUMN outcome           text,
  ADD COLUMN uom               text;

CREATE UNIQUE INDEX quality_record_org_id_id_key ON quality_record (org_id, id);

ALTER TABLE quality_record
  ADD CONSTRAINT quality_record_quantities_valid CHECK (produced_qty > 0 AND accepted_qty >= 0 AND rejected_qty >= 0) NOT VALID,
  ADD CONSTRAINT quality_record_accounts_for_all CHECK (accepted_qty + rejected_qty = produced_qty) NOT VALID,
  ADD CONSTRAINT quality_record_outcome_matches CHECK (outcome IN ('pass', 'fail') AND ((outcome = 'pass') = (rejected_qty = 0))) NOT VALID,
  ADD CONSTRAINT quality_record_reject_needs_reason CHECK (rejected_qty = 0 OR reject_reason IS NOT NULL) NOT VALID,
  ADD CONSTRAINT quality_record_inspector_required CHECK (inspector_user_id IS NOT NULL) NOT VALID;

CREATE TRIGGER trg_quality_record_immutable
  BEFORE UPDATE OR DELETE ON quality_record
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_quality_record_job_open
  BEFORE INSERT ON quality_record
  FOR EACH ROW EXECUTE FUNCTION assert_job_open_for_posting();

-- 2 -------------------------------------------------------------------------
CREATE TABLE production_output (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      uuid NOT NULL,
  job_id                      uuid NOT NULL,
  job_stage_id                uuid,
  good_qty                    numeric(14,4) NOT NULL DEFAULT 0 CHECK (good_qty >= 0),
  scrap_qty                   numeric(14,4) NOT NULL DEFAULT 0 CHECK (scrap_qty >= 0),
  rework_qty                  numeric(14,4) NOT NULL DEFAULT 0 CHECK (rework_qty >= 0),
  -- good units that came back from rework in this entry (a subset of good_qty)
  rework_good_qty             numeric(14,4) NOT NULL DEFAULT 0 CHECK (rework_good_qty >= 0),
  -- scrap units that were being reworked when scrapped (a subset of scrap_qty)
  rework_scrap_qty            numeric(14,4) NOT NULL DEFAULT 0 CHECK (rework_scrap_qty >= 0),
  -- units earlier counted good and now reclassified by a quality disposition.
  -- Never set by an operator (CHECK below): only quality_disposition rows.
  reclassified_from_good_qty  numeric(14,4) NOT NULL DEFAULT 0 CHECK (reclassified_from_good_qty >= 0),
  uom                         text NOT NULL,
  reason                      "RejectReason",
  notes                       text,
  source                      text NOT NULL DEFAULT 'operator' CHECK (source IN ('operator', 'quality_disposition')),
  inspection_id               uuid,
  operator_user_id            uuid,
  recorded_at                 timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  client_request_id           uuid,
  CONSTRAINT production_output_something_recorded CHECK (good_qty + scrap_qty + rework_qty > 0),
  CONSTRAINT production_output_rework_good_subset CHECK (rework_good_qty <= good_qty),
  CONSTRAINT production_output_rework_scrap_subset CHECK (rework_scrap_qty <= scrap_qty),
  CONSTRAINT production_output_reclass_bounded CHECK (reclassified_from_good_qty <= scrap_qty + rework_qty),
  CONSTRAINT production_output_reclass_only_by_quality CHECK (reclassified_from_good_qty = 0 OR source = 'quality_disposition'),
  CONSTRAINT production_output_reason_for_loss CHECK ((scrap_qty = 0 AND rework_qty = 0) OR reason IS NOT NULL),
  CONSTRAINT production_output_uom_present CHECK (length(btrim(uom)) > 0),
  FOREIGN KEY (org_id, job_id) REFERENCES production_job (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, job_stage_id) REFERENCES production_job_stage (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, inspection_id) REFERENCES quality_record (org_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX production_output_org_id_id_key ON production_output (org_id, id);
CREATE UNIQUE INDEX production_output_org_id_client_request_id_key ON production_output (org_id, client_request_id);
CREATE INDEX production_output_job_id_idx ON production_output (job_id);

CREATE TRIGGER trg_production_output_immutable
  BEFORE UPDATE OR DELETE ON production_output
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_production_output_job_open
  BEFORE INSERT ON production_output
  FOR EACH ROW EXECUTE FUNCTION assert_job_open_for_posting();

-- 3 -------------------------------------------------------------------------
CREATE TABLE production_output_void (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  job_id      uuid NOT NULL,
  output_id   uuid NOT NULL,
  reason      text NOT NULL CHECK (length(btrim(reason)) >= 5),
  voided_by   uuid,
  voided_at   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_id, output_id) REFERENCES production_output (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, job_id) REFERENCES production_job (org_id, id) ON DELETE RESTRICT
);
-- a given entry can be voided once
CREATE UNIQUE INDEX production_output_void_org_id_output_id_key ON production_output_void (org_id, output_id);

CREATE TRIGGER trg_production_output_void_immutable
  BEFORE UPDATE OR DELETE ON production_output_void
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_production_output_void_job_open
  BEFORE INSERT ON production_output_void
  FOR EACH ROW EXECUTE FUNCTION assert_job_open_for_posting();

-- 5 -------------------------------------------------------------------------
CREATE TABLE quality_disposition (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  job_id            uuid NOT NULL,
  inspection_id     uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('scrap', 'rework', 'use_as_is')),
  qty               numeric(14,4) NOT NULL CHECK (qty > 0),
  reason            text NOT NULL CHECK (length(btrim(reason)) >= 5),
  decided_by        uuid NOT NULL,
  decided_at        timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  client_request_id uuid,
  FOREIGN KEY (org_id, inspection_id) REFERENCES quality_record (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, job_id) REFERENCES production_job (org_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX quality_disposition_org_id_client_request_id_key ON quality_disposition (org_id, client_request_id);
CREATE INDEX quality_disposition_inspection_id_idx ON quality_disposition (inspection_id);

-- Race-safe cap: dispositions for one inspection can never exceed its rejected quantity.
CREATE OR REPLACE FUNCTION assert_disposition_within_rejected() RETURNS trigger AS $$
DECLARE
  v_rejected numeric;
  v_so_far numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.inspection_id::text, 17));
  SELECT rejected_qty INTO v_rejected FROM quality_record WHERE org_id = NEW.org_id AND id = NEW.inspection_id;
  SELECT COALESCE(sum(qty), 0) INTO v_so_far FROM quality_disposition WHERE org_id = NEW.org_id AND inspection_id = NEW.inspection_id;
  IF v_rejected IS NULL OR v_so_far + NEW.qty > v_rejected THEN
    RAISE EXCEPTION 'Dispositions (% + %) would exceed the % rejected units of this inspection.', v_so_far, NEW.qty, COALESCE(v_rejected, 0)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_quality_disposition_within_rejected
  BEFORE INSERT ON quality_disposition
  FOR EACH ROW EXECUTE FUNCTION assert_disposition_within_rejected();
CREATE TRIGGER trg_quality_disposition_immutable
  BEFORE UPDATE OR DELETE ON quality_disposition
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_quality_disposition_job_open
  BEFORE INSERT ON quality_disposition
  FOR EACH ROW EXECUTE FUNCTION assert_job_open_for_posting();

-- Grants (role-targeted, so guarded exactly like Phase 2's migration) -----------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT ON production_output, production_output_void, quality_disposition TO mops_runtime;
    -- inspections become append-only: the earlier blanket CRUD grant is withdrawn
    REVOKE UPDATE, DELETE ON quality_record FROM mops_runtime;
  END IF;
END $$;
