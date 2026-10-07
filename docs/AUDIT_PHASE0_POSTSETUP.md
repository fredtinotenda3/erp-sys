# Operis — Post-Setup Architecture & Foundation Audit

Status: **Audit only. No code, schema, or migration changes were made.** Per
the brief's CRITICAL RULE, this document inspects and reports; it does not
implement, modify the database, modify migrations, or make architectural
changes. Everything below is answerable from the repository alone — no
database connection was available or used.

Scope note: this project already has an `ARCHITECTURE.md` from an earlier
Phase 0 round (design) and a "Phase 0 Addendum" documenting 9 approved
schema revisions plus a Phase 1 implementation summary. This audit does not
repeat that design work — it checks whether what's actually in the
repository (and, by direct evidence, what's actually in the database)
matches what those documents claim. Where this audit disagrees with
`ARCHITECTURE.md`, that disagreement is the finding.

---

## A. Current architecture — what exists now

**Stack, confirmed from `package.json`/configs:** Next.js 16.3.8 (App
Router, Turbopack), React 19.2.8, TypeScript 5 (strict), Tailwind 4,
ESLint 9 (flat config, `eslint-config-next`), Prisma ORM 7.10.0 with the
`prisma-client` generator + `@prisma/adapter-pg` driver adapter, `pg`,
`@node-rs/argon2` for password hashing, `zod` 4 for validation, Vitest 3 for
tests. All dependency versions are pinned exactly (no `^`/`latest` floats on
the Prisma trio), matching the stated rationale in `schema.prisma`'s header
about the CLI/client major-version mismatch risk.

**What's actually built (not just designed):**

- `src/server/shared/*` — cross-cutting primitives: `db.ts` (single Prisma
  Client instance, pooled via `pg.Pool` + `PrismaPg` adapter, dev-mode
  `globalThis` caching), `authz.ts` (role → capability matrix,
  `hasBranchAccess`), `scope.ts` (`OrgScope`/`BranchScope` marker types),
  `errors.ts` (typed `AppError` hierarchy → HTTP status mapping),
  `http.ts` (session cookie helpers, `errorResponse`), `password.ts`
  (argon2id at OWASP-minimum parameters).
- `src/server/modules/iam/*` — `org-service.ts` (unauthenticated tenant
  bootstrap), `branch-service.ts`, `user-service.ts`, `session-service.ts`
  (custom Postgres-backed sessions), `session-guard.ts`, `audit-service.ts`.
- `src/app/api/v1/*` — 9 thin route handlers wrapping the above:
  `organizations/bootstrap`, `auth/login`, `auth/logout`, `branches` (+
  `[id]` deactivate), `users` (+ `[id]` role/deactivate,
  `[id]/branch-access` grant/revoke), `audit-log`.
- `src/server/modules/iam/__tests__/*` — 4 Vitest suites
  (tenant-isolation, branch-isolation, auth, audit), 23 test cases total,
  run against a real Postgres instance per `vitest.config.ts`
  (`fileParallelism: false`, no mocking).
- `prisma/schema.prisma` + two migrations:
  `20261007061917_init` (full DDL for every table/enum in the schema —
  including tables well beyond Phase 1, e.g. `item`, `production_job`,
  `stock_movement`) and `20261007062213_manual_constraints`.
- `docs/ARCHITECTURE.md`, `docs/SETUP_COMMANDS.md`, `docs/schema.sql`,
  `docs/db-roles-and-security.sql` — design/setup documentation. `schema.sql`
  and `db-roles-and-security.sql` are *reference* artifacts (the intended
  final DDL/security model); they are not themselves run by `prisma migrate`.
- `app/` — untouched `create-next-app` scaffold (`page.tsx`, `layout.tsx`,
  default Geist fonts, default copy). No UI has been built, which matches
  the stated Phase 1 scope ("auth, org/branch/user/role, audit log, module
  skeleton" — no frontend).

**What's modeled but not built (by design, confirmed from the schema and
service code):** catalog/`Item`, `BillOfMaterial`/`BomLine`, `Customer`,
`SalesOrder`/`SalesOrderLine`, `ProductionJob` and everything under it,
`Warehouse`/`StockMovement`/`StockBalance`, `ExchangeRate`,
`JobCostEstimate`/`JobCostActual`. All of these exist as Prisma models and
as tables in the applied `init` migration, but zero service-layer code,
zero routes, and zero tests touch them. This is consistent with the stated
intent ("modeled now for the ERD, not built in the first slice") — flagged
again in Section I because *modeling and migrating* a table is not the same
as that table's invariants being enforced (see Section B, Finding 1).

---

## B. Problems found

### Finding 1 (critical) — the database is materially less protected than the documentation claims, because the "manual constraints" migration was never actually written

`prisma/migrations/20261007062213_manual_constraints/migration.sql` contains
exactly one line:

```sql
-- This is an empty migration.
```

`docs/SETUP_COMMANDS.md` Section 5a instructs, in detail, pasting a specific
block of hand-written SQL into this exact file before running
`npx prisma migrate dev` a second time to apply it. That paste never
happened. The consequence is that **every one of the following, which
`ARCHITECTURE.md`'s "Phase 0 Addendum" and `docs/schema.sql`'s inline
comments describe as already-verified, load-bearing invariants, does not
exist in the actual database right now:**

| Missing object | What it was supposed to guarantee | Currently enforced? |
|---|---|---|
| `uq_bom_one_active_per_product` partial unique index | Exactly one ACTIVE BOM per product | No |
| `app_user_email_lowercase` CHECK | DB-level backstop on email casing | No (app-level `.toLowerCase()` in `zod` schemas still covers *create* paths — see Finding 2) |
| `trg_stock_movement_before_insert()` + trigger | Weighted-average costing, negative-stock blocking, currency-mix blocking, branch/warehouse consistency | No |
| `job_cost_actual.gross_profit` generated column | Derived, never-stored-twice gross profit | No |
| `job_material_cost_live` / `job_labour_cost_live` views | Currency-safe live cost rollups | No |

None of these five are reachable by Phase 1's shipped code today (they all
belong to catalog/inventory/costing, which have no service layer yet), so
**the immediate blast radius is zero** — but the setup transcript's claim
that "the database is now in sync with your schema" is true only in the
narrow Prisma-drift-detection sense (no pending model changes), not in the
sense `ARCHITECTURE.md` uses it (the hand-verified invariants are live).
Treat the two as different claims going forward.

**The actually dangerous gap is a sixth item the Addendum's own enumeration
missed naming at all, and it's the one Phase 1 code depends on today:**
`docs/db-roles-and-security.sql` — the file that creates the
`mops_migrator`/`mops_runtime` role split and installs the four
`prevent_mutation()` immutability triggers on `stock_movement`,
`audit_log`, `exchange_rate`, and `job_cost_actual` — is a **separate file
from the Prisma migration flow entirely.** It is run by hand, by a
superuser, via `psql -U postgres -d mops_dev -f docs/db-roles-and-security.sql`
(`SETUP_COMMANDS.md` Section 6), never through `prisma migrate`. There is no
artifact in this repository (no migration, no CI step, no startup check)
that proves this file was ever executed against the real database, and the
project's own `.env`/connection setup isn't in the delivered tree to check
either.

If it wasn't run (the more likely case on a fresh Neon database, where the
app is probably connecting with the single default `neondb_owner`-style
role rather than two hand-created roles — Neon *does* support creating
extra roles, but it's an explicit extra step nobody's transcript confirms
was taken): **`audit_log` has no technical enforcement of its append-only
property right now.** The entire design rationale in `audit-service.ts`'s
header comment ("Append-only audit trail… the audit entry is a side effect
of an already-authorized write") and the isolation test suite's header
comment (explaining why there's no cleanup — "the immutability trigger…
blocks deleting the audit rows themselves even as the table owner") are
describing a guarantee that, as far as this repository can prove, is not
currently live. The audit log is today an ordinary mutable table that the
application *happens* not to update or delete from — which is a materially
weaker guarantee than "the database physically refuses it," and it's the
single property most worth having enforced at the DB layer for exactly the
reason the design doc gives (defense against a bug or a stray admin
`UPDATE`).

**Why this matters more than the catalog/inventory gaps:** audit logging
and tenant/branch isolation are *the* Phase 1 deliverable. A gap in a
not-yet-built module is a non-issue; a gap in the guarantee the one
finished module is supposed to provide is the finding this whole audit
exists to catch.

**Action, not performed by this audit (per the CRITICAL RULE) — recommended
as the literal next step:** run `docs/db-roles-and-security.sql` as a
Postgres superuser against the real database and confirm with the sanity
check `SETUP_COMMANDS.md` Section 6 already gives you (`UPDATE stock_movement
SET quantity = 1 WHERE false;` as `mops_runtime`, expect it to fail). Then
open the empty `manual_constraints` migration, paste the SQL block
`SETUP_COMMANDS.md` Section 5a already specifies verbatim, and run
`npx prisma migrate dev` again. Both steps are copy-paste from documentation
that already exists in this repository — this is a "finish applying what
you already wrote," not a new design task.

### Finding 2 (moderate) — the "six things Prisma can't express" list in `schema.prisma`'s header undercounts; it's missing at least nine more CHECK constraints

The header comment lists six objects that need hand-written SQL. Comparing
`docs/schema.sql` line-by-line against `prisma/schema.prisma` and the
applied `init` migration turns up CHECK constraints that are in
`schema.sql` but have no Prisma equivalent, are not in either numbered list,
and are confirmed absent from `20261007061917_init/migration.sql`'s
`CreateTable` statements (which have no `CHECK` clauses at all):

- `item`: `CHECK (NOT is_sellable OR selling_price IS NOT NULL)`
- `bom_line`: `CHECK (quantity > 0)`
- `sales_order_line`: `CHECK (quantity > 0)`, `CHECK (unit_price >= 0)`
- `production_job`: `CHECK (planned_qty > 0)`
- `material_requirement`: `CHECK (expected_qty >= 0)`
- `labour_record`: `CHECK (hours > 0)`, `CHECK (rate >= 0)`
- `quality_record`: `CHECK (accepted_qty + rejected_qty <= produced_qty)`
- `stock_movement`: `CHECK (quantity <> 0)`
- `exchange_rate`: `CHECK (rate > 0)`

(Status/type columns are fine — those became native Postgres enums via
Prisma and *are* present in the applied migration; only the
business-rule numeric CHECKs are missing.) None of these block anything
today since their tables are unused, but when Phase 2+ actually starts
writing to `item`/`sales_order`/`production_job`, these constraints need to
exist before the first write, not be discovered missing after a bad row
gets in. **Recommendation:** fold this list into the same manual-constraints
migration from Finding 1 rather than writing a third one later — one
hand-written migration that brings the DB fully up to `schema.sql` parity,
not two.

### Finding 3 (low) — `.gitignore`'s `.env*` pattern also excludes `.env.example`

```
# env files (can opt-in for committing if needed)
.env*
```

`SETUP_COMMANDS.md` Section 4 refers to "`.env.example` (included in this
delivery)" as the file a new developer copies to `.env`. The glob `.env*`
matches `.env.example` too, so if that file is ever added with `git add`,
it will be silently ignored (or require `-f` to force-add, which is easy to
forget and easy for a teammate to not realize is necessary). Standard fix
is `.env*` plus `!.env.example` immediately after it. Low severity today
since the repo is still a solo project, but worth fixing before the "on a
team" onboarding this is meant to support actually happens — a missing
`.env.example` is the single most common "works on my machine" bug for a
new teammate's first setup.

### Finding 4 (low) — no `test` script in `package.json`

`scripts` has `dev`/`build`/`start`/`lint` only. `SETUP_COMMANDS.md`
instructs running `npx vitest run` directly, which works, but there's no
`npm test` / `npm run test` entry, which is the convention CI systems and
most teammates will reach for first. Trivial to add
(`"test": "vitest run"`), not done here since it's a `package.json` edit
and this audit is inspect-only.

### Finding 5 (low) — `SESSION_SECRET` is documented but dead

`SETUP_COMMANDS.md`'s `.env` template includes `SESSION_SECRET`, generated
via `crypto.randomBytes`. Grepping the entire `src/` tree: it is never read
anywhere in the application. This is consistent with the actual session
design (an opaque random token, SHA-256-hashed before storage — no
HMAC/JWT signing step that would need a shared secret), so there's no
missing security control here, just a stale setup instruction left over
from an earlier assumption. **Recommendation:** either delete it from the
`.env` template or add a one-line comment reserving it for a future
HMAC-signed-cookie variant, so a future reader doesn't waste time looking
for where it's supposed to be consumed.

### Finding 6 (moderate, forward-looking) — no login throttling

`POST /api/v1/auth/login` has no rate limiting, attempt counting, or
backoff. `session-service.ts` already does the one thing that matters most
(identical error for wrong-password vs. nonexistent-user, preventing
account enumeration — confirmed by `auth.test.ts`), but nothing currently
stops repeated password-guessing against a known `(organizationId, email)`
pair. Argon2id's deliberate slowness provides some natural throttling, but
that's a side effect, not a control. Not a Phase 1 blocker (no production
traffic yet), but it belongs on the same "Phase 1 hardening backlog" list
`ARCHITECTURE.md` already keeps for Row-Level Security — a short-window
per-IP/per-account attempt counter (in Postgres or an edge/middleware
layer) before this goes anywhere near real users.

### Finding 7 (low, forward-looking) — bootstrap endpoint has no abuse control

`POST /api/v1/organizations/bootstrap` is intentionally unauthenticated
(it's how a new tenant signs up), and the service's header comment already
flags that production deployment should consider gating it behind an
invite code. Worth being explicit about the two separate risks this
leaves open until that gate exists: (a) unverified email — anyone can claim
`owner@theirrealcompany.com` as an OWNER_ADMIN with no proof of mailbox
ownership, and (b) resource exhaustion — each call does a real argon2id
hash (deliberately expensive) and a DB transaction with no request-level
limit. Neither needs solving before internal/pilot use; both need an answer
before public self-serve signup.

---

## C. Recommended architecture

No changes from the modular-monolith design already recorded in
`ARCHITECTURE.md` Section 1 — it's a sound call and the repository matches
it: `server/modules/*` has zero `next/server` imports, route handlers are
uniformly thin (parse → call service → map error), and the one cross-module
dependency rule stated there (`shared/` has no dependency on any
`modules/*`) holds in every file inspected. The only addition this audit
would make explicit for Phase 1.5 onward: now that a real IAM module
exists as a template, each new module (`catalog`, `inventory`, `sales`,
`production`, `costing`) should get its own `__tests__/` directory running
against the same real-database pattern from day one, not retrofitted later
— the isolation-test style here (fresh random org/branch per test, no
shared fixtures, no cleanup given the audit-trail `ON DELETE RESTRICT`
chain) is worth keeping as the house style, not just an IAM-specific choice.

---

## D. Database assessment

**Correct and already verified (per Finding 1's table, these are the parts
that *are* live):** every table and native-enum column in the applied
`init` migration; all composite foreign keys enforcing `org_id` consistency
between parent and child; the two-table idempotency pattern
(`(org_id, client_request_id)` unique) on every table that needs offline
sync; `UNIQUE (org_id, id)` on every parent table enabling those composite
FKs; `audit_log`'s polymorphic free-text `entity_type` (correctly left
unconstrained — a closed enum here would require a migration per new
feature, defeating the point).

**Should change before Phase 2 starts writing to it:** nothing structural
— the schema design itself (unified `Item`, snapshot-on-creation
`MaterialRequirement`/`bom_id`, append-only `StockMovement` with
system-stamped consumption cost, currency-grouped live-cost views) is
sound and matches the spec's own stated principles (provenance over
plausible numbers, no cross-currency summation, no silent BOM-history
rewrite). What should change is **procedural**: Finding 1 and Finding 2's
constraints need to exist *before* the first `item`/`production_job`/
`stock_movement` row is ever written, not after. Treat "run the manual
migration" as a Phase 1.5 precondition, not a Phase 1 cleanup item, since
Phase 1.5 is literally the first phase that writes to these tables.

**What should wait:** Row-Level Security (already correctly deferred per
`ARCHITECTURE.md`'s own note — composite-FK + mandatory-scope-threading is
a reasonable first layer, RLS as a second independent layer is real but not
urgent); overhead allocation method (explicitly undecided, correctly left
`NULL`-capable rather than guessed); multi-currency-source exchange rates
beyond the single-source-with-provenance model already built.

---

## E. Domain model

Unchanged from `ARCHITECTURE.md` Section 3 — the ERD there is an accurate
description of `schema.prisma` as it stands (verified field-by-field for
the IAM/tenancy section; spot-checked for the later-phase sections). Not
reproduced here to avoid duplicating a diagram that's already correct;
Section B's findings are deltas against it, not replacements.

---

## F. Authorization model

**Confirmed working, by direct code reading and by the test suite actually
exercising it (not just asserted in a comment):**

- Every `server/modules/iam/*` write function takes `AuthenticatedSession`
  (or, for bootstrap, is explicitly the one unauthenticated exception) and
  calls `assertCapability` before touching the database.
- Every read/write that targets an existing row fetches it scoped by
  `orgId` first (`findFirst({ where: { orgId, id } })`) before acting on
  the bare `id` — checked in `branch-service.ts`, `user-service.ts`; no
  counter-example found in any of the 9 route handlers or 5 service files.
- `OWNER_ADMIN` implicit all-branch access is centralized in exactly one
  function (`hasBranchAccess`) and never materialized as grant rows —
  matches the design doc and is the thing `branch-isolation.test.ts`'s
  first test specifically proves ("implicit access… with zero explicit
  grant rows").
- Privilege escalation is blocked at two independent points:
  `assertCapability(role, "user:create")` gates who can create users at
  all, and `assertCanAssignRole` separately blocks a non-OWNER_ADMIN from
  minting a new OWNER_ADMIN even if they do have `user:create`. Both paths
  have a dedicated test.
- `user:update_role` is OWNER_ADMIN-only — a Phase 1 default the code
  comments flag as a choice, not a spec answer; it is consistently applied
  and tested (`rolesLocked` test case).
- The "last active OWNER_ADMIN" guard is present on both the demote and
  deactivate paths, with a known, explicitly-documented (not hidden) TOCTOU
  race under concurrent requests — correctly judged as acceptable for a
  Phase 1 IAM skeleton rather than over-engineered with a `SERIALIZABLE`
  transaction for a vanishingly rare, recoverable failure mode.

**Gap, not in the authorization layer itself but adjacent to it:** no
rate limiting on authentication (Finding 6). Capability/scope checks being
correct doesn't help if the password itself can be brute-forced
unthrottled.

---

## G. Recommended project structure

No changes recommended — the structure in `ARCHITECTURE.md` Section 1 is
exactly what's on disk, and it's working at the scale of one finished
module. Restating it here only to confirm it as the pattern to replicate,
not redesign, for `catalog`/`inventory`/`sales`/`production`/`costing`:

```
src/
  app/api/v1/<module-plural>/...        → thin route handlers
  server/
    modules/<module>/
      <noun>-service.ts                 → one file per aggregate root
      __tests__/                        → real-DB isolation tests, from day one
    shared/                             → zero module-specific imports, ever
```

---

## H. Implementation roadmap

Unchanged in shape from `ARCHITECTURE.md` Section 13, with one insertion
based on this audit's findings:

- **Phase 1 (done, this audit's subject)** — auth, org/branch/user/role,
  audit log, module skeleton. Built, tested, and — pending Finding 1's fix
  — not yet fully guaranteed at the DB layer.
- **Phase 1.5a (new, insert before any catalog code) — "close the manual
  migration gap."** Apply Finding 1's trigger/role/immutability SQL and
  Finding 2's CHECK constraints in one migration. This is a half-day task
  using SQL that's already written, and it's a hard precondition for
  Phase 1.5b, not parallel work — don't let catalog/BOM code get written
  against a database that's still missing the invariants its own tests
  will assume exist.
- **Phase 1.5b — First Slice (as originally scoped)**: catalog + BOM +
  production job + stock ledger + labour + job costing.
- Phases 2–7 as already laid out in `ARCHITECTURE.md` — no changes
  recommended.

---

## I. Risks

- **Documentation/reality drift is the main risk this audit surfaces, not
  any single schema decision.** `ARCHITECTURE.md` reads as a verified,
  tested design — and for the parts that went through local `psql`
  verification during its own writing, it genuinely is. But "verified
  against a real database during development" and "applied to *your*
  database via the migrations actually committed to this repo" turned out
  to be two different claims (Finding 1). The practical risk isn't this one
  gap — it's the pattern: as more phases ship, re-verify by reading the
  applied migration files and the database itself, not by re-reading the
  design doc's confidence level. The design doc describes intent well; it
  is not proof of what's live.
- **Role-separation status is unknown, not just unverified.** This audit
  could not connect to the database (by design — the brief prohibits DB
  changes and no credentials were provided), so "`mops_migrator`/
  `mops_runtime` may not exist as separate roles" is a hypothesis from the
  available evidence (an empty manual-constraints migration, no `.env` in
  the delivered tree, Neon's default single-owner-role pattern), not a
  confirmed fact. Confirm directly — it's a five-minute `psql \du` check —
  before assuming either way.
- **Schema-doc drift between `docs/schema.sql` and `prisma/schema.prisma`
  for later-phase tables** (e.g. `production_job_stage.qty_processed`
  defaults to `0` in `schema.sql`, has no default in `schema.prisma`/the
  applied migration) is low-risk today because nothing writes to those
  tables yet, but will cause real confusion the day someone implements
  Phase 3/4 by reading `schema.sql` as the source of truth when
  `schema.prisma` (plus whatever the next manual migration adds) is what's
  actually live. Worth a short reconciliation pass at the start of
  whichever phase first touches each later-phase table, not now.
- **Argon2id + unauthenticated bootstrap + no rate limiting (Findings 6–7)**
  is a real but currently low-severity combination — low severity only
  because there's no production traffic yet. Revisit before any external
  user touches this.

---

## J. Immediate next step

**Apply the manual-constraints migration this project already specifies,
expanded to include Finding 2's missing CHECK constraints, and confirm
`docs/db-roles-and-security.sql` has actually been run.** Concretely, in
order:

1. `psql` in as a superuser and run `\du` — confirm `mops_migrator` and
   `mops_runtime` exist as separate roles with the privileges
   `db-roles-and-security.sql` Stage 1/3 specify. If they don't, run that
   file now (Stage 3 can run idempotently even if Stage 1 already happened
   via some other path).
2. Open `prisma/migrations/20261007062213_manual_constraints/migration.sql`
   and paste in: the five objects already fully specified in
   `SETUP_COMMANDS.md` Section 5a, plus the nine additional CHECK
   constraints from this audit's Finding 2. Run `npx prisma migrate dev`
   to apply.
3. Run the sanity check `SETUP_COMMANDS.md` Section 6 already gives you
   (attempt an `UPDATE` on `stock_movement` as `mops_runtime`; confirm it's
   rejected) — this is the one check that actually proves Finding 1 is
   closed, as opposed to just believing the migration ran.
4. Run `npx vitest run` and confirm all 23 existing tests still pass
   against the now-hardened schema — they should, since none of them touch
   the newly-constrained tables, but this is the cheap way to catch a typo
   in step 2 before it reaches Phase 1.5 code.
5. Only then start Phase 1.5 (catalog + BOM + first-slice job costing).

This is explicitly *not* "run `npm audit`" or "add a test script" or any
of the other low-severity findings above — those are real but don't block
anything. Finding 1 blocks every later phase's safety guarantees from being
true, and all the SQL to fix it already exists in this repository.

---

## Hardening Addendum — 2026-10-07

Scope of this round: close Finding 1 and Finding 2 above (Finding 3, the
`.gitignore` pattern, is addressed here too since it's a one-line fix
touching the same migration-hygiene theme; Findings 4–7 remain untouched —
out of scope per instruction, not forgotten). No product architecture,
IAM behavior, tenant model, branch authorization, or business logic changed.

### Migration-history decision: new migration, not an edit

`20261007062213_manual_constraints` is recorded as applied in your
database's `_prisma_migrations` table, which stores a checksum of the
migration file's content at apply time. Editing that file's SQL in place
now wouldn't undo anything in the live database (it was, and remains, a
no-op empty migration) — but it would make the on-disk file's checksum
stop matching the one already recorded, which `prisma migrate
status`/`migrate deploy` surfaces as "migration modified after it was
applied." That's a migration-history integrity problem, and in a stricter
environment (CI, a teammate's machine) `migrate deploy` can refuse to
proceed when it sees that.

The correct fix is to roll forward: a new migration,
`prisma/migrations/20261007080000_harden_manual_constraints/migration.sql`,
carries every object that should have been in the original. The empty
migration stays exactly as it is — applied, empty, and now a permanent,
accurate record that this gap existed and when it was closed, rather than
something to be quietly erased from history.

### Finding 2's count, verified

The original report said "at least nine more CHECK constraints"; re-checked
line-by-line against `docs/schema.sql` before writing the migration, as
asked: it's **9 tables, 11 individual CHECK constraints** (`sales_order_line`
and `labour_record` each carry two). The original phrasing was ambiguous,
not wrong, but worth stating precisely since the verification query in
`SETUP_COMMANDS.md` Section 11.3 asserts exactly 11 rows — if that query
ever returns a different count, something is actually missing, not just
imprecisely counted.

### Section 4 of the brief: what stays manual vs. what's migration-managed

Splitting `docs/db-roles-and-security.sql` in two, by what each statement
actually depends on:

**Must stay manual, forever, not just for now:**
- `CREATE ROLE mops_migrator` / `CREATE ROLE mops_runtime` and the
  `ALTER DATABASE ... OWNER TO` that follows (Stage 1). Role creation
  needs `CREATEROLE` or superuser privilege. `mops_migrator` — the role
  that runs Prisma migrations — is deliberately never granted
  `CREATEROLE` (see its own `CREATE ROLE ... NOSUPERUSER CREATEDB`
  statement — `CREATEDB`, not `CREATEROLE`), so even in principle a
  migration running as `mops_migrator` could never execute this. This
  isn't a current limitation to work around later; it's the actual
  security boundary the two-role split exists to draw.
- Stage 3's `GRANT ... TO mops_runtime` statements. These name a specific
  role. Baking them into a Prisma migration would make `prisma migrate
  deploy` fail outright on any database where Stage 1 hasn't run yet (the
  named role wouldn't exist to grant to), and would hard-couple the
  versioned schema-migration chain to an operational detail — the exact
  runtime role name — that isn't guaranteed identical across every
  environment you might ever deploy to.

**Safe to migration-manage (now living in the hardening migration):**
- `prevent_mutation()` and its four triggers. These have no dependency on
  any role name — the function body raises unconditionally on
  `UPDATE`/`DELETE`, for every role including the table owner. Whether
  `mops_runtime` exists, has the right grants, or exists at all doesn't
  change whether this trigger fires.
- `trg_stock_movement_before_insert()`. Its `SECURITY DEFINER` clause makes
  it run with the privileges of whichever role *owns* the function —
  automatically whichever role the migration runs as. If the two-role
  split exists, that's `mops_migrator`, exactly as intended. If it
  doesn't exist yet, the function is just owned by your current single
  role and `SECURITY DEFINER` is a harmless no-op until the split happens
  — no re-migration needed when it does.
- The partial unique index, the email CHECK, the 11 business-rule CHECKs,
  the generated column, and the two views — ordinary schema DDL, no role
  dependency at all.

### Role existence: do not assume — verify

`docs/db-roles-and-security.sql`'s header now flags this directly: its
"run as the postgres superuser" instructions assume a local PostgreSQL
install. Neon doesn't expose a conventional `postgres` superuser login —
Stage 1/Stage 3 should be run as your Neon project's default/owner role
instead. Whether `mops_migrator`/`mops_runtime` currently exist at all is
unverified by this audit (no database credentials were available or used)
— `SETUP_COMMANDS.md` Section 11.2 gives the exact `pg_roles` query to
check. Don't treat either answer as a blocker: the hardening migration
(Finding 1/2's fix) is correct and complete whether or not that role split
has happened yet, by construction (see the DEFINER point above). The role
split itself is still worth doing — it's `ARCHITECTURE.md`'s stated design
— just on its own schedule, confirmed rather than assumed.

### Finding 3 closed

`.gitignore`'s `.env*` → `.env*` / `!.env.example` split, so a future commit
of `.env.example` as a template isn't silently dropped.

### Files in this round

| File | Change | Why |
|---|---|---|
| `prisma/migrations/20261007080000_harden_manual_constraints/migration.sql` | **New** | Carries every object `20261007062213_manual_constraints` should have had (5 originally-specified + 11 CHECK constraints) plus the 4 immutability triggers relocated from `db-roles-and-security.sql` — see above for why each piece landed here. |
| `docs/db-roles-and-security.sql` | **Changed** | Removed the `prevent_mutation()`/trigger block (now migration-managed); header explains the split and adds the Neon connection note. |
| `docs/SETUP_COMMANDS.md` | **Changed** | Section 5a rewritten to the roll-forward strategy; Section 6 trimmed to grants-only and its sanity check extended to cover `audit_log`, not just `stock_movement`; new Section 11 with the full verification checklist and role-existence query. |
| `.gitignore` | **Changed** | `.env*` exception for `.env.example` (Finding 3). |
| `docs/AUDIT_PHASE0_POSTSETUP.md` | **Changed** | This addendum. |

### Local commands, start to finish

```powershell
cd C:\Users\Accounts\Desktop\erp-sys

# 1. Confirm current migration state before touching anything
npx prisma migrate status

# 2. Create + fill the new migration (paste the SQL from the delivered
#    migration.sql into the file this command creates)
npx prisma migrate dev --create-only --name harden_manual_constraints
# → open the generated prisma/migrations/<timestamp>_harden_manual_constraints/migration.sql
#   and replace its content with this delivery's version of that file
npx prisma migrate dev

# 3. Role check (Section 11.2) — see SETUP_COMMANDS.md for the full query
psql "<your current connection string>" -c "SELECT rolname FROM pg_roles WHERE rolname IN ('mops_migrator','mops_runtime');"

# 4. If Stage 1/Stage 3 haven't run yet and you want the role split now:
psql "<superuser-equivalent connection string>" -d mops_dev -f docs/db-roles-and-security.sql

# 5. Object-existence verification (Section 11.3) and the two sanity checks
#    (Section 6) — run every query in SETUP_COMMANDS.md Sections 6 and 11.3

# 6. Regression check
npx vitest run
```

### Verification checklist

- [ ] `npx prisma migrate status` shows all three migrations applied, no drift warnings
- [ ] Role-existence query run and result known (either answer is fine, just no longer assumed)
- [ ] All 11 CHECK constraints present (SETUP_COMMANDS.md §11.3 query returns 11 rows)
- [ ] `uq_bom_one_active_per_product` exists
- [ ] `app_user_email_lowercase` exists
- [ ] `trg_stock_movement_before_insert` trigger + function exist, `prosecdef = true`
- [ ] `job_cost_actual.gross_profit` column exists with a generation expression
- [ ] Both `job_material_cost_live` / `job_labour_cost_live` views exist
- [ ] All 4 `*_immutable` triggers exist (the Finding 1 fix)
- [ ] `UPDATE stock_movement ... WHERE false` fails with the immutable-table error
- [ ] `UPDATE audit_log ... WHERE false` fails with the immutable-table error
- [ ] `npx vitest run` — all 23 existing tests still pass

Only once every box is checked does Phase 1.5 start.
