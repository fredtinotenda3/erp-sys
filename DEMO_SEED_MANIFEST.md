# Demo Seed Manifest — Mavuno Packaging Industries (Pvt) Ltd

**This organization, every user, supplier, customer, transaction and figure in it is entirely fictional**, built solely to demonstrate this application's real plastics-manufacturing vertical. It is not based on, and does not claim affiliation with, any real company (including ALPLA, Visy, or Plastipak, which informed only the general shape of the industry — none of their names, branding, products, or data appear anywhere in this seed). Every number (weights, cycle times, cavity counts, costs, quantities) is a plausible, internally-consistent plastics-industry figure authored for this demo, **not** a measurement from any real plant and **not** read back from device telemetry — this codebase has no machine-telemetry integration (see `plastics-process-service.ts`'s header comment); every process-detail figure below was entered by a (fictional) operator, exactly as a real operator would key it in.

This manifest is the authoritative, line-by-line account of what the demo seed creates. `DEMO_DATA_CATALOGUE.md` is the narrative companion (what each thing *is* and *why*); this file is the checklist (what exists, how many, and how to reproduce it).

---

## 1. What this is, and is not

- **Is:** a second, independent, idempotent seed script (`scripts/seed-demo.ts` → `src/server/dev/seed-demo.ts` / `src/server/dev/seed-demo-data.ts`) that bootstraps a brand-new organization and populates it end-to-end using **only this application's own service-layer functions** — the same functions the UI and API routes call. Nothing here inserts into a database table directly.
- **Is not:** a modification of `scripts/seed-dev.ts` or its organization (`seed-dev.ts`'s generic dev org is untouched — it is a different org, found by a different slug, and this script never touches it). Not a database migration. Not a change to any schema, role, capability, or workflow — none was invented; every record type, field, enum value and permission used below already existed in the codebase before this seed was written.

## 2. Files added

| File | Purpose |
|---|---|
| `src/server/dev/seed-demo-data.ts` | Plain data constants (org, 8 users, work centres, machines, warehouses, 11 raw materials, 15 products with BOM lines and plastics specs, 15 moulds, 10 suppliers, 14 customers, 4 exchange-rate pairs, 3 inspection plans). No side effects — importing this file touches no database. |
| `src/server/dev/seed-demo.ts` | Orchestration: turns the data above into real records via `bootstrapOrganization`, `createItem`, `createBomVersion`, `createPurchaseOrder`, `createJob`, `issueMaterialToJob`, `recordOutput`, `recordInspection`, `createRegrindLot`, `createDispatch`, etc. Exports `planMavunoSeed()` (read-only dry run) and `seedMavunoDemo(options)` (apply). |
| `scripts/seed-demo.ts` | CLI entry point (`npm run seed:demo`). Dry-run by default; `--apply` requires explicit passwords and a target-database confirmation. |
| `package.json` | One line added: `"seed:demo": "tsx scripts/seed-demo.ts"`. |

No existing file's behavior was changed. `package.json`'s other scripts, including `seed:dev`, are untouched.

## 3. Safety model — identical guard to `seed-dev.ts`, not a weaker second gate

This seed reuses `checkSeedSafety` from `src/server/dev/seed-guard.ts` **completely unmodified**. It never runs without the operator first seeing the dry-run output and explicitly setting `OPERIS_DEV_SEED_TARGET` to the exact `<database>@<host>` string the dry run prints — the same confirmation `seed-dev.ts` already requires. There is no separate, weaker "demo mode" bypass.

Additional guarantees specific to this seed:

- **Idempotent.** Every record is found by a stable business key (slug, email, SKU, code, name, or a deterministic `clientRequestId`) before anything is created. Re-running `npm run seed:demo -- --apply` against the same database creates nothing new and reports everything as "already there."
- **Never clears, resets, or deletes anything.** No `DELETE`, `TRUNCATE`, or Prisma `deleteMany` appears anywhere in either seed file.
- **Passwords are never hardcoded.** The OWNER_ADMIN password and the shared password for the other 7 demo users are supplied by the operator as environment variables (`OPERIS_DEMO_OWNER_PASSWORD`, `OPERIS_DEMO_PASSWORD`) at apply time, validated to be at least 12 characters, hashed by the application's own `createUser`/`bootstrapOrganization` services (Argon2id via `@node-rs/argon2`, same as every other user in the system), and never written to a file or printed to the console.
- **Separate deterministic ID namespace.** `demoUuid()` hashes with the prefix `operis-mavuno-demo-seed:`, distinct from `seed-dev.ts`'s `operis-dev-seed:` prefix, so the two seeds' idempotency keys can never collide even if ever run against the same database.

## 4. Exact commands

```powershell
# 1. Dry run — writes nothing, shows the target database and what would be created
npm run seed:demo

# 2. Confirm the printed target is the database you intend to seed, then set:
$env:OPERIS_DEV_SEED_TARGET     = "<database>@<host>"   # copied verbatim from step 1's output
$env:OPERIS_DEMO_OWNER_PASSWORD = "<a password, 12+ characters, for owner@mavunopackaging.test>"
$env:OPERIS_DEMO_PASSWORD       = "<a password, 12+ characters, shared by the other 7 demo users>"

# 3. Apply
npm run seed:demo -- --apply
```

Re-running step 3 at any time is safe — see Section 3.

`checkSeedSafety` is the same guard documented in the base application's own setup docs: it reads `MIGRATION_DATABASE_URL`/`RUNTIME_DATABASE_URL`, rejects anything it cannot positively identify as a local/dev-looking target, and requires the explicit `OPERIS_DEV_SEED_TARGET` confirmation string on every run (not just the first). It is the operator's responsibility, not this script's, to point those connection strings at a database that is safe to seed — this script adds no independent judgment about what "safe" means beyond what `seed-guard.ts` already enforces.

## 5. What gets created (counts, as reported by a first run against an empty organization)

| Entity | Count | Notes |
|---|---|---|
| Organization | 1 | `mavuno-packaging` |
| Branches | 2 | Harare Plant (first branch, created by `bootstrapOrganization`), Bulawayo Depot |
| Industry profile | plastics | 6 modules enabled: `plastics_materials`, `plastics_product_spec`, `mould_management`, `plastics_process_detail`, `regrind_tracking`, `plastics_analytics` |
| Users | 8 | 1 OWNER_ADMIN (created by bootstrap) + 7 created via `createUser` |
| Work centres | 6 | WC-RMR, WC-INJ, WC-BLOW, WC-QA, WC-FGD, WC-MAINT |
| Machines | 4 | INJ-01, INJ-02 (under WC-INJ); ISBM-01, EBM-01 (under WC-BLOW) |
| Warehouses | 6 | 5 at Harare Plant, 1 at Bulawayo Depot |
| Items | 26 | 11 raw materials/consumables/spare parts + 15 products (4 WIP preforms, 11 finished goods) |
| BOMs | 15 | one active v1 per product; the 2L preform (`WIP-PET-PFM-2L`) additionally gets a v2 (see below) |
| BOM v2 (2L preform) | 1 | superseding v1, activated mid-sequence (after Job A1 snapshots v1, before Job A3) |
| Moulds | 15 | each tied to one product and 1–2 compatible machines |
| Mould–machine compatibility links | 16 | (preforms/closures: INJ-01 + INJ-02 both, = 8×2=16; blow-moulded items: 1 machine each — included in the 15 moulds, 7 of which have 2 links) |
| Inspection plans | 3 | incoming virgin PET resin; PET Bottle 2L finished good; PP Closure 28mm finished good |
| Suppliers | 10 | |
| Customers | 14 | |
| Exchange-rate pairs | 4 | USD↔ZIG (RBZ_OFFICIAL, 2 dated USD→ZIG rates + 1 ZIG→USD rate), USD↔ZAR (MARKET) |
| Purchase orders | 8 | statuses: 4 received, 1 partially received, 1 confirmed, 1 draft, 1 closed |
| Goods receipts | 7 | one per non-draft PO (the draft PO has none) |
| Sales orders | 6 | statuses: 2 fulfilled-later (confirmed then dispatched), 1 confirmed (not yet produced), 2 draft, 1 cancelled |
| Production jobs | 6 | A1, A2, A3 (PET preform/bottle chain), B1, B2 (PP closures), C1 (HDPE bottle) |
| Regrind lots | 1 | ground from Job A2's scrap + QA-scrapped rejects, same item (`RM-PET-VIRGIN`) it came from |
| Dispatches | 3 | 2 for SO1 (partial, then the remainder via the Bulawayo transfer), 1 for SO3 |
| Deliveries confirmed | 3 | one per dispatch above |
| Warehouse transfers | 1 | 730 finished bottles, Harare Finished Goods Warehouse → Bulawayo Finished Goods Store |

A second run against the same database reports every row above as "already there" and creates 0 new records. `npm run seed:demo` (dry run, no `--apply`) shows this live tally without writing anything, by querying for each business key and reporting creates-vs-exists — see `planMavunoSeed()`.

## 6. Environment variables this seed uses

| Variable | Required for | Notes |
|---|---|---|
| `OPERIS_DEV_SEED_TARGET` | `--apply` | Must exactly match the `<database>@<host>` string `checkSeedSafety` computes from your connection strings; printed by the dry run. Unchanged, pre-existing guard from `seed-guard.ts`. |
| `OPERIS_DEMO_OWNER_PASSWORD` | `--apply` | ≥ 12 characters. Used once, to create (or log into) `owner@mavunopackaging.test`. Never logged, never written to disk. |
| `OPERIS_DEMO_PASSWORD` | `--apply` | ≥ 12 characters. Shared by the other 7 demo users (`production.manager@…`, `purchasing@…`, `warehouse@…`, `supervisor@…`, `operator@…`, `quality@…`, `sales@…`). Never logged, never written to disk. |
| `MIGRATION_DATABASE_URL` / `RUNTIME_DATABASE_URL` | always | Same connection strings the rest of the application already uses (see `docs/SETUP_COMMANDS.md`). This seed does not introduce new ones. |

Demo login emails (passwords are whatever you set above — never hardcoded in any file):

```
owner@mavunopackaging.test                       Owner / Administrator           -- OPERIS_DEMO_OWNER_PASSWORD
production.manager@mavunopackaging.test           Production Manager              -- OPERIS_DEMO_PASSWORD
purchasing@mavunopackaging.test                   Purchasing Officer               -- OPERIS_DEMO_PASSWORD
warehouse@mavunopackaging.test                     Warehouse Manager                -- OPERIS_DEMO_PASSWORD
supervisor@mavunopackaging.test                   Production Supervisor           -- OPERIS_DEMO_PASSWORD
operator@mavunopackaging.test                      Machine Operator                 -- OPERIS_DEMO_PASSWORD
quality@mavunopackaging.test                       Quality Inspector                -- OPERIS_DEMO_PASSWORD
sales@mavunopackaging.test                         Sales and Dispatch Officer      -- OPERIS_DEMO_PASSWORD
```

## 7. Persona → real role mapping (no role was invented)

This application has 7 real roles (`src/server/shared/authz.ts`): `OWNER_ADMIN`, `OPERATIONS_MANAGER`, `PRODUCTION_MANAGER`, `INVENTORY_MANAGER`, `PRODUCTION_OPERATOR`, `FINANCE_MANAGER`, `VIEWER`. The demo's 8 named personas map onto 5 of them (no Finance persona is seeded — there is no transactional need for one in this demo's scenarios, so none was forced in just to populate the role; exchange rates are recorded through the Owner session, which already holds `exchange_rate:create`):

| Persona (title) | Email | Real role | Why this role |
|---|---|---|---|
| Owner / Administrator | owner@… | `OWNER_ADMIN` | Only role with `industry_profile:manage` (switches the org to the plastics profile) and `exchange_rate:create` alongside Finance Manager. |
| Production Manager | production.manager@… | `PRODUCTION_MANAGER` | Holds `production_job:create/update/complete`, `quality:approve` (dispositions), `mould:manage`, `plastics_spec:manage` — runs every job. |
| Purchasing Officer | purchasing@… | `INVENTORY_MANAGER` | Holds `purchase_order:create/update` but deliberately **not** `purchase_order:confirm` (segregation of duties — see Section 8). |
| Warehouse Manager | warehouse@… | `INVENTORY_MANAGER` | Same role as Purchasing (the schema's own role set, not a separate warehouse role); holds `goods_receipt:create`, `finished_goods:manage`, `dispatch:create`, `regrind:create`. Branch access spans both branches, to receive/transfer/dispatch at Bulawayo too. |
| Production Supervisor | supervisor@… | `PRODUCTION_OPERATOR` | Holds `stage:transition` — starts/completes job stages. |
| Machine Operator | operator@… | `PRODUCTION_OPERATOR` | Holds `material:issue`, `labour:record`, `output:record`, `plastics_process:record` — performs every shop-floor recording action; `recordLabour`/`recordOutput`/`setPlasticsProcessDetail` attribute each entry to this exact session's `userId`. |
| Quality Inspector | quality@… | `PRODUCTION_OPERATOR` | Holds `quality:record` (same role as Operator/Supervisor — there is no separate QA role in this system); records inspections, never dispositions (dispositions need `quality:approve`, which `PRODUCTION_OPERATOR` does not hold — the Production Manager decides disposition). |
| Sales and Dispatch Officer | sales@… | `OPERATIONS_MANAGER` | Holds `sales_order:create/confirm`, `dispatch:create` is actually on `INVENTORY_MANAGER` (see note below), `customer:create`. Branch access spans both branches. |

**Correction worth stating plainly, not glossing over:** `dispatch:create` and `finished_goods:manage` belong to `OWNER_ADMIN` / `OPERATIONS_MANAGER` / `INVENTORY_MANAGER` (see `authz.ts`'s own comment on these capabilities), **not** `PRODUCTION_MANAGER`. In the seed's transaction chain, `createDispatch`/`confirmDelivery` are called through the **Sales and Dispatch Officer** session (`OPERATIONS_MANAGER`, which does hold `dispatch:create`), and `transferBatch` is called through the **Warehouse Manager** session (`INVENTORY_MANAGER`). This was verified against the real capability map before writing a single transaction, not assumed.

## 8. Segregation-of-duties points this demo deliberately exercises

- **Purchase orders:** the Purchasing Officer (`INVENTORY_MANAGER`) drafts every PO; the **Owner** confirms each one (`confirmPurchaseOrder`/`closePurchaseOrder` called via the owner session), because `purchase_order:confirm` is withheld from `INVENTORY_MANAGER` by design (`authz.ts`: "Confirming a PO is the point where the organisation takes on a real financial commitment").
- **Quality dispositions:** the Quality Inspector (`PRODUCTION_OPERATOR`) records every inspection; only the **Production Manager** records the disposition (scrap/rework/use-as-is), because `quality:approve` is withheld from `PRODUCTION_OPERATOR`.
- **Finished goods / dispatch:** `finished_goods:receive` (converting recorded output into valued FG stock) is called via the Production Manager session; `finished_goods:manage` (the Bulawayo transfer) and `dispatch:create` are called via Warehouse Manager / Sales sessions respectively, since `PRODUCTION_MANAGER` holds neither.

## 9. What was verified, and how

| Check | Result |
|---|---|
| `npx tsc --noEmit` on the full project | Clean. (One pre-existing, unrelated failure — `app/layout.tsx`'s `LayoutProps` — is a Next.js-generated ambient type not available under plain `tsc`; `npm run typecheck`, below, is the project's real check and is clean.) |
| `npm run typecheck` (`next typegen && tsc --noEmit`) | **Clean. Zero errors.** |
| `npm run lint` | **Clean on every file this seed touches.** (Remaining lint output elsewhere in the repo is pre-existing, in files this task never modified.) |
| `npm run build` | **Blocked**, for a reason unrelated to any file this task wrote — see Section 10. |
| Actual seed run against a live PostgreSQL database | **Not performed.** See Section 10. |

## 10. What the sandbox prevented, stated plainly

Per this engagement's standing mandate (do not connect to or modify any database, do not claim success without evidence), the following were **not** done in this sandbox, and are not claimed to have been done:

1. **The seed script was never actually executed against a running PostgreSQL database.** This sandbox has no database instance it is authorized to connect to, and no production/unknown database may ever be targeted. `tsc`/`npm run typecheck`/`npm run lint` passing clean is strong evidence the code is correct (every service call's argument shape, every return-type assumption, was checked against the real service signatures and two real type errors were caught and fixed this way — see `DEMO_DATA_CATALOGUE.md`'s verification notes) — but it is not the same as a successful run. **Before relying on this seed, run it yourself** against a disposable local database, following Section 4 above, and confirm the dry-run and apply output matches Section 5's table.
2. **`npm run build` fails**, but for a cause fully independent of this delivery: Turbopack cannot fetch the Geist/Geist Mono fonts `next/font/google` requests in the stock `app/layout.tsx` (a file this task never touched), because `fonts.googleapis.com` is not reachable from this sandbox's network-egress allowlist (confirmed via the sandbox's own proxy-status tooling that this is a policy denial, the same category that also blocks Prisma's own engine-binary CDN — see below). This will build normally on your machine, which has ordinary internet access; it is not a defect in any file this task added or changed.
3. **`npx prisma generate`** also fails in this sandbox for the same network-policy reason (`binaries.prisma.sh` is not on the allowlist) — a pre-existing, already-documented limitation of this specific sandbox (see `authz.ts`'s own header comment, "Known verification gap," predating this task). To unblock local `tsc`/lint checks in this sandbox, an already-generated Prisma client from an earlier, schema-verified copy of this same project was reused — this has no bearing on your machine, where `npx prisma generate` will run normally.

None of the above required, or came close to requiring, a connection to any real database, migration execution, or production credential. Everything this task performed was either a pure static check (`tsc`, `lint`) run against the file tree, or a read of already-generated artifacts to confirm schema consistency before reuse.

## 11. Re-running / resetting

There is no "reset demo" command, deliberately — this seed, like `seed-dev.ts`, never deletes anything, so there is nothing to reset without touching real database state the sandbox rules forbid automating. To start over, drop and recreate the database yourself (outside this seed, on your own machine) and re-run `npm run seed:demo -- --apply` from a clean schema.
