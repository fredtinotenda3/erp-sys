-- Milestone 4 -- Full Manufacturing Lifecycle. Additive only: five new
-- enums, nine new tables, and a small set of nullable columns added to
-- existing tables (bill_of_material, bom_line, production_job,
-- production_stage_template, production_job_stage, labour_record,
-- quality_record). No existing column is altered or dropped, and no
-- existing row's meaning changes -- every new column defaults to NULL (or,
-- for production_job.priority, to 'normal', the only sensible default for a
-- field that didn't exist before). See prisma/schema.prisma's "MILESTONE 4"
-- comment block for the full design rationale; this file only mirrors it
-- into DDL.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "JobPriority" AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE "MachineStatus" AS ENUM ('available', 'in_use', 'down', 'maintenance', 'retired');
CREATE TYPE "DowntimeCategory" AS ENUM ('breakdown', 'changeover', 'no_material', 'no_operator', 'planned_maintenance', 'other');
CREATE TYPE "MaintenanceType" AS ENUM ('scheduled', 'unscheduled');
CREATE TYPE "CorrectiveActionStatus" AS ENUM ('open', 'in_progress', 'completed', 'cancelled');

-- ---------------------------------------------------------------------------
-- Columns added to existing tables
-- ---------------------------------------------------------------------------
ALTER TABLE "bill_of_material" ADD COLUMN "effective_to" DATE;

ALTER TABLE "bom_line" ADD COLUMN "expected_scrap_pct" DECIMAL(5,2);
ALTER TABLE "bom_line" ADD COLUMN "expected_yield_pct" DECIMAL(5,2);
ALTER TABLE "bom_line"
  ADD CONSTRAINT "bom_line_expected_scrap_pct_range" CHECK ("expected_scrap_pct" IS NULL OR ("expected_scrap_pct" >= 0 AND "expected_scrap_pct" < 100)),
  ADD CONSTRAINT "bom_line_expected_yield_pct_range" CHECK ("expected_yield_pct" IS NULL OR ("expected_yield_pct" > 0 AND "expected_yield_pct" <= 100));

ALTER TABLE "production_job" ADD COLUMN "priority" "JobPriority" NOT NULL DEFAULT 'normal';

ALTER TABLE "production_stage_template" ADD COLUMN "work_centre_id" UUID;
ALTER TABLE "production_stage_template" ADD COLUMN "expected_setup_minutes" INTEGER;
ALTER TABLE "production_stage_template" ADD COLUMN "expected_run_minutes" INTEGER;
ALTER TABLE "production_stage_template"
  ADD CONSTRAINT "production_stage_template_setup_minutes_nonneg" CHECK ("expected_setup_minutes" IS NULL OR "expected_setup_minutes" >= 0),
  ADD CONSTRAINT "production_stage_template_run_minutes_nonneg" CHECK ("expected_run_minutes" IS NULL OR "expected_run_minutes" >= 0);

ALTER TABLE "production_job_stage" ADD COLUMN "work_centre_id" UUID;
ALTER TABLE "production_job_stage" ADD COLUMN "machine_id" UUID;
ALTER TABLE "production_job_stage" ADD COLUMN "expected_setup_minutes" INTEGER;
ALTER TABLE "production_job_stage" ADD COLUMN "expected_run_minutes" INTEGER;
ALTER TABLE "production_job_stage"
  ADD CONSTRAINT "production_job_stage_setup_minutes_nonneg" CHECK ("expected_setup_minutes" IS NULL OR "expected_setup_minutes" >= 0),
  ADD CONSTRAINT "production_job_stage_run_minutes_nonneg" CHECK ("expected_run_minutes" IS NULL OR "expected_run_minutes" >= 0);

ALTER TABLE "labour_record" ADD COLUMN "job_stage_id" UUID;

ALTER TABLE "quality_record" ADD COLUMN "inspection_plan_id" UUID;

-- ---------------------------------------------------------------------------
-- New tables
-- ---------------------------------------------------------------------------
CREATE TABLE "work_centre" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "daily_capacity_minutes" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_centre_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "work_centre_capacity_nonneg" CHECK ("daily_capacity_minutes" IS NULL OR "daily_capacity_minutes" >= 0)
);

CREATE TABLE "machine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "work_centre_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MachineStatus" NOT NULL DEFAULT 'available',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "machine_downtime_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "category" "DowntimeCategory" NOT NULL,
    "reason" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "logged_by" UUID,

    CONSTRAINT "machine_downtime_record_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "machine_downtime_record_ended_after_started" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at")
);

CREATE TABLE "machine_maintenance_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "type" "MaintenanceType" NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "notes" TEXT,
    "performed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_maintenance_record_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "machine_time_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "job_stage_id" UUID,
    "machine_id" UUID NOT NULL,
    "setup_minutes" INTEGER NOT NULL DEFAULT 0,
    "run_minutes" INTEGER NOT NULL DEFAULT 0,
    "operator_user_id" UUID,
    "client_request_id" UUID,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_time_record_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "machine_time_record_setup_nonneg" CHECK ("setup_minutes" >= 0),
    CONSTRAINT "machine_time_record_run_nonneg" CHECK ("run_minutes" >= 0),
    CONSTRAINT "machine_time_record_at_least_one_positive" CHECK ("setup_minutes" > 0 OR "run_minutes" > 0)
);

CREATE TABLE "inspection_plan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspection_plan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inspection_characteristic" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "uom" TEXT,
    "min_value" DECIMAL(14,4),
    "max_value" DECIMAL(14,4),
    "target_value" DECIMAL(14,4),
    "sequence" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "inspection_characteristic_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspection_characteristic_bounds" CHECK ("min_value" IS NULL OR "max_value" IS NULL OR "min_value" <= "max_value")
);

CREATE TABLE "quality_measurement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "quality_record_id" UUID NOT NULL,
    "characteristic_id" UUID NOT NULL,
    "characteristic_name" TEXT NOT NULL,
    "uom" TEXT,
    "min_value" DECIMAL(14,4),
    "max_value" DECIMAL(14,4),
    "measured_value" DECIMAL(14,4) NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_measurement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "corrective_action" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "quality_record_id" UUID,
    "description" TEXT NOT NULL,
    "assigned_to" UUID,
    "status" "CorrectiveActionStatus" NOT NULL DEFAULT 'open',
    "due_date" DATE,
    "resolved_at" TIMESTAMP(3),
    "resolution_notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corrective_action_pkey" PRIMARY KEY ("id"),
    -- Mirrors dispatch's status/delivered_at consistency check: resolved_at
    -- is stamped if and only if the status says this is done.
    CONSTRAINT "corrective_action_resolved_consistency" CHECK (("status" IN ('completed', 'cancelled')) = ("resolved_at" IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "work_centre_org_id_id_key" ON "work_centre"("org_id", "id");
CREATE UNIQUE INDEX "work_centre_branch_id_code_key" ON "work_centre"("branch_id", "code");

CREATE UNIQUE INDEX "machine_org_id_id_key" ON "machine"("org_id", "id");
CREATE UNIQUE INDEX "machine_work_centre_id_code_key" ON "machine"("work_centre_id", "code");
CREATE INDEX "machine_work_centre_id_idx" ON "machine"("work_centre_id");

CREATE UNIQUE INDEX "machine_downtime_record_org_id_id_key" ON "machine_downtime_record"("org_id", "id");
CREATE INDEX "machine_downtime_record_machine_id_ended_at_idx" ON "machine_downtime_record"("machine_id", "ended_at");
-- At most one OPEN downtime record per machine -- a machine can't be "down
-- for two different reasons" at once; close the first before opening another.
CREATE UNIQUE INDEX "machine_downtime_record_one_open_per_machine" ON "machine_downtime_record"("machine_id") WHERE "ended_at" IS NULL;

CREATE UNIQUE INDEX "machine_maintenance_record_org_id_id_key" ON "machine_maintenance_record"("org_id", "id");
CREATE INDEX "machine_maintenance_record_machine_id_idx" ON "machine_maintenance_record"("machine_id");

CREATE UNIQUE INDEX "machine_time_record_org_id_id_key" ON "machine_time_record"("org_id", "id");
CREATE UNIQUE INDEX "machine_time_record_org_id_client_request_id_key" ON "machine_time_record"("org_id", "client_request_id");
CREATE INDEX "machine_time_record_job_id_idx" ON "machine_time_record"("job_id");
CREATE INDEX "machine_time_record_machine_id_idx" ON "machine_time_record"("machine_id");

CREATE UNIQUE INDEX "inspection_plan_org_id_id_key" ON "inspection_plan"("org_id", "id");
CREATE INDEX "inspection_plan_item_id_idx" ON "inspection_plan"("item_id");

CREATE UNIQUE INDEX "inspection_characteristic_org_id_id_key" ON "inspection_characteristic"("org_id", "id");
CREATE INDEX "inspection_characteristic_plan_id_idx" ON "inspection_characteristic"("plan_id");

CREATE UNIQUE INDEX "quality_measurement_org_id_id_key" ON "quality_measurement"("org_id", "id");
CREATE INDEX "quality_measurement_quality_record_id_idx" ON "quality_measurement"("quality_record_id");

CREATE UNIQUE INDEX "corrective_action_org_id_id_key" ON "corrective_action"("org_id", "id");
CREATE INDEX "corrective_action_job_id_idx" ON "corrective_action"("job_id");
CREATE INDEX "corrective_action_status_idx" ON "corrective_action"("status");

-- ---------------------------------------------------------------------------
-- Foreign keys -- org-isolation at the constraint level, same convention as
-- every other relationship in this schema.
-- ---------------------------------------------------------------------------
ALTER TABLE "production_stage_template" ADD CONSTRAINT "production_stage_template_org_id_work_centre_id_fkey" FOREIGN KEY ("org_id", "work_centre_id") REFERENCES "work_centre"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_job_stage" ADD CONSTRAINT "production_job_stage_org_id_work_centre_id_fkey" FOREIGN KEY ("org_id", "work_centre_id") REFERENCES "work_centre"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_job_stage" ADD CONSTRAINT "production_job_stage_org_id_machine_id_fkey" FOREIGN KEY ("org_id", "machine_id") REFERENCES "machine"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "labour_record" ADD CONSTRAINT "labour_record_org_id_job_stage_id_fkey" FOREIGN KEY ("org_id", "job_stage_id") REFERENCES "production_job_stage"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_record" ADD CONSTRAINT "quality_record_org_id_inspection_plan_id_fkey" FOREIGN KEY ("org_id", "inspection_plan_id") REFERENCES "inspection_plan"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "work_centre" ADD CONSTRAINT "work_centre_org_id_branch_id_fkey" FOREIGN KEY ("org_id", "branch_id") REFERENCES "branch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "machine" ADD CONSTRAINT "machine_org_id_work_centre_id_fkey" FOREIGN KEY ("org_id", "work_centre_id") REFERENCES "work_centre"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "machine_downtime_record" ADD CONSTRAINT "machine_downtime_record_org_id_machine_id_fkey" FOREIGN KEY ("org_id", "machine_id") REFERENCES "machine"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "machine_maintenance_record" ADD CONSTRAINT "machine_maintenance_record_org_id_machine_id_fkey" FOREIGN KEY ("org_id", "machine_id") REFERENCES "machine"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "machine_time_record" ADD CONSTRAINT "machine_time_record_org_id_job_id_fkey" FOREIGN KEY ("org_id", "job_id") REFERENCES "production_job"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "machine_time_record" ADD CONSTRAINT "machine_time_record_org_id_job_stage_id_fkey" FOREIGN KEY ("org_id", "job_stage_id") REFERENCES "production_job_stage"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "machine_time_record" ADD CONSTRAINT "machine_time_record_org_id_machine_id_fkey" FOREIGN KEY ("org_id", "machine_id") REFERENCES "machine"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inspection_plan" ADD CONSTRAINT "inspection_plan_org_id_item_id_fkey" FOREIGN KEY ("org_id", "item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inspection_characteristic" ADD CONSTRAINT "inspection_characteristic_org_id_plan_id_fkey" FOREIGN KEY ("org_id", "plan_id") REFERENCES "inspection_plan"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quality_measurement" ADD CONSTRAINT "quality_measurement_org_id_quality_record_id_fkey" FOREIGN KEY ("org_id", "quality_record_id") REFERENCES "quality_record"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quality_measurement" ADD CONSTRAINT "quality_measurement_org_id_characteristic_id_fkey" FOREIGN KEY ("org_id", "characteristic_id") REFERENCES "inspection_characteristic"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "corrective_action" ADD CONSTRAINT "corrective_action_org_id_job_id_fkey" FOREIGN KEY ("org_id", "job_id") REFERENCES "production_job"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "corrective_action" ADD CONSTRAINT "corrective_action_org_id_quality_record_id_fkey" FOREIGN KEY ("org_id", "quality_record_id") REFERENCES "quality_record"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Append-only enforcement (prevent_mutation(), defined in
-- 20261007080000_harden_manual_constraints). machine_time_record and
-- quality_measurement are pure ledgers, same discipline as
-- production_output/labour_record's intent -- a mistaken entry is corrected
-- by recording an offsetting/replacement row, never by editing history.
-- (A dedicated void/reversal flow for machine time, mirroring output-
-- service.ts's voidOutput, is NOT included in this milestone -- see
-- IMPLEMENTATION_MANIFEST.md's Milestone 4 "Known limitations".)
-- machine_downtime_record and machine_maintenance_record are deliberately
-- NOT made fully immutable -- closing a downtime window (ended_at) and
-- completing a maintenance record (completed_at) are legitimate, expected
-- updates to the SAME row, same convention as dispatch's status mutation
-- (column-level grants below, not a blanket trigger).
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_machine_time_record_immutable
  BEFORE UPDATE OR DELETE ON machine_time_record
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_quality_measurement_immutable
  BEFORE UPDATE OR DELETE ON quality_measurement
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- ---------------------------------------------------------------------------
-- Reconciliation checks (periodic job / integration test, not a live
-- constraint -- same convention as every other ledger in this schema).
--
-- A quality_measurement's recorded min/max/uom always match what its
-- characteristic currently has UNLESS the characteristic was edited since --
-- this is BY DESIGN (the measurement is a snapshot), so this is not a check
-- that should ever be run as "must match"; it's listed here only so a
-- future reader knows the divergence is expected, not a bug:
--   SELECT qm.id FROM quality_measurement qm
--   JOIN inspection_characteristic ic ON ic.id = qm.characteristic_id
--   WHERE qm.min_value IS DISTINCT FROM ic.min_value OR qm.max_value IS DISTINCT FROM ic.max_value;
-- Any number of rows is fine; this is informational only.
--
-- Every production_job_stage with a non-null machine_id has a machine whose
-- work_centre_id matches the stage's own work_centre_id (when the stage sets
-- both) -- a stage should not be assigned a machine that lives in a
-- different work centre than the one the stage itself was assigned to:
--   SELECT s.id FROM production_job_stage s
--   JOIN machine m ON m.id = s.machine_id
--   WHERE s.work_centre_id IS NOT NULL AND s.work_centre_id <> m.work_centre_id;
-- Expected result: zero rows, always (enforced in code by stage-service.ts,
-- not by a CHECK constraint, which cannot join to another table).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Runtime grants -- guarded exactly like every prior migration (mops_runtime
-- is created outside Prisma; grant only if it already exists).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT, UPDATE (name, code, daily_capacity_minutes, is_active) ON work_centre TO mops_runtime;
    GRANT SELECT, INSERT, UPDATE (name, code, status, is_active) ON machine TO mops_runtime;
    GRANT SELECT, INSERT, UPDATE (ended_at, logged_by) ON machine_downtime_record TO mops_runtime;
    GRANT SELECT, INSERT, UPDATE (completed_at, notes, performed_by) ON machine_maintenance_record TO mops_runtime;
    GRANT SELECT, INSERT ON machine_time_record TO mops_runtime;
    GRANT SELECT, INSERT, UPDATE (name, is_active) ON inspection_plan TO mops_runtime;
    GRANT SELECT, INSERT, UPDATE (name, uom, min_value, max_value, target_value, sequence, is_active) ON inspection_characteristic TO mops_runtime;
    GRANT SELECT, INSERT ON quality_measurement TO mops_runtime;
    GRANT SELECT, INSERT, UPDATE (status, assigned_to, due_date, resolved_at, resolution_notes) ON corrective_action TO mops_runtime;
    -- effective_to and expected_scrap_pct/expected_yield_pct are set only at
    -- INSERT (createBomVersion), never UPDATE after the fact -- consistent
    -- with "no UPDATE ever touches an existing BomLine/BillOfMaterial row"
    -- (bom-service.ts header comment). No UPDATE grant for either, by design.
    GRANT UPDATE (priority) ON production_job TO mops_runtime;
    GRANT UPDATE (work_centre_id, expected_setup_minutes, expected_run_minutes) ON production_stage_template TO mops_runtime;
    GRANT UPDATE (work_centre_id, machine_id, expected_setup_minutes, expected_run_minutes) ON production_job_stage TO mops_runtime;
    GRANT UPDATE (job_stage_id) ON labour_record TO mops_runtime;
    GRANT UPDATE (inspection_plan_id) ON quality_record TO mops_runtime;
  END IF;
END
$$;
