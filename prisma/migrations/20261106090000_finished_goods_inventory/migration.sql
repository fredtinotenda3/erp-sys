-- Finished-Goods Inventory -- Milestone 2. Additive only: four new tables,
-- two new enums, no change to any existing table's columns (StockMovement's
-- existing movement_type enum already has finished_goods_receipt and
-- stock_transfer_out/stock_transfer_in -- reserved since the init migration,
-- used by this milestone for the first time). See prisma/schema.prisma's
-- comments on FinishedGoodsBatch / FgBatchMovement / FgBatchMaterialLot /
-- FinishedGoodsBatchCostLine for the full design rationale; this file only
-- mirrors it into DDL.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "FgBatchStatus" AS ENUM ('active', 'quarantined', 'rejected');
CREATE TYPE "FgBatchMovementType" AS ENUM ('transfer_out', 'adjustment', 'dispatch');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE "finished_goods_batch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "batch_number" TEXT NOT NULL,
    "product_item_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "produced_movement_id" UUID NOT NULL,
    "good_qty" DECIMAL(14,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "status" "FgBatchStatus" NOT NULL DEFAULT 'active',
    "quality_notes" TEXT,
    "produced_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transferred_from_batch_id" UUID,
    "transferred_from_movement_id" UUID,

    CONSTRAINT "finished_goods_batch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "finished_goods_batch_good_qty_positive" CHECK ("good_qty" > 0)
);

CREATE TABLE "fg_batch_movement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "type" "FgBatchMovementType" NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fg_batch_movement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fg_batch_movement_sign" CHECK (
      ("type" IN ('transfer_out', 'dispatch') AND "quantity" < 0) OR
      ("type" = 'adjustment' AND "quantity" <> 0)
    )
);

CREATE TABLE "fg_batch_material_lot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "lot_consumption_id" UUID,
    "material_item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fg_batch_material_lot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fg_batch_material_lot_qty_positive" CHECK ("quantity" > 0)
);

CREATE TABLE "finished_goods_batch_cost_line" (
    "org_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "material_cost" DECIMAL(14,4) NOT NULL,
    "labour_cost" DECIMAL(14,4),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finished_goods_batch_cost_line_pkey" PRIMARY KEY ("batch_id", "currency"),
    CONSTRAINT "finished_goods_batch_cost_line_nonneg" CHECK ("material_cost" >= 0 AND ("labour_cost" IS NULL OR "labour_cost" >= 0))
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "finished_goods_batch_org_id_batch_number_key" ON "finished_goods_batch"("org_id", "batch_number");
CREATE UNIQUE INDEX "finished_goods_batch_org_id_id_key" ON "finished_goods_batch"("org_id", "id");
CREATE UNIQUE INDEX "finished_goods_batch_org_id_produced_movement_id_key" ON "finished_goods_batch"("org_id", "produced_movement_id");
-- Backs the one-to-one relation (fgBatchTransferredInTo / transferredFromMovement)
-- in schema.prisma: a StockMovement is the transfer-in movement for at most
-- one FinishedGoodsBatch. Without this, Prisma's "@relation must use unique
-- fields on the defining side" check fails at `prisma generate`/validate --
-- the FK two statements below already existed but had no backing unique index.
CREATE UNIQUE INDEX "finished_goods_batch_org_id_transferred_from_movement_id_key" ON "finished_goods_batch"("org_id", "transferred_from_movement_id");
CREATE INDEX "finished_goods_batch_org_id_product_item_id_warehouse_id_idx" ON "finished_goods_batch"("org_id", "product_item_id", "warehouse_id");
CREATE INDEX "finished_goods_batch_org_id_job_id_idx" ON "finished_goods_batch"("org_id", "job_id");

CREATE UNIQUE INDEX "fg_batch_movement_org_id_id_key" ON "fg_batch_movement"("org_id", "id");
CREATE INDEX "fg_batch_movement_batch_id_idx" ON "fg_batch_movement"("batch_id");
CREATE INDEX "fg_batch_movement_movement_id_idx" ON "fg_batch_movement"("movement_id");

CREATE UNIQUE INDEX "fg_batch_material_lot_org_id_id_key" ON "fg_batch_material_lot"("org_id", "id");
CREATE INDEX "fg_batch_material_lot_batch_id_idx" ON "fg_batch_material_lot"("batch_id");
CREATE INDEX "fg_batch_material_lot_lot_id_idx" ON "fg_batch_material_lot"("lot_id");

-- ---------------------------------------------------------------------------
-- Foreign keys -- org-isolation at the constraint level, same convention as
-- every other relationship in this schema.
-- ---------------------------------------------------------------------------
ALTER TABLE "finished_goods_batch" ADD CONSTRAINT "finished_goods_batch_org_id_branch_id_fkey" FOREIGN KEY ("org_id", "branch_id") REFERENCES "branch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_batch" ADD CONSTRAINT "finished_goods_batch_org_id_product_item_id_fkey" FOREIGN KEY ("org_id", "product_item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_batch" ADD CONSTRAINT "finished_goods_batch_org_id_job_id_fkey" FOREIGN KEY ("org_id", "job_id") REFERENCES "production_job"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_batch" ADD CONSTRAINT "finished_goods_batch_org_id_warehouse_id_fkey" FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "warehouse"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_batch" ADD CONSTRAINT "finished_goods_batch_org_id_produced_movement_id_fkey" FOREIGN KEY ("org_id", "produced_movement_id") REFERENCES "stock_movement"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_batch" ADD CONSTRAINT "finished_goods_batch_org_id_transferred_from_batch_id_fkey" FOREIGN KEY ("org_id", "transferred_from_batch_id") REFERENCES "finished_goods_batch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_batch" ADD CONSTRAINT "finished_goods_batch_org_id_transferred_from_movement_id_fkey" FOREIGN KEY ("org_id", "transferred_from_movement_id") REFERENCES "stock_movement"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fg_batch_movement" ADD CONSTRAINT "fg_batch_movement_org_id_batch_id_fkey" FOREIGN KEY ("org_id", "batch_id") REFERENCES "finished_goods_batch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fg_batch_movement" ADD CONSTRAINT "fg_batch_movement_org_id_movement_id_fkey" FOREIGN KEY ("org_id", "movement_id") REFERENCES "stock_movement"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fg_batch_material_lot" ADD CONSTRAINT "fg_batch_material_lot_org_id_batch_id_fkey" FOREIGN KEY ("org_id", "batch_id") REFERENCES "finished_goods_batch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fg_batch_material_lot" ADD CONSTRAINT "fg_batch_material_lot_org_id_lot_id_fkey" FOREIGN KEY ("org_id", "lot_id") REFERENCES "material_lot"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fg_batch_material_lot" ADD CONSTRAINT "fg_batch_material_lot_org_id_lot_consumption_id_fkey" FOREIGN KEY ("org_id", "lot_consumption_id") REFERENCES "lot_consumption"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fg_batch_material_lot" ADD CONSTRAINT "fg_batch_material_lot_org_id_material_item_id_fkey" FOREIGN KEY ("org_id", "material_item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "finished_goods_batch_cost_line" ADD CONSTRAINT "finished_goods_batch_cost_line_org_id_batch_id_fkey" FOREIGN KEY ("org_id", "batch_id") REFERENCES "finished_goods_batch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_batch_cost_line" ADD CONSTRAINT "finished_goods_batch_cost_line_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Append-only enforcement, same mechanism as stock_movement / goods_receipt /
-- lot_consumption (prevent_mutation(), defined in
-- 20261007080000_harden_manual_constraints). finished_goods_batch is
-- deliberately NOT given this trigger -- it has one legitimately mutable
-- column (status, plus quality_notes alongside it) -- that is enforced
-- instead by the column-level GRANT below, the same discipline
-- material_lot's (status, expiry_date) already uses.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_fg_batch_movement_immutable
  BEFORE UPDATE OR DELETE ON fg_batch_movement
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_fg_batch_material_lot_immutable
  BEFORE UPDATE OR DELETE ON fg_batch_material_lot
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_finished_goods_batch_cost_line_immutable
  BEFORE UPDATE OR DELETE ON finished_goods_batch_cost_line
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- ---------------------------------------------------------------------------
-- Reconciliation checks (periodic job / integration test, not a live
-- constraint -- same convention as every other ledger in this schema).
--
-- A batch's computed remaining quantity never goes negative:
--   SELECT b.id, b.batch_number, b.good_qty,
--          b.good_qty + COALESCE(SUM(m.quantity), 0) AS remaining
--   FROM finished_goods_batch b LEFT JOIN fg_batch_movement m ON m.batch_id = b.id
--   GROUP BY b.id, b.batch_number, b.good_qty
--   HAVING b.good_qty + COALESCE(SUM(m.quantity), 0) < 0;
-- Expected result: zero rows, always.
--
-- A job's finished-goods batches never claim more cost, per currency, than
-- the job's own actual cost (actual-cost.ts's computeActualCostLines):
--   SELECT j.id, c.currency, c.alloc_material, a.material_cost
--   FROM production_job j
--   JOIN (SELECT b.job_id, l.currency, SUM(l.material_cost) AS alloc_material
--         FROM finished_goods_batch_cost_line l
--         JOIN finished_goods_batch b ON b.id = l.batch_id
--         GROUP BY b.job_id, l.currency) c ON c.job_id = j.id
--   JOIN job_cost_actual_line a ON a.job_id = j.id AND a.currency = c.currency
--   WHERE c.alloc_material > a.actual_material_cost;
-- Expected result: zero rows, always (enforced by the service layer's clamp
-- in finished-goods-service.ts's computeBatchCostLines).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Runtime grants -- guarded exactly like every prior migration (mops_runtime
-- is created outside Prisma; grant only if it already exists).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT ON finished_goods_batch TO mops_runtime;
    GRANT UPDATE (status, quality_notes) ON finished_goods_batch TO mops_runtime;
    GRANT SELECT, INSERT ON fg_batch_movement TO mops_runtime;
    GRANT SELECT, INSERT ON fg_batch_material_lot TO mops_runtime;
    GRANT SELECT, INSERT ON finished_goods_batch_cost_line TO mops_runtime;
  END IF;
END
$$;