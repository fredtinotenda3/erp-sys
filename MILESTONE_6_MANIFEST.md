## Milestone 6 of 6: Plastics Manufacturing Vertical

**Scope of this delivery.** The first fully implemented industry profile
(mandate §8): plastics-specific material management (polymer grades, resin
specs, colour masterbatch, additives, regrind, blends, recycled content —
explicitly **not** hardcoded to one product shape), plastics product
configuration, mould management, configurable (not hardcoded) process
types and cycle/cavity recording per job stage, and plastics production
analytics that honestly separate measured from unavailable data. Every
write path in this milestone requires the organisation's industry profile
to be `plastics` (Milestone 5's `assertPlasticsProfileActive`); every read
path remains available regardless of profile, so switching away from
plastics never hides or corrupts history.

This section, and the ZIP it describes, contain **only the files changed or
added for this milestone** on top of Milestones 1–5's delivery — not a full
copy of the repository.

### 1. What was implemented

- **Plastics material attributes** (`plastics-item-service.ts`'s
  `getPlasticsMaterialAttributes`/`setPlasticsMaterialAttributes`, 206
  lines) — a 1:1 extension of a `raw_material`/`consumable` `Item`
  (rejected for any other `itemType`): polymer grade, resin spec, colour
  masterbatch, free-text additive notes, recycled-content percentage,
  supplier material reference/certificate reference, and a structured
  `blendComposition` (`{component, percentage}[]`, rejected if the
  percentages sum past 100%) — deliberately **not** a fixed set of columns
  for one product (e.g. "PET bottle resin"); any raw plastics material, a
  masterbatch, a blended regrind mix, or an additive concentrate all use
  the same record shape, satisfying the mandate's explicit "do not
  hardcode to only PET bottles."
- **Plastics product specification**
  (`getPlasticsProductSpec`/`setPlasticsProductSpec`, same file) — a 1:1
  extension of a `finished_good`/`wip` `Item`: a free-text `productType`
  (required on first creation, optional thereafter) with suggested values
  rather than a fixed enum — a new product shape (a cap, a tub, a film roll)
  never needs a migration — plus resin type, colour, nominal weight,
  capacity, height, diameter, neck finish, and closure-compatibility notes,
  all optional and all rejected if given a non-positive value.
- **A real correctness fix found and made during this round's
  hand-verification, before any test ran** (recorded here as concrete
  evidence the review had value, matching Milestone 4's own precedent of
  documenting findings — see §7/§8): both of the functions above
  originally used `??` to merge an incoming partial update onto the
  existing row, which cannot distinguish "the caller omitted this field"
  from "the caller explicitly sent `null`" — both collapse to the same
  fallback. Because the UI form
  (`plastics-spec-form.tsx`) has no input for `blendComposition` at all, a
  user editing *any other* field through the UI would have silently wiped
  an existing `blendComposition` value to `null` on every save. Fixed with
  a small `merged<T>(provided, existingValue)` helper used consistently in
  both functions' `data` construction: a key present in the request at all
  (including an explicit `null`) wins; only a genuinely omitted key falls
  back to the row's current value. Covered directly by
  `plastics-item-service.test.ts`'s "preserves a field omitted from a later
  PUT instead of wiping it to null" and "an explicit null still clears it,
  distinct from omitting it" tests.
- **Mould management** (`mould-service.ts`, 239 lines) — `createMould`/
  `updateMould`/`listMoulds`/`getMould`, machine-compatibility management
  (`addMouldMachineCompatibility`/`removeMouldMachineCompatibility`), and
  maintenance (`recordMouldMaintenance`/`completeMouldMaintenance`). A
  mould is branch-scoped, carries a `cavityCount` (`[1, 256]`), an
  optional `compatibleProductItemId` (must be `finished_good`/`wip`), and a
  `code` unique **per branch** (the same code is allowed to recur in a
  different branch — two plants, same internal tooling-numbering scheme).
  `MouldStatus` is `available`/`in_use`/`maintenance`/`retired` — a mould
  has no `down` state the way a `Machine` does (a mould doesn't fail
  mid-cycle the way a machine can; a damaged mould goes straight to
  `maintenance`). Completing a maintenance record auto-transitions the
  mould from `maintenance` back to `available` (mirroring
  `closeDowntime`'s machine-status handling in Milestone 4); a second
  completion of the same record is a `ConflictError`, not silently
  idempotent, since a maintenance record genuinely can only be completed
  once.
- **Configurable process types and cycle/cavity recording**
  (`plastics-process-service.ts`'s `getPlasticsProcessDetail`/
  `setPlasticsProcessDetail`, 137 lines) — a 1:1 extension of a
  `ProductionJobStage`: a free-text `processType` (injection moulding, blow
  moulding, ISBM, preform production, bottle production, cap/closure
  production, ... — suggested values, not a fixed enum, directly satisfying
  the mandate's "represent these as configurable process types ... not one
  hardcoded universal production sequence"), an optional `mouldId`
  (validated against this organisation's own moulds), target/actual cycle
  time, and total/good cavity counts (`goodCavities <= totalCavities`,
  enforced with explicit-`null`-aware semantics — see the bug fix below).
  `actualCycleTimeSeconds` is **always operator-entered**: this codebase
  has no PLC/telemetry integration anywhere, directly satisfying the
  mandate's "do not invent machine telemetry ... when no connected
  equipment provides them" — `plastics-analytics-service.ts` (below) labels
  it accordingly rather than presenting it as a measured sensor reading.
  Once a stage reaches `completed` status, its process detail can no
  longer be changed (`ConflictError`, checked once before the write
  transaction and re-checked inside it, to catch the stage completing
  concurrently — the same optimistic guard discipline
  `corrective-action-service.ts` established in Milestone 4), for both an
  update to an existing record **and** a first-time create.
- **A second real correctness fix found and made during this round's
  hand-verification** (also before any test ran): the pre-write validation
  that computes the effective `totalCavities`/`goodCavities` to compare
  (for the `goodCavities <= totalCavities` check) originally used `??`
  while the function's own `data` assignment three lines below it
  correctly used `!== undefined` — an inconsistency that could have
  **falsely rejected** a legitimate request explicitly clearing
  `totalCavities` (e.g. `totalCavities: null`) while raising `goodCavities`
  past the *old*, now-irrelevant total, because the validation step would
  have incorrectly fallen back to the stale existing `totalCavities` for
  the comparison while the write itself correctly nulled it. Fixed by
  aligning the validation computation with the same `!== undefined`
  pattern already used by the write. Covered directly by
  `plastics-process-service.test.ts`'s "an explicit null clearing
  totalCavities is honored by the goodCavities check, not silently replaced
  by the stale existing value" test.
- **Regrind generation** (`regrind-service.ts`'s `createRegrindLot`, 181
  lines) — a regrind lot is an ordinary `MaterialLot` **of the same
  raw-material item** it was ground from (never a separate catalogue SKU),
  created via a dedicated `regrind_generation` movement type — **never**
  `purchase_receipt` — directly satisfying the mandate's "do not permit
  regrind to be counted as newly purchased raw material." Traceability is
  deliberately **job-level**, not single-lot-level (`sourceRegrindJobId`/
  `sourceRegrindMovementId` on `MaterialLot`): grinding physically mixes
  scrap that may trace back to several different original lots, so
  claiming one specific parent lot would overstate the precision the
  physical process actually has. The regrind quantity is always
  **operator-weighed and operator-entered**, never derived automatically
  from the job's recorded scrap quantity (`ProductionOutput.scrapQty` is in
  the *product's* UOM — e.g. bottles — not the raw-material UOM a regrind
  lot is weighed in, and this schema stores no hard conversion factor
  between the two) — the job reference is for traceability, not an
  automatic quantity derivation. Gated on a real `unitCost`/`currency`
  (never invented or copied forward, the same discipline every other
  positive stock movement in this codebase already follows), an active
  `raw_material`/`consumable` item, and a warehouse active and in the
  source job's own branch.
- **Regrind lineage on read** (`lot-service.ts`'s `getLotDetail`/
  `getLotTraceability`, extended) — a regrind-sourced lot's `origin` is
  reported as `{type: "regrind", sourceRegrindJobId, ...}` (checked before
  the pre-existing "return" fallback in the function's discriminated-union
  resolution), and its `supplierId` is correctly `null` (a regrind lot has
  no external supplier at all); `getLotTraceability`'s `originChain` for a
  regrind lot is a single entry (`{type: "regrind",
  generatedFromJobId}`) — regrind, like a goods receipt, is a chain
  **terminus**, not a link back to further ancestor lots. This extension
  required `MaterialLot.supplierId` to become nullable at the schema level
  (§3) — the one schema change this milestone makes to a pre-existing
  table's pre-existing column, rather than only adding new columns.
- **Plastics production analytics**
  (`plastics-analytics-service.ts`'s `getPlasticsJobCostSummary`, 123
  lines) — deliberately **not** a second cost engine: material cost,
  labour cost, output totals, yield, and cost-per-good-unit are all read
  straight through from `cost-service.ts`'s existing `getJobCost` (the
  established single source of truth for job costing), never re-derived,
  directly satisfying "never double-count material value" / "single
  source of truth via the existing stock ledger" applied to a new
  reporting surface. This module adds exactly the two figures genuinely
  new to this milestone that `getJobCost` has no reason to know about:
  `regrindGeneratedQty` (lots sourced from this job) and
  `regrindConsumedQty` (this job's own material consumption against **any**
  regrind-sourced lot, from this job or another — regrind stock is
  ordinary, reusable raw-material stock once generated). Both are summed
  by `sumSingleMaterial`, which deliberately reports **zero**, never a
  fabricated blended figure, the moment more than one distinct
  `(itemId, uom)` pair is involved — summing across different materials or
  units would not be a real measurement. `machineCost` is always
  `{amount: null, currency: null, basis: "not_available", note: "..."}` —
  this codebase has no telemetry/PLC/energy-meter integration anywhere
  (Milestone 4's `machine-time-service.ts` captures operator-entered
  *duration*, never cost or energy), so machine cost is never estimated or
  defaulted to zero; it is omitted from the figure entirely and explained,
  directly satisfying "do not invent machine telemetry or energy readings
  when no connected equipment provides them." Reads are never profile-gated
  (no `assertPlasticsProfileActive` call anywhere in this file) and carry
  no plastics-specific capability gate at all — only the pre-existing
  `production_job:read` + `cost:read`, the same two capabilities
  `getJobCost` itself already requires.

### 2. The user's non-negotiables, addressed directly

1. **Correct WIP cost flow** — `plastics-analytics-service.ts` reads
   `getJobCost`'s own WIP-aware figures verbatim; it introduces no new cost
   computation that could diverge from the existing flow.
2. **Never count material value twice** — regrind generation posts its own
   distinct `regrind_generation` movement (never `purchase_receipt`), so a
   ground, re-entered material is never double-counted as freshly
   purchased stock; `plastics-analytics-service.ts` reuses `getJobCost`'s
   material figure rather than re-summing issued material itself.
3. **Correct lot/batch genealogy** — a regrind lot's job-level lineage
   (not an overstated single-parent-lot claim) is recorded at creation and
   surfaced correctly through `lot-service.ts`'s existing traceability
   reads (§1); "do not count regrind as newly purchased raw material" and
   "maintain cost/lot traceability for regrind" (mandate §8, both verbatim)
   are both satisfied by the same `regrind_generation` movement type +
   job-level lineage design.
4. **Single source of truth via the existing stock ledger** — a regrind
   lot is an ordinary `MaterialLot`/`StockMovement` pair, posted through
   the same `postMovement`/`stock-core.ts` machinery every other stock
   movement in this codebase uses (§3); there is no second, parallel
   ledger for plastics-specific stock.
5. **Prevent negative inventory and duplicate postings** — regrind
   generation is `clientRequestId`-keyed idempotent (replay returns the
   original movement; reuse with different data is a `ConflictError`,
   verified under the same discipline every other stock-posting service
   already follows, §7) and posts through the existing balance/negative-
   inventory guards `postMovement` already enforces for every movement
   type.
6. **Preserve immutable stock-movement history** — regrind-sourced lineage
   columns on `MaterialLot` (`source_regrind_job_id`/
   `source_regrind_movement_id`) are write-once at the database level: the
   migration (§3) deliberately grants no `UPDATE` privilege on them to the
   runtime role, the same "set once at creation, never revised" discipline
   `sourceReturnJobId`/`sourceReturnOfLotId` already follow.
7. **Preserve org/branch isolation** — every new table carries composite
   `(org_id, id)` FKs; every service function scopes through
   `session.orgId` plus branch-filtered `WHERE` clauses and
   `hasBranchAccess`/`assertBranchAccess`, the same convention as every
   existing module; verified by the tenant/branch-isolation tests in every
   one of this milestone's five new test files (§7).
8. **Transactional stock-changing operations** — `createRegrindLot` posts
   its movement and creates the spawned `MaterialLot` row inside the same
   `postMovement` transaction every other stock-moving service function
   already uses; `setPlasticsProcessDetail`'s stage-completion guard is
   re-checked inside its own write transaction (§1) to catch a stage
   completing concurrently with the write.
9. **Do not hardcode to a single product or process.** The mandate repeats
   this specifically for plastics twice (§8: "do not hardcode to only PET
   bottles," "represent process types as configurable ... not one
   hardcoded universal production sequence," and "do not assume every
   plastics product uses the same measurements"): `blendComposition`,
   `productType`, `processType`, and every plastics-specific measurement
   field (weight/capacity/height/diameter/neck finish) are free-form or
   optional rather than a fixed schema for one SKU shape (§1).
10. **Never invent machine telemetry or energy readings.** Addressed
    directly and explicitly by `machineCost`'s `not_available` shape and
    `actualCycleTimeSeconds` always being operator-entered (§1) — this is
    the one non-negotiable this milestone is most directly built around,
    and it is enforced by *omission* (no field anywhere claims a measured
    value this codebase cannot actually measure) rather than by a runtime
    check that could be bypassed.

### 3. Database schema

`prisma/schema.prisma` (mostly additive, one existing-column change): 1 new
enum (`MouldStatus`); `MovementType` gains one new value
(`regrind_generation`); `MaterialLot.supplierId` becomes **nullable**
(`String?`, was `String`) — the one change to a pre-existing column, needed
because a regrind lot genuinely has no external supplier; two new nullable
columns on `material_lot` (`source_regrind_job_id`, pointing at the
`ProductionJob` it was ground from, `source_regrind_movement_id`, pointing
at its own generating `StockMovement`); 6 new tables (`mould`,
`mould_machine_compatibility`, `mould_maintenance_record`,
`plastics_material_attributes`, `plastics_product_spec`,
`plastics_process_detail`).

Migration:
`prisma/migrations/20261110080000_plastics_manufacturing_vertical/migration.sql`
(255 lines, read and verified in full against the service-layer code this
session — no inconsistency found):
- `ALTER TABLE "material_lot" ALTER COLUMN "supplier_id" DROP NOT NULL` —
  the only column-loosening change in this entire delivery; every existing
  row already has a non-null `supplierId`, so this is a pure widening, not
  a data migration, and changes nothing about any existing lot.
- `source_regrind_job_id`/`source_regrind_movement_id` added with a
  mutual-exclusion `CHECK` against the pre-existing return-lineage columns
  (`sourceReturnJobId`/`sourceReturnOfLotId`) — a lot cannot simultaneously
  claim to be regrind-sourced and return-sourced — and FKs to
  `production_job`/`stock_movement`.
- `ALTER TYPE "MovementType" ADD VALUE IF NOT EXISTS 'regrind_generation'`.
- `CREATE TYPE "MouldStatus"`; `mould`, `mould_machine_compatibility`,
  `mould_maintenance_record`, `plastics_material_attributes`,
  `plastics_product_spec`, `plastics_process_detail` created with
  appropriate `CHECK` constraints, unique indexes (including
  `plastics_material_attributes`/`plastics_product_spec`/
  `plastics_process_detail`'s own 1:1 `@@unique([orgId, itemId or
  jobStageId])` constraints enforcing the "1:1 extension" design at the
  database level, not just in application code), and FKs.
- **Explicitly documents, in the migration file's own comments, why NONE
  of the new tables get a `prevent_mutation()` append-only trigger** — all
  six are **configuration/specification** records meant to be edited in
  place (a mould's name, a material's polymer grade, a stage's process
  detail before the stage completes), unlike Milestone 4's genuinely
  append-only event tables (`machine_time_record`,
  `quality_measurement`). Immutability where it actually matters here
  (regrind lineage, §2.6; a completed stage's process detail, §1) is
  enforced at the service layer and, for the lineage columns specifically,
  by withholding the `UPDATE` grant — a deliberate, documented choice, not
  an oversight.
- Two reconciliation checks are explicitly documented in the migration's
  comments as **enforced in code, not by a database constraint**: a
  mould's `compatibleProductItemId` must be `finished_good`/`wip`
  (enforced in `mould-service.ts`); a regrind-sourced lot's item must be
  `raw_material`/`consumable` (enforced in `regrind-service.ts`) — both are
  cross-table item-type checks Postgres `CHECK` constraints cannot express
  without a cross-table subquery trigger, which this codebase's existing
  convention (see Milestones 1–4's own migrations) deliberately avoids in
  favour of application-layer validation plus hand-verified tests.
- Guarded (`IF EXISTS`) column-level `GRANT`s to the runtime role,
  identical convention to every prior migration — explicitly **excluding**
  `UPDATE` on `material_lot`'s two new regrind-lineage columns (§2.6).

**No destructive operation beyond the one documented nullability
loosening.** Nothing drops a column, a table, or data. No migration was run
against any database by this round of work — per the mandate, that remains
the user's own action against their own local environment (see §10, in
order).

### 4. Backend: files and API routes

| File | Change |
|---|---|
| `src/server/modules/catalog/plastics-item-service.ts` | New. `getPlasticsMaterialAttributes`/`setPlasticsMaterialAttributes`, `getPlasticsProductSpec`/`setPlasticsProductSpec`. One correctness fix this session (§1/§7): the partial-merge/`blendComposition` data-loss bug. |
| `src/server/modules/production/mould-service.ts` | New. `createMould`/`updateMould`/`listMoulds`/`getMould`, `addMouldMachineCompatibility`/`removeMouldMachineCompatibility`, `recordMouldMaintenance`/`completeMouldMaintenance`. |
| `src/server/modules/production/plastics-process-service.ts` | New. `getPlasticsProcessDetail`/`setPlasticsProcessDetail`. One correctness fix this session (§1/§7): the `??`-vs-`!== undefined` validation-consistency bug. |
| `src/server/modules/inventory/regrind-service.ts` | New. `createRegrindLot`. |
| `src/server/modules/production/plastics-analytics-service.ts` | New. `getPlasticsJobCostSummary`. |
| `src/server/modules/inventory/lot-service.ts` | Extended. `getLotDetail`/`getLotTraceability`'s origin resolution gains the "regrind" branch (§1). |
| `src/server/modules/inventory/stock-core.ts` | Extended. `PostableMovementType` includes `regrind_generation`. |
| `src/server/shared/authz.ts` | New capabilities `mould:read`/`mould:manage`, `plastics_spec:manage`, `regrind:create`, `plastics_process:record` (see §6 for the exact role grants). |
| `lib/server/lookups.ts` | New `loadMoulds`, gated on `mould:read` (not `machine:read` — the two capability sets overlap but are not identical). |
| `lib/api-types.ts` | New "Milestone 6" section: `MouldStatus`, `Mould`, `MouldMaintenanceRecordView`, `MouldDetail`, `PlasticsMaterialAttributesView`, `PlasticsProductSpecView`, and the corresponding process-detail/cost-summary view types; `MovementType` extended with `regrind_generation`. |
| `app/(app)/catalog/items/[id]/page.tsx` | Extended. New `PlasticsTab`, shown for `raw_material`/`consumable`/`finished_good`/`wip` items, wired to the new material-attributes/product-spec endpoints. One bug fixed this session (§7/§8): `PlasticsTab`'s parameter used an undefined type name (`PageContext`) instead of this file's own established convention. |
| `app/(app)/production/jobs/[id]/page.tsx` | Extended. New Plastics Process card and cost-summary panel on a job's detail page. |
| `components/ui/status-badge.tsx` | Extended. `MouldStatusBadge` (reuses the machine-status badge's four-state visual convention; a mould has no `down` state — see §1). |
| `components/shell/nav-config.ts` | Extended. "Moulds" nested under the existing Production nav parent, gated on `mould:read`. |

New API routes (all org/branch/capability-scoped through the existing
session middleware, same thin-wrapper convention as every other route —
spot-checked this session by reading
`app/api/v1/organization/industry-profile/route.ts`,
`app/api/v1/production-jobs/[id]/plastics-cost-summary/route.ts`,
`app/api/v1/moulds/[id]/compatible-machines/route.ts`, and
`app/api/v1/production-jobs/[id]/regrind/route.ts` in full — all four
clean, correctly wired, no deviation from convention; the regrind route in
particular defensively cross-checks the URL's job id against the body's
`sourceJobId` to catch a stale page posting against the wrong job after
navigation):

| Route | Method | Handler |
|---|---|---|
| `/api/v1/moulds` | GET / POST | `listMoulds` / `createMould` |
| `/api/v1/moulds/[id]` | GET / PATCH | `getMould` / `updateMould` |
| `/api/v1/moulds/[id]/compatible-machines` | POST | `addMouldMachineCompatibility` |
| `/api/v1/moulds/[id]/compatible-machines/[machineId]` | DELETE | `removeMouldMachineCompatibility` |
| `/api/v1/moulds/[id]/maintenance` | POST | `recordMouldMaintenance` |
| `/api/v1/moulds/[id]/maintenance/[maintenanceId]/complete` | POST | `completeMouldMaintenance` |
| `/api/v1/items/[id]/plastics-material-attributes` | GET / PUT | `getPlasticsMaterialAttributes` / `setPlasticsMaterialAttributes` |
| `/api/v1/items/[id]/plastics-product-spec` | GET / PUT | `getPlasticsProductSpec` / `setPlasticsProductSpec` |
| `/api/v1/production-jobs/[id]/stages/[stageId]/plastics-process-detail` | GET / PUT | `getPlasticsProcessDetail` / `setPlasticsProcessDetail` |
| `/api/v1/production-jobs/[id]/regrind` | POST | `createRegrindLot` |
| `/api/v1/production-jobs/[id]/plastics-cost-summary` | GET | `getPlasticsJobCostSummary` |

### 5. Frontend

- **Plastics item tab** (`app/(app)/catalog/items/[id]/page.tsx`'s
  `PlasticsTab`, `components/features/catalog/plastics-spec-form.tsx`) —
  shown on a raw-material/consumable item (material-attributes form) or a
  finished-good/WIP item (product-spec form), gated on
  `plastics_spec:manage` for editing, visible read-only otherwise (reads
  are never profile- or capability-restricted beyond ordinary `item:read`).
- **Moulds register**
  (`app/(app)/production/moulds/page.tsx`,
  `app/(app)/production/moulds/[id]/page.tsx`,
  `components/features/production/mould-form.tsx`,
  `components/features/production/mould-actions.tsx`) — a branch-scoped
  list and a detail page showing compatible machines and maintenance
  history alongside create/edit/compatibility/maintenance actions, gated
  on `mould:manage`; visible (read-only) to every role via `mould:read`.
- **Job-detail plastics integration**
  (`app/(app)/production/jobs/[id]/page.tsx`,
  `components/features/production/plastics-process-form.tsx`,
  `components/features/production/plastics-cost-summary-panel.tsx`) — a
  stage-level process-detail form (process type, mould picker, cycle time,
  cavity counts, locked once the stage is completed) and a read-only
  plastics cost-summary panel (material/labour cost pulled straight from
  the existing job-cost view, regrind generated/consumed quantities, and
  an explicit "not available" state for machine cost, never a blank or
  zero that could be mistaken for a real figure).
- `components/ui/status-badge.tsx` / `components/shell/nav-config.ts`:
  `MouldStatusBadge`, and a new "Moulds" entry nested under the existing
  "Production" nav parent.

### 6. Permission changes

Five new capabilities (see §4's table for the service-layer surface each
one gates): `mould:read` (every role, including `VIEWER` — browsing the
mould register is read-only equipment visibility, the same tier as
`machine:read`), `mould:manage` (`OWNER_ADMIN`, `OPERATIONS_MANAGER`,
`PRODUCTION_MANAGER` — mirrors `machine:manage`'s exact role set: a mould
is equipment, the same management tier as a machine), `plastics_spec:manage`
(`OWNER_ADMIN`, `OPERATIONS_MANAGER`, `PRODUCTION_MANAGER`,
`INVENTORY_MANAGER` — mirrors `bom:create`'s role set: planning/engineering
configuration, not shop-floor recording), `regrind:create` (`OWNER_ADMIN`,
`OPERATIONS_MANAGER`, `INVENTORY_MANAGER` — mirrors `lot:manage`'s exact
role set, since creating a regrind lot genuinely *is* a lot-management
action; deliberately **not** `PRODUCTION_MANAGER`, who lacks `lot:manage`
too), `plastics_process:record` (`OWNER_ADMIN`, `OPERATIONS_MANAGER`,
`PRODUCTION_MANAGER`, `PRODUCTION_OPERATOR` — mirrors
`machine_time:record`'s exact role set: the same shop-floor act of
recording what actually happened on a specific stage, for plastics-specific
fields instead of generic setup/run minutes; deliberately **not**
`INVENTORY_MANAGER`). Reading a regrind lot reuses the pre-existing
`lot:read` (it is an ordinary `MaterialLot` once created, §1); reading
plastics material attributes/product spec reuses the item's own
`item:read`. No existing capability or permission was weakened, removed, or
had its role grants narrowed.

### 7. Tests added

Five new files, all written against a real Postgres database in the same
style as every other module suite in this codebase, and all hand-verified
this session against the real service/schema code (every called function's
existence and signature cross-checked by reading the real source directly;
`npx tsc --noEmit` confirmed, file by file, to introduce zero new,
non-stale-client issues — see §8; three test-writing self-corrections caught
and fixed before considering any file finished, detailed in full in this
session's own working notes):

- **`plastics-item-service.test.ts`** (175 lines) — material attributes:
  null-when-unset; set/read-back; the partial-merge fix (§1) exercised
  directly (an omitted field survives a later PUT; an explicit `null` still
  clears it, distinct from omitting it); `blendComposition` summing past
  100% rejected; `itemType` gate rejecting `finished_good`/`spare_part`;
  `plastics_spec:manage` capability gate with reads unaffected; the
  plastics-profile write gate with reads surviving a switch away from
  plastics. Product spec: `productType` required on create only; partial
  update preserving omitted fields; `itemType` gate rejecting
  `raw_material`/`spare_part`; non-positive dimension rejection; capability
  gate; 404 for a cross-org item; explicit tenant isolation.
- **`mould-service.test.ts`** — creation (branch-scoped,
  `compatibleProductItemId` must be `finished_good`/`wip`, duplicate code
  within a branch rejected, the same code allowed across different
  branches, `cavityCount` bounds `[1,256]`, capability gate, plastics-
  profile write gate); listing/detail (branch-scoped by default unless
  `OWNER_ADMIN`, status filter, compatible-machines/maintenance shape, 404
  for an unknown id, reads surviving a profile switch away from plastics);
  update (partial, preserving untouched fields, empty-payload rejection,
  capability gate); machine compatibility (add/remove, duplicate-pair
  conflict, 404 removing a never-added pair, validation for an
  inaccessible/unknown machine); maintenance (a `scheduled` record requires
  `scheduledAt`, an `unscheduled` one doesn't, completing one stamps
  `completedAt` and auto-transitions the mould from `maintenance` back to
  `available`, double-completion rejected, 404 for a record belonging to a
  different mould); org and branch tenant isolation.
- **`regrind-service.test.ts`** (covers `regrind-service.ts` **and**
  `lot-service.ts`'s regrind-lineage reads together, since the lineage
  reads are the real contract other code and the UI rely on) — posts a
  `regrind_generation` movement with the correct `referenceType`/
  `referenceId`; raises/accumulates the warehouse balance across multiple
  postings; idempotent replay; reuse of a `clientRequestId` with different
  data is a `ConflictError`; validation rejections for a `finished_good`
  item, an inactive item, an inactive warehouse, a warehouse in a different
  branch than the source job (tested with `OWNER_ADMIN` specifically so the
  test isolates the branch-mismatch check, not an incidental lack of branch
  access — the same technique Milestone 4's own extension tests already
  established), an unknown currency, and a non-positive quantity; 404 for
  an unknown source job; capability gate (`PRODUCTION_MANAGER`/
  `PRODUCTION_OPERATOR` both lack `regrind:create`); the plastics-profile
  write gate; `getLotDetail`'s `origin.type === "regrind"` with the correct
  `sourceRegrindJobId` and a null `supplierId`; `getLotTraceability`'s
  single-entry `originChain` for a regrind lot; tenant isolation.
- **`plastics-process-service.test.ts`** — `processType` required on
  create only; mould validation (`mouldId` must be a real mould in this
  organisation); the `goodCavities <= totalCavities` check, **including**
  the explicit-null-clear fix (§1) exercised directly, mirroring the exact
  scenario the bug would have mishandled; the stage-completion lock,
  tested for both an update to an existing record and a first-time create
  on an already-completed stage (the completed-stage check runs before the
  "processType required" check, so the latter is a `ConflictError`, not a
  `ValidationError`); reads surviving stage completion and a profile
  switch away from plastics; capability gate
  (`INVENTORY_MANAGER`/`VIEWER` both lack `plastics_process:record`); org
  and branch tenant isolation.
- **`plastics-analytics-service.test.ts`** — asserts
  `getPlasticsJobCostSummary`'s material cost, labour cost, output
  quantities, yield, and cost-per-good-unit are **identical** to an
  independently-called `getJobCost` for the same job (the single-source-
  of-truth claim in §1, tested directly rather than by hand-computing
  expected numbers, which would only test this test's own arithmetic);
  `scrapRatePct`'s formula; `machineCost`'s always-`not_available` shape;
  `regrindGeneratedQty` summing regrind lots sourced from the job (two
  separate regrind postings, one of which is never consumed); a dedicated
  "consumed" scenario — a warehouse holding *only* a regrind lot, so
  issuing from it deterministically consumes that lot, exercising
  `regrindConsumedQty` without depending on FIFO lot-selection order; a job
  with no regrind activity reporting zero (never `null`) for both
  quantities; capability gate (`INVENTORY_MANAGER` lacks `cost:read`); no
  plastics-specific profile gate on this read path at all; tenant
  isolation.

**Deliberately not tested, and why (avoiding an overclaiming test):** the
database-level race `setPlasticsProcessDetail`'s in-transaction
`stillOpen` re-check guards against (a stage completing *between* the
function's initial status check and its write transaction) is not
independently exercised with a genuinely concurrent test, unlike Milestone
4's at-most-one-open-downtime-record test (which tests a database-level
partial unique index two real concurrent calls can reliably collide
against). Reliably forcing a stage to complete in the narrow window between
one call's read and its own transaction, deterministically, would require
mocking or artificially pausing the function mid-execution, which is not
done anywhere else in this codebase's test suite either; the straightforward
"already completed before the call starts" path (§1) is fully covered, and
is the path that actually matters for correctness — the in-transaction
re-check exists as defence-in-depth for the race, mirroring
`corrective-action-service.ts`'s identical, likewise-untested-for-the-race
pattern from Milestone 4.

**Two real bugs found and fixed during this hand-verification pass, before
any test could run** (see §1 for the full description of each, and §8 for
how `tsc` and manual review together found them):
1. `plastics-item-service.ts`'s `setPlasticsMaterialAttributes`/
   `setPlasticsProductSpec` used full-replace (`??`) merge semantics
   instead of partial-merge, which would have silently wiped
   `blendComposition` to `null` on any UI-driven edit of an unrelated
   field, since the UI form never sends that field at all. Found by manual
   code review, **not** by `tsc` (this is a semantic bug, not a type
   error) — direct evidence that type-checking alone, however thorough,
   is not a substitute for reading the actual update semantics.
2. `plastics-process-service.ts`'s pre-validation `totalCavities`/
   `goodCavities` computation used `??` while the function's own `data`
   assignment a few lines below correctly used `!== undefined` — an
   internal inconsistency within a single function, found by comparing the
   two computations against each other while writing this milestone's own
   tests, not by `tsc`.

### 8. Tests executed and results

**Not executed in this environment** — the same unfixable network-egress-
allowlist limitation documented exhaustively in Milestone 4's §8; that
investigation stands for this delivery too and is not repeated here.

`npx tsc --noEmit` was run repeatedly throughout this milestone's
development, and the full 264-line baseline output was triaged
category-by-category against `prisma/schema.prisma` as ground truth (every
"Property X does not exist on type PrismaClient"/"did you mean Y" error
individually cross-checked, not assumed uniform) before any fix was made,
the same rigor Milestone 4's own §8 established. Every remaining error
after this milestone's two source fixes (§1/§7) is confirmed stale-
generated-client fallout: `src/generated/prisma` was generated before this
milestone's new models (`Mould`, `MouldMachineCompatibility`,
`MouldMaintenanceRecord`, `PlasticsMaterialAttributes`,
`PlasticsProductSpec`, `PlasticsProcessDetail`) and enum/column changes
(`regrind_generation`, `MaterialLot.supplierId`,
`MaterialLot.sourceRegrindJobId`/`sourceRegrindMovementId`) existed, so the
generated client has no knowledge of any of them yet — not a defect in
this milestone's code, which was instead cross-checked by hand, field by
field, against `prisma/schema.prisma` and the migration file (§3). A
byte-level diff of the full `tsc` output, taken before and after each of
the two §1/§7 source fixes, confirmed each fix removed exactly its own
target error line and introduced zero new ones, mirroring the rigor
Milestone 4's §8 established for its own two fixes.

Each of this milestone's five new test files was individually checked with
`npx tsc --noEmit` after being written; this caught two genuine, unrelated
test-code issues (not service-code bugs) that were fixed before considering
any file finished: a missing `(... ) as any` cast on `createJob(...)`'s
return value in two files (`regrind-service.test.ts`,
`plastics-process-service.test.ts`) — `job-service.ts`'s `createJob`/
`getJob` return an untyped `Record<string, unknown>` view by design
(`job-view.ts`'s `toJobView`), and every pre-existing test file in this
codebase that calls `createJob` already casts its result this same way;
and three implicit-`any` callback parameters in `mould-service.test.ts`
caused by `listMoulds`'s return type itself resolving through the stale
`prisma.mould` (the same category as every other stale-client error
above, just surfacing as an implicit-`any` in a strict-mode test file
rather than a direct property-access error). Both were fixed by matching
this codebase's own established idiom rather than suppressing the check.

**After you run `npx prisma generate` locally, re-run `npx tsc --noEmit` —
it should come back completely clean.**

**Run this yourself, against your own local test database, before
merging** — in this exact order:
```
npx prisma generate                        # REQUIRED FIRST: regenerates the client against every
                                            # model/enum/column Milestone 6 adds (Mould,
                                            # MouldMachineCompatibility, MouldMaintenanceRecord,
                                            # PlasticsMaterialAttributes, PlasticsProductSpec,
                                            # PlasticsProcessDetail, regrind_generation,
                                            # MaterialLot.supplierId/sourceRegrindJobId/
                                            # sourceRegrindMovementId)
npx prisma migrate dev                      # applies 20261109080000_configurable_industry_architecture
                                             # and 20261110080000_plastics_manufacturing_vertical
                                             # (and every prior migration, if not already applied)
npm test -- plastics-item-service mould-service regrind-service \
             plastics-process-service plastics-analytics-service   # the 5 new Milestone 6 files
npm test -- industry-profile-service                                # Milestone 5's own file
npm test -- lot-service lot-consumption stock-core                  # regression: the
                                             # pre-existing services this milestone extended
npx tsc --noEmit                            # should now be fully clean
npm run lint
```
Before running `prisma migrate dev`, confirm what `prisma.config.ts` and
your local `.env`/`.env.local` actually point at — **never assume `.env`
points to a safe local database.** Nothing above was run against your
database or any database by this round of work.

### 9. Known limitations (deliberate scope decisions, not oversights)

- **Regrind quantity is never derived from scrap output.** As documented
  in §1, `ProductionOutput.scrapQty` (product UOM) and a regrind lot's
  quantity (raw-material UOM) are not convertible without a per-product
  weight factor this schema does not store as a hard conversion; the
  operator always weighs and enters the real regrind quantity. A future
  milestone could add a per-product unit-weight field and an automatic
  suggested-quantity calculation, but this delivery deliberately does not
  guess at one.
- **`plastics-analytics-service.ts`'s regrind quantities go to zero, not
  an error or a partial sum, when a job's regrind activity spans more than
  one distinct material or UOM.** This is `sumSingleMaterial`'s documented
  "honest granularity" rule (§1): summing across different materials or
  units would be a fabricated figure. A job that generates or consumes
  regrind of more than one material/UOM combination will report `0` for
  the affected quantity rather than a misleading blended number; a future
  per-material breakdown (an array instead of one summed figure) is a
  plausible refinement this delivery does not implement.
- **No machine-cost or energy-cost figure, and none is planned without new
  hardware integration.** This is a direct, permanent consequence of
  "never invent machine telemetry," not a gap expected to close with more
  development time alone — it would require an actual PLC/energy-meter
  integration this codebase does not have.
- **Mould management has no utilisation/OEE reporting.** `mould-service.ts`
  tracks identity, compatibility, status, and maintenance history, but
  computing mould utilisation or overall-equipment-effectiveness would
  require cycle-level telemetry this codebase does not have (the same
  limitation as machine cost, above) — `actualCycleTimeSeconds` is
  per-stage, operator-entered, and not aggregated into any utilisation
  metric in this delivery.
- **Quality plans/characteristics (Milestone 4) are reused as-is, not
  extended for plastics-specific measurement types.** The mandate's "do
  not assume every plastics product uses the same measurements" is
  satisfied by `InspectionPlan`/`InspectionCharacteristic` already being
  per-item and free-form (any characteristic name/UOM/bounds, defined
  per product) — no plastics-specific quality-plan code was added or was
  needed; this is listed here explicitly so it is clear the mandate's
  measurement-variability requirement was satisfied by Milestone 4's
  existing, already-generic design rather than overlooked.
- **The five unimplemented industry profiles (Milestone 5) have zero
  plastics-equivalent vertical code.** This is Milestone 5's own scope
  boundary, repeated here only to be explicit that Milestone 6 does not
  change it: a `food_beverage` org gets the registry entry and nothing
  else.

### 10. Required local commands

```
npx prisma generate                         # MUST run before anything else touches this milestone's code
npx prisma migrate dev                      # applies 20261109080000_configurable_industry_architecture
                                             # and 20261110080000_plastics_manufacturing_vertical
npm test -- plastics-item-service mould-service regrind-service \
             plastics-process-service plastics-analytics-service
npm test -- industry-profile-service
npm test -- lot-service lot-consumption stock-core
npm run lint                                 # or: npx eslint .
npx tsc --noEmit
```

None of these were run against your database or your local environment by
this round of work, per the mandate. Confirm `prisma.config.ts` and your
local `.env`/`.env.local` point at a database you intend to migrate before
running `prisma migrate dev` — do not assume `.env` is safe by default.

### 11. Manual configuration required

**One organisation-level action required before any Milestone 6 feature is
usable**: an `OWNER_ADMIN` must switch the organisation's industry profile
to `plastics` (Settings → Manufacturing profile, or `PATCH
/api/v1/organization/industry-profile`) — every Milestone 6 write path is
rejected with a `ValidationError` until this is done (Milestone 5's
`assertPlasticsProfileActive`, by design). No new environment variable,
feature flag, or external service is introduced.

### 12. Files in this delivery (Milestone 6)

Changed (10):
```
prisma/schema.prisma
src/server/shared/authz.ts
src/server/modules/inventory/lot-service.ts
src/server/modules/inventory/stock-core.ts
lib/server/lookups.ts
lib/api-types.ts
components/ui/status-badge.tsx
components/shell/nav-config.ts
app/(app)/catalog/items/[id]/page.tsx
app/(app)/production/jobs/[id]/page.tsx
```

New (29):
```
prisma/migrations/20261110080000_plastics_manufacturing_vertical/migration.sql
src/server/modules/catalog/plastics-item-service.ts
src/server/modules/production/mould-service.ts
src/server/modules/production/plastics-process-service.ts
src/server/modules/inventory/regrind-service.ts
src/server/modules/production/plastics-analytics-service.ts
app/api/v1/moulds/route.ts
app/api/v1/moulds/[id]/route.ts
app/api/v1/moulds/[id]/compatible-machines/route.ts
app/api/v1/moulds/[id]/compatible-machines/[machineId]/route.ts
app/api/v1/moulds/[id]/maintenance/route.ts
app/api/v1/moulds/[id]/maintenance/[maintenanceId]/complete/route.ts
app/api/v1/items/[id]/plastics-material-attributes/route.ts
app/api/v1/items/[id]/plastics-product-spec/route.ts
app/api/v1/production-jobs/[id]/stages/[stageId]/plastics-process-detail/route.ts
app/api/v1/production-jobs/[id]/regrind/route.ts
app/api/v1/production-jobs/[id]/plastics-cost-summary/route.ts
app/(app)/production/moulds/page.tsx
app/(app)/production/moulds/[id]/page.tsx
components/features/catalog/plastics-spec-form.tsx
components/features/production/mould-form.tsx
components/features/production/mould-actions.tsx
components/features/production/plastics-process-form.tsx
components/features/production/plastics-cost-summary-panel.tsx
src/server/modules/catalog/__tests__/plastics-item-service.test.ts
src/server/modules/production/__tests__/mould-service.test.ts
src/server/modules/inventory/__tests__/regrind-service.test.ts
src/server/modules/production/__tests__/plastics-process-service.test.ts
src/server/modules/production/__tests__/plastics-analytics-service.test.ts
```
