# Suppliers milestone — verification checkpoint

Written 4 Nov 2026 against the Suppliers delivery (`suppliers-module.zip`), before starting
Purchasing. Everything below was checked by reading the actual code and running `tsc`/`eslint`
in the sandbox — nothing here is asserted without the evidence next to it. Where the sandbox
genuinely cannot verify something (no network path to any real Postgres, `prisma generate`
blocked), that's stated plainly rather than assumed to be fine.

## 1. Zip manifest — confirmed complete

The zip was built directly from the same 14 paths that were written (`zip` listed each file as
it added it; `unzip -l` then confirmed all 14, with sizes). No file was dropped or substituted:

| Path | Kind |
|---|---|
| `prisma/schema.prisma` | modified — `SupplierStatus` enum + `Supplier` model |
| `prisma/migrations/20261104100000_suppliers/migration.sql` | new — the migration |
| `src/server/shared/authz.ts` | modified — capabilities |
| `src/server/modules/suppliers/supplier-service.ts` | new — service |
| `src/server/modules/suppliers/__tests__/supplier-service.test.ts` | new — 22 tests |
| `app/api/v1/suppliers/route.ts`, `app/api/v1/suppliers/[id]/route.ts` | new — API |
| `app/(app)/suppliers/{page,new/page,[id]/page,[id]/edit/page}.tsx` | new — UI |
| `components/features/suppliers/supplier-form.tsx` | new — form |
| `components/shell/nav-config.ts`, `components/shell/nav-list.tsx` | modified — nav |

Both the migration and the test file are present and non-empty (confirmed by reading each in
full, not just listing them).

## 2. The 9 TypeScript errors — root-caused individually, not assumed

Baseline before this milestone (confirmed earlier this session): `tsc --noEmit` reports exactly
one error, `app/layout.tsx(20,50): Cannot find name 'LayoutProps'` — a pre-existing Next.js
codegen artifact, in a file this milestone never touched. That one is unrelated and unchanged.

With Suppliers added, `tsc --noEmit` reports that same baseline error plus exactly 9 new ones,
and all 9 trace to a single root cause — the generated Prisma client bundled in this sandbox
predates the schema change and `prisma generate` cannot be re-run here (the schema-engine binary
fetch is 403'd by the sandbox's egress policy, same blocker documented throughout this project;
confirmed again just now — `npx prisma generate` and `npx prisma validate` both fail with
`Failed to fetch ... schema-engine.gz - 403 Forbidden`, with or without
`PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING`):

- **5 direct errors** — `error TS2339: Property 'supplier' does not exist on type 'PrismaClient'`
  at `supplier-service.ts:53,80,99,121,131`. Checked each line individually: these are exactly
  the file's 5 Prisma call sites (`create`, `findMany`, two `findFirst`s, `update`) — no more, no
  fewer, and no other kind of error at any of them.
- **4 downstream errors** — `error TS7006: Parameter 's' implicitly has an 'any' type` at
  `supplier-service.test.ts:111,132,133,136`. Checked each: all four are `.some((s) => …)`
  callbacks consuming the return value of `listSuppliers`. Because `prisma.supplier` doesn't
  type-check, TypeScript can't infer `listSuppliers`'s return type, so the array type `s` is
  destructured from collapses to `any` — a mechanical consequence of the same root cause, not an
  independent bug. Once the client is regenerated, `listSuppliers` returns `Supplier[]` and these
  4 disappear without any code change.

So: 1 pre-existing + unrelated, 9 new + all one cause. Confirmed by reading every flagged line,
not inferred from the error count alone.

## 3. Migration safety — additive, checked against the init migration's own conventions

Full text re-read line by line. Findings:

- **Additive only.** One `CREATE TYPE`, one `CREATE TABLE`, one `CREATE UNIQUE INDEX`, one
  `ALTER TABLE … ADD CONSTRAINT` (the FK), one guarded `GRANT`. No `DROP`, no `ALTER …TYPE` on an
  existing column, no `NOT NULL` added to a populated column, nothing touching any existing
  table's structure. New table starts empty, so the FK add is effectively instant — no long lock
  on `organization`.
- **Native enum, not TEXT+CHECK.** Checked the init migration's `customer` table: `status` there
  is typed `"CustomerStatus"`, a real `CREATE TYPE … AS ENUM`. The Supplier migration follows the
  identical pattern (`SupplierStatus`) rather than the TEXT+CHECK shape an earlier draft of this
  migration used — fixed before delivery so Prisma won't see schema drift on the next
  `migrate dev`.
- **Org isolation at the constraint level, not just in application code.** `org_id` is `NOT NULL`
  with an `FK → organization(id) ON DELETE RESTRICT ON UPDATE CASCADE` — byte-for-byte the same
  referential action the init migration uses for `item_org_id_fkey` and `customer_org_id_fkey`.
  `RESTRICT` means an organization can never be deleted while it still has supplier rows, closing
  off an orphaned-row path.
- **Index naming/shape matches what Prisma itself would generate.** `supplier_org_id_id_key` on
  `("org_id","id")` is the same name and column order as the init migration's
  `customer_org_id_id_key` / `item_org_id_id_key` — so the schema and the hand-written SQL stay
  in sync; `prisma migrate dev` shouldn't detect drift and propose a redundant index.
- **No naming collision.** Searched every existing `migration.sql` for `SupplierStatus`,
  `CREATE TABLE "supplier"`, `supplier_pkey`, `supplier_org_id` — no prior hits.
- **Runtime grant.** Guarded by `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime')`
  — identical structure to the `account_security` migration's self-grant. Full CRUD (no
  restriction), correctly: `supplier` is ordinary data, not a ledger, so it doesn't belong on the
  INSERT-only list alongside `stock_movement`/`audit_log`.
- **Documentation completeness fix made during this review:** `docs/db-roles-and-security.sql`'s
  Stage 3 comment block lists every table that self-grants, "for completeness," even though the
  migration already grants itself (see its existing comments on `job_number_counter` and the
  account-security tables). `supplier` was missing from that list — added in this checkpoint's
  corrections (one line, no behavior change, matches the existing pattern exactly).

Verdict: safe to apply to an existing/live schema. This was not run against any real database in
this sandbox (none is reachable here) — see §8 for the exact local verification sequence.

## 4. Service-layer security properties — verified function by function

Re-read `supplier-service.ts` in full against the four properties asked for:

| Function | Capability check (first line) | Org-scoped query | Zod validation | Audit log |
|---|---|---|---|---|
| `createSupplier` | `assertCapability(…, "supplier:create")` | `orgId: session.orgId` on the insert | `createSupplierSchema.safeParse` | `action: "create"`, `afterValue: { name }` |
| `listSuppliers` | `assertCapability(…, "supplier:read")` | `where: { orgId: session.orgId, … }` | n/a (filter object, not user content) | n/a (read) |
| `getSupplierById` | `assertCapability(…, "supplier:read")` | `findFirst({ orgId: session.orgId, id })` | n/a | n/a (read) |
| `updateSupplier` | `assertCapability(…, "supplier:update")` | existing row fetched scoped by `orgId + id` before any write | `updateSupplierSchema.safeParse`, rejects empty payload | `action: "update"`, before/after diff of **only the changed keys** |

Tenant isolation specifically: `getSupplierById`/`updateSupplier` both filter by `{ orgId, id }`
together on the read, so a cross-org id simply doesn't match any row — the caller gets
`NotFoundError`, never a distinguishable "forbidden" that would confirm the id exists in another
org. This is the same mechanism `customer-service.ts` uses, not a new pattern.

One thing to call out rather than gloss over: `updateSupplier`'s final `prisma.supplier.update`
uses `where: { id: existing.id }`, not a repeated `{ orgId, id }` filter — the isolation is
enforced by the **read that happened immediately before it** in the same function, not by the
write itself. This is exactly `customer-service.ts`'s existing, already-reviewed pattern
(verified by reading `updateCustomer` side by side) — not a new risk introduced here, and there's
no window for it to matter since both calls happen synchronously within one request with no
intervening await on anything that could change `existing.id`'s ownership.

## 5. INVENTORY_MANAGER capability grant — reviewed against existing precedent, not in isolation

The question: is giving `INVENTORY_MANAGER` `supplier:create`/`supplier:update` (unlike
`CUSTOMER`, where only Owner/Admin/Ops-Manager get write access) consistent with how this
codebase already draws these lines, or an outlier?

**Precedent found for it:** `INVENTORY_MANAGER` already holds `item:create`/`item:update` —
full write access to another master-data entity, beyond the stock-ledger operations
(`stock:receive`/`adjust`, `warehouse:create`) that are obviously "theirs." So the role already
has a standing pattern of owning master data that feeds the operations it runs, not just the
operations themselves. Supplier is the direct procurement-side counterpart to Item on the
catalog side, and the next milestone (Purchasing/POs) is explicitly inventory-adjacent work per
`FEATURE_AUDIT_MATRIX.md` (#6 Suppliers, #8 Purchasing, #9 Goods receiving are listed together,
all P0/P1, all missing).

**Precedent against treating this as automatic:** `INVENTORY_MANAGER` has **zero** Customer
capability — not even read. So the codebase's actual rule isn't "Inventory Manager gets write on
all master data," it's narrower: write access tracks whether the master data feeds something the
role already owns. That's a real distinction, not a coincidence, and it's why Supplier and
Customer get different treatment here rather than both mechanically mirroring one another.

**Implications worth recording, not just the conclusion:**
1. Supplier creation now has a lower bar than Customer creation (Inventory Manager vs.
   Owner/Admin/Ops-Manager only) — an intentional asymmetry between the procurement and sales
   sides of master data, matching the asymmetry already in the role's job, not a new policy.
2. Because this slice of Supplier has no financial fields yet (no payment terms, bank details,
   tax ID — deliberately, see schema.prisma's comment on the model), the risk surface of this
   grant today is low. **This should be revisited when Purchasing adds vendor-financial fields**:
   letting the same role both create a vendor and set its banking/tax details unsupervised is a
   segregation-of-duties question real procurement controls usually care about. Flagging this
   now so it isn't forgotten when those fields land, not deciding it now.
3. `supplier:update` also covers deactivation (no separate `supplier:deactivate` capability,
   same as Customer) — so Inventory Manager has full unsupervised lifecycle control over
   Supplier, same as they already do over Item. Consistent with point 1, not a separate issue.
4. No role's grants were widened beyond what's listed above — `FINANCE_MANAGER`,
   `PRODUCTION_MANAGER`, `VIEWER` are read-only on Supplier (mirroring their exact Customer
   access), and `PRODUCTION_OPERATOR` has no Supplier capability at all (also mirroring Customer).

## 6. Frontend integration — checked against the actual shell, not assumed to "just work"

- **Layout wiring needs no per-route registration.** Re-read `app/(app)/layout.tsx`: it wraps
  every route under the `(app)` route group generically (session check, sidebar built from
  `getVisibleNavItems(session.role)`, top bar, skip-link, `<main>`). Because the four new pages
  live under `app/(app)/suppliers/...`, they receive this shell automatically through Next's route
  group convention — there is no separate registry to add them to, and none was missed.
  `PRODUCTION_OPERATOR` gets the structurally different `OperatorShell` instead, but still renders
  `{children}` — so even a direct URL hit on `/suppliers` by an operator renders the Suppliers
  page's own `ctx.can("supplier:read")` check and gets `AccessDenied`, not a crash. No operator
  has any Supplier capability, so this is the expected and only outcome for that role.
- **Nav icon resolves to a real export.** `Truck` was added to `nav-list.tsx`'s `ICONS` map;
  confirmed directly in `node_modules/lucide-react`'s type declarations that `Truck` is a real
  exported `LucideIcon` in the installed version (not inferred from "it's a common icon name" —
  grepped the actual `.d.ts`). The clean `tsc`/`eslint` run over this file is independent
  confirmation: a bad import here would have failed type-checking, and it didn't.
- **Every page/component reuses existing primitives, not reimplementations.** `page.tsx` uses
  `PageHeader`, `FilterBar`/`FilterField`, `Table`/`THead`/`TBody`/`TR`/`TH`/`TD`, `Pagination`,
  `ActiveBadge`, `EmptyState`/`LoadFailure`/`AccessDenied` — each one read in full from
  `components/ui/*` and `components/features/shared/*` before writing the page, and the props
  passed match each component's actual signature (not guessed from the Customer page's usage
  alone — cross-checked against the component source). `SupplierForm` uses the same
  `useSubmission`/`apiRequest`/`Field`/`FormError`/`SubmitButton` stack as `CustomerForm`, so
  pending state, field-level errors, and the one-request-in-flight guard all come from the same
  already-tested hook, not a parallel implementation.
- **Loading/error states are real, not placeholders.** `LoadFailure` maps a 403 to `AccessDenied`
  and anything else to `ErrorState` with the service's actual message — same as Customer. The
  list page's empty state differs by whether a filter is active (same pattern as Customer).

## 7. Test isolation — confirmed, with one pre-existing gap surfaced rather than papered over

Read `vitest.config.ts`, `vitest.setup.ts`, and `vitest.global-setup.ts` in full.

**What's true:** nothing in the test harness has a hardcoded connection string. `vitest.setup.ts`
reads `RUNTIME_DATABASE_URL`/`MIGRATION_DATABASE_URL` from `process.env` (populated from your own
local `.env` via `dotenv/config`) and refuses to run at all if either is unset.
`vitest.global-setup.ts` additionally checks migration state and `mops_runtime`'s grants before
any test runs, and fails loudly with a specific remediation message if the database is behind.
The Supplier test file (`supplier-service.test.ts`) makes no network or file-system call of its
own outside the service functions under test — every row it creates goes through
`createTestOrg`/`createSupplier` etc., i.e. through the exact same path production code uses, so
there's no separate "test-only" code path that could drift from what's actually deployed.

**What I won't overstate:** there is no code-level guard here that stops `MIGRATION_DATABASE_URL`
/`RUNTIME_DATABASE_URL` from pointing at a production Neon database if you put production
credentials in your local `.env` — unlike `src/server/dev/seed-guard.ts`, which does exactly that
(refuses to run unless `NODE_ENV!=production`, the two URLs agree, and the target doesn't match a
`prod`/`production`/`live` heuristic, plus a positive `OPERIS_DEV_SEED_TARGET=<db>@<host>`
confirmation). This is a **pre-existing gap in the test harness, not something introduced by
Suppliers** — it was true before this milestone and applies to every test file in the suite, not
just the new one. I'm surfacing it now rather than asserting isolation is guaranteed when the code
doesn't actually guarantee it. The practical isolation today is entirely operator discipline: keep
a separate `.env` pointed at a local or branched database and never let a production URL sit in
the file you run `vitest` against.

**Recommendation (not applied — scope decision, not mine to make silently):** port
`checkSeedSafety`'s logic (or call it directly) into `vitest.global-setup.ts` so the test suite
gets the same positive-confirmation guard the seed path already has. This is a real improvement
but it's test-harness-wide, not Suppliers-specific, so it isn't bundled into this milestone's
corrections — say if you want it done as its own small change before or alongside Purchasing.

## 8. Exact commands to run locally

All of these use your **local/test** database only. Do not point `MIGRATION_DATABASE_URL` at
production for any of these, and never pass `--accept-data-loss` or run `migrate reset` against
a database that has real data.

```bash
# 1. Apply the new migration and regenerate the client (creates prisma/migrations/
#    20261104100000_suppliers against your local/test DB, then regenerates
#    src/generated/prisma from the updated schema).
npx prisma migrate dev

# 2. Re-run Stage 3 grants only if mops_runtime already existed before step 1 — the
#    migration self-grants when the role exists, so this is a no-op safety net, not
#    required on a fresh setup. Run as your Postgres/Neon owner-equivalent role:
#    psql "$YOUR_SUPERUSER_URL" -f docs/db-roles-and-security.sql   (Stage 1 + 3 only)

# 3. Static verification (same as every prior milestone)
npx tsc --noEmit
npx eslint src app components lib

# 4. The Supplier test file specifically, then the full backend suite
npx vitest run src/server/modules/suppliers/__tests__/supplier-service.test.ts
npx vitest run

# 5. UI test suite (unaffected by this milestone, but confirm nothing regressed)
npx vitest run --config vitest.ui.config.ts
```

Expected outcome: step 3 reports zero errors (the 9 Supplier-related ones and the pre-existing
`LayoutProps` one should both be gone/unaffected respectively — `LayoutProps` is a Next.js
codegen artifact unrelated to this change and may still appear depending on your Next version;
if it does, that's the pre-existing baseline, not a regression). Step 4's new file should show
22 passing tests, 0 failing.
