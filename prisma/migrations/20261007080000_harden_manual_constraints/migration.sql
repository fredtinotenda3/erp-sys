-- ============================================================================
-- Hardening migration — closes Finding 1 and Finding 2 of
-- docs/AUDIT_PHASE0_POSTSETUP.md (see that file's "Hardening Addendum"
-- section for the full writeup).
--
-- WHY THIS IS A NEW MIGRATION, NOT AN EDIT TO
-- 20261007062213_manual_constraints:
-- That migration is already recorded as applied in your database's
-- _prisma_migrations table, which stores a checksum of the migration file's
-- content at apply time. Editing an already-applied migration's SQL in
-- place doesn't undo anything in the database (it was a no-op empty file),
-- but it does make the on-disk file's checksum stop matching the recorded
-- one — `prisma migrate status`/`migrate deploy` will then report that
-- migration as "modified after it was applied," which is exactly the kind
-- of migration-history inconsistency the brief asked to avoid. Rolling
-- forward with a new migration is the standard, safe fix; the empty one
-- stays exactly as applied, as a historical record of the gap this migration
-- closes.
--
-- WHY NO ROLE/GRANT STATEMENTS APPEAR HERE:
-- Every object below is schema DDL — functions, triggers, constraints,
-- an index, a generated column, two views. None of it requires or
-- references a specific role name, so it is safe to run via `prisma
-- migrate` regardless of whether the mops_migrator/mops_runtime role split
-- (docs/db-roles-and-security.sql) has been set up yet, has been verified,
-- or ever happens at all:
--   - CHECK constraints, the partial unique index, and the generated column
--     need no privileges beyond normal DDL rights on your own tables.
--   - trg_stock_movement_before_insert() is SECURITY DEFINER, which makes
--     it run with the privileges of whichever role OWNS the function —
--     that's automatically whichever role runs this migration (your
--     MIGRATION_DATABASE_URL role), so it's correctly set up for the
--     mops_runtime/mops_migrator split the moment that split exists, and
--     harmless (a no-op privilege difference) if it doesn't yet.
--   - prevent_mutation() and its four triggers block UPDATE/DELETE for
--     EVERY role, including the table owner — that's enforced by the
--     function body (RAISE EXCEPTION unconditionally), not by a GRANT, so
--     it needs no role to exist first either.
-- GRANT statements that target a specific role name (mops_runtime) stay in
-- docs/db-roles-and-security.sql, run manually — see that file's updated
-- header note for why, and Section 4 of the hardening addendum.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Exactly one ACTIVE BillOfMaterial per product.
--    (SETUP_COMMANDS.md Section 5a, item 1 — unchanged from the original
--    spec, just finally applied.)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX uq_bom_one_active_per_product
  ON bill_of_material (product_item_id) WHERE (status = 'active');

-- ---------------------------------------------------------------------------
-- 2. app_user.email must be lowercase — DB-level backstop. The application
--    already lowercases on every write via zod (.toLowerCase()) on the
--    create/login paths; this is belt-and-suspenders, not the only guard.
--    (SETUP_COMMANDS.md Section 5a, item 2.)
-- ---------------------------------------------------------------------------
ALTER TABLE app_user
  ADD CONSTRAINT app_user_email_lowercase CHECK (email = lower(email));

-- ---------------------------------------------------------------------------
-- 3. Numeric / business-rule CHECK constraints Prisma cannot express.
--    Finding 2 of the audit, re-verified against docs/schema.sql line by
--    line before writing this: 9 tables, 11 individual CHECK clauses
--    (sales_order_line and labour_record each carry two). Every
--    status/type column already has a native Postgres enum type from the
--    init migration — these are specifically the ones that don't.
--    All nine tables below have zero rows today (no Phase 1 code writes to
--    them), so every ALTER TABLE in this section is instantaneous — no
--    table lock of consequence, no backfill, safe at any time.
-- ---------------------------------------------------------------------------
ALTER TABLE item
  ADD CONSTRAINT item_sellable_requires_price
    CHECK (NOT is_sellable OR selling_price IS NOT NULL);

ALTER TABLE bom_line
  ADD CONSTRAINT bom_line_quantity_positive
    CHECK (quantity > 0);

ALTER TABLE sales_order_line
  ADD CONSTRAINT sales_order_line_quantity_positive
    CHECK (quantity > 0),
  ADD CONSTRAINT sales_order_line_unit_price_nonnegative
    CHECK (unit_price >= 0);

ALTER TABLE production_job
  ADD CONSTRAINT production_job_planned_qty_positive
    CHECK (planned_qty > 0);

ALTER TABLE material_requirement
  ADD CONSTRAINT material_requirement_expected_qty_nonnegative
    CHECK (expected_qty >= 0);

ALTER TABLE labour_record
  ADD CONSTRAINT labour_record_hours_positive
    CHECK (hours > 0),
  ADD CONSTRAINT labour_record_rate_nonnegative
    CHECK (rate >= 0);

ALTER TABLE quality_record
  ADD CONSTRAINT quality_record_qty_consistency
    CHECK (accepted_qty + rejected_qty <= produced_qty);

ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_quantity_nonzero
    CHECK (quantity <> 0);

ALTER TABLE exchange_rate
  ADD CONSTRAINT exchange_rate_rate_positive
    CHECK (rate > 0);

-- ---------------------------------------------------------------------------
-- 4. Weighted-average stock costing + negative-stock blocking + currency-mix
--    blocking + branch/warehouse consistency. Copied verbatim from
--    docs/schema.sql / SETUP_COMMANDS.md Section 5a, item 3 — not
--    rewritten. SECURITY DEFINER is load-bearing: see the comment inline
--    and ARCHITECTURE.md's Phase 0 Addendum ("Finding from verification").
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_stock_movement_before_insert() RETURNS trigger
SECURITY DEFINER SET search_path = public AS $$
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

-- ---------------------------------------------------------------------------
-- 5. Generated column: gross profit on the immutable job-completion
--    snapshot. (SETUP_COMMANDS.md Section 5a, item 4.)
-- ---------------------------------------------------------------------------
ALTER TABLE job_cost_actual
  ADD COLUMN gross_profit numeric(14,4) GENERATED ALWAYS AS (
    revenue - (actual_material_cost + coalesce(actual_labour_cost,0) + coalesce(actual_overhead_cost,0))
  ) STORED;

-- ---------------------------------------------------------------------------
-- 6. Live (in-progress) job cost views — ALWAYS grouped by currency, never
--    summed across currencies. Read via $queryRaw; not modeled in
--    schema.prisma by design (see that file's header). (SETUP_COMMANDS.md
--    Section 5a, item 5.)
-- ---------------------------------------------------------------------------
CREATE VIEW job_material_cost_live AS
SELECT
  sm.reference_id AS job_id,
  sm.currency,
  SUM(sm.quantity * sm.unit_cost) * -1 AS material_cost
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

-- ---------------------------------------------------------------------------
-- 7. Append-only / immutability enforcement on the four ledger-like tables.
--    MOVED HERE from docs/db-roles-and-security.sql Stage 3, where it was
--    previously bundled together with role GRANTs. This part is pure schema
--    DDL (a function that unconditionally raises, and triggers wired to
--    it) — it has nothing to do with which role is connected, so it
--    belongs in the versioned migration chain, not the manual role-setup
--    script. See docs/db-roles-and-security.sql's updated header and
--    docs/AUDIT_PHASE0_POSTSETUP.md's Hardening Addendum, Section 4, for
--    the full "what stays manual vs. what's migration-managed" reasoning.
--
--    This is the fix for the audit's single highest-severity finding:
--    before this, audit_log had no technical enforcement of its
--    append-only property — it was an ordinary mutable table the
--    application simply chose not to update. After this, the database
--    itself refuses, regardless of which role is connected, including the
--    schema owner.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted — % is immutable/append-only. Insert an offsetting or compensating row instead.',
    TG_OP, TG_TABLE_NAME, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_movement_immutable
  BEFORE UPDATE OR DELETE ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_exchange_rate_immutable
  BEFORE UPDATE OR DELETE ON exchange_rate
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER trg_job_cost_actual_immutable
  BEFORE UPDATE OR DELETE ON job_cost_actual
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
