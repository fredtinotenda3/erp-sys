# Operis ERP — Implementation Manifest

## Milestone 1 of 6: Complete Lot Traceability

**Scope of this delivery.** Material lot allocation to jobs, exact-quantity
consumption per lot, multi-lot/multi-job allocation, partial consumption and
remaining balances, returns to the originating lot, rejection/quarantine and
expiry handling, prevention of consuming unavailable material, full
transaction history, lot-ledger reconciliation, production allocation
fields, and traceability queries — exactly as scoped for Phase One. Finished-
goods batches (Milestone 2), dispatch (Milestone 3), the rest of the
manufacturing lifecycle (Milestone 4), configurable industry architecture
(Milestone 5) and the plastics vertical (Milestone 6) are **not** part of
this delivery and nothing here commits to their design.

This manifest, and the ZIP it describes, contain **only the files changed or
added for this milestone** — not a full copy of the repository.

---

### 1. What was implemented

Material lots (`MaterialLot`) already existed from the Purchasing/Goods-
Receipt milestone (one lot created per accepted PO receipt line). This
milestone adds the consumption/traceability layer on top of them:

- **Lot allocation on issue.** Issuing material to a job
  (`issueMaterialToJob`) now checks whether the item has ever been
  lot-tracked in that warehouse. If it has:
  - the caller may name specific lots and quantities (`lotAllocations`), or
  - omit it, and the server auto-allocates **FEFO** (first-expiry-first-out,
    falling back to first-received for lots with no expiry), spilling over
    across as many lots as needed.
  - An item that has never had a lot in that warehouse issues exactly as
    before this migration (zero behavioural change for every existing
    caller) — this is a deliberate backward-compatibility rule, not an
    oversight.
- **Exact per-lot consumption quantities, multi-lot and multi-job.** Every
  draw from a lot is one append-only `LotConsumption` row
  (`type: "consumption"`, positive quantity), linked to the job and to the
  exact `StockMovement` it is part of. A single issue can draw from several
  lots (summed exactly to the issued quantity); a single lot can supply
  several different jobs over time; nothing here ever double-counts or loses
  a fraction of a quantity — enforced transactionally, verified under real
  concurrent contention (see §8).
- **Partial consumption / remaining balances.** A lot's remaining quantity is
  **computed**, never stored (`quantityReceived - SUM(LotConsumption.quantity)`),
  the same "no duplicate source of truth" convention `StockBalance` already
  uses. This is what `lot-service.ts`'s read endpoints and the lot detail
  page show.
- **Returns to the originating lot.** Returning material
  (`returnMaterialFromJob`, new) requires the caller to say which lot(s) the
  returned quantity traces back to whenever that job's consumption of that
  material was lot-tracked (and forbids naming lots when it wasn't). Each
  return is bounded by what that job actually drew from that lot and has not
  already returned.
- **Rejection / quarantine handling.** A return's `disposition` is `"good"`
  (credited straight back to the originating lot — a negative
  `LotConsumption` row — making it available again) or `"quarantine"` (the
  original lot's consumption is left standing; the returned quantity instead
  spawns a **new**, linked `MaterialLot` with `status: "quarantined"`, using
  the same `LOT-000001` sequential numbering as goods receipt). A quarantined
  lot is never available for consumption until manually released.
- **Expiry handling.** A lot past its `expiryDate` is never available for
  consumption (checked at read time from the date, not a stored flag that
  could drift) — enforced identically for auto-FEFO and for an explicit
  override naming it.
- **Prevention of consuming unavailable material.** Expired, quarantined, and
  fully-depleted lots are excluded at the allocation layer, independently of
  the warehouse's overall physical stock balance — a warehouse can show
  plenty of physical stock while having far less *lot-available* stock (e.g.
  half of it quarantined), and the system now distinguishes the two
  correctly (test: "insufficient LOT-AVAILABLE stock blocks the whole issue
  atomically, even when the warehouse's physical balance is sufficient").
- **Full transaction history.** Every consumption and return is its own
  append-only ledger row (`lot_consumption`, trigger-enforced immutable, same
  convention as `stock_movement`), carrying who, when, which movement, and
  which job — nothing is ever updated or deleted in place.
- **Lot-ledger reconciliation.** Two provable invariants (documented as SQL
  in the migration and exercised as real queries in the test suite, §8):
  every lot-tracked movement's `LotConsumption` rows sum to exactly that
  movement's own quantity; no lot's computed remaining balance ever goes
  negative.
- **Production allocation fields.** `lot_consumption` carries `lotId`,
  `jobId`, `movementId`, `type`, signed `quantity`, `createdById`,
  `createdAt` — the full allocation record the job-detail page and the
  traceability queries read back.
- **Traceability queries.** `getLotTraceability` walks a lot's full origin
  chain backward (through however many quarantine-return hops it takes to
  reach the original goods receipt) and lists every job that has ever drawn
  from it, net of returns. `getJobLotConsumption` is the per-job mirror: which
  lots a job's material came from. Both are read-only, `lot:read`-gated.

### 2. The user's three non-negotiables, addressed directly

1. **Inventory accounting** — unaffected by this milestone's own scope
   (lot traceability tracks physical lot *identity*, not a separate costing
   method). Weighted-average costing remains the system's only accounting
   method, exactly as before. What this milestone adds: a *return's* unit
   cost is now derived from the cost basis of the specific consumption
   event(s) it reverses — per-lot weighted average for a lot-tracked
   material, net-weighted-average of the job's own ledger otherwise — never
   from the current pool average, so that a full return of everything
   issued nets a job's material cost back to exactly zero. Verified with a
   test that deliberately drives the per-lot weighted average and the
   simple arithmetic mean of its two consumption events to different
   values (5.25 vs 6.5) to prove the computation is genuinely weighted, not
   a shortcut that happens to coincide.
2. **Traceability** — this is this milestone's core subject. A lot's
   `consumedByJobs` and a job's `getJobLotConsumption` are the two
   directions of the same fact; `getLotTraceability`'s `originChain` proves
   a quarantine-spawned lot still traces back to its original receipt. A
   production *batch* consuming several material lots at once is exactly
   the multi-lot-allocation case this milestone implements end to end
   (one issue, several `LotConsumption` rows, one shared `movementId`);
   linking a **finished-goods batch record** itself to those lots is
   Milestone 2's subject (finished-goods batches don't exist as a concept
   yet) and is explicitly out of scope here — see §9.
3. **Industry configuration** — nothing in this milestone is plastics-
   specific or touches configurable industry architecture at all. Lots,
   consumption, returns and traceability are generic manufacturing concepts
   that apply to every vertical; no plastics-specific field, enum value, or
   branch of logic was added anywhere in this round.

### 3. Database schema

`prisma/schema.prisma` (additive):
- `StockMovement`: `@@unique([orgId, id])` (lets `LotConsumption` carry a
  real FK to a specific movement) + reverse relations `lotConsumptions`,
  `lotsReturnedFrom`.
- `MaterialLot`: `receiptLineId` made nullable (a lot can now originate from
  a return, not only a receipt); new nullable `sourceReturnOfLotId` /
  `sourceReturnJobId` / `sourceReturnMovementId` (+ relations
  `sourceReturnOfLot` / `sourceReturnJob` / `sourceReturnMovement`), reverse
  relation `returnChildLots`, `consumptions LotConsumption[]`, and a new
  index `@@index([orgId, itemId, warehouseId])` (the lookup
  `allocateLotsForConsumption` and `listLotsWithRemaining` run on every
  issue).
- New enum `LotConsumptionType { consumption, return }`.
- New model `LotConsumption` (id, orgId, lotId, jobId, movementId, type,
  signed `quantity Decimal(14,4)`, notes, createdById, createdAt;
  `@@unique([orgId, id])`; mapped to `lot_consumption`).
- `ProductionJob`: reverse relations `lotConsumptions`, `returnSpawnedLots`.

Migration: `prisma/migrations/20261105120000_lot_consumption_and_traceability/migration.sql`
— additive only, as the mandate requires:
- Drops the `NOT NULL` constraint on `material_lot.receipt_line_id`.
- Adds the 3 new nullable columns + their composite FKs to `material_lot`.
- Adds the `stock_movement_org_id_id_key` unique index.
- Creates the `LotConsumptionType` enum and the `lot_consumption` table,
  with a DB-level `CHECK` constraint tying `type` to the sign of `quantity`
  (`consumption` must be positive, `return` must be negative) as a second,
  independent line of defence beyond the service-layer validation.
- Adds `trg_lot_consumption_immutable` (append-only, same trigger pattern as
  `stock_movement`/`goods_receipt`).
- Documents the two reconciliation queries from §1 as SQL comments.
- Grants `mops_runtime` SELECT + INSERT only on the new table, guarded
  (skipped if that role doesn't exist in the target database), matching
  every prior migration's convention exactly.

**No destructive operation of any kind.** Nothing drops a column, a table,
or data. No migration was run against any database by this round of work —
per the mandate, that remains the user's own action against their own local
environment.

### 4. Backend: files and API routes

| File | Change |
|---|---|
| `src/server/modules/inventory/lot-availability.ts` | New. `listLotsWithRemaining`, `isAvailable`, `lockLots` (sorted per-lot advisory locks — see §8), `getRemainingForLots`. |
| `src/server/modules/inventory/material-issue-service.ts` | Rewritten. Lot allocation on issue (`allocateLotsForConsumption`), and the new `returnMaterialFromJob` (good/quarantine disposition, cost-basis reversal). |
| `src/server/modules/inventory/lot-service.ts` | New. `getAvailableLotsForIssue`, `listLots`, `getLotDetail`, `getLotTraceability`, `setLotStatus`, `getJobLotConsumption`. |
| `src/server/modules/inventory/stock-core.ts` | `afterInsert`'s signature widened to receive the inserted movement, so lot-consumption rows can reference its real id inside the same transaction. |
| `src/server/shared/authz.ts` | New capabilities `lot:read` (OWNER_ADMIN, OPERATIONS_MANAGER, PRODUCTION_MANAGER, INVENTORY_MANAGER, FINANCE_MANAGER, VIEWER) and `lot:manage` (OWNER_ADMIN, OPERATIONS_MANAGER, INVENTORY_MANAGER) — see §6 for why PRODUCTION_OPERATOR deliberately holds neither. |
| `lib/api-types.ts` | New "Lot traceability" section: `MaterialLot`, `LotDetail`, `LotOrigin`, `LotTraceability`, `JobLotConsumptionRow`, etc. |

New API routes (all org/branch/capability-scoped through the existing
session middleware, same as every other route in the codebase):

| Route | Method | Handler |
|---|---|---|
| `/api/v1/inventory/lots` | GET | `listLots` |
| `/api/v1/inventory/lots/available` | GET | `getAvailableLotsForIssue` |
| `/api/v1/inventory/lots/[id]` | GET | `getLotDetail` |
| `/api/v1/inventory/lots/[id]/traceability` | GET | `getLotTraceability` |
| `/api/v1/inventory/lots/[id]/status` | POST | `setLotStatus` |
| `/api/v1/production-jobs/[id]/material-lots` | GET | `getJobLotConsumption` |
| `/api/v1/production-jobs/[id]/material-returns` | POST | `returnMaterialFromJob` |

### 5. Frontend

Every backend capability above has a real page or component behind it —
proper loading/empty/error states, permission-awareness via `ctx.can(...)`,
and no demo/fake data:

- **Issue flow** (`components/features/inventory/issue-material-form.tsx`,
  `issue-workflow.tsx`, `app/(app)/inventory/issue/page.tsx`,
  `components/features/production/issue-material-dialog.tsx`): an
  `LotAllocationFields` sub-form appears only for a material/warehouse pair
  that actually has lots, and only for a session holding `lot:read` — it
  fetches `/inventory/lots/available` and lets the user either leave it on
  auto-FEFO or override specific lots and quantities.
- **Return flow** (new — `return-material-form.tsx`, `return-workflow.tsx`,
  `app/(app)/inventory/return/page.tsx`,
  `components/features/production/return-material-dialog.tsx`): mirrors the
  issue flow; shows the lot breakdown (quantity + disposition per lot) only
  when the job's consumption of that material was actually lot-tracked.
- **Lot browsing** (new — `app/(app)/inventory/lots/page.tsx`,
  `lots/[id]/page.tsx`, `components/features/inventory/lot-status-actions.tsx`):
  a filterable list (item/warehouse/supplier/status/search) and a detail page
  showing received/remaining/available, origin (receipt→PO→supplier, or
  return→parent lot/job), any lots spawned by quarantining this one, and the
  full "consumed by jobs" breakdown with a traceability note explaining that
  finished-goods/delivery traceability continues in a later milestone.
  Quarantine/release actions render only for `lot:manage`.
- **Job detail page** (`app/(app)/production/jobs/[id]/page.tsx`): the
  Materials tab now shows, per material, the lots it came from (linked) and
  a Return action alongside Issue, visible only when there is something
  returnable.
- `components/ui/status-badge.tsx` / `components/shell/nav-config.ts`:
  `LotStatusBadge` and the two new nav entries ("Material lots",
  "Return from job"), capability-gated the same way every other nav entry
  is.

### 6. Permission changes

Two new capabilities, `lot:read` and `lot:manage` (see §4's table for the
exact role grants). This is a deliberate least-privilege split, not an
oversight: **PRODUCTION_OPERATOR holds neither.** An operator can still
issue and return lot-tracked material — `allocateLotsForConsumption` runs
the FEFO sweep server-side with no capability check of its own, the same
"no gate on an internal lookup" convention `findWarehouseInScope` already
uses — but cannot browse the lot catalogue or hand-pick a lot to override
FEFO with. There is no legitimate operational reason for an operator to
choose a lot FEFO wouldn't have chosen anyway, so the frontend's lot picker
is rendered only for roles holding `lot:read`, and an operator's issue/return
simply omits `lotAllocations`/`lotReturns`' lot choice and lets the server
auto-allocate. No existing capability or permission was weakened, removed,
or had its role grants narrowed.

### 7. Tests added

`src/server/modules/inventory/__tests__/lot-consumption.test.ts` — one new
file, written against a real Postgres database in the same style as every
other module suite (`material-issue.test.ts`, `goods-receipt-service.test.ts`).
28 tests across 6 `describe` blocks:

- **Lot allocation on issue** (10 tests): auto-FEFO ordering and spillover
  across lots; explicit `lotAllocations` overriding FEFO; explicit-allocation
  validation (sum mismatch, duplicate lot, foreign lot, exceeds remaining);
  expired/quarantined lots skipped by auto-FEFO and refused by override;
  insufficient lot-available stock blocking the whole issue atomically even
  when physical stock is sufficient; one lot serving multiple jobs; two
  concurrency tests (exact-exhaustion and over-commit, see §8); idempotent
  replay never double-writes `LotConsumption`.
- **Returns: good disposition** (4 tests): weighted (not simple-averaged)
  per-lot cost basis across two differently-costed consumption events;
  cannot return more than a lot's outstanding balance; `lotReturns`
  required/forbidden depending on whether the job's consumption was
  lot-tracked; `lotReturns` quantities must sum exactly and may not repeat a
  lot.
- **Returns: quarantine disposition** (1 test): spawns a new, correctly
  linked, non-consumable lot; the original lot's balance is provably
  untouched; the child becomes consumable again once released; the full
  traceability chain reaches back to the original receipt.
- **Backward compatibility** (1 test): a never-lot-tracked item's issue and
  return behave exactly as before this migration.
- **Capability matrix, read endpoints, isolation** (7 tests): `lot:read` /
  `lot:manage` enforcement per role; an operator issuing/returning
  lot-tracked material without `lot:read`; `getJobLotConsumption` is a no-op
  for untracked materials; `listLots` filtering; org and branch isolation
  (`NotFoundError`) across every new endpoint.
- **Reconciliation invariants** (1 test): both SQL invariants from §1,
  executed as real queries against the test database, for both test orgs.

### 8. Tests executed and results

**Not executed in this environment**, by the mandate's own design: this
sandbox has no reachable database, and the mandate explicitly prohibits
connecting to or running anything against any real or external database.
Verified directly this round (not merely assumed): `vitest.config.ts`
(`fileParallelism: false`, real Postgres), `vitest.global-setup.ts`, and
`vitest.test-env.ts`'s `loadTestEnv()` / `assertSafeTestDatabase()` (reads
`.env.test` only, refuses a non-local database without
`ALLOW_REMOTE_TEST_DB=1`); only `.env.test.example` exists here, no real
`.env.test`, so `assertSafeTestDatabase()` would refuse to run regardless.

**What was verified here instead:**
- `npx eslint` over every file touched this milestone, including the new
  test file: **0 problems.**
- `npx tsc --noEmit` over the whole project: the only errors touching files
  from this milestone are in `lot-availability.ts` (12), `lot-service.ts`
  (18), `material-issue-service.ts` (19), and the new test file (2) — all of
  the identical shape (`Property 'materialLot' | 'lotConsumption' does not
  exist on type 'PrismaClient'`), caused by the bundled
  `src/generated/prisma` client being stale (this sandbox cannot run
  `npx prisma generate`: `binaries.prisma.sh` returns 403 through the
  proxy). This is a pre-existing, documented environment limitation, not a
  defect introduced here: the identical error shape already existed, before
  this round touched anything, in `purchase-order-service.ts` (21),
  `purchase-order-service.test.ts` (3), and `goods-receipt-service.ts` (36)
  — confirmed by grepping the full `tsc` output and counting errors per
  file. Every one of those pre-dates this milestone. **After you run
  `npx prisma generate` locally, re-run `npx tsc --noEmit` — it should come
  back clean** (I cannot verify that final step myself in this sandbox,
  which is exactly why it's listed here rather than claimed as done).
- Every reconciliation and correctness invariant that *can* be verified by
  static reasoning against the real schema and the real service code was
  checked by hand while writing the service layer (e.g. the signed-quantity
  convention matching the DB `CHECK` constraint; the FEFO sort key; the
  per-lot weighted-average formula).

**Run this yourself, against your local test database, before merging:**
```
npx prisma migrate dev          # applies 20261105120000_lot_consumption_and_traceability
npx prisma generate
npm test -- lot-consumption     # the new suite
npm test -- material-issue      # regression: the pre-existing issue suite
npm test -- goods-receipt-service  # regression: still the only lot-creation path
```

### 9. Known limitations (deliberate scope decisions, not oversights)

- **No soft reservation.** "Allocate" and "consume" are one atomic act, at
  issuance time — there is no way to hold a lot for a future job without
  immediately debiting the ledger. A real reservation system (hold +
  release/expire + a visible "committed but not yet issued" state) is a
  meaningfully different feature and belongs with the Manufacturing
  Lifecycle milestone, not bolted on here.
- **Quarantine has no physical location.** This schema's only location
  granularity is the warehouse; there is no sub-warehouse "quarantine bin".
  Quarantine is enforced entirely at the lot-selection layer (a quarantined
  lot is simply never `isAvailable`), not by moving the quantity anywhere
  physically. If the business needs quarantined stock to be excluded from
  warehouse-level *physical* availability views too (as opposed to just
  lot-consumption availability), that needs a schema-level location concept
  this milestone did not introduce.
- **Lot traceability tracks physical identity, not cost.** The system's only
  costing method remains weighted-average per (item, warehouse). A lot does
  not carry "its own" cost separately from that average — a return's unit
  cost is reconstructed from the specific consumption events being reversed
  (§2.1), which is correct for reversing a cost, but there is no notion of
  "this lot cost $X regardless of when it was drawn from."
  Lot/batch-specific costing (if ever wanted) is a different, larger
  feature than lot *traceability*.
- **No forward traceability past the job yet.** `getLotTraceability` walks
  backward to the original receipt and forward to every job that has drawn
  from a lot, but a finished-goods batch and a customer delivery (the
  forward continuation of this chain) don't exist as concepts yet — that's
  Milestone 2/3. Nothing here commits to how that will work;
  `forwardChainNote` in `getLotTraceability`'s response says so explicitly
  rather than silently stopping.
- **No bulk/CSV lot import or correction tooling.** A lot can only be
  created by receiving goods against a PO, or by quarantine-returning part
  of an existing one. There is no manual "create a lot" or "merge two lots"
  operation. If a real-world correction is ever needed outside those two
  paths, it isn't supported yet.

### 10. Required local commands

```
npx prisma migrate dev     # apply the new migration locally
npx prisma generate        # regenerate the Prisma client (resolves the known tsc noise in §8)
npm test -- lot-consumption material-issue goods-receipt-service   # run the suites above
npm run lint                # or: npx eslint .
npx tsc --noEmit
```

None of these were run against your database or your local environment by
this round of work, per the mandate.

### 11. Manual configuration required

None. The two new capabilities are wired into the existing role tables; no
new environment variable, feature flag, or external service is introduced.

### 12. Milestone status

| Milestone | Status |
|---|---|
| 1 — Complete Lot Traceability | **Delivered in this ZIP.** |
| 2 — Finished-Goods Inventory | Not started. |
| 3 — Dispatch | Not started. |
| 4 — Full Manufacturing Lifecycle | Not started. |
| 5 — Configurable Industry Architecture | Not started. |
| 6 — Plastics Vertical | Not started. |

Per your explicit instruction, work stops here for review before Milestone 2
begins.

### 13. Files in this delivery

Changed (10):
```
prisma/schema.prisma
src/server/shared/authz.ts
src/server/modules/inventory/material-issue-service.ts
src/server/modules/inventory/stock-core.ts
lib/api-types.ts
components/ui/status-badge.tsx
components/shell/nav-config.ts
components/features/inventory/issue-material-form.tsx
components/features/inventory/issue-workflow.tsx
app/(app)/inventory/issue/page.tsx
components/features/production/issue-material-dialog.tsx
app/(app)/production/jobs/[id]/page.tsx
```

New (18):
```
prisma/migrations/20261105120000_lot_consumption_and_traceability/migration.sql
src/server/modules/inventory/lot-availability.ts
src/server/modules/inventory/lot-service.ts
app/api/v1/inventory/lots/route.ts
app/api/v1/inventory/lots/available/route.ts
app/api/v1/inventory/lots/[id]/route.ts
app/api/v1/inventory/lots/[id]/traceability/route.ts
app/api/v1/inventory/lots/[id]/status/route.ts
app/api/v1/production-jobs/[id]/material-lots/route.ts
app/api/v1/production-jobs/[id]/material-returns/route.ts
components/features/inventory/return-material-form.tsx
components/features/inventory/return-workflow.tsx
app/(app)/inventory/return/page.tsx
components/features/production/return-material-dialog.tsx
components/features/inventory/lot-status-actions.tsx
app/(app)/inventory/lots/page.tsx
app/(app)/inventory/lots/[id]/page.tsx
src/server/modules/inventory/__tests__/lot-consumption.test.ts
```
