-- Suppliers: first milestone of the shared-core build-out (ARCHITECTURE.md's
-- "shared core before industry layer" sequencing note). Additive only — one
-- new table, no change to any existing data. Shaped identically to
-- `customer`: org-wide (no branch_id), soft-lifecycle via `status`, no
-- uniqueness constraint on `name` (see schema.prisma's comment on the
-- Supplier model for why that's deliberate, not an oversight).

-- Native enum type, matching every other Prisma enum in this schema
-- (e.g. "CustomerStatus" in the init migration) rather than TEXT + CHECK.
CREATE TYPE "SupplierStatus" AS ENUM ('active', 'inactive');

CREATE TABLE "supplier" (
  "id"         UUID             NOT NULL DEFAULT gen_random_uuid(),
  "org_id"     UUID             NOT NULL,
  "name"       TEXT             NOT NULL,
  "contact"    TEXT,
  "address"    TEXT,
  "status"     "SupplierStatus" NOT NULL DEFAULT 'active',
  "notes"      TEXT,
  "created_at" TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3)     NOT NULL,
  CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_org_id_id_key" ON "supplier"("org_id", "id");

ALTER TABLE "supplier"
  ADD CONSTRAINT "supplier_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The app's runtime role is created outside Prisma (docs/db-roles-and-security.sql), so grant only
-- when it exists, exactly like earlier migrations (e.g. 20261031100000_account_security). `supplier`
-- is ordinary CRUD data, not a ledger — full DML, no restriction.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON supplier TO mops_runtime;
  END IF;
END
$$;
