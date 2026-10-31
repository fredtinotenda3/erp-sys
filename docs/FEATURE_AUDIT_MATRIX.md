# Operis feature audit matrix

Status as of 31 Oct 2026, from reading the schema, services, routes and tests in the repository (not from running a deployed system).

- **Verified** = backend behaviour covered by passing automated tests against a real PostgreSQL database.
- **Unverified UI** = page exists, compiles, typechecks and lints, but has **not** been rendered or clicked through in a browser, and has no component tests.
- **Partial** / **Missing** = see the evidence column.

Last recorded results: backend 420 tests passing, UI 50 passing, lint clean, `tsc` clean once `seed-review/` is excluded.

| # | Module (priority) | Status | Evidence / gap |
|---|---|---|---|
| 1 | Auth, roles, permissions (P0) | Verified (backend), partial overall | Login/logout/sessions, 8 roles, capability checks in services, last-owner protection, owner-only owner deactivation, org + branch isolation, no password hashes in responses: `src/server/modules/iam/*` + tests. **Missing:** change password, password reset, brute-force/rate limiting (none found), failed-login audit events |
| 2 | Company and branches (P0) | Verified (backend), unverified UI | Branch create/list/detail/deactivate, branch-scoped queries, last-active-branch guard. **Missing:** company profile editing, branch rename/reactivate, deactivation blocked by open dependencies, consolidated vs branch report switch beyond the branch selector |
| 3 | Dashboard (P1) | Partial | Existing Command Centre reads real jobs/stock. Not audited against the checklist (sales totals, low stock alerts, pending approvals not present) |
| 4 | Items and catalogue (P0) | Partial | Items, types, UoM, standard cost, selling price, BOM link, active flag, duplicate SKU rejection. **Missing:** categories, packaging/unit conversions, tax codes, import |
| 5 | Customers (P0) | Verified (backend), unverified UI | Create/edit/deactivate, search, related orders/jobs. **Missing:** customer codes, payment terms, credit limits, tax info, address split (billing/delivery), import |
| 6 | Suppliers (P0) | **Missing** | No supplier model, service, API or page |
| 7 | Inventory control (P0) | Partial | Ledger of stock movements, derived balances, receipts, issues, adjustments, warehouses, DB-level protection of balances: `src/server/modules/inventory/*` + tests. Movement types for transfers/deliveries exist in the enum, but **no transfer or delivery service/route was found**. **Missing:** reservations, min/max and reorder alerts, lots/serials/expiry, stocktakes, valuation report |
| 8 | Purchasing (P1) | **Missing** | `purchase_order` exists only as a stock-movement reference type; no PO model/workflow |
| 9 | Goods receiving (P1) | Partial | Stock receipt exists and writes to the database. **Missing:** receiving against a PO, discrepancy/damage/reject quantities, attachments, inspection hand-off |
| 10 | Bills of materials (P0) | Verified (backend) | Versions, activation, line validation, requirement calculation, job keeps its BOM. **Not found:** circular-structure detection (BOM is single-level) |
| 11 | Production planning (P1) | Partial | Jobs, planned dates, requirements, shortage view, order linkage (one job per order line, quantity must match). **Open decision:** partial/split production per order line. **Missing:** reservations, prioritisation |
| 12 | Production execution (P0) | Verified (backend) | State machine, stages, output (with voids), labour, material issue, completion guards for stages and quality. **Missing:** downtime, scrap/wastage as its own record |
| 13 | Shop-floor interface (P1) | Unverified UI | Operator shell, job list, job screen reusing job forms. Not tested on a tablet or in a browser |
| 14 | Quality (P0) | Verified (backend), unverified UI | Inspections, rejects, dispositions, completion blocked by open rejects. **Missing:** quarantine stock status, reinspection flow, attachments, non-conformance/corrective actions, rejection-rate report |
| 15 | Sales orders (P0) | Verified (backend), unverified UI | Draft/confirm/cancel, edit draft, release lines to production, cancel blocked by live jobs. **Missing:** tax/discount, stock availability checks, reservations, produced/dispatched/remaining quantities, overdue report. States after `confirmed` are **not** driven by anything |
| 16 | Dispatch and delivery (P1) | **Missing** | No delivery model or workflow |
| 17 | Sales invoicing (P1) | **Missing** | **Decision needed:** does Operis own invoicing or integrate with accounting? |
| 18 | Product costing (P0) | Verified (backend) | Estimates, actuals, adjustments, frozen snapshots at completion, multi-currency lines. **Missing:** overhead allocation, written costing policy (actual vs standard), unit-cost-per-finished-unit report |
| 19 | Profitability (P1) | Verified (backend), unverified UI | Quote-vs-cost gross profit before overhead, labelled as such, CSV + print. **Missing:** revenue from invoices, by customer/branch/period roll-ups |
| 20 | Exchange rates (P0 if multi-currency) | Verified (backend) | Currencies, dated rates with source, history preserved on snapshots |
| 21 | Accounting (P1) | **Missing** | No ledger, AR/AP, tax, periods. Decision pending |
| 22 | MRP / forecasting (P2) | Missing | Only a per-job shortage view exists |
| 23 | Reports (P1) | Partial | Job costs and profitability only (with CSV/print). Stock, movement, purchasing, quality, labour reports missing |
| 24 | Audit log (P0) | Verified (backend), unverified UI | Writes in the same transaction as changes; read-only viewer with filters; branch-scoped for non-owners. **Missing:** login/failed-login events, export events, tamper-evidence beyond DB permissions |
| 25 | Database integrity (P0) | Partial | Constraints, triggers, transactions, idempotency keys, separate migrator/runtime roles in `docs/db-roles-and-security.sql` and the test setup. **To confirm on the live Neon project:** that `MIGRATION_DATABASE_URL` and `RUNTIME_DATABASE_URL` really use different accounts. Backup/restore **not** established |
| 26 | App security (P0) | Partial | Server-side validation (zod), parameterised queries, safe error responses. **Not checked/missing:** rate limiting, security headers, CSRF review, dependency audit, file-upload rules |
| 27 | Backups, monitoring (P0) | **Missing** (health probe added: `GET /api/v1/health`) | No automated backup or restore evidence, no error tracking or alerting in the repo |
| 28 | Documents/attachments (P1) | Missing | |
| 29 | Notifications/approvals (P1) | Missing | |
| 30 | Data import (P1) | Missing | |
| 31 | Integrations (P2) | Missing | |
| 32 | UX consistency (P1) | Unverified UI | Shared table/filter/form/states components, labelled fields, confirmations before consequential actions. No accessibility or browser pass done |

## Order of work this suggests

1. **Phase 1 leftovers:** confirm Neon roles differ; add backups and a restore test; add login rate limiting and password change/reset; browser-test the screens already built.
2. **Decisions needed before building:** invoicing ownership, partial production per order line, costing method/overhead, which states follow `confirmed`.
3. **Then the missing P0/P1 core:** suppliers, purchasing + receiving, stock transfers, dispatch.
