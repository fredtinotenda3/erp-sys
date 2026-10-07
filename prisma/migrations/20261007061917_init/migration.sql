-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER_ADMIN', 'OPERATIONS_MANAGER', 'PRODUCTION_MANAGER', 'INVENTORY_MANAGER', 'PRODUCTION_OPERATOR', 'FINANCE_MANAGER', 'VIEWER');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('create', 'update', 'delete', 'transition', 'grant', 'revoke');

-- CreateEnum
CREATE TYPE "RateSource" AS ENUM ('RBZ_OFFICIAL', 'MARKET', 'MANUAL');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('raw_material', 'consumable', 'spare_part', 'finished_good', 'wip');

-- CreateEnum
CREATE TYPE "BomStatus" AS ENUM ('draft', 'active', 'superseded');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('draft', 'confirmed', 'in_production', 'partially_delivered', 'delivered', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "ProductionJobStatus" AS ENUM ('planned', 'released', 'in_progress', 'on_hold', 'completed', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "ProductionJobStageStatus" AS ENUM ('pending', 'in_progress', 'completed');

-- CreateEnum
CREATE TYPE "RejectReason" AS ENUM ('wrong_dimensions', 'damaged', 'paint_defect', 'missing_component', 'other');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('purchase_receipt', 'material_issue', 'material_return', 'production_consumption', 'finished_goods_receipt', 'sale_delivery', 'adjustment', 'stock_transfer_out', 'stock_transfer_in');

-- CreateEnum
CREATE TYPE "ReferenceType" AS ENUM ('production_job', 'purchase_order', 'sales_order', 'manual');

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "base_currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_branch_access" (
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by" UUID,

    CONSTRAINT "user_branch_access_pkey" PRIMARY KEY ("user_id","branch_id")
);

-- CreateTable
CREATE TABLE "user_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "user_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID NOT NULL,
    "branch_id" UUID,
    "actor_user_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" "AuditAction" NOT NULL,
    "before_value" JSONB,
    "after_value" JSONB,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency" (
    "code" CHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 2,

    CONSTRAINT "currency_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "exchange_rate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "base_currency" CHAR(3) NOT NULL,
    "quote_currency" CHAR(3) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "as_of_date" DATE NOT NULL,
    "source" "RateSource" NOT NULL,
    "recorded_by" UUID,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "uom" TEXT NOT NULL,
    "item_type" "ItemType" NOT NULL,
    "is_sellable" BOOLEAN NOT NULL DEFAULT false,
    "selling_price" DECIMAL(14,4),
    "selling_price_currency" CHAR(3),
    "standard_cost" DECIMAL(14,4),
    "standard_cost_currency" CHAR(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_of_material" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "product_item_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "BomStatus" NOT NULL DEFAULT 'draft',
    "effective_from" DATE,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_of_material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "bom_id" UUID NOT NULL,
    "material_item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "uom" TEXT NOT NULL,

    CONSTRAINT "bom_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "address" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'draft',
    "currency" CHAR(3) NOT NULL,
    "requested_delivery_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unit_price" DECIMAL(14,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,

    CONSTRAINT "sales_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "job_number" TEXT NOT NULL,
    "sales_order_line_id" UUID,
    "customer_id" UUID,
    "product_item_id" UUID NOT NULL,
    "bom_id" UUID NOT NULL,
    "planned_qty" DECIMAL(14,4) NOT NULL,
    "planned_start" DATE,
    "planned_end" DATE,
    "actual_start" TIMESTAMP(3),
    "actual_end" TIMESTAMP(3),
    "status" "ProductionJobStatus" NOT NULL DEFAULT 'planned',
    "quoted_amount" DECIMAL(14,4),
    "quoted_currency" CHAR(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_requirement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "material_item_id" UUID NOT NULL,
    "expected_qty" DECIMAL(14,4) NOT NULL,
    "uom" TEXT NOT NULL,

    CONSTRAINT "material_requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "user_id" UUID,
    "hours" DECIMAL(8,2) NOT NULL,
    "rate" DECIMAL(14,4) NOT NULL,
    "rate_currency" CHAR(3) NOT NULL,
    "client_request_id" UUID,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labour_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_stage_template" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "product_item_id" UUID,
    "stage_name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,

    CONSTRAINT "production_stage_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_job_stage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "stage_name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "ProductionJobStageStatus" NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "operator_user_id" UUID,
    "qty_processed" DECIMAL(14,4),
    "qty_rejected" DECIMAL(14,4),
    "notes" TEXT,
    "client_request_id" UUID,

    CONSTRAINT "production_job_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "job_stage_id" UUID,
    "produced_qty" DECIMAL(14,4) NOT NULL,
    "accepted_qty" DECIMAL(14,4) NOT NULL,
    "rejected_qty" DECIMAL(14,4) NOT NULL,
    "reject_reason" "RejectReason",
    "notes" TEXT,
    "evidence_ref" TEXT,
    "client_request_id" UUID,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "movement_type" "MovementType" NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unit_cost" DECIMAL(14,4),
    "currency" CHAR(3),
    "reference_type" "ReferenceType",
    "reference_id" UUID,
    "reason" TEXT,
    "client_request_id" UUID,
    "created_by" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balance" (
    "org_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "average_unit_cost" DECIMAL(14,4),
    "average_unit_cost_currency" CHAR(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_balance_pkey" PRIMARY KEY ("item_id","warehouse_id")
);

-- CreateTable
CREATE TABLE "job_cost_estimate" (
    "org_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "estimated_material_cost" DECIMAL(14,4) NOT NULL,
    "estimated_labour_cost" DECIMAL(14,4),
    "estimated_overhead_cost" DECIMAL(14,4),
    "currency" CHAR(3) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_cost_estimate_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "job_cost_actual" (
    "org_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "actual_material_cost" DECIMAL(14,4) NOT NULL,
    "actual_labour_cost" DECIMAL(14,4),
    "actual_overhead_cost" DECIMAL(14,4),
    "currency" CHAR(3) NOT NULL,
    "exchange_rate_id" UUID,
    "revenue" DECIMAL(14,4),
    "snapshotted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_cost_actual_pkey" PRIMARY KEY ("job_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "branch_org_id_name_key" ON "branch"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "branch_org_id_id_key" ON "branch"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_org_id_email_key" ON "app_user"("org_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_org_id_id_key" ON "app_user"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "user_session_token_hash_key" ON "user_session"("token_hash");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_org_id_created_at_idx" ON "audit_log"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "exchange_rate_base_currency_quote_currency_source_as_of_dat_idx" ON "exchange_rate"("base_currency", "quote_currency", "source", "as_of_date");

-- CreateIndex
CREATE UNIQUE INDEX "item_org_id_sku_key" ON "item"("org_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "item_org_id_id_key" ON "item"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_of_material_product_item_id_version_key" ON "bill_of_material"("product_item_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "bill_of_material_org_id_id_key" ON "bill_of_material"("org_id", "id");

-- CreateIndex
CREATE INDEX "bom_line_bom_id_idx" ON "bom_line"("bom_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_org_id_id_key" ON "customer"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_org_id_order_number_key" ON "sales_order"("org_id", "order_number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_org_id_id_key" ON "sales_order"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_line_org_id_id_key" ON "sales_order_line"("org_id", "id");

-- CreateIndex
CREATE INDEX "production_job_branch_id_status_idx" ON "production_job"("branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "production_job_org_id_job_number_key" ON "production_job"("org_id", "job_number");

-- CreateIndex
CREATE UNIQUE INDEX "production_job_org_id_id_key" ON "production_job"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "production_job_org_id_sales_order_line_id_key" ON "production_job"("org_id", "sales_order_line_id");

-- CreateIndex
CREATE INDEX "material_requirement_job_id_idx" ON "material_requirement"("job_id");

-- CreateIndex
CREATE INDEX "labour_record_job_id_idx" ON "labour_record"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "labour_record_org_id_client_request_id_key" ON "labour_record"("org_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_stage_template_org_id_id_key" ON "production_stage_template"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "production_job_stage_org_id_id_key" ON "production_job_stage"("org_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "production_job_stage_org_id_client_request_id_key" ON "production_job_stage"("org_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "quality_record_org_id_client_request_id_key" ON "quality_record"("org_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_branch_id_name_key" ON "warehouse"("branch_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_org_id_id_key" ON "warehouse"("org_id", "id");

-- CreateIndex
CREATE INDEX "stock_movement_item_id_warehouse_id_occurred_at_idx" ON "stock_movement"("item_id", "warehouse_id", "occurred_at");

-- CreateIndex
CREATE INDEX "stock_movement_reference_type_reference_id_idx" ON "stock_movement"("reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movement_org_id_client_request_id_key" ON "stock_movement"("org_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_cost_estimate_org_id_job_id_key" ON "job_cost_estimate"("org_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_cost_actual_org_id_job_id_key" ON "job_cost_actual"("org_id", "job_id");

-- AddForeignKey
ALTER TABLE "organization" ADD CONSTRAINT "organization_base_currency_fkey" FOREIGN KEY ("base_currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_org_id_user_id_fkey" FOREIGN KEY ("org_id", "user_id") REFERENCES "app_user"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_org_id_branch_id_fkey" FOREIGN KEY ("org_id", "branch_id") REFERENCES "branch"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_org_id_user_id_fkey" FOREIGN KEY ("org_id", "user_id") REFERENCES "app_user"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_branch_id_fkey" FOREIGN KEY ("org_id", "branch_id") REFERENCES "branch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_actor_user_id_fkey" FOREIGN KEY ("org_id", "actor_user_id") REFERENCES "app_user"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_base_currency_fkey" FOREIGN KEY ("base_currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_quote_currency_fkey" FOREIGN KEY ("quote_currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item" ADD CONSTRAINT "item_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_of_material" ADD CONSTRAINT "bill_of_material_org_id_product_item_id_fkey" FOREIGN KEY ("org_id", "product_item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_line" ADD CONSTRAINT "bom_line_org_id_bom_id_fkey" FOREIGN KEY ("org_id", "bom_id") REFERENCES "bill_of_material"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_line" ADD CONSTRAINT "bom_line_org_id_material_item_id_fkey" FOREIGN KEY ("org_id", "material_item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_org_id_branch_id_fkey" FOREIGN KEY ("org_id", "branch_id") REFERENCES "branch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_org_id_customer_id_fkey" FOREIGN KEY ("org_id", "customer_id") REFERENCES "customer"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_org_id_sales_order_id_fkey" FOREIGN KEY ("org_id", "sales_order_id") REFERENCES "sales_order"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_org_id_item_id_fkey" FOREIGN KEY ("org_id", "item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job" ADD CONSTRAINT "production_job_org_id_branch_id_fkey" FOREIGN KEY ("org_id", "branch_id") REFERENCES "branch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job" ADD CONSTRAINT "production_job_org_id_sales_order_line_id_fkey" FOREIGN KEY ("org_id", "sales_order_line_id") REFERENCES "sales_order_line"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job" ADD CONSTRAINT "production_job_org_id_customer_id_fkey" FOREIGN KEY ("org_id", "customer_id") REFERENCES "customer"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job" ADD CONSTRAINT "production_job_org_id_product_item_id_fkey" FOREIGN KEY ("org_id", "product_item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job" ADD CONSTRAINT "production_job_org_id_bom_id_fkey" FOREIGN KEY ("org_id", "bom_id") REFERENCES "bill_of_material"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requirement" ADD CONSTRAINT "material_requirement_org_id_job_id_fkey" FOREIGN KEY ("org_id", "job_id") REFERENCES "production_job"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requirement" ADD CONSTRAINT "material_requirement_org_id_material_item_id_fkey" FOREIGN KEY ("org_id", "material_item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour_record" ADD CONSTRAINT "labour_record_org_id_job_id_fkey" FOREIGN KEY ("org_id", "job_id") REFERENCES "production_job"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage_template" ADD CONSTRAINT "production_stage_template_org_id_product_item_id_fkey" FOREIGN KEY ("org_id", "product_item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job_stage" ADD CONSTRAINT "production_job_stage_org_id_job_id_fkey" FOREIGN KEY ("org_id", "job_id") REFERENCES "production_job"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_record" ADD CONSTRAINT "quality_record_org_id_job_id_fkey" FOREIGN KEY ("org_id", "job_id") REFERENCES "production_job"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_record" ADD CONSTRAINT "quality_record_org_id_job_stage_id_fkey" FOREIGN KEY ("org_id", "job_stage_id") REFERENCES "production_job_stage"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_org_id_branch_id_fkey" FOREIGN KEY ("org_id", "branch_id") REFERENCES "branch"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_org_id_item_id_fkey" FOREIGN KEY ("org_id", "item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_org_id_warehouse_id_fkey" FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "warehouse"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_org_id_item_id_fkey" FOREIGN KEY ("org_id", "item_id") REFERENCES "item"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_org_id_warehouse_id_fkey" FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "warehouse"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_cost_estimate" ADD CONSTRAINT "job_cost_estimate_org_id_job_id_fkey" FOREIGN KEY ("org_id", "job_id") REFERENCES "production_job"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_cost_actual" ADD CONSTRAINT "job_cost_actual_org_id_job_id_fkey" FOREIGN KEY ("org_id", "job_id") REFERENCES "production_job"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
