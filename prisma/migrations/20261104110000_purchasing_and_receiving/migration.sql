-- Purchasing (Purchase Orders) + Goods Receiving + incoming Material Lots —
-- second and third milestones of the shared-core build-out, after Suppliers
-- (ARCHITECTURE.md's "shared core before industry layer" sequencing note).
-- Additive only — five new tables, two new enums, no change to any existing
-- table's columns. See prisma/schema.prisma's comments on each model for the
-- design rationale; this file only mirrors it into DDL.

-- ---------------------------------------------------------------------------
-- Enums — native types, matching every other enum in this schema.
-- ---------------------------------------------------------------------------
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('draft', 'confirmed', 'partially_received', 'received', 'closed', 'cancelled');
CREATE TYPE "MaterialLotStatus" AS ENUM ('active', 'quarantined', 'expired');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE "purchase_order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "po_number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'draft',
    "currency" CHAR(3) NOT NULL,
    "requested_delivery_date" DATE,
    "supplier_reference" TEXT,
    "notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_order_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "unit_price" DECIMAL(14,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,

    CONSTRAINT "purchase_order_line_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "goods_receipt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "delivery_reference" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "client_request_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "goods_receipt_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "po_line_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "received_qty" DECIMAL(14,4) NOT NULL,
    "accepted_qty" DECIMAL(14,4) NOT NULL,
    "rejected_qty" DECIMAL(14,4) NOT NULL,
    "reject_reason" "RejectReason",
    "unit_cost" DECIMAL(14,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipt_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "goods_receipt_line_qty_nonneg" CHECK ("received_qty" >= 0 AND "accepted_qty" >= 0 AND "rejected_qty" >= 0),
    CONSTRAINT "goods_receipt_line_qty_balances" CHECK ("accepted_qty" + "rejected_qty" = "received_qty")
);

CREATE TABLE "material_lot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "lot_number" TEXT NOT NULL,
    "item_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "supplier_lot_ref" TEXT,
    "receipt_line_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "quantity_received" DECIMAL(14,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "status" "MaterialLotStatus" NOT NULL DEFAULT 'active',
    "expiry_date" DATE,
    "received_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_lot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "material_lot_qty_positive" CHECK ("quantity_received" > 0)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "purchase_order_org_id_po_number_key" ON "purchase_order"("org_id", "po_number");
CREATE UNIQUE INDEX "purchase_order_org_id_id_key" ON "purchase_order"("org_id", "id");
CREATE INDEX "purchase_order_branch_id_status_idx" ON "purchase_order"("branch_id", "status");

CREATE UNIQUE INDEX "purchase_order_line_org_id_id_key" ON "purchase_order_line"("org_id", "id");
CREATE INDEX "purchase_order_line_po_id_idx" ON "purchase_order_line"("po_id");

CREATE UNIQUE INDEX "goods_receipt_org_id_id_key" ON "goods_receipt"("org_id", "id");
CREATE UNIQUE INDEX "goods_receipt_org_id_client_request_id_key" ON "goods_receipt"("org_id", "client_request_id");
CREATE INDEX "goods_receipt_po_id_idx" ON "goods_receipt"("po_id");
CREATE INDEX "goods_receipt_branch_id_received_at_idx" ON "goods_receipt"("branch_id", "received_at");

CREATE UNIQUE INDEX "goods_receipt_line_org_id_id_key" ON "goods_receipt_line"("org_id", "id");
CREATE INDEX "goods_receipt_line_po_line_id_idx" ON "goods_receipt_line"("po_line_id");
CREATE INDEX "goods_receipt_line_receipt_id_idx" ON "goods_receipt_line"("receipt_id");

CREATE UNIQUE INDEX "material_lot_org_id_lot_number_key" ON "material_lot"("org_id", "lot_number");
CREATE UNIQUE INDEX "material_lot_org_id_id_key" ON "material_lot"("org_id", "id");
CREATE UNIQUE INDEX "material_lot_org_id_receipt_line_id_key" ON "material_lot"("org_id", "receipt_line_id");

-- ---------------------------------------------------------------------------
-- Foreign keys — org-isolation at the constraint level, same referential
-- actions as the equivalent existing relationships (sales_order/
-- sales_order_line/production_job in the init migration; supplier in
-- 20261104100000_suppliers).
-- ---------------------------------------------------------------------------
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_org_id_branch_id_fkey" FOREIGN KEY ("org_id", "branch_id") REFERENCES "branch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_org_id_supplier_id_fkey" FOREIGN KEY ("org_id", "supplier_id") REFERENCES "supplier"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_org_id_po_id_fkey" FOREIGN KEY ("org_id", "po_id") REFERENCES "purchase_order"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_org_id_item_id_fkey" FOREIGN KEY ("org_id", "item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_org_id_po_id_fkey" FOREIGN KEY ("org_id", "po_id") REFERENCES "purchase_order"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_org_id_branch_id_fkey" FOREIGN KEY ("org_id", "branch_id") REFERENCES "branch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_org_id_receipt_id_fkey" FOREIGN KEY ("org_id", "receipt_id") REFERENCES "goods_receipt"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_org_id_po_line_id_fkey" FOREIGN KEY ("org_id", "po_line_id") REFERENCES "purchase_order_line"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_org_id_item_id_fkey" FOREIGN KEY ("org_id", "item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_org_id_warehouse_id_fkey" FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "warehouse"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "material_lot" ADD CONSTRAINT "material_lot_org_id_item_id_fkey" FOREIGN KEY ("org_id", "item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_lot" ADD CONSTRAINT "material_lot_org_id_supplier_id_fkey" FOREIGN KEY ("org_id", "supplier_id") REFERENCES "supplier"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_lot" ADD CONSTRAINT "material_lot_org_id_receipt_line_id_fkey" FOREIGN KEY ("org_id", "receipt_line_id") REFERENCES "goods_receipt_line"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_lot" ADD CONSTRAINT "material_lot_org_id_warehouse_id_fkey" FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "warehouse"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Append-only enforcement for goods_receipt / goods_receipt_line, same
-- mechanism as stock_movement/audit_log/exchange_rate/job_cost_actual
-- (prevent_mutation(), defined in 20261007080000_harden_manual_constraints,
-- which runs before this migration). A posted receipt is never corrected by
-- UPDATE — mistakes are corrected with a stock adjustment (stock-service.ts)
-- plus an explanatory note, same discipline the ledger already enforces
-- elsewhere. purchase_order / purchase_order_line and material_lot are
-- ordinary mutable data (status/lifecycle fields change over time) and are
-- NOT made immutable here.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_goods_receipt_immutable
  BEFORE UPDATE OR DELETE ON goods_receipt
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_goods_receipt_line_immutable
  BEFORE UPDATE OR DELETE ON goods_receipt_line
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- ---------------------------------------------------------------------------
-- Runtime grants — guarded exactly like 20261104100000_suppliers /
-- 20261031100000_account_security (mops_runtime is created outside Prisma;
-- grant only if it already exists). purchase_order / purchase_order_line are
-- ordinary CRUD data: full DML. goods_receipt / goods_receipt_line are
-- append-only (enforced above by trigger too, so this is belt-and-suspenders
-- the same way stock_movement's grants already are): SELECT + INSERT only.
-- material_lot allows SELECT + INSERT, plus UPDATE restricted to the two
-- columns that legitimately change after creation (status, expiry_date) —
-- quantity_received and every FK linkage are set once at creation and never
-- updated, enforced here at the column-privilege level, not just by
-- service-layer discipline.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order, purchase_order_line TO mops_runtime;
    GRANT SELECT, INSERT ON goods_receipt, goods_receipt_line TO mops_runtime;
    GRANT SELECT, INSERT ON material_lot TO mops_runtime;
    GRANT UPDATE (status, expiry_date) ON material_lot TO mops_runtime;
  END IF;
END
$$;
