-- Lot consumption, allocation, returns and end-to-end lot traceability --
-- "Phase One" of the next development mandate. Additive only: one new
-- table, one new enum, and a widening of material_lot (one column goes from
-- NOT NULL to nullable; three new nullable columns added). No existing
-- column's type, default or NOT NULL-ness is tightened, and no existing row
-- is touched. See prisma/schema.prisma's comments on MaterialLot and
-- LotConsumption for the full design rationale; this file only mirrors it
-- into DDL.

-- ---------------------------------------------------------------------------
-- material_lot: widen for return lineage.
--
-- receipt_line_id becomes nullable because a lot spawned by a "needs
-- inspection" return (see material-issue-service.ts's returnMaterialFromJob)
-- has no originating goods_receipt_line -- it originates from a production
-- job's returned material instead. Postgres composite FK/unique constraints
-- already treat a NULL in any column as "not compared", so this is safe for
-- both the existing FK to goods_receipt_line and the existing
-- material_lot_org_id_receipt_line_id_key unique index: multiple lots with a
-- NULL receipt_line_id do not collide.
-- ---------------------------------------------------------------------------
ALTER TABLE "material_lot" ALTER COLUMN "receipt_line_id" DROP NOT NULL;

ALTER TABLE "material_lot" ADD COLUMN "source_return_of_lot_id" UUID;
ALTER TABLE "material_lot" ADD COLUMN "source_return_job_id" UUID;
ALTER TABLE "material_lot" ADD COLUMN "source_return_movement_id" UUID;

CREATE INDEX "material_lot_org_id_item_id_warehouse_id_idx" ON "material_lot"("org_id", "item_id", "warehouse_id");

-- ---------------------------------------------------------------------------
-- stock_movement: add the (org_id, id) unique index that every other table
-- in this schema already has, needed so material_lot.source_return_movement_id
-- and lot_consumption.movement_id can carry a composite, org-isolated FK back
-- to it (the same defense-in-depth pattern as every other relation here --
-- a single-column FK on `id` alone would not verify the referenced row
-- belongs to the same org). `id` is already a PK (globally unique), so this
-- index is a pure addition with no effect on any existing query or write.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "stock_movement_org_id_id_key" ON "stock_movement"("org_id", "id");

-- ---------------------------------------------------------------------------
-- New FKs for material_lot's three new columns.
-- ---------------------------------------------------------------------------
ALTER TABLE "material_lot" ADD CONSTRAINT "material_lot_org_id_source_return_of_lot_id_fkey"
  FOREIGN KEY ("org_id", "source_return_of_lot_id") REFERENCES "material_lot"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_lot" ADD CONSTRAINT "material_lot_org_id_source_return_job_id_fkey"
  FOREIGN KEY ("org_id", "source_return_job_id") REFERENCES "production_job"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_lot" ADD CONSTRAINT "material_lot_org_id_source_return_movement_id_fkey"
  FOREIGN KEY ("org_id", "source_return_movement_id") REFERENCES "stock_movement"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- lot_consumption: the append-only usage ledger against a lot. See
-- prisma/schema.prisma's comment on the LotConsumption model for the sign
-- convention (positive = consumption, negative = return) and why the
-- CHECK constraint below encodes it at the database level, not just in the
-- service layer.
-- ---------------------------------------------------------------------------
CREATE TYPE "LotConsumptionType" AS ENUM ('consumption', 'return');

CREATE TABLE "lot_consumption" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "type" "LotConsumptionType" NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lot_consumption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lot_consumption_sign_matches_type" CHECK (
      ("type" = 'consumption' AND "quantity" > 0) OR ("type" = 'return' AND "quantity" < 0)
    )
);

CREATE UNIQUE INDEX "lot_consumption_org_id_id_key" ON "lot_consumption"("org_id", "id");
CREATE INDEX "lot_consumption_lot_id_idx" ON "lot_consumption"("lot_id");
CREATE INDEX "lot_consumption_job_id_idx" ON "lot_consumption"("job_id");
CREATE INDEX "lot_consumption_movement_id_idx" ON "lot_consumption"("movement_id");

ALTER TABLE "lot_consumption" ADD CONSTRAINT "lot_consumption_org_id_lot_id_fkey"
  FOREIGN KEY ("org_id", "lot_id") REFERENCES "material_lot"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lot_consumption" ADD CONSTRAINT "lot_consumption_org_id_job_id_fkey"
  FOREIGN KEY ("org_id", "job_id") REFERENCES "production_job"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lot_consumption" ADD CONSTRAINT "lot_consumption_org_id_movement_id_fkey"
  FOREIGN KEY ("org_id", "movement_id") REFERENCES "stock_movement"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: same mechanism as stock_movement/goods_receipt/audit_log
-- (prevent_mutation(), defined in 20261007080000_harden_manual_constraints,
-- which runs before this migration).
CREATE TRIGGER trg_lot_consumption_immutable
  BEFORE UPDATE OR DELETE ON lot_consumption
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- ---------------------------------------------------------------------------
-- Reconciliation check (periodic job / integration test, not a live
-- constraint -- same convention as the stock_balance reconciliation query
-- documented in docs/schema.sql). Proves that, for every StockMovement of
-- type production_consumption or material_return, the LotConsumption rows
-- referencing it (if the item is lot-tracked at all) sum, in absolute value,
-- to exactly that movement's own quantity:
--
--   SELECT sm.id, sm.quantity, lc.sum_qty
--   FROM stock_movement sm
--   JOIN (SELECT movement_id, SUM(quantity) AS sum_qty
--         FROM lot_consumption GROUP BY movement_id) lc
--     ON lc.movement_id = sm.id
--   WHERE sm.movement_type IN ('production_consumption', 'material_return')
--     AND abs(lc.sum_qty) <> abs(sm.quantity);
-- Expected result: zero rows, always.
--
-- And that no lot's computed remaining balance ever goes negative:
--   SELECT ml.id, ml.lot_number, ml.quantity_received,
--          ml.quantity_received - COALESCE(SUM(lc.quantity), 0) AS remaining
--   FROM material_lot ml LEFT JOIN lot_consumption lc ON lc.lot_id = ml.id
--   GROUP BY ml.id, ml.lot_number, ml.quantity_received
--   HAVING ml.quantity_received - COALESCE(SUM(lc.quantity), 0) < 0;
-- Expected result: zero rows, always (enforced by the service layer at
-- write time, same "no live DB constraint, but provably true" treatment as
-- stock_balance).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Runtime grants -- guarded exactly like every prior migration (mops_runtime
-- is created outside Prisma; grant only if it already exists). lot_consumption
-- is append-only: SELECT + INSERT only, same as stock_movement/goods_receipt.
-- material_lot's existing grants (SELECT + INSERT, plus UPDATE restricted to
-- status/expiry_date) are untouched and already cover the three new columns
-- correctly: they are set once at INSERT time by application code and the
-- existing restricted UPDATE grant does not include them, so they inherit
-- the same "immutable after creation" enforcement the existing columns have
-- without any grant change here.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT ON lot_consumption TO mops_runtime;
  END IF;
END
$$;
