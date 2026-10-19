# Operis — Phase 1 UI

## Run locally
```powershell
npm install
npm run dev            # http://localhost:3000  (needs .env + migrated DB as before)
npx tsc --noEmit
npx eslint src app components lib
npx vitest run         # existing real-database suites (need .env)
npm run test:ui        # new pure-logic UI tests, no database needed
```
No schema or migration changes. No new npm packages.

## Screens and the APIs/services each uses
Pages are Server Components that call the existing service functions (same functions the HTTP routes call), so authentication, org isolation, branch scope and capability checks run on the server for every read. Mutations go through the existing `/api/v1` routes from small client forms.

| Screen | Route | Reads | Writes |
|---|---|---|---|
| Command Centre | `/dashboard` | listJobs (per status + overdueOnly), getShortages, listAuditLog or listStockMovements, items/users lookups | – |
| Products list | `/catalog/items` | listItems (search/type/active) | – |
| New item | `/catalog/items/new` | currencies | POST `/items` |
| Item detail (Overview, BOM) | `/catalog/items/[id]` | getItemById, listBomVersions, listStockBalances | PATCH `/items/[id]`, POST `/items/[id]/boms/[bomId]/activate` |
| New BOM version | `/catalog/items/[id]/bom/new` | listBomVersions, listItems | POST `/items/[id]/boms` |
| Jobs list | `/production/jobs` | listJobs, listJobCosts (cost:read), customers, items | – |
| New job | `/production/jobs/new` | items, customers, currencies, GET `/items/[id]/boms/active` (preview) | POST `/production-jobs` |
| Job detail: Overview / Materials / Production / Costs / Activity | `/production/jobs/[id]?tab=` | getJob, getJobMaterials, getJobCost (+convertTo), listAuditLog | PATCH job, POST transition, POST complete, POST material-issues, POST labour |
| Stock | `/inventory/stock` | listStockBalances, getShortages | – |
| Movements | `/inventory/movements` | listStockMovements | – |
| Warehouses | `/inventory/warehouses` | listWarehouses, listStockBalances | POST `/warehouses` |
| Receive / Adjust / Issue | `/inventory/receive`, `/adjust`, `/issue` | warehouses, items, balances, job materials | POST `/stock/receipts`, `/stock/adjustments`, `/production-jobs/[id]/material-issues` |

## Backend-adjacent changes (small, additive, justified)
1. `src/server/modules/catalog/item-view.ts` (+ test) and the four item route handlers now project `standardCost` / `sellingPrice` (+currencies) away for roles without `cost:read`. Before, `GET /api/v1/items` returned them to INVENTORY_MANAGER, VIEWER and PRODUCTION_OPERATOR. This only removes data from responses.
2. `GET /api/v1/currencies` (+ `costing/currency-service.ts`): read-only list of the seeded currency codes so forms can offer a dropdown. No endpoint existed.

## Backend gaps found (not papered over)
- **Job creation has no `clientRequestId`**, so a duplicate POST creates two jobs. The UI prevents double-submit and warns after an unknown outcome, but the server cannot de-duplicate.
- **No endpoint lists labour records.** Labour can be recorded; per-record history can't be shown (only the total in Costs, for cost roles).
- **Audit log can't be filtered to "everything about a job"** (labour/stock entries have their own entity ids), so Activity shows job-level changes only.
- **No shop-floor data** (stages, output, scrap, quality): those tabs/figures are marked unavailable, never faked.
- Movements/shortages have no pagination cursor (limit only).
- PRODUCTION_OPERATOR still gets the "workspace not available yet" screen (spec §9.5: separate shell, out of scope).

## Design decisions to know about
- Branch selector sets a cookie that only changes the *default* list filter; services re-validate branch access.
- Breadcrumbs live in each page header (so they can show real job numbers) rather than the top bar.
- Global search (⌘K) is not rendered: it would be a dead control.
- Timestamps render in UTC on first paint and switch to local time after hydration.
