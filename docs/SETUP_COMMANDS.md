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

**UPDATED 2026-10-07 — see `docs/AUDIT_PHASE0_POSTSETUP.md`'s Hardening Addendum for the full story.** The original version of this section said to create the `manual_constraints` migration and paste SQL into it. That migration was in fact created — and then, on the actual delivered database, left empty and applied as a no-op. The six-plus-eleven objects below were never applied anywhere. **Do not repeat that mistake by editing `prisma/migrations/20261007062213_manual_constraints/migration.sql` now that it's recorded as applied** — Prisma checksums each migration file at apply time, and editing an already-applied one makes `prisma migrate status`/`deploy` report it as "modified after it was applied," a migration-history inconsistency that's worse than the gap it would be fixing. Roll forward with a new migration instead:

```powershell
npx prisma migrate dev --create-only --name harden_manual_constraints
```

This creates a fresh, empty `prisma/migrations/<timestamp>_harden_manual_constraints/migration.sql`. Open it and paste the SQL block below **exactly as written** (it is copied verbatim from `docs/schema.sql` and `docs/db-roles-and-security.sql`, both verified end-to-end against a real `mops_runtime` connection during development — see `ARCHITECTURE.md`'s Phase 0 Addendum). It now has **three** parts, not the original's one: the five objects originally specified here, the nine tables' worth of CHECK constraints (eleven individual constraints) the audit found were never flagged at all, and the four append-only immutability triggers that used to live in `docs/db-roles-and-security.sql` (moved here because they're pure schema DDL with no dependency on which role is connected — see that file's updated header for why). The full, current content of this migration is maintained in this repository at `prisma/migrations/20261007080000_harden_manual_constraints/migration.sql` — copy it from there rather than retyping it.

Apply it:
```powershell
npx prisma migrate dev
```

---

## 6. Stage 3 — runtime grants

**UPDATED 2026-10-07:** this file's title used to say "+ immutability triggers" — those moved into the `harden_manual_constraints` migration (Section 5a) since they're schema DDL, not role-targeted grants. This step is now grants only.

Run **as your superuser-equivalent role** (on Neon: your project's default/owner role — see `docs/db-roles-and-security.sql`'s Neon note; there's no traditional `postgres` superuser login on Neon), after Section 5's migrations — including the hardening migration — have been applied:

```powershell
psql "<your superuser-equivalent connection string>" -d mops_dev -f docs/db-roles-and-security.sql
```

This is idempotent-safe to re-run (the function/trigger block it used to contain is gone; what's left is plain `GRANT`, which Postgres allows re-running), but note it does **not** re-run Stage 1 (role creation) — if you need to run it a second time after Stage 1 already succeeded, that's fine.

Sanity-check it worked — connect as `mops_runtime` and confirm it can insert but not update/delete the two tables that matter most (the inventory ledger, and the audit log — Finding 1 of the audit was specifically that `audit_log` had no enforcement here):
```powershell
psql "<mops_runtime connection string>" -c "UPDATE stock_movement SET quantity = 1 WHERE false;"
# expect: ERROR: permission denied for table stock_movement

psql "<mops_runtime connection string>" -c "UPDATE audit_log SET reason = 'tampered' WHERE false;"
# expect: ERROR: permission denied for table audit_log
```
**CORRECTED 2026-10-07 (caught by actually running this against a real database, not just reading the SQL):** the error text above is `permission denied for table ...`, not the `prevent_mutation()` trigger's own message — and that is the GRANT layer blocking the statement, which Postgres checks before row-level triggers run at all. Stage 3 deliberately never grants `mops_runtime` UPDATE/DELETE on these tables, so that check fails first and the trigger is never reached for this role. `WHERE false` reinforces this: even if it matched a real row, a statement-level permission failure happens regardless of which rows would match.

To see the `prevent_mutation()` trigger's own message fire — the second, independent layer, which exists so a future *accidental* `GRANT UPDATE` can't reopen these tables — you need a role that already has UPDATE/DELETE (e.g. `mops_migrator`, which owns every table) **and** a real matching row, since a `FOR EACH ROW` trigger body never runs over zero rows:
```powershell
psql "<mops_migrator connection string>" -c "INSERT INTO exchange_rate (base_currency, quote_currency, rate, as_of_date, source) VALUES ('USD','ZAR', 18.5, CURRENT_DATE, 'MANUAL');"
psql "<mops_migrator connection string>" -c "UPDATE exchange_rate SET rate = 99 WHERE base_currency = 'USD';"
# expect: ERROR: UPDATE on exchange_rate is not permitted — exchange_rate is immutable/append-only. Insert an offsetting or compensating row instead.
```
Both layers were verified for real during this hardening pass: the GRANT-level denial for `mops_runtime` above, and the trigger-level denial for `mops_migrator` against a real row, confirming the "belt and suspenders" design actually holds at both layers rather than only the one that happens to fire first.

---

## 7. Seed reference data

```powershell
psql -U mops_migrator -d mops_dev -c "INSERT INTO currency (code, name, decimals) VALUES ('USD','United States Dollar',2), ('ZIG','Zimbabwe Gold',2), ('ZAR','South African Rand',2);"
```
(Run as `mops_migrator`, not `mops_runtime` — `mops_runtime` intentionally has no INSERT grant on `currency`; org admins don't edit reference currency rows directly in V1.)

---

## 8. Phase 1 — run and test the application code

The Phase 1 deliverable (`src/server/shared/*`, `src/server/modules/iam/*`, `app/api/v1/*`) is included in this delivery. From your project root, with `.env` filled in as above:

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

---

## 11. Hardening verification — 2026-10-07, Phase 1.5 precondition

Added after the post-setup audit found `20261007062213_manual_constraints` was applied empty (`docs/AUDIT_PHASE0_POSTSETUP.md`). Run this whole section after Sections 5a and 6 above, in order, before starting any catalog/BOM/production/costing code. Don't treat "the migration ran with no errors" as sufficient evidence by itself — the checks below confirm the actual objects exist.

### 11.1 Confirm the migration state

```powershell
npx prisma migrate status
```

Expect `20261007061917_init`, `20261007062213_manual_constraints` (still empty — that's correct, it's the historical record of the gap, not a mistake to undo), and `20261007080000_harden_manual_constraints` all listed as applied, with no "modified after being applied" warnings.

### 11.2 Confirm role state — do not assume

Run as whichever role you're currently connecting with (reading role metadata needs no special privilege):

```powershell
psql "<any connection string that currently works>" -c "SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname IN ('mops_migrator', 'mops_runtime');"
```

Zero rows means Section 2 (Stage 1) hasn't actually been run against this database yet — the app and the migrator are currently the same role. That's not catastrophic (everything in Section 5a's migration works correctly either way — see that migration's own header comment for why), but it means Stage 3's `GRANT`s have nothing to attach to and the `mops_runtime`-specific sanity checks below won't apply until you run Section 2.

### 11.3 Confirm every hardened object actually exists

```sql
-- Partial unique BOM index
SELECT indexname FROM pg_indexes WHERE indexname = 'uq_bom_one_active_per_product';
-- expect 1 row

-- Email lowercase CHECK
SELECT conname FROM pg_constraint WHERE conname = 'app_user_email_lowercase';
-- expect 1 row

-- The 11 numeric/business-rule CHECK constraints (9 tables)
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname IN (
  'item_sellable_requires_price','bom_line_quantity_positive',
  'sales_order_line_quantity_positive','sales_order_line_unit_price_nonnegative',
  'production_job_planned_qty_positive','material_requirement_expected_qty_nonnegative',
  'labour_record_hours_positive','labour_record_rate_nonnegative',
  'quality_record_qty_consistency','stock_movement_quantity_nonzero',
  'exchange_rate_rate_positive'
)
ORDER BY table_name;
-- expect exactly 11 rows

-- Stock movement costing trigger + function, and confirm SECURITY DEFINER
SELECT tgname FROM pg_trigger WHERE tgname = 'trg_stock_movement_before_insert';
SELECT proname, prosecdef FROM pg_proc WHERE proname = 'trg_stock_movement_before_insert';
-- expect 1 row each; prosecdef must be true

-- gross_profit generated column
SELECT column_name, generation_expression FROM information_schema.columns
WHERE table_name = 'job_cost_actual' AND column_name = 'gross_profit';
-- expect 1 row, generation_expression non-null

-- Live cost views
SELECT table_name FROM information_schema.views
WHERE table_name IN ('job_material_cost_live', 'job_labour_cost_live');
-- expect 2 rows

-- The four append-only immutability triggers
SELECT tgrelid::regclass AS table_name, tgname FROM pg_trigger
WHERE tgname IN ('trg_stock_movement_immutable', 'trg_audit_log_immutable',
                  'trg_exchange_rate_immutable', 'trg_job_cost_actual_immutable')
ORDER BY table_name;
-- expect exactly 4 rows — this is the one that matters most (Finding 1)
```

### 11.4 Re-run the existing test suite

```powershell
npx vitest run
```

All 23 existing IAM tests should still pass — none of them touch the newly-constrained tables, so this is a cheap way to catch a typo in the migration before Phase 1.5 code gets written against it, not a test of the hardening itself (that's Section 11.3 and the sanity checks in Section 6).

### 11.5 What "done" looks like

Every query in 11.3 returns the expected row count, `npx prisma migrate status` shows no drift, both sanity-check `UPDATE`s in Section 6 fail with the expected error, and `npx vitest run` is still green. Only then start Phase 1.5.
