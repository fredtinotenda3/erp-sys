-- ============================================================================
-- Manufacturing Operations Intelligence Platform — Schema (Phase 0, revised
-- per approval notes of 2026-10-06)
-- PostgreSQL 16+ (uses gen_random_uuid(), generated columns, partial indexes,
-- composite foreign keys, row locking in trigger functions)
--
-- Tables are tagged:
--   -- FIRST SLICE   -> needed to stand up the job-costing slice
--   -- LATER PHASE   -> modeled now for the ERD, not built in the first slice
--
-- CHANGELOG vs the originally approved draft (see ARCHITECTURE.md "Phase 0
-- Addendum" for the reasoning behind each):
--   1. (Prisma-side only — see prisma/schema.prisma)
--   2. citext removed. app_user.email is now `text`, lowercased by the
--      application before every write/lookup, enforced by a CHECK.
--   3. (tooling, not schema — see SETUP_COMMANDS.md)
--   4. Every status/type column is now CHECK-constrained; previously
--      production_job.status, production_job_stage.status,
--      stock_movement.reference_type, audit_log.action and
--      exchange_rate.source were plain text with no constraint.
--   5. client_request_id uniqueness is now composite (org_id, client_request_id)
--      on every table that has one, not a bare global UNIQUE.
--   6. See docs/db-roles-and-security.sql — migration vs runtime roles, and
--      triggers that block UPDATE/DELETE on stock_movement, audit_log,
--      exchange_rate, job_cost_actual regardless of which role is connected.
--   7. org_id is now present on every operational table and enforced via
--      composite foreign keys against (org_id, id) on the referenced parent
--      — a child row's org_id literally cannot disagree with its parent's.
--      stock_movement gains a direct branch_id, validated against its
--      warehouse's branch_id by trigger.
--   8. The old single job_cost_actual_live view (which summed
--      quantity*unit_cost across potentially different currencies) is
--      replaced by two views grouped by currency — see COSTING section.
--   9. stock_balance now tracks a weighted-average unit cost, maintained by
--      a BEFORE INSERT trigger that also blocks negative stock and blocks a
--      receipt from mixing a second currency into an existing cost basis.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid(); built into PG13+, harmless either way

-- ----------------------------------------------------------------------------
-- Helper: updated_at trigger, reused by every mutable table
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- IAM / TENANCY                                                 -- FIRST SLICE
-- (this section — through audit_log — is what Phase 1 actually implements;
--  everything after it remains a Phase 0 design artifact for later phases)
-- ============================================================================

CREATE TABLE organization (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  base_currency char(3) NOT NULL,            -- FK added after currency table exists
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_organization_updated BEFORE UPDATE ON organization FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE branch (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (org_id, id)                         -- lets children do composite FK (org_id, branch_id) -> branch(org_id, id)
);
CREATE TRIGGER trg_branch_updated BEFORE UPDATE ON branch FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE app_user (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  email           text NOT NULL,              -- lowercased by the application before every write/read; see CHECK below
  password_hash   text NOT NULL,              -- argon2id, via @node-rs/argon2
  full_name       text NOT NULL,
  role            text NOT NULL CHECK (role IN (
                    'OWNER_ADMIN','OPERATIONS_MANAGER','PRODUCTION_MANAGER',
                    'INVENTORY_MANAGER','PRODUCTION_OPERATOR','FINANCE_MANAGER','VIEWER')),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email),
  UNIQUE (org_id, id),
  CHECK (email = lower(email))                -- the DB itself rejects a non-lowercased email, not just app discipline
);
CREATE TRIGGER trg_app_user_updated BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_branch_access (
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  user_id     uuid NOT NULL,
  branch_id   uuid NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid REFERENCES app_user(id),
  PRIMARY KEY (user_id, branch_id),
  FOREIGN KEY (org_id, user_id)   REFERENCES app_user (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, branch_id) REFERENCES branch   (org_id, id) ON DELETE CASCADE
);
-- NOTE: OWNER_ADMIN implicit all-branch access is enforced in application
-- code (authz.ts / scope.ts), not via rows here — this table only holds
-- EXPLICIT grants for every other role. See ARCHITECTURE.md Section 15, Q4
-- (answered: implicit).

CREATE TABLE user_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  user_id       uuid NOT NULL,
  token_hash    text NOT NULL UNIQUE,         -- sha256 of the opaque cookie token; the raw token is never stored
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip_address    inet,
  user_agent    text,
  FOREIGN KEY (org_id, user_id) REFERENCES app_user (org_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_user_session_user ON user_session(user_id) WHERE revoked_at IS NULL;

CREATE TABLE audit_log (                       -- append-only; see db-roles-and-security.sql for the immutability trigger
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  branch_id     uuid,
  actor_user_id uuid,
  entity_type   text NOT NULL,                -- intentionally free text: polymorphic over every entity kind in the
                                                -- system, including ones not yet modeled (future phases); constraining
                                                -- it to a fixed enum here would mean editing this table's constraint
                                                -- every time a new module ships, which defeats the point of an
                                                -- append-only audit trail outliving the schema around it.
  entity_id     uuid NOT NULL,
  action        text NOT NULL CHECK (action IN ('create','update','delete','transition','grant','revoke')),
  before_value  jsonb,
  after_value   jsonb,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, branch_id)     REFERENCES branch   (org_id, id), -- NULL branch_id skips this check (org-wide actions)
  FOREIGN KEY (org_id, actor_user_id) REFERENCES app_user (org_id, id)  -- NULL actor skips this check (system actions)
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_org_time ON audit_log(org_id, created_at DESC);

-- ============================================================================
-- CURRENCY                                                      -- FIRST SLICE
-- Intentionally NOT org-scoped: exchange rates are platform-wide reference
-- data, not something each tenant maintains independently. See
-- ARCHITECTURE.md Section 15, Q3 (answered: single source, tracked via the
-- `source` column for provenance even though only one is populated for now).
-- ============================================================================

CREATE TABLE currency (
  code      char(3) PRIMARY KEY,
  name      text NOT NULL,
  decimals  smallint NOT NULL DEFAULT 2
);

ALTER TABLE organization
  ADD CONSTRAINT fk_org_base_currency FOREIGN KEY (base_currency) REFERENCES currency(code);

CREATE TABLE exchange_rate (                   -- append-only: a new rate is a new row, never an UPDATE
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency   char(3) NOT NULL REFERENCES currency(code),
  quote_currency  char(3) NOT NULL REFERENCES currency(code),
  rate            numeric(18,8) NOT NULL CHECK (rate > 0),
  as_of_date      date NOT NULL,
  source          text NOT NULL CHECK (source IN ('RBZ_OFFICIAL','MARKET','MANUAL')),
  recorded_by     uuid REFERENCES app_user(id),
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_exchange_rate_lookup ON exchange_rate(base_currency, quote_currency, source, as_of_date DESC);

-- ============================================================================
-- CATALOG — unified Item (approved: Section 15 Q1 = yes)      -- LATER PHASE
-- (Phase 1 does not touch this section — included for ERD completeness and
--  so later phases build on a schema already hardened the same way.)
-- ============================================================================

CREATE TABLE item (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  sku                    text NOT NULL,
  name                   text NOT NULL,
  description            text,
  uom                    text NOT NULL,         -- free text in V1 by design; not a status/type field in the Section 4 sense
  item_type              text NOT NULL CHECK (item_type IN (
                           'raw_material','consumable','spare_part','finished_good','wip')),
  is_sellable            boolean NOT NULL DEFAULT false,
  selling_price          numeric(14,4),
  selling_price_currency char(3) REFERENCES currency(code),
  standard_cost          numeric(14,4),
  standard_cost_currency char(3) REFERENCES currency(code),
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, sku),
  UNIQUE (org_id, id),
  CHECK (NOT is_sellable OR selling_price IS NOT NULL)
);
CREATE TRIGGER trg_item_updated BEFORE UPDATE ON item FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE bill_of_material (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  product_item_id  uuid NOT NULL,
  version          integer NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded')),
  effective_from   date,
  created_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_item_id, version),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, product_item_id) REFERENCES item (org_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_bom_one_active_per_product
  ON bill_of_material (product_item_id) WHERE (status = 'active');

CREATE TABLE bom_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  bom_id           uuid NOT NULL,
  material_item_id uuid NOT NULL,
  quantity         numeric(14,4) NOT NULL CHECK (quantity > 0),
  uom              text NOT NULL,
  FOREIGN KEY (org_id, bom_id)           REFERENCES bill_of_material (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, material_item_id) REFERENCES item             (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_bom_line_bom ON bom_line(bom_id);

-- ============================================================================
-- SALES                                                         -- LATER PHASE
-- ============================================================================

CREATE TABLE customer (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  contact     text,
  address     text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
-- org-scoped, not branch-scoped — approved: Section 15 Q5 = org-wide.
CREATE TRIGGER trg_customer_updated BEFORE UPDATE ON customer FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sales_order (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL,
  branch_id               uuid NOT NULL,
  order_number            text NOT NULL,
  customer_id             uuid NOT NULL,
  status                  text NOT NULL DEFAULT 'draft' CHECK (status IN (
                            'draft','confirmed','in_production','partially_delivered','delivered','closed','cancelled')),
  currency                char(3) NOT NULL REFERENCES currency(code),
  requested_delivery_date date,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, order_number),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, branch_id)   REFERENCES branch   (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_sales_order_updated BEFORE UPDATE ON sales_order FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sales_order_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  sales_order_id   uuid NOT NULL,
  item_id          uuid NOT NULL,
  quantity         numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit_price       numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  currency         char(3) NOT NULL REFERENCES currency(code),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, sales_order_id) REFERENCES sales_order (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, item_id)        REFERENCES item        (org_id, id) ON DELETE RESTRICT
);

-- ============================================================================
-- PRODUCTION                                                    -- LATER PHASE
-- ============================================================================

CREATE TABLE production_job (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL,
  branch_id             uuid NOT NULL,
  job_number            text NOT NULL,
  sales_order_line_id   uuid,
  customer_id           uuid,
  product_item_id       uuid NOT NULL,
  bom_id                uuid NOT NULL,          -- snapshot, never repointed when the BOM changes later
  planned_qty           numeric(14,4) NOT NULL CHECK (planned_qty > 0),
  planned_start         date,
  planned_end           date,
  actual_start          timestamptz,
  actual_end            timestamptz,
  status                text NOT NULL DEFAULT 'planned' CHECK (status IN (
                          'planned','released','in_progress','on_hold','completed','closed','cancelled')),
  quoted_amount         numeric(14,4),
  quoted_currency       char(3) REFERENCES currency(code),
  created_by            uuid REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, job_number),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, branch_id)           REFERENCES branch           (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, sales_order_line_id) REFERENCES sales_order_line (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, customer_id)         REFERENCES customer         (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, product_item_id)     REFERENCES item             (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, bom_id)              REFERENCES bill_of_material (org_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER trg_job_updated BEFORE UPDATE ON production_job FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_job_branch_status ON production_job(branch_id, status);

CREATE TABLE material_requirement (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  job_id           uuid NOT NULL,
  material_item_id uuid NOT NULL,
  expected_qty     numeric(14,4) NOT NULL CHECK (expected_qty >= 0),
  uom              text NOT NULL,
  FOREIGN KEY (org_id, job_id)           REFERENCES production_job (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, material_item_id) REFERENCES item           (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_material_req_job ON material_requirement(job_id);

CREATE TABLE labour_record (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  job_id             uuid NOT NULL,
  user_id            uuid,
  hours              numeric(8,2) NOT NULL CHECK (hours > 0),
  rate               numeric(14,4) NOT NULL CHECK (rate >= 0),
  rate_currency      char(3) NOT NULL REFERENCES currency(code),
  client_request_id  uuid,                      -- idempotency for offline sync — see composite UNIQUE below
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, job_id)  REFERENCES production_job (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, user_id) REFERENCES app_user        (org_id, id),
  UNIQUE (org_id, client_request_id)
);
CREATE INDEX idx_labour_job ON labour_record(job_id);

CREATE TABLE production_stage_template (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  product_item_id uuid,                          -- null = org-default routing
  stage_name      text NOT NULL,
  sequence        integer NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, product_item_id) REFERENCES item (org_id, id) ON DELETE CASCADE
);

CREATE TABLE production_job_stage (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  job_id             uuid NOT NULL,
  stage_name         text NOT NULL,
  sequence           integer NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
  started_at         timestamptz,
  completed_at       timestamptz,
  operator_user_id   uuid,
  qty_processed      numeric(14,4) DEFAULT 0,
  qty_rejected       numeric(14,4) DEFAULT 0,
  notes              text,
  client_request_id  uuid,
  UNIQUE (org_id, id),
  UNIQUE (org_id, client_request_id),
  FOREIGN KEY (org_id, job_id)           REFERENCES production_job (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, operator_user_id) REFERENCES app_user        (org_id, id)
);

CREATE TABLE quality_record (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  job_id             uuid NOT NULL,
  job_stage_id       uuid,
  produced_qty       numeric(14,4) NOT NULL,
  accepted_qty       numeric(14,4) NOT NULL,
  rejected_qty       numeric(14,4) NOT NULL,
  reject_reason      text CHECK (reject_reason IN (
                       'wrong_dimensions','damaged','paint_defect','missing_component','other')),
  notes              text,
  evidence_ref       text,
  client_request_id  uuid,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (accepted_qty + rejected_qty <= produced_qty),
  UNIQUE (org_id, client_request_id),
  FOREIGN KEY (org_id, job_id)       REFERENCES production_job       (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, job_stage_id) REFERENCES production_job_stage (org_id, id)
);

-- ============================================================================
-- INVENTORY                                                     -- LATER PHASE
-- ============================================================================

CREATE TABLE warehouse (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  branch_id  uuid NOT NULL,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, name),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, branch_id) REFERENCES branch (org_id, id) ON DELETE RESTRICT
);

CREATE TABLE stock_movement (                  -- IMMUTABLE LEDGER — see db-roles-and-security.sql
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  branch_id          uuid NOT NULL,             -- denormalized from warehouse.branch_id, validated by trigger below
  item_id            uuid NOT NULL,
  warehouse_id       uuid NOT NULL,
  movement_type      text NOT NULL CHECK (movement_type IN (
                       'purchase_receipt','material_issue','material_return','production_consumption',
                       'finished_goods_receipt','sale_delivery','adjustment',
                       'stock_transfer_out','stock_transfer_in')),
  quantity           numeric(14,4) NOT NULL,     -- signed: receipts/returns positive, issues/consumption/sales negative
  unit_cost          numeric(14,4),              -- required on positive movements; system-stamped on negative ones (see trigger)
  currency           char(3) REFERENCES currency(code),
  reference_type     text CHECK (reference_type IN ('production_job','purchase_order','sales_order','manual')),
  reference_id       uuid,
  reason             text,                        -- required by app layer for 'adjustment', optional otherwise
  client_request_id  uuid,                         -- idempotency for offline sync — composite UNIQUE below
  created_by         uuid,
  occurred_at        timestamptz NOT NULL DEFAULT now(), -- client-asserted time (shop-floor ordering)
  synced_at          timestamptz NOT NULL DEFAULT now(), -- server receipt time (audit-authoritative)
  CHECK (quantity <> 0),
  UNIQUE (org_id, client_request_id),
  FOREIGN KEY (org_id, branch_id)   REFERENCES branch   (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, item_id)     REFERENCES item     (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, warehouse_id) REFERENCES warehouse (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, created_by)  REFERENCES app_user  (org_id, id)
);
CREATE INDEX idx_stock_movement_item_wh ON stock_movement(item_id, warehouse_id, occurred_at);
CREATE INDEX idx_stock_movement_reference ON stock_movement(reference_type, reference_id);

CREATE TABLE stock_balance (                   -- derived cache, maintained ONLY by the trigger below
  org_id                      uuid NOT NULL,
  item_id                     uuid NOT NULL,
  warehouse_id                uuid NOT NULL,
  quantity                    numeric(14,4) NOT NULL DEFAULT 0,
  average_unit_cost           numeric(14,4),   -- weighted average cost basis; NULL until the first receipt
  average_unit_cost_currency  char(3) REFERENCES currency(code),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, warehouse_id),
  FOREIGN KEY (org_id, item_id)      REFERENCES item      (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, warehouse_id) REFERENCES warehouse (org_id, id) ON DELETE RESTRICT
);

-- Weighted-average costing + negative-stock blocking + currency-mixing
-- blocking + branch_id consistency, all enforced here rather than trusted to
-- application code. BEFORE INSERT (not AFTER) because it needs to both
-- validate the incoming row and, for consumption-type movements, OVERWRITE
-- NEW.unit_cost / NEW.currency with the system's own cost basis before the
-- row is actually written — the caller does not get to assert a consumption
-- cost, only a receipt cost (the real purchase/production price).
CREATE OR REPLACE FUNCTION trg_stock_movement_before_insert() RETURNS trigger
SECURITY DEFINER SET search_path = public AS $$
-- SECURITY DEFINER is load-bearing, not incidental: mops_runtime is granted
-- only SELECT on stock_balance (see db-roles-and-security.sql — the app must
-- never write that table directly). This function needs to read-and-lock
-- (FOR UPDATE) and then write stock_balance on mops_runtime's behalf. A
-- plain function runs with the CALLER's privileges by default (SECURITY
-- INVOKER) — without this clause, every INSERT on stock_movement from the
-- application would fail with "permission denied for table stock_balance",
-- which is exactly what happened the first time this was tested against the
-- real mops_runtime role (see ARCHITECTURE.md Phase 0 Addendum). SET
-- search_path pins it against search_path hijacking, standard practice for
-- any SECURITY DEFINER function.
DECLARE
  warehouse_branch_id uuid;
  current_qty         numeric(14,4);
  current_avg_cost    numeric(14,4);
  current_avg_ccy     char(3);
  new_qty             numeric(14,4);
BEGIN
  SELECT branch_id INTO warehouse_branch_id FROM warehouse WHERE id = NEW.warehouse_id;
  IF warehouse_branch_id IS NULL THEN
    RAISE EXCEPTION 'warehouse % does not exist', NEW.warehouse_id;
  END IF;
  IF NEW.branch_id IS DISTINCT FROM warehouse_branch_id THEN
    RAISE EXCEPTION 'stock_movement.branch_id (%) does not match warehouse %''s branch (%)',
      NEW.branch_id, NEW.warehouse_id, warehouse_branch_id;
  END IF;

  -- Lock the balance row to serialize concurrent movements against the same
  -- item/warehouse (avoids lost-update races on both the weighted-average
  -- recomputation and the negative-stock check below).
  SELECT quantity, average_unit_cost, average_unit_cost_currency
    INTO current_qty, current_avg_cost, current_avg_ccy
  FROM stock_balance
  WHERE item_id = NEW.item_id AND warehouse_id = NEW.warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    current_qty := 0;
    current_avg_cost := NULL;
    current_avg_ccy := NULL;
    INSERT INTO stock_balance (org_id, item_id, warehouse_id, quantity, average_unit_cost, average_unit_cost_currency)
    VALUES (NEW.org_id, NEW.item_id, NEW.warehouse_id, 0, NULL, NULL);
  END IF;

  IF NEW.quantity > 0 THEN
    -- Receipt-type movement: the caller supplies the real unit_cost (purchase
    -- price, job-actual finished-goods cost, transferred-in cost basis, ...).
    IF NEW.unit_cost IS NULL THEN
      RAISE EXCEPTION 'unit_cost is required for a positive stock_movement (movement_type=%)', NEW.movement_type;
    END IF;
    IF current_qty <= 0 OR current_avg_cost IS NULL THEN
      current_avg_cost := NEW.unit_cost;
      current_avg_ccy := NEW.currency;
    ELSE
      IF current_avg_ccy IS NOT NULL AND NEW.currency IS NOT NULL AND current_avg_ccy <> NEW.currency THEN
        RAISE EXCEPTION 'item % in warehouse % has an existing % cost basis; a % receipt cannot be averaged into it — '
          'convert to % using a recorded exchange rate before posting, or record this as a separate cost basis once '
          'multi-currency valuation is supported', NEW.item_id, NEW.warehouse_id, current_avg_ccy, NEW.currency, current_avg_ccy;
      END IF;
      current_avg_cost := ((current_qty * current_avg_cost) + (NEW.quantity * NEW.unit_cost)) / (current_qty + NEW.quantity);
    END IF;
  ELSE
    -- Consumption-type movement (negative quantity): the SYSTEM is the
    -- authority on cost, not the caller. Stamp unit_cost/currency from the
    -- current weighted average, overriding anything the caller passed.
    IF current_avg_cost IS NULL THEN
      RAISE EXCEPTION 'cannot consume item % from warehouse %: no cost basis exists yet (no prior receipt recorded)',
        NEW.item_id, NEW.warehouse_id;
    END IF;
    NEW.unit_cost := current_avg_cost;
    NEW.currency := current_avg_ccy;
  END IF;

  new_qty := current_qty + NEW.quantity;

  IF new_qty < 0 THEN
    RAISE EXCEPTION 'movement would take item % in warehouse % negative (current %, movement % of type %): '
      'negative stock is blocked', NEW.item_id, NEW.warehouse_id, current_qty, NEW.quantity, NEW.movement_type;
  END IF;

  UPDATE stock_balance
  SET quantity = new_qty,
      average_unit_cost = current_avg_cost,
      average_unit_cost_currency = current_avg_ccy,
      updated_at = now()
  WHERE item_id = NEW.item_id AND warehouse_id = NEW.warehouse_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_movement_before_insert
  BEFORE INSERT ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION trg_stock_movement_before_insert();

-- Reconciliation check (periodic job / integration test, not a live
-- constraint — summing the full ledger on every write would be wasteful;
-- this is the query that proves the derived cache matches the ledger):
--   SELECT sb.item_id, sb.warehouse_id, sb.quantity, s.sum_qty
--   FROM stock_balance sb
--   JOIN (SELECT item_id, warehouse_id, SUM(quantity) sum_qty
--         FROM stock_movement GROUP BY item_id, warehouse_id) s
--     ON s.item_id = sb.item_id AND s.warehouse_id = sb.warehouse_id
--   WHERE sb.quantity <> s.sum_qty;
-- Expected result: zero rows, always.

-- ============================================================================
-- COSTING                                                       -- LATER PHASE
-- ============================================================================

CREATE TABLE job_cost_estimate (
  org_id                  uuid NOT NULL,
  job_id                  uuid PRIMARY KEY,
  estimated_material_cost numeric(14,4) NOT NULL,
  estimated_labour_cost   numeric(14,4),
  estimated_overhead_cost numeric(14,4),
  currency                char(3) NOT NULL REFERENCES currency(code),
  computed_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, job_id) REFERENCES production_job (org_id, id) ON DELETE RESTRICT
);

CREATE TABLE job_cost_actual (                 -- written ONCE, at job completion — immutable after that (see security.sql)
  org_id                uuid NOT NULL,
  job_id                uuid PRIMARY KEY,
  actual_material_cost  numeric(14,4) NOT NULL,
  actual_labour_cost    numeric(14,4),
  actual_overhead_cost  numeric(14,4),
  currency              char(3) NOT NULL REFERENCES currency(code),
  exchange_rate_id      uuid REFERENCES exchange_rate(id), -- set only if a cross-currency conversion was needed to reach `currency`
  revenue               numeric(14,4),
  gross_profit          numeric(14,4) GENERATED ALWAYS AS (
                           revenue - (actual_material_cost + coalesce(actual_labour_cost,0) + coalesce(actual_overhead_cost,0))
                         ) STORED,
  snapshotted_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, job_id) REFERENCES production_job (org_id, id) ON DELETE RESTRICT
);

-- Live (in-progress) cost, grouped by currency — NEVER summed across
-- currencies. A job with costs in more than one currency produces more than
-- one row here (one per currency actually used); the costing module
-- converts each bucket into the job's chosen currency using a specific,
-- recorded exchange_rate row before writing the immutable job_cost_actual
-- snapshot at completion. This view never performs that conversion itself.
CREATE VIEW job_material_cost_live AS
SELECT
  sm.reference_id AS job_id,
  sm.currency,
  SUM(sm.quantity * sm.unit_cost) * -1 AS material_cost -- consumption is stored negative; flip sign for a cost figure
FROM stock_movement sm
WHERE sm.reference_type = 'production_job'
  AND sm.movement_type = 'production_consumption'
GROUP BY sm.reference_id, sm.currency;

CREATE VIEW job_labour_cost_live AS
SELECT
  lr.job_id,
  lr.rate_currency AS currency,
  SUM(lr.hours * lr.rate) AS labour_cost
FROM labour_record lr
GROUP BY lr.job_id, lr.rate_currency;

-- ============================================================================
-- Suppliers / Procurement — Phase 6, intentionally not modeled yet.
-- ============================================================================

-- ============================================================================
-- Seed data suggestion (not run automatically — review before applying)
-- ============================================================================
-- INSERT INTO currency (code, name, decimals) VALUES
--   ('USD','United States Dollar', 2),
--   ('ZIG','Zimbabwe Gold', 2),
--   ('ZAR','South African Rand', 2);
