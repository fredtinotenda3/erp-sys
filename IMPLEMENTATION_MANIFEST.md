# Implementation Manifest — Purchasing, Goods Receiving & Incoming Lot Traceability

Delivered against the Master Completion and Engineering Execution Mandate, §15. Covers
everything changed since the baseline you gave me for this round (after the Suppliers
milestone, which was already delivered and is **not** re-included here): the test-database
remote-target safety hardening, and the Purchasing + Goods Receiving + incoming Lot
Traceability milestone (mandate priority order items B, C, and the receiving half of F).

Every claim below was checked by reading the actual diff against your baseline and by running
`npx next typegen && npx tsc --noEmit` and `npx eslint` in this sandbox — not asserted from
memory. Section 6 states plainly what could **not** be checked here (anything needing a live
database or a browser), per mandate §15.

## 1. Scope of this delivery

| # | Item | Status |
|---|---|---|
| — | Test-database remote-target safety hardening | Done (closes a gap the Suppliers checkpoint flagged, not part of the original priority list) |
| B | Purchasing (Purchase Orders) | Done |
| C | Goods Receiving | Done |
| F (incoming half) | Lot/Batch Traceability | **Partial** — see §7. Consumption, finished-goods batches, and dispatch-side traceability are a separate, not-yet-started milestone. |

Suppliers (priority A) was completed in the prior round and is unchanged here except for one
addition noted in §2 (the supplier detail page now shows that supplier's purchase orders, which
could only be wired up once Purchasing existed).

## 2. File manifest

### 2a. New files

**Schema / migration**
- `prisma/migrations/20261104110000_purchasing_and_receiving/migration.sql` — the DDL for everything in §3.

**Backend — Purchasing & Receiving**
- `src/server/modules/purchasing/purchase-order-service.ts` — PO CRUD + lifecycle (draft → confirmed → partially_received/received → closed, or cancelled). Mirrors `sales-order-service.ts`'s shape; see its own header comment for the specific differences the domain requires (currency-per-PO, raw_material/consumable/spare_part-only line items, `partially_received`/`received` written only by the receiving service, never here).
- `src/server/modules/purchasing/goods-receipt-service.ts` — records a delivery against a confirmed PO: inspects each line (accepted/rejected), posts accepted quantity to stock through the one canonical stock-movement insert, creates one `MaterialLot` per accepted line, recomputes the PO's status. See its own header comment for the governing design decisions (header-level idempotency, over-accept blocking vs. over-receive-then-reject being allowed, cost always from the PO line).
- `src/server/modules/purchasing/__tests__/purchase-order-service.test.ts` — written, statically checked, **not executed** (see §6).
- `src/server/modules/purchasing/__tests__/goods-receipt-service.test.ts` — written, statically checked, **not executed** (see §6).

**API routes** (all follow the existing `requireSession`/`errorResponse` pattern byte-for-byte, copied from the equivalent Sales Order / Supplier routes)
- `app/api/v1/purchase-orders/route.ts` — GET list (filters: status, supplierId, branchId, search, limit, offset), POST create.
- `app/api/v1/purchase-orders/[id]/route.ts` — GET, PATCH (draft-only, enforced server-side).
- `app/api/v1/purchase-orders/[id]/confirm/route.ts` — POST.
- `app/api/v1/purchase-orders/[id]/cancel/route.ts` — POST (reason required).
- `app/api/v1/purchase-orders/[id]/close/route.ts` — POST (reason required).
- `app/api/v1/purchase-orders/[id]/goods-receipts/route.ts` — GET list receipts for this PO, POST record a receipt.
- `app/api/v1/goods-receipts/[id]/route.ts` — GET one receipt (traceability drill-down).

**Frontend**
- `components/features/purchasing/purchase-order-form.tsx` — create/edit draft PO. One addition `order-form.tsx` (Sales) doesn't need: a per-line editable `uom` field, because `PurchaseOrderLine.uom` is a persisted snapshot distinct from `item.uom`.
- `components/features/purchasing/purchase-order-actions.tsx` — confirm/cancel/close action buttons + confirmation dialogs.
- `components/features/purchasing/goods-receipt-form.tsx` — the receiving form: per-outstanding-line warehouse/received/rejected/reason/lot-ref/expiry capture. `acceptedQty` is always computed client-side (received − rejected), never typed directly, matching the server's own invariant.
- `app/(app)/purchasing/orders/page.tsx` — list page.
- `app/(app)/purchasing/orders/new/page.tsx` — create page.
- `app/(app)/purchasing/orders/[id]/page.tsx` — detail page: header, status-conditional notices, lines table, goods-receipts history.
- `app/(app)/purchasing/orders/[id]/edit/page.tsx` — edit-draft page.
- `app/(app)/purchasing/orders/[id]/receive/page.tsx` — the receiving page.

**Test-database hardening** (not part of the Purchasing mandate items, but completed this round — see §8)
- `src/server/dev/db-target.ts` — pure helpers (`parseTarget`, `targetLabel`, `isProductionLikeLabel`, `LOCAL_DB_HOSTS`) extracted out of `seed-guard.ts` so the test-suite guard and the dev-seed guard can't silently diverge on what counts as "the same database" or "looks like production."
- `src/server/dev/test-db-guard.ts` — `checkRemoteTestDbSafety`: once a team opts into `ALLOW_REMOTE_TEST_DB=1` (a shared/branched CI database), requires the two configured URLs to agree, refuses a production-looking name outright, and requires a positive `TEST_DB_CONFIRM_TARGET=<database>@<host>` confirmation copied from the error message — the same discipline `seed-guard.ts` already applies to the dev seed.
- `src/server/dev/__tests__/test-db-guard.test.ts` — pure unit tests, no I/O, no database — but blocked from running here regardless by the global setup gate; see §6.
- `.env.example`, `.env.test.example` — environment templates (placeholder credentials only, e.g. `change-me-migrator-password`; never a real secret). Referenced by `docs/SETUP_COMMANDS.md` and `docs/TESTING.md`, which already assumed these existed.

### 2b. Modified files

| File | What changed | Why |
|---|---|---|
| `prisma/schema.prisma` | +274/−3 lines. Added `PurchaseOrderStatus`/`MaterialLotStatus` enums and the `PurchaseOrder`, `PurchaseOrderLine`, `GoodsReceipt`, `GoodsReceiptLine`, `MaterialLot` models; added `purchaseOrders`/`goodsReceiptLines`/`materialLots` back-relations to `Supplier`, `Item`, `Warehouse`; extended the file's own top-of-file invariant checklist (items 7–8). The 3 removed lines are the two `Warehouse` back-relation lines being re-aligned with two new ones added beside them, and one comment line being extended — **no existing field, relation, or constraint was altered.** | New entities for this milestone. |
| `src/server/shared/authz.ts` | Added `purchase_order:{create,read,update,confirm}` and `goods_receipt:{create,read}` to the `Capability` union and to five roles' grant sets (OWNER_ADMIN, OPERATIONS_MANAGER, PRODUCTION_MANAGER, FINANCE_MANAGER, VIEWER all read-or-more; INVENTORY_MANAGER gets create/read/update on POs and create/read on receipts, but **not** `purchase_order:confirm`). **Purely additive** — confirmed by diff: no existing capability was removed from any role. | Capability-based access control for the new module; see §5 for the segregation-of-duties reasoning. |
| `src/server/modules/inventory/stock-core.ts` | Extracted the core stock-movement insert into `insertMovementTx(tx, session, args)`; `postMovement` is now a thin wrapper around it (external behavior unchanged); added `postMovementInTransaction(tx, session, args)`. | `goods-receipt-service.ts` needs the stock-movement write to happen *inside its own already-open transaction* (header + lines + movement + lot + PO status must commit or roll back together). `postMovement` always opens its own transaction against the pooled client, so calling it from inside another transaction would use a second connection and silently break atomicity. See the file's own comment on `postMovementInTransaction` for the full reasoning, including why it does not retry on the balance-creation race the way `postMovement` does. |
| `app/(app)/suppliers/[id]/page.tsx` | Added a "Purchase orders" related-records section (cost-gated Total column), fulfilling a TODO left by the Suppliers delivery for exactly this. | Mirrors the Customer detail page's "Sales orders" section; couldn't be built until Purchasing existed. |
| `components/shell/nav-config.ts`, `components/shell/nav-list.tsx` | Added a "Purchasing" nav entry (gated on `purchase_order:read`/`goods_receipt:read`) and its icon. | Navigation for the new module. |
| `lib/api-types.ts` | Added `Supplier` interface. | Needed by `lib/server/lookups.ts`'s new `loadSuppliers`, used by the PO form's supplier dropdown. |
| `lib/server/lookups.ts` | Added `loadSuppliers`, mirroring `loadCustomers` exactly (degrades gracefully when the role lacks `supplier:read`). | Same reason. |
| `components/ui/status-badge.tsx` | Added `PurchaseOrderStatusBadge` (draft/confirmed/partially_received/received/closed/cancelled). | Status display for PO list/detail pages. |
| `docs/db-roles-and-security.sql` | Added the Stage 3 grant/revoke lines for the five new tables, for documentation completeness (the migration already self-grants when `mops_runtime` exists — this is belt-and-suspenders, same pattern already used for every prior migration). | Keeps this file's "every self-granting table, for completeness" list accurate. |
| `src/server/dev/seed-guard.ts` | Re-exports `DbTarget`/`parseTarget`/`targetLabel` from the new `db-target.ts` instead of defining them inline. **No behavior change** — confirmed by diff: the function bodies that moved are byte-identical, only their location changed. | Single source of truth for the "is this a safe database target" logic, shared with `test-db-guard.ts`. |
| `vitest.test-env.ts` | Calls `checkRemoteTestDbSafety` after the existing local/non-local check and throws with its `problems` list if it fails. | Closes the gap `docs/SUPPLIERS_VERIFICATION_CHECKPOINT.md` §7 flagged: nothing previously stopped `ALLOW_REMOTE_TEST_DB=1` plus a production-looking URL from running the suite's permanent-row-writing tests against it. |
| `docs/TESTING.md` | Documented the `ALLOW_REMOTE_TEST_DB=1` + `TEST_DB_CONFIRM_TARGET` requirement. | Keep the docs matching the code. |

**Not included, deliberately:** `package-lock.json` differs only in platform-metadata noise (`libc: glibc` entries) from `npm install` running in this sandbox's environment — `package.json` itself is byte-identical to your baseline, so no dependency actually changed. `next-env.d.ts` and `tsconfig.tsbuildinfo` are this sandbox's own auto-generated artifacts. None of the three are shipped.

## 3. Migration: `20261104110000_purchasing_and_receiving`

Additive only, checked line by line against the init migration's own conventions (same review
discipline as the Suppliers migration's checkpoint):

- **2 new enums** (native `CREATE TYPE ... AS ENUM`, matching every other enum in this schema — not TEXT+CHECK), **5 new tables**, **0 changes to any existing table's columns.**
- **Org isolation at the constraint level**: every table's `org_id` participates in a composite FK back to its parent (`branch`, `supplier`, `item`, `warehouse`, or another new table), same `ON DELETE RESTRICT ON UPDATE CASCADE` shape the init migration already uses.
- **Two CHECK constraints** on `goods_receipt_line`: quantities non-negative, and `accepted_qty + rejected_qty = received_qty` — enforced at the database level, not just by the Zod schema in `goods-receipt-service.ts`. `material_lot.quantity_received > 0` similarly.
- **Append-only enforcement**: `goods_receipt`/`goods_receipt_line` get the same `prevent_mutation()` trigger that already guards `stock_movement`/`audit_log`/`exchange_rate`/`job_cost_actual`. A posted receipt is corrected with a stock adjustment, never an `UPDATE`. `purchase_order`/`purchase_order_line`/`material_lot` are ordinary mutable data and are **not** made immutable (a PO's status and a lot's status/expiry legitimately change over time).
- **Runtime grants**, guarded by the same `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime')` pattern every prior self-granting migration uses: full CRUD on `purchase_order`/`purchase_order_line` (ordinary data); `SELECT, INSERT` only on `goods_receipt`/`goods_receipt_line` (append-only, belt-and-suspenders with the trigger); `SELECT, INSERT` on `material_lot` plus a **column-restricted** `UPDATE (status, expiry_date)` — every other column on that table, including `quantity_received`, can never be updated by the running application, enforced at the privilege level rather than by service-layer discipline alone.
- Searched every existing `migration.sql` for the new type/table/constraint names — no collisions.

Applying this migration is the one step that genuinely cannot be verified in this sandbox (no
reachable Postgres, and `npx prisma generate`/`migrate dev`/`validate` all fail with `403
Forbidden` fetching the schema-engine binary from `binaries.prisma.sh` — your network, not mine,
has no such restriction). See §9 for the exact command.

## 4. Design decisions worth restating (full rationale lives in the code comments)

1. **Idempotency is header-level for receipts, not per-line.** `GoodsReceipt.clientRequestId` covers the whole submission; a UI retry resubmits the entire delivery note once. The individual `StockMovement`/`MaterialLot` rows a receipt creates get their own fresh, server-generated ids — they don't need their own idempotency key because the header check already prevents the creating code from running twice.
2. **Over-accepting is hard-blocked; over-receiving-then-rejecting is allowed.** Cumulative *accepted* quantity against a PO line is bounded by the ordered quantity, with `ConflictError` on violation and no override in this milestone. Physically receiving more than was ordered and rejecting the excess at inspection is a legitimate, common receiving scenario and is not blocked — only the quantity that actually enters inventory is bounded. I did **not** build an authorized-exception workflow for deliberately over-accepting beyond the ordered quantity; the mandate allows one, but inventing the approval process for it is a business decision, not an engineering one — flagging it in §7 rather than deciding it silently.
3. **Cost always comes from the PO line, never the client**, for both the stock movement and the `GoodsReceiptLine`/`MaterialLot` rows — same rule every other inventory-affecting endpoint in this codebase already follows.
4. **The whole receipt submission is one transaction.** Header + every line's `GoodsReceiptLine` + `StockMovement` + `MaterialLot` + the PO's resulting status commit or roll back together. This required the `stock-core.ts` change in §2b — reusing `postMovement` unmodified from inside another transaction would have opened a second database connection and broken atomicity silently (stock posted but no `GoodsReceiptLine`, on a mid-transaction failure). Caught during design, not after.
5. **`purchase_order:confirm` is its own capability**, withheld from `INVENTORY_MANAGER` (segregation of duties — confirming a PO is a financial commitment, same category as `sales_order:confirm`). `goods_receipt:create`/`read` *are* granted to that role — physically receiving an already-committed delivery is a direct extension of `stock:receive`, which the role already holds, and creates no new financial commitment.

## 5. Capability matrix (verified against `authz.ts`, not assumed)

| Role | `purchase_order:create/update` | `purchase_order:confirm` | `goods_receipt:create` | `goods_receipt:read` | `cost:read` (sees unit price/total) |
|---|---|---|---|---|---|
| OWNER_ADMIN | ✓ | ✓ | ✓ | ✓ | ✓ |
| OPERATIONS_MANAGER | ✓ | ✓ | ✓ | ✓ | ✓ |
| INVENTORY_MANAGER | ✓ | ✗ | ✓ | ✓ | ✗ |
| PRODUCTION_MANAGER | ✗ (read only) | ✗ | ✗ | ✓ | ✓ |
| FINANCE_MANAGER | ✗ (read only) | ✗ | ✗ | ✓ | ✓ |
| VIEWER | ✗ (read only) | ✗ | ✗ | ✓ | ✗ |
| PRODUCTION_OPERATOR | ✗ (no capability at all) | ✗ | ✗ | ✗ | ✗ |

## 6. Verification performed vs. not performed

**Performed, in this sandbox:**
- `npx next typegen && npx tsc --noEmit` — see §6a.
- `npx eslint` over every new/modified file listed in §2 — found and fixed one genuine issue (an unescaped apostrophe in `app/(app)/purchasing/orders/[id]/page.tsx`, `react/no-unescaped-entities`). Re-run after the fix: **0 errors, 0 warnings.**
- `npx vitest list`/`npx vitest run` against the Purchasing/Receiving test files and against `src/server/dev/__tests__/test-db-guard.test.ts` — all three are blocked at the same point, **before any test file is even collected**: `vitest.global-setup.ts` runs exactly once for the whole process (not per file) and calls `assertSafeTestDatabase()` unconditionally, which refuses outright with no `.env.test` present. I initially assumed `test-db-guard.test.ts` (pure functions, no I/O) could be run standalone and said so in an earlier draft of this section — that was wrong, caught by actually running the command rather than trusting the assumption, and corrected here. All three files are therefore in the same unverified state: written and statically checked, not executed. This is the global setup correctly doing its job uniformly, not a bug — it has no way to know in advance that one particular file wouldn't have touched a database.
- Full read-through of the migration SQL, the schema diff, the `authz.ts` diff, and every modified file's diff against baseline (not just a file-count check) — see §2–3.

**Not performed, and why (mandate §15):**
- Neither `purchase-order-service.test.ts` nor `goods-receipt-service.test.ts` was executed. Both are real-database tests (same convention as every other module in this codebase — a fresh random org per test against a live Postgres, no mocks), and I was instructed not to connect to your local database or to Neon, and this sandbox has no reachable Postgres of its own regardless. I wrote and statically checked them; I did not run them. See §9 for the exact local command.
- `npx prisma migrate dev` / `npx prisma generate` were not run — see §3's last paragraph. This is why `tsc --noEmit` still reports errors (below) — once you run either command locally, the generated Prisma client will know about the five new models and these disappear without any code change.
- No browser/UI testing was performed. I did not claim it was.

### 6a. `tsc --noEmit` result, root-caused line by line (not assumed from the count)

60 errors, **every one tracing to the single known cause**: the Prisma client bundled in this
sandbox predates this schema change, and `prisma generate`/`migrate dev` cannot be re-run here
(403 from `binaries.prisma.sh`, same blocker documented in every prior milestone's verification).
Confirmed by category, not just by total:

- **~24 direct errors** — `Property 'purchaseOrder'/'purchaseOrderLine'/'goodsReceipt'/'goodsReceiptLine'/'materialLot' does not exist on type 'PrismaClient'` (or `'TransactionClient'`), and `has no exported member 'PurchaseOrderGetPayload'/'PurchaseOrderWhereInput'/'GoodsReceiptGetPayload'` from the generated namespace — exactly the new models' call sites in `purchase-order-service.ts` and `goods-receipt-service.ts`, no more and no fewer.
- **~36 downstream errors** — `implicitly has an 'any' type` on `.map()`/`.groupBy()`/`.find()` callback parameters, and `Property '...' does not exist on type '{}'` on variables whose declared type comes from one of the above calls. Mechanical consequences of the direct errors, not independent bugs: once the client is regenerated, every one of these resolves without a code change (same pattern the Suppliers milestone's checkpoint documented for its own 4 downstream errors).

Before fixing `next typegen` separately (below), this run also showed the one pre-existing,
unrelated `app/layout.tsx(20,50): Cannot find name 'LayoutProps'` error the Suppliers checkpoint
already flagged. Running `npx next typegen` first (a pure codegen step, no database involved)
regenerates Next's route-type ambients and makes that one disappear — it isn't part of this
milestone and I didn't touch that file, but `npm run typecheck` (which already runs `next
typegen && tsc --noEmit` per your `package.json`) is the cleaner command to use going forward
instead of bare `tsc --noEmit`, and I've used it for this verification.

**Net new, independent type/lint errors introduced by this milestone's code: zero.**

## 7. Known limitations / decisions needing your input

1. **No authorized-over-accept-exception workflow.** Over-accepting beyond a PO line's ordered quantity is a hard `ConflictError` with no override. The mandate permits an exception path; I didn't invent one, since the approval workflow around it (who can authorize it, whether it needs a reason, whether it's logged differently) is a business decision. Tell me if you want one and how it should work, and I'll build it as its own small addition rather than guessing.
2. **Lot traceability is incoming-only** (mandate priority F is listed as "a critical ERP capability" and spans the full chain). This milestone creates one `MaterialLot` per accepted goods-receipt line — the first arrow of Supplier → PO → Goods Receipt → Incoming Lot. **Not built**: lot-level consumption when material is issued to a production job (currently `material:issue` draws from a warehouse balance, not a specific lot), finished-goods batch creation, or dispatch-side traceability. This is explicitly the next milestone, not a partial/buggy version of this one — the schema's own comment on `MaterialLot` says so, so a future reviewer doesn't mistake the gap for an oversight.
3. **`goods_receipt.received_at` date-only picker and timezone.** The receiving form sends `YYYY-MM-DDT00:00:00Z` for a date-only field (same convention every other date-only picker in this app already uses). A narrow edge case: a user in UTC+9 through UTC+14 entering today's date very close to local midnight could have it land just past the server's 5-minute future-dated grace window and be rejected. This is a pre-existing pattern in the app (other date pickers have the same latent behavior), not something new I introduced or think needs fixing on its own — noting it so it isn't a surprise if it ever comes up.
4. **Test-database hardening** closes the gap the Suppliers checkpoint flagged, but I did not go further and port the same confirmation discipline into anywhere else that might warrant it — if there are other places you'd want this (a staging-seed script, say), say so and I'll look.

## 8. Dependencies between the changes in this delivery

- `goods-receipt-service.ts` depends on the `stock-core.ts` change (§2b/§4.4) — it cannot be removed or reverted independently without breaking atomicity.
- `goods-receipt-service.ts` depends on `purchase-order-service.ts` exporting `findPoInScope`/`branchWhere` (already designed that way by `purchase-order-service.ts` itself, per its own trailing comment) — the receiving service deliberately does not re-derive PO scoping independently.
- The frontend pages depend on the API routes, which depend on the two services, which depend on the migration having been applied (the generated Prisma client must know about the five new models). Applying the migration is therefore the one blocking step before anything else in this delivery can run end-to-end — see §9, step 1.
- The test-database hardening (`db-target.ts`/`test-db-guard.ts`) has no dependency on, and is not depended on by, the Purchasing/Receiving code — it's an independent, unrelated change bundled into this same delivery only because nothing had been handed back to you since it was finished.

## 9. Exact commands to run locally

All of these use **your local/test database only**, same caveat as every prior delivery: never
point `MIGRATION_DATABASE_URL` at production for any of these, never pass `--accept-data-loss`,
never run `migrate reset` against a database with real data. Copy-pasteable in either Windows
CMD or PowerShell (no shell-specific syntax below).

```
:: 1. Apply the new migration and regenerate the client (creates
::    prisma/migrations/20261104110000_purchasing_and_receiving against your local/test DB,
::    then regenerates src/generated/prisma from the updated schema). This also makes every
::    tsc error in §6a disappear.
npx prisma migrate dev

:: 2. If mops_runtime already existed before step 1, the migration self-grants and step 2 is a
::    no-op safety net, not required on a fresh setup. Run only if you want to re-confirm the
::    grants, as your Postgres/Neon owner-equivalent role:
::    psql "%YOUR_SUPERUSER_URL%" -f docs/db-roles-and-security.sql   (Stage 1 + 3 only)

:: 3. Static verification (same as every prior milestone; next typegen first per section 6a)
npm run typecheck
npx eslint src app components lib

:: 4. The two new test files specifically, then the full backend suite
npx vitest run src/server/modules/purchasing/__tests__/purchase-order-service.test.ts
npx vitest run src/server/modules/purchasing/__tests__/goods-receipt-service.test.ts
npm test

:: 5. The pure unit test for the test-database hardening (no database needed, but confirm it
::    locally too)
npx vitest run src/server/dev/__tests__/test-db-guard.test.ts

:: 6. UI test suite (unaffected by this milestone, but confirm nothing regressed)
npm run test:ui
```

**Expected outcome:** step 3 reports zero errors. Steps 4 and 5 should show all tests passing —
none of this was run by me (§6), so treat the first local run as the real verification, not a
formality; if anything fails, paste the output back and I'll fix it rather than you having to
debug my code. Step 6 should be unaffected since nothing in this delivery touches the UI test
harness.

Then, in the browser against your own dev server (`npm run dev`): create a supplier (if you
don't have one already), create a draft PO, confirm it, receive goods against it (try a partial
receipt, then complete it; try rejecting a line and check no stock posts for the rejected
portion; try over-accepting and confirm it's refused), and check the new "Purchasing" nav item
and the supplier detail page's new "Purchase orders" section render correctly for each role. I
have not done this and am not claiming to have.
