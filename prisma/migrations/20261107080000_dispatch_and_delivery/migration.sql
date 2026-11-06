-- Dispatch and Delivery -- Milestone 3. Additive only: one new enum, three
-- new tables, no change to any existing table's columns.
--
-- StockMovement's movement_type enum already has "sale_delivery" (reserved
-- since the init migration) and ReferenceType already has "sales_order"
-- (same) -- both used by this milestone for the first time, exactly the
-- same "reserved ahead of the milestone that needs it" pattern
-- finished_goods_receipt / stock_transfer_out / stock_transfer_in followed
-- for Milestone 2. FgBatchMovementType's "dispatch" value, reserved by
-- Milestone 2's own migration for exactly this moment, is likewise used for
-- the first time here. See prisma/schema.prisma's comment above the
-- Dispatch / DispatchLine / DispatchBatchAllocation models for the full
-- design rationale; this file only mirrors it into DDL.

-- ---------------------------------------------------------------------------
-- Enum
-- ---------------------------------------------------------------------------
CREATE TYPE "DispatchStatus" AS ENUM ('dispatched', 'delivered');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE "dispatch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "dispatch_number" TEXT NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'dispatched',
    "dispatched_at" TIMESTAMP(3) NOT NULL,
    "carrier" TEXT,
    "tracking_reference" TEXT,
    "notes" TEXT,
    "delivered_at" TIMESTAMP(3),
    "received_by" TEXT,
    "delivery_notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_pkey" PRIMARY KEY ("id"),
    -- A dispatch is "delivered" if and only if a delivery has actually been
    -- confirmed (delivered_at stamped) -- neither can happen without the
    -- other, enforced here rather than trusted to the service layer alone.
    CONSTRAINT "dispatch_delivered_consistency" CHECK (("status" = 'delivered') = ("delivered_at" IS NOT NULL))
);

CREATE TABLE "dispatch_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "dispatch_id" UUID NOT NULL,
    "sales_order_line_id" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "uom" TEXT NOT NULL,

    CONSTRAINT "dispatch_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dispatch_line_qty_positive" CHECK ("quantity" > 0)
);

CREATE TABLE "dispatch_batch_allocation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "dispatch_line_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "fg_batch_movement_id" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_batch_allocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dispatch_batch_allocation_qty_positive" CHECK ("quantity" > 0)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "dispatch_org_id_dispatch_number_key" ON "dispatch"("org_id", "dispatch_number");
CREATE UNIQUE INDEX "dispatch_org_id_id_key" ON "dispatch"("org_id", "id");
CREATE INDEX "dispatch_org_id_sales_order_id_idx" ON "dispatch"("org_id", "sales_order_id");
CREATE INDEX "dispatch_org_id_warehouse_id_idx" ON "dispatch"("org_id", "warehouse_id");

CREATE UNIQUE INDEX "dispatch_line_org_id_id_key" ON "dispatch_line"("org_id", "id");
CREATE INDEX "dispatch_line_sales_order_line_id_idx" ON "dispatch_line"("sales_order_line_id");
CREATE INDEX "dispatch_line_dispatch_id_idx" ON "dispatch_line"("dispatch_id");

CREATE UNIQUE INDEX "dispatch_batch_allocation_org_id_id_key" ON "dispatch_batch_allocation"("org_id", "id");
CREATE UNIQUE INDEX "dispatch_batch_allocation_org_id_fg_batch_movement_id_key" ON "dispatch_batch_allocation"("org_id", "fg_batch_movement_id");
CREATE INDEX "dispatch_batch_allocation_dispatch_line_id_idx" ON "dispatch_batch_allocation"("dispatch_line_id");
CREATE INDEX "dispatch_batch_allocation_batch_id_idx" ON "dispatch_batch_allocation"("batch_id");

-- ---------------------------------------------------------------------------
-- Foreign keys -- org-isolation at the constraint level, same convention as
-- every other relationship in this schema.
-- ---------------------------------------------------------------------------
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_org_id_branch_id_fkey" FOREIGN KEY ("org_id", "branch_id") REFERENCES "branch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_org_id_sales_order_id_fkey" FOREIGN KEY ("org_id", "sales_order_id") REFERENCES "sales_order"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_org_id_warehouse_id_fkey" FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "warehouse"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dispatch_line" ADD CONSTRAINT "dispatch_line_org_id_dispatch_id_fkey" FOREIGN KEY ("org_id", "dispatch_id") REFERENCES "dispatch"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dispatch_line" ADD CONSTRAINT "dispatch_line_org_id_sales_order_line_id_fkey" FOREIGN KEY ("org_id", "sales_order_line_id") REFERENCES "sales_order_line"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dispatch_batch_allocation" ADD CONSTRAINT "dispatch_batch_allocation_org_id_dispatch_line_id_fkey" FOREIGN KEY ("org_id", "dispatch_line_id") REFERENCES "dispatch_line"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dispatch_batch_allocation" ADD CONSTRAINT "dispatch_batch_allocation_org_id_batch_id_fkey" FOREIGN KEY ("org_id", "batch_id") REFERENCES "finished_goods_batch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispatch_batch_allocation" ADD CONSTRAINT "dispatch_batch_allocation_org_id_fg_batch_movement_id_fkey" FOREIGN KEY ("org_id", "fg_batch_movement_id") REFERENCES "fg_batch_movement"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Append-only enforcement (prevent_mutation(), defined in
-- 20261007080000_harden_manual_constraints). dispatch_line and
-- dispatch_batch_allocation are fully immutable -- once a dispatch leaves
-- the warehouse, its line detail and batch allocations are a permanent
-- record (there is no reversal/return flow in this milestone -- see
-- dispatch-service.ts's header). dispatch itself deliberately does NOT get
-- this trigger -- it has four legitimately mutable columns (status,
-- delivered_at, received_by, delivery_notes), all written exactly once, by
-- confirmDelivery -- enforced instead by the column-level GRANT below, the
-- same discipline finished_goods_batch's (status, quality_notes) already
-- uses.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_dispatch_line_immutable
  BEFORE UPDATE OR DELETE ON dispatch_line
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_dispatch_batch_allocation_immutable
  BEFORE UPDATE OR DELETE ON dispatch_batch_allocation
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- ---------------------------------------------------------------------------
-- Reconciliation checks (periodic job / integration test, not a live
-- constraint -- same convention as every other ledger in this schema).
--
-- A dispatch line's recorded quantity always equals the sum of its own
-- batch allocations (the service layer's invariant -- not DB-enforced by a
-- CHECK, which cannot reference another table; verified here instead):
--   SELECT dl.id, dl.quantity, COALESCE(SUM(a.quantity), 0) AS allocated
--   FROM dispatch_line dl LEFT JOIN dispatch_batch_allocation a ON a.dispatch_line_id = dl.id
--   GROUP BY dl.id, dl.quantity
--   HAVING dl.quantity <> COALESCE(SUM(a.quantity), 0);
-- Expected result: zero rows, always.
--
-- Cumulative dispatched quantity per sales order line never exceeds the
-- line's ordered quantity (dispatch-service.ts's createDispatch enforces
-- this under a FOR UPDATE lock on the sales_order row):
--   SELECT sol.id, sol.quantity AS ordered, COALESCE(SUM(dl.quantity), 0) AS dispatched
--   FROM sales_order_line sol LEFT JOIN dispatch_line dl ON dl.sales_order_line_id = sol.id
--   GROUP BY sol.id, sol.quantity
--   HAVING COALESCE(SUM(dl.quantity), 0) > sol.quantity;
-- Expected result: zero rows, always.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Runtime grants -- guarded exactly like every prior migration (mops_runtime
-- is created outside Prisma; grant only if it already exists).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT ON dispatch TO mops_runtime;
    GRANT UPDATE (status, delivered_at, received_by, delivery_notes) ON dispatch TO mops_runtime;
    GRANT SELECT, INSERT ON dispatch_line TO mops_runtime;
    GRANT SELECT, INSERT ON dispatch_batch_allocation TO mops_runtime;
  END IF;
END
$$;
