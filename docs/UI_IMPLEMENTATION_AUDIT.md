# UI implementation audit

Written 28 Oct 2026 against the `erp-sys-master` snapshot. Everything here was checked against the code, not assumed. "Verified" means a command was run and its output observed (see *Verification*).

## 1. Findings from the audit

| Area | What existed | What was missing | Kind |
|---|---|---|---|
| Customers | Full service + API (no pagination, no job filter) | All pages | missing page |
| Sales orders | Schema, capabilities | **Service, API routes, order-to-job link, pages** | missing API + pages |
| Quality | Per-job service/API, per-job UI on the job page | Cross-job lists, blocked-jobs view, inspection detail page | missing API + pages |
| Reports | `/api/v1/reports/job-costs`, `/profitability` | Pages, CSV, print | missing pages |
| Users | create / list / change role / deactivate | Pages; get-one read; **privilege gaps (below)** | missing page + defects |
| Branches | create / list / deactivate | Pages; get-one read; **scope gaps (below)** | missing page + defects |
| Audit log | API with only branch/entity/limit | Date, actor, action, cursor filters; **no branch scoping**; page | missing API + defect |
| Operator shell | "workspace not available" screen | Workspace pages and list | missing page |
| Existing screens | Dashboard, catalog, BOM, inventory, jobs, exchange rates | Nothing found broken in the parts exercised by the tests; not re-audited screen by screen (see §6) | — |

### Security defects found in existing code (all fixed, all tested)
1. A manager (OPERATIONS_MANAGER) could deactivate an OWNER_ADMIN. Now only an owner can.
2. A non-owner could grant/revoke access to a branch they cannot access themselves, and assign such branches when creating a user. Now refused ("not found" / forbidden).
3. A non-owner could deactivate a branch they have no access to. Now "not found".
4. Non-owner audit-log readers could read every branch's history. Now: org-wide entries plus their own branches only.
5. A branch could be deactivated even if it was the organization's last active one. Now refused.

## 2. Module inventory

Routes, API, permissions and test coverage per module. Status: **Done** = routes + real data + server-side checks + tests passing; **Partial** = see notes.

| Module | Routes | Backend used | Permissions | Tests | Status |
|---|---|---|---|---|---|
| Customers | `/customers`, `/new`, `/[id]`, `/[id]/edit` | existing customer service/API; `listJobs` gained `customerId` filter; related orders and jobs shown if the role may read them | customer:read/create/update | service + job-filter tests | Done. List pages in memory (25/page) because the service has no pagination |
| Sales orders | `/orders`, `/new`, `/[id]`, `/[id]/edit` | **new** `sales-order-service` + `/api/v1/sales-orders[/id][/confirm\|/cancel]`; `createJob` accepts `salesOrderLineId` | sales_order:read/create/update/confirm; production_job:create to release | 12 + journey | Done within the scope in §4 |
| Quality | `/quality`, `/inspections`, `/inspections/[id]` | **new** read-only `quality-overview` (cross-job list, blocked jobs, by id); decisions reuse `DispositionDialog` → existing disposition API | quality:read (+production_job:read); quality:approve to decide | 3 + journey | Done. Recording an inspection stays on the job's Quality tab and the shop floor |
| Reports | `/reports`, `/job-costs`, `/profitability` + CSV export routes | existing `listJobCosts`, `getProfitabilityReport`; all money from the services | cost:read + production_job:read | csv tests + journey | Done (see §4 for what the report does *not* claim) |
| User admin | `/settings/users`, `/new`, `/[id]` | existing + **new** `getUser`; guards added | user:read/create/update_role/deactivate; branch_access:grant/revoke | 7 | Done. No reactivate or rename (backend doesn't support) |
| Branch admin | `/settings/branches`, `/new`, `/[id]` | existing + **new** `getBranchDetail`; guards | branch:read/create/deactivate | 3 | Done. No rename/reactivate (backend doesn't support) |
| Audit log | `/settings/audit-log` | existing API, extended filters + cursor + scope | audit_log:read | 2 | Done. Read-only |
| Shop floor | `/shop-floor`, `/shop-floor/jobs/[id]`, operator shell, dashboard redirect | **new** read model `listWorkspaceJobs`; production/quality sections extracted from the job page and shared | production_job:read; actions gated by existing stage/output/labour/quality capabilities | 4 + journey | Done; not exercised in a browser (see §6) |
| Navigation | modules enabled in `nav-config.ts` | — | per-capability | 3 new UI tests | Done |

## 3. Permissions summary

All enforcement is in services; pages only decide what to *show*. Out-of-scope records return "not found", never "forbidden". New tests cover: capability refusal per role, cross-organization ids, other-branch ids (read, confirm, release, inspection detail), operator list contents (no customer/quote/cost fields).

## 4. Business rules decided, and the ones still open

Implemented conservatively:
- Order states used: draft → confirmed, and cancelled (from draft/confirmed). Editing only while draft. Cancel needs a reason and is refused while a linked job is not cancelled.
- Creating or confirming an order **never** creates production. Release is explicit, per line, via `createJob({ salesOrderLineId })`; requires a confirmed order, same branch and product, one job per line.
- A released job's quantity must equal the line quantity; its customer and quote come from the order (caller may not supply them).
- One currency per order; total = quantity × unit price (no tax, discount or rounding rule).
- Only finished goods can be ordered.
- "Revenue" on the profitability report is the **job's quote**, not recognised revenue, and profit **excludes overhead**. The page and CSV say so.

**Open — need a decision from you**
1. What moves an order to `in_production`, `partially_delivered`, `delivered`, `closed`? No delivery/invoicing model exists, so nothing does.
2. Must a job quantity always equal its order line? (Partial or split production is not supported.)
3. Should users be reactivatable / renamable, and branches renamable / reactivatable? Backend lacks them.
4. Should deactivating a branch be blocked when it has open jobs or stock?
5. Overhead allocation and revenue recognition, if profitability should go beyond quote-minus-cost.

## 5. Data-integrity notes
- No migration was required (order numbers use an advisory-locked max+1 per organization).
- Release/cancel race closed with row locks (`FOR SHARE` on release, `FOR UPDATE` on cancel); not stress-tested under real concurrency.
- Nothing edits ledgers, snapshots or audit rows. The audit screen has no write path.

## 6. Verification and known gaps

Environment: a throwaway local PostgreSQL 16 (`mops_test`) built from the repo's migration SQL applied with `psql` (Prisma's migrate engine could not download), plus the repo's role grants. No real database was touched.

| Check | Result |
|---|---|
| Backend tests (`vitest run`) | 29 files, **419 passed** (baseline 393) |
| UI tests (`vitest.ui.config.ts`) | 8 files, **50 passed** |
| ESLint (`src app components lib`) | clean, exit 0 |
| `tsc --noEmit` | 34 errors, **all inside the stray `seed-review/` folder** (pre-existing); 0 in the app |
| `next build` | **Cannot be run as-is here**: the sandbox blocks Google Fonts. With `NEXT_FONT_GOOGLE_MOCKED_RESPONSES`, `--webpack`, and `seed-review/` moved aside for the run, the build **passed** and listed every new route. Not run as plain `npm run build` |

Not done / not verified:
- **No browser testing.** Pages compile, typecheck and lint, and their services are tested, but no page was rendered or clicked through; client forms have no component tests (the UI test setup has no DOM environment).
- Existing screens (dashboard, catalog, BOM, inventory, exchange rates, job creation) were **not** re-audited screen by screen; only the job page was touched (pure extraction of its production/quality sections, behaviour unchanged).
- Customer and order lists beyond 25 rows paginate; customer lists load all rows then slice.
- Job-costs report reads at most 500 jobs (the existing API limit) and says so.
- No role-by-role end-to-end test through HTTP routes; tests call services directly.
- `seed-review/` (duplicate of `src/server/dev` with broken imports) should be deleted or excluded from `tsconfig.json`; left untouched.
- `.env` in the repo directory holds throwaway local credentials; do not commit it.
