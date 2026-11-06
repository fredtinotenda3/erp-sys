-- Milestone 6 -- Plastics Manufacturing Vertical. Additive except for one
-- deliberate, backward-compatible relaxation: material_lot.supplier_id
-- becomes nullable (a regrind lot has no external supplier -- see below).
-- No column is dropped, no existing row's meaning changes, and every
-- existing material_lot row already has a real, non-null supplier_id, so
-- that relaxation affects zero existing rows. See prisma/schema.prisma's
-- "MILESTONE 6" comment block for the full design rationale; this file only
-- mirrors it into DDL.

-- ---------------------------------------------------------------------------
-- Existing-table changes: material_lot (regrind lineage)
-- ---------------------------------------------------------------------------
-- A regrind lot is generated internally from a job's own scrap, not
-- purchased -- it has no supplier at all. Relaxing this NOT NULL is the
-- correct domain model, not a workaround (the alternative -- a fake
-- "Internal" Supplier row -- would pollute the supplier catalogue and its
-- PO-creation picker with a non-vendor). This does not touch the existing
-- FK (material_lot_org_id_supplier_id_fkey, or equivalent) -- a FOREIGN KEY
-- always permits a NULL value regardless of this column's nullability.
ALTER TABLE "material_lot" ALTER COLUMN "supplier_id" DROP NOT NULL;

ALTER TABLE "material_lot" ADD COLUMN "source_regrind_job_id" UUID;
ALTER TABLE "material_lot" ADD COLUMN "source_regrind_movement_id" UUID;

-- A lot is never both a return-child (of one specific parent lot) AND a
-- regrind lot (of a job's aggregate scrap) -- those are two different
-- origins and regrind-service.ts never sets both. New columns only (every
-- existing row already has source_regrind_job_id = NULL), so this CHECK
-- validates cleanly against all existing data with no exceptions needed.
ALTER TABLE "material_lot"
  ADD CONSTRAINT "material_lot_regrind_return_mutually_exclusive"
  CHECK (NOT ("source_return_of_lot_id" IS NOT NULL AND "source_regrind_job_id" IS NOT NULL));

ALTER TABLE "material_lot" ADD CONSTRAINT "material_lot_org_id_source_regrind_job_id_fkey"
  FOREIGN KEY ("org_id", "source_regrind_job_id") REFERENCES "production_job"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_lot" ADD CONSTRAINT "material_lot_org_id_source_regrind_movement_id_fkey"
  FOREIGN KEY ("org_id", "source_regrind_movement_id") REFERENCES "stock_movement"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Existing-table changes: stock_movement (regrind posting)
-- ---------------------------------------------------------------------------
-- A plain ADD VALUE, not inside this migration's own DML -- nothing below
-- inserts a 'regrind_generation' row, so there is no "new value used in the
-- same transaction it was added in" hazard. Deliberately its own value,
-- never purchase_receipt: any report summing purchase_receipt to answer
-- "how much material did we buy" is correct by construction, with no need
-- to separately know regrind exists and exclude it.
ALTER TYPE "MovementType" ADD VALUE IF NOT EXISTS 'regrind_generation';

-- ---------------------------------------------------------------------------
-- Enum
-- ---------------------------------------------------------------------------
CREATE TYPE "MouldStatus" AS ENUM ('available', 'in_use', 'maintenance', 'retired');

-- ---------------------------------------------------------------------------
-- New tables
-- ---------------------------------------------------------------------------
CREATE TABLE "mould" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cavity_count" INTEGER NOT NULL,
    "status" "MouldStatus" NOT NULL DEFAULT 'available',
    "compatible_product_item_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mould_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mould_cavity_count_positive" CHECK ("cavity_count" > 0)
);

CREATE TABLE "mould_machine_compatibility" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "mould_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mould_machine_compatibility_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mould_maintenance_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "mould_id" UUID NOT NULL,
    "type" "MaintenanceType" NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "notes" TEXT,
    "performed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mould_maintenance_record_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "plastics_material_attributes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "polymer_grade" TEXT,
    "resin_spec" TEXT,
    "colour_masterbatch" TEXT,
    "additive_notes" TEXT,
    "recycled_content_pct" DECIMAL(5,2),
    "supplier_material_ref" TEXT,
    "material_certificate_reference" TEXT,
    "blend_composition" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plastics_material_attributes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plastics_material_attributes_recycled_pct_range" CHECK ("recycled_content_pct" IS NULL OR ("recycled_content_pct" >= 0 AND "recycled_content_pct" <= 100)),
    CONSTRAINT "plastics_material_attributes_blend_is_array" CHECK ("blend_composition" IS NULL OR jsonb_typeof("blend_composition") = 'array')
);

CREATE TABLE "plastics_product_spec" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "product_type" TEXT NOT NULL,
    "resin_type" TEXT,
    "colour" TEXT,
    "nominal_weight_grams" DECIMAL(10,3),
    "capacity_ml" DECIMAL(12,3),
    "height_mm" DECIMAL(10,2),
    "diameter_mm" DECIMAL(10,2),
    "neck_finish" TEXT,
    "closure_compatibility_notes" TEXT,
    "other_attributes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plastics_product_spec_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plastics_product_spec_weight_nonneg" CHECK ("nominal_weight_grams" IS NULL OR "nominal_weight_grams" > 0),
    CONSTRAINT "plastics_product_spec_capacity_nonneg" CHECK ("capacity_ml" IS NULL OR "capacity_ml" > 0),
    CONSTRAINT "plastics_product_spec_height_nonneg" CHECK ("height_mm" IS NULL OR "height_mm" > 0),
    CONSTRAINT "plastics_product_spec_diameter_nonneg" CHECK ("diameter_mm" IS NULL OR "diameter_mm" > 0)
);

CREATE TABLE "plastics_process_detail" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "job_stage_id" UUID NOT NULL,
    "process_type" TEXT NOT NULL,
    "mould_id" UUID,
    "target_cycle_time_seconds" DECIMAL(10,2),
    "actual_cycle_time_seconds" DECIMAL(10,2),
    "total_cavities" INTEGER,
    "good_cavities" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plastics_process_detail_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plastics_process_detail_target_cycle_nonneg" CHECK ("target_cycle_time_seconds" IS NULL OR "target_cycle_time_seconds" > 0),
    CONSTRAINT "plastics_process_detail_actual_cycle_nonneg" CHECK ("actual_cycle_time_seconds" IS NULL OR "actual_cycle_time_seconds" > 0),
    CONSTRAINT "plastics_process_detail_total_cavities_positive" CHECK ("total_cavities" IS NULL OR "total_cavities" > 0),
    CONSTRAINT "plastics_process_detail_good_cavities_range" CHECK ("good_cavities" IS NULL OR ("good_cavities" >= 0 AND ("total_cavities" IS NULL OR "good_cavities" <= "total_cavities")))
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "mould_org_id_id_key" ON "mould"("org_id", "id");
CREATE UNIQUE INDEX "mould_branch_id_code_key" ON "mould"("branch_id", "code");

CREATE UNIQUE INDEX "mould_machine_compatibility_org_id_id_key" ON "mould_machine_compatibility"("org_id", "id");
CREATE UNIQUE INDEX "mould_machine_compatibility_mould_id_machine_id_key" ON "mould_machine_compatibility"("mould_id", "machine_id");

CREATE UNIQUE INDEX "mould_maintenance_record_org_id_id_key" ON "mould_maintenance_record"("org_id", "id");
CREATE INDEX "mould_maintenance_record_mould_id_idx" ON "mould_maintenance_record"("mould_id");

CREATE UNIQUE INDEX "plastics_material_attributes_org_id_id_key" ON "plastics_material_attributes"("org_id", "id");
CREATE UNIQUE INDEX "plastics_material_attributes_org_id_item_id_key" ON "plastics_material_attributes"("org_id", "item_id");

CREATE UNIQUE INDEX "plastics_product_spec_org_id_id_key" ON "plastics_product_spec"("org_id", "id");
CREATE UNIQUE INDEX "plastics_product_spec_org_id_item_id_key" ON "plastics_product_spec"("org_id", "item_id");

CREATE UNIQUE INDEX "plastics_process_detail_org_id_id_key" ON "plastics_process_detail"("org_id", "id");
CREATE UNIQUE INDEX "plastics_process_detail_org_id_job_stage_id_key" ON "plastics_process_detail"("org_id", "job_stage_id");
CREATE INDEX "plastics_process_detail_mould_id_idx" ON "plastics_process_detail"("mould_id");

-- ---------------------------------------------------------------------------
-- Foreign keys -- org-isolation at the constraint level, same convention as
-- every other relationship in this schema.
-- ---------------------------------------------------------------------------
ALTER TABLE "mould" ADD CONSTRAINT "mould_org_id_branch_id_fkey" FOREIGN KEY ("org_id", "branch_id") REFERENCES "branch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mould" ADD CONSTRAINT "mould_org_id_compatible_product_item_id_fkey" FOREIGN KEY ("org_id", "compatible_product_item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "mould_machine_compatibility" ADD CONSTRAINT "mould_machine_compatibility_org_id_mould_id_fkey" FOREIGN KEY ("org_id", "mould_id") REFERENCES "mould"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mould_machine_compatibility" ADD CONSTRAINT "mould_machine_compatibility_org_id_machine_id_fkey" FOREIGN KEY ("org_id", "machine_id") REFERENCES "machine"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mould_maintenance_record" ADD CONSTRAINT "mould_maintenance_record_org_id_mould_id_fkey" FOREIGN KEY ("org_id", "mould_id") REFERENCES "mould"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "plastics_material_attributes" ADD CONSTRAINT "plastics_material_attributes_org_id_item_id_fkey" FOREIGN KEY ("org_id", "item_id") REFERENCES "item"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plastics_product_spec" ADD CONSTRAINT "plastics_product_spec_org_id_item_id_fkey" FOREIGN KEY ("org_id", "item_id") REFERENCES "item"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plastics_process_detail" ADD CONSTRAINT "plastics_process_detail_org_id_job_stage_id_fkey" FOREIGN KEY ("org_id", "job_stage_id") REFERENCES "production_job_stage"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plastics_process_detail" ADD CONSTRAINT "plastics_process_detail_org_id_mould_id_fkey" FOREIGN KEY ("org_id", "mould_id") REFERENCES "mould"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Append-only enforcement: deliberately NONE of the new tables get a
-- prevent_mutation() trigger. plastics_process_detail is a single
-- result/configuration row per job stage (mutable while the stage is
-- active, locked by the SERVICE layer once the stage reaches a terminal
-- status -- plastics-process-service.ts -- the same pattern
-- corrective_action already uses without a trigger); mould/
-- plastics_material_attributes/plastics_product_spec are register/spec
-- data, edited in place like work_centre/machine themselves; mould_
-- maintenance_record mirrors machine_maintenance_record's own
-- NOT-fully-immutable precedent (completing a maintenance record is a
-- legitimate update to the same row, gated by column-level GRANTs below,
-- not a trigger).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Reconciliation checks (periodic job / integration test, not a live
-- constraint -- same convention as Milestone 4's migration).
--
-- A mould's compatible_product_item_id, when set, should name an item of
-- type finished_good or wip (moulds don't produce raw materials):
--   SELECT mo.id FROM mould mo JOIN item i ON i.id = mo.compatible_product_item_id
--   WHERE i.item_type NOT IN ('finished_good', 'wip');
-- Expected result: zero rows, enforced in code by mould-service.ts, not a
-- CHECK constraint (cannot join to another table).
--
-- A regrind-sourced material_lot's item should be of type raw_material or
-- consumable (regrind is reground scrap re-entering the material stream,
-- never a finished good):
--   SELECT ml.id FROM material_lot ml JOIN item i ON i.id = ml.item_id
--   WHERE ml.source_regrind_job_id IS NOT NULL AND i.item_type NOT IN ('raw_material', 'consumable');
-- Expected result: zero rows, enforced in code by regrind-service.ts.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Runtime grants -- guarded exactly like every prior migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT, UPDATE (name, code, cavity_count, status, compatible_product_item_id, is_active) ON mould TO mops_runtime;
    GRANT SELECT, INSERT, DELETE ON mould_machine_compatibility TO mops_runtime;
    GRANT SELECT, INSERT, UPDATE (completed_at, notes, performed_by) ON mould_maintenance_record TO mops_runtime;
    GRANT SELECT, INSERT, UPDATE (polymer_grade, resin_spec, colour_masterbatch, additive_notes, recycled_content_pct, supplier_material_ref, material_certificate_reference, blend_composition) ON plastics_material_attributes TO mops_runtime;
    GRANT SELECT, INSERT, UPDATE (product_type, resin_type, colour, nominal_weight_grams, capacity_ml, height_mm, diameter_mm, neck_finish, closure_compatibility_notes, other_attributes) ON plastics_product_spec TO mops_runtime;
    GRANT SELECT, INSERT, UPDATE (process_type, mould_id, target_cycle_time_seconds, actual_cycle_time_seconds, total_cavities, good_cavities) ON plastics_process_detail TO mops_runtime;
    -- material_lot's regrind-lineage columns are set only at INSERT
    -- (createRegrindLot), never UPDATEd after the fact -- same "write-once"
    -- discipline as its return-lineage columns already have. No UPDATE
    -- grant for either, by design.
  END IF;
END
$$;
