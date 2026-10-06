# Setup Commands — Phase 0 (revised) + Phase 1

Rewritten after Phase 0 approval to match the revised `schema.sql` /
`db-roles-and-security.sql` / `schema.prisma` (9 approved revisions — see
`ARCHITECTURE.md` "Phase 0 Addendum") and Prisma ORM 7's generator/adapter
model. **Supersedes the previous version of this file.** Exact,
copy-pasteable commands for Windows 10 / PowerShell / npm, in order.

Everything in this file has been run against a real local PostgreSQL 16
instance during development of this delivery, **except** the `npx prisma
migrate dev` step itself — the sandbox this was built in cannot reach
`binaries.prisma.sh` to download the Prisma engine binaries (network
policy, not a code issue). That step will run normally on your machine,
which has ordinary internet access. See "Known verification gap" in
`ARCHITECTURE.md`'s Phase 0 Addendum for the full explanation, and feel
free to paste back the generated `migration.sql` if you want it reviewed
before applying it to anything but a throwaway database.

---

## 1. PostgreSQL — install locally

**Recommended: native Windows installer** (simplest, no Docker/WSL2 dependency assumed).

1. Download PostgreSQL 16 from https://www.postgresql.org/download/windows/ (EnterpriseDB installer).
2. During install: remember the `postgres` superuser password you set. Keep the default port `5432`.
3. Add PostgreSQL's `bin` directory to PATH if the installer didn't — typically `C:\Program Files\PostgreSQL\16\bin` — so `psql` works from PowerShell.

**Alternative, if you already use Docker Desktop with WSL2 set up:**
```powershell
docker run --name mops-postgres -e POSTGRES_PASSWORD=devpassword -p 5432:5432 -d postgres:16
```

### 1a. Create the database (native install path)

```powershell
psql -U postgres
```
At the `postgres=#` prompt:
```sql
CREATE DATABASE mops_dev;
\q
```
(If using the Docker alternative, `mops_dev` doesn't exist yet either — run `psql -U postgres -h localhost -c "CREATE DATABASE mops_dev;"` instead, password `devpassword`.)

---

## 2. Create the two database roles and set ownership

This is revision #6 (separate migration-owner and runtime roles) — **do this before running any migration.** Connect as the `postgres` superuser:

```powershell
psql -U postgres -d mops_dev
```

Paste this (it's also preserved verbatim in `docs/db-roles-and-security.sql`, Stage 1 — **pick real passwords, not the placeholders shown**):

```sql
CREATE ROLE mops_migrator WITH LOGIN PASSWORD 'change-me-migrator-password' NOSUPERUSER CREATEDB;
CREATE ROLE mops_runtime  WITH LOGIN PASSWORD 'change-me-runtime-password'  NOSUPERUSER;

ALTER DATABASE mops_dev OWNER TO mops_migrator;
GRANT ALL ON SCHEMA public TO mops_migrator;
GRANT CONNECT ON DATABASE mops_dev TO mops_runtime;
GRANT USAGE ON SCHEMA public TO mops_runtime;
\q
```

Keep Stage 3 (grants to `mops_runtime` + immutability triggers) for after the schema exists — Section 5 below.

---

## 3. Install packages into the existing Next.js project

From your project root (where `package.json` already lives). **Versions are pinned exactly** — do not let `npm install prisma @prisma/client` float to `latest`; at the time this was written, the `prisma` CLI package's `latest` npm dist-tag resolves to an `8.0.0` release candidate while `@prisma/client`'s `latest` is still `7.10.0` stable, and an unpinned install would silently mix CLI/client majors:

```powershell
# ORM, Postgres driver, and the Prisma 7 driver adapter (required at runtime — see schema.prisma header)
npm install prisma@7.10.0 @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0 pg

# Validation at API boundaries. Pinned to a known-current 4.x — all
# zod calls in this delivery use only the chained `.email()`/`.uuid()`/
# `.length()` forms and `parsed.error.issues` (not the v3-only `.errors`
# alias, which v4 removed), both confirmed compatible with Zod v4.
npm install zod@4.4.3

# Password hashing — @node-rs/argon2 ships prebuilt native binaries, avoiding
# the node-gyp/Python/Visual Studio Build Tools toolchain the plain `argon2`
# package needs to compile on Windows.
npm install @node-rs/argon2

# Dev-only
npm install -D typescript tsx @types/node @types/pg vitest@3.2.4 dotenv
```

If `@node-rs/argon2` fails to install for any reason (unsupported platform/arch), fall back to `bcryptjs` (pure JS, zero native deps, slightly slower, still OWASP-acceptable) and flag it back to me — do not silently downgrade password hashing without noting it.

---

## 4. Environment variables

Copy `.env.example` (included in this delivery) to `.env` in your project root:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` and fill in the **same passwords you used in Section 2**:

```
MIGRATION_DATABASE_URL="postgresql://mops_migrator:change-me-migrator-password@localhost:5432/mops_dev?schema=public"
RUNTIME_DATABASE_URL="postgresql://mops_runtime:change-me-runtime-password@localhost:5432/mops_dev?schema=public"
SESSION_SECRET="<output of: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">"
```

Confirm `.env` is in `.gitignore` (Next.js's default `create-next-app` output already includes this) — never commit real credentials.

Also copy `prisma.config.ts` (included in this delivery) to your project root — Prisma 7 requires this file; it's how the CLI finds `MIGRATION_DATABASE_URL` and the schema/migrations paths (the `prisma` key in `package.json` that older Prisma versions used is gone in 7).

---

## 5. Apply the schema

Copy `prisma/schema.prisma` from this delivery into your project's `prisma/` folder.

```powershell
npx prisma migrate dev --name init
```

This connects using `MIGRATION_DATABASE_URL` (i.e. as `mops_migrator`), creates `prisma/migrations/<timestamp>_init/migration.sql`, applies it, and generates the Prisma Client into `src/generated/prisma` (per the `output` path in `schema.prisma`).

**If this fails with a checksum/download error** (`Failed to fetch sha256 checksum at https://binaries.prisma.sh/...`), that's your machine failing to reach Prisma's CDN, not a config problem — check your network/firewall/proxy allows `binaries.prisma.sh` and retry. This is the exact step that could not be exercised in the sandbox this was built in.

### 5a. Required manual SQL follow-up — objects Prisma can't express

Six things in the verified design (listed in `schema.prisma`'s header comment) aren't expressible in Prisma's schema language and need a hand-written follow-up migration. Create one:

```powershell
npx prisma migrate dev --create-only --name manual_constraints
```

Open the new (empty) `prisma/migrations/<timestamp>_manual_constraints/migration.sql` and paste the following **exactly as written** — this is not new SQL, it's copied verbatim from `docs/schema.sql` and `docs/db-roles-and-security.sql`, both of which were verified end-to-end against a real `mops_runtime` connection during development (see `ARCHITECTURE.md` Phase 0 Addendum for what that verification caught):

```sql
-- 1. Exactly one ACTIVE BillOfMaterial per product (schema.sql line ~218)
CREATE UNIQUE INDEX uq_bom_one_active_per_product
  ON bill_of_material (product_item_id) WHERE (status = 'active');

-- 2. email lowercase enforcement (schema.sql line ~92) — the app lowercases
--    on every write/lookup; this is the DB-level backstop, not the only guard.
ALTER TABLE app_user ADD CONSTRAINT app_user_email_lowercase CHECK (email = lower(email));

-- 3. Stock balance maintenance trigger — weighted-average costing,
--    negative-stock blocking, currency-mix blocking, branch/warehouse
--    consistency. SECURITY DEFINER is load-bearing (see comment inline) —
--    do not remove it, mops_runtime only has SELECT on stock_balance.
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

-- 4. Generated column: gross profit on the immutable job-completion snapshot
ALTER TABLE job_cost_actual
  ADD COLUMN gross_profit numeric(14,4) GENERATED ALWAYS AS (
    revenue - (actual_material_cost + coalesce(actual_labour_cost,0) + coalesce(actual_overhead_cost,0))
  ) STORED;

-- 5. Live (in-progress) job cost views — ALWAYS grouped by currency, never
--    summed across currencies. Read via $queryRaw; not modeled in schema.prisma.
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
```

Apply it:
```powershell
npx prisma migrate dev
```

---

## 6. Stage 3 — runtime grants + immutability triggers

Run **as the `postgres` superuser**, after Section 5's migrations have both been applied (the tables/views/trigger from Section 5 must already exist):

```powershell
psql -U postgres -d mops_dev -f docs/db-roles-and-security.sql
```

This is idempotent-safe to re-run (`CREATE OR REPLACE FUNCTION`), but note it does **not** re-run Stage 1 (role creation) — if you need to run it a second time after Stage 1 already succeeded, that's fine, the `GRANT`/`CREATE TRIGGER` statements will just reapply.

Sanity-check it worked — connect as `mops_runtime` and confirm it can insert but not update/delete the ledger:
```powershell
psql "postgresql://mops_runtime:change-me-runtime-password@localhost:5432/mops_dev" -c "UPDATE stock_movement SET quantity = 1 WHERE false;"
# expect: ERROR: UPDATE on stock_movement is not permitted — stock_movement is immutable/append-only.
```

---

## 7. Seed reference data

```powershell
psql -U mops_migrator -d mops_dev -c "INSERT INTO currency (code, name, decimals) VALUES ('USD','United States Dollar',2), ('ZIG','Zimbabwe Gold',2), ('ZAR','South African Rand',2);"
```
(Run as `mops_migrator`, not `mops_runtime` — `mops_runtime` intentionally has no INSERT grant on `currency`; org admins don't edit reference currency rows directly in V1.)

---

## 8. Phase 1 — run and test the application code

The Phase 1 deliverable (`src/server/shared/*`, `src/server/modules/iam/*`, `src/app/api/v1/*`) is included in this delivery. From your project root, with `.env` filled in as above:

```powershell
npm run dev
```

Tests (tenant and branch isolation, auth, audit log — see `src/server/modules/iam/__tests__/`) run against the same real Postgres database via `RUNTIME_DATABASE_URL`/`MIGRATION_DATABASE_URL`, not a mock:

```powershell
npx vitest run
```

The isolation tests create and tear down their own organizations/branches/users per test (no shared fixtures across test files) so they're safe to run repeatedly against your dev database, but **do not point `MIGRATION_DATABASE_URL`/`RUNTIME_DATABASE_URL` at anything you care about** while running them — they do real inserts and deletes scoped to their own test-created orgs.

---

## 9. npm audit — the 5 high-severity warnings

I don't have your actual audit output (no project zip was ever uploaded to this session — see `ARCHITECTURE.md` Section 0). Run:

```powershell
npm audit
npm audit --json > audit-report.json
```

Paste the text output back to me, or send me `audit-report.json`, and I'll tell you:
- Which specific packages and advisories.
- Whether they're reachable at runtime (most high-severity advisories in a fresh `create-next-app` tree are in build-time tooling — `eslint`/webpack-adjacent packages — not code that ships to users, which is a materially different risk).
- The minimal-diff fix — usually a targeted `npm install <package>@<safe-version>`, not a blanket `--force`.

**Do not run `npm audit fix --force` before I've seen the report** — on a Next.js 16 / React 19 project it can jump major versions of transitive dependencies (sometimes Next.js or React itself) and break the build.

---

## 10. What I have *not* done

- Not touched your existing `package.json`, `tsconfig.json`, `next.config.*`, or any other file already in your project — nothing in this delivery modifies files I never received; only new files are added/changed, listed in the delivery zip.
- Not run `npx prisma migrate dev` myself — confirmed network-blocked in my sandbox (see Section 5). Everything else in this file (the role setup, the manual-SQL follow-up, the grants script, the Vitest suite) **was** run and verified against a real local PostgreSQL 16 instance during development.
- Not built any frontend/UI — Phase 1 scope per your instruction was auth, org/branch/user/role, audit log, and the module skeleton only.
