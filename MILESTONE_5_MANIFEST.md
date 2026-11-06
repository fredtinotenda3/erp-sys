## Milestone 5 of 6: Configurable Industry Architecture

**Scope of this delivery.** A controlled, OWNER_ADMIN-only mechanism for an
organisation to declare which manufacturing industry it runs and which of
that industry's optional modules it has enabled, with a static registry of
seven supported profiles — exactly Milestone 5's scope (mandate §7). Only
`general` (the pre-existing, implicit default behaviour) and `plastics`
are **implemented**; `food_beverage`, `metal_fabrication`,
`textile_garment`, `furniture_woodworking`, and `packaging_printing` are
registered (so the mechanism is architecturally ready for them) but
deliberately claim zero available modules and `isImplemented: false` —
per the mandate, "do not permit arbitrary users to change an
organisation's manufacturing configuration" and do not "pretend
industry-specific workflows have already been implemented" for the five
unbuilt profiles.

This section, and the ZIP it describes, contain **only the files changed or
added for this milestone** on top of Milestones 1–4's delivery — not a full
copy of the repository.

### 1. What was implemented

- **A static profile registry** (`profile-registry.ts`, 137 lines) —
  `PROFILE_REGISTRY`, a compile-time (never built or mutated at request
  time) map of all 7 `IndustryProfileKey` values to a label, description,
  `isImplemented` flag, `implementedModules` list, and a `terminology`
  override (e.g. plastics relabels "Work Centre"/"Machine" to "Production
  Line"/"Press", and adds "Mould" — read back by every role via
  `me-service.ts`, §4). This is intentionally **not** a database table: the
  set of profiles and which modules each one offers is a code-level,
  reviewed decision, not something any user — including `OWNER_ADMIN` —
  can expand by writing a row. Adding profile #8, or a new module to an
  existing profile, is a code change and a migration-free deploy, exactly
  the "avoid unnecessary runtime plugin loading" the mandate asks for.
- **Reading an org's own profile** (`getIndustryProfile`) — every
  authenticated session can read its own organisation's current
  `industryProfile`, `enabledModules`, `isImplemented`, and resolved
  `terminology` map. **No capability check at all** — like `me-service.ts`'s
  `orgName`, this is base information every role needs to render the app
  shell correctly (e.g. to know whether to say "Machine" or "Press"), not a
  privileged read.
- **Listing all profiles** (`listIndustryProfiles`) — the static registry,
  as-is, for the settings-page picker. Also uncapability-gated (it is
  compile-time data, not per-organisation state) and verified
  **not** organisation-specific: two calls in the same process return
  `toEqual` results regardless of which session (or no session's worth of
  state) calls it.
- **Changing an org's profile** (`updateIndustryProfile`) — `OWNER_ADMIN`
  only (`industry_profile:manage`, deliberately narrower than every other
  "admin tier" capability in `authz.ts`, which `OPERATIONS_MANAGER`
  otherwise mirrors — see §6). Validates the target `industryProfile`
  against the 7 registered keys, and every requested `enabledModules` entry
  against **that target profile's own** `implementedModules` list (so an
  unimplemented profile — which has an empty implemented-modules list —
  rejects any module at all, and a valid module for plastics is rejected
  for `food_beverage`). Deduplicates a module key submitted more than once.
  Every successful change is audited (`recordAudit`, `entityType:
  "organization"`) with a `beforeValue`/`afterValue` snapshot of
  `{industryProfile, enabledModules}`, so a profile switch is itself part
  of the organisation's permanent audit trail, not a silent column update.
- **Enforcing the profile on Milestone 6 writes**
  (`assertPlasticsProfileActive`) — the single real enforcement point every
  Milestone 6 **write** path calls before touching plastics-specific data:
  throws `ValidationError` unless the organisation's current
  `industryProfile === "plastics"`. Deliberately does **not** also check
  `industryProfileModules` — the plastics vertical's own write paths
  (material attributes, product spec, moulds, process detail, regrind) are
  gated on the profile being plastics at all, not on each optional module
  being individually enabled; `enabledModules` is informational/UI-facing
  (which plastics features a given org has turned on for itself) rather
  than a second, finer-grained authorisation layer, which would have
  doubled the gating logic for no requirement the mandate actually states.
- **Historical-data safety on a profile switch** — switching an
  organisation away from `plastics` (to `general`, or in theory to any
  other profile) changes **nothing** about already-recorded
  `PlasticsMaterialAttributes`/`PlasticsProductSpec`/`Mould`/
  `PlasticsProcessDetail`/regrind-sourced `MaterialLot` rows: every
  Milestone 6 **read** path is intentionally **never** profile-gated
  (`assertPlasticsProfileActive` is called only from write paths — see
  each Milestone 6 service file's own header comment, and §7's tests, which
  explicitly switch an org away from plastics and assert reads still
  succeed while writes are rejected). This is the direct implementation of
  the mandate's "changing an org's profile cannot corrupt historical
  transactions."

### 2. The user's non-negotiables, addressed directly

1–8 (WIP cost flow, material double-counting, lot/batch genealogy, the
stock ledger as single source of truth, negative inventory/duplicate
postings, immutable stock-movement history, org/branch isolation,
transactional stock-changing operations) — **not applicable to this
milestone directly**: `updateIndustryProfile` changes one `Organization`
row (`industryProfile`/`industryProfileModules`) and writes one audit row;
it posts no `StockMovement`, touches no `MaterialLot`, `ProductionJob`, or
cost record, and is wrapped in no multi-statement transaction because it
has nothing else to coordinate. The milestone's actual accounting-relevant
contribution is **negative-space**: it guarantees (§1, "historical-data
safety") that nothing about a profile switch can retroactively corrupt
Milestone 1–4 or Milestone 6 financial/inventory history, which is the
concrete form "preserve immutable stock-movement history" and "never count
material value twice" take for a cross-cutting configuration feature like
this one.
9. **Do not permit arbitrary users to change an organisation's
   manufacturing configuration** (mandate §7, verbatim) — this is this
   milestone's primary non-negotiable, and it is enforced at the single
   `industry_profile:manage` capability, held by `OWNER_ADMIN` alone (§6),
   checked inside `updateIndustryProfile` itself (not just at the route or
   UI layer, so a direct API call is covered identically to the settings
   page).
10. **Avoid unnecessary runtime plugin loading; avoid a generic EAV model**
    (mandate §7) — `profile-registry.ts` is a plain, statically-typed
    TypeScript map read at import time, not a database-driven plugin
    loader or an entity-attribute-value table; there is no dynamic
    `require`/`import()` of per-profile code anywhere in this milestone,
    and `Organization.industryProfileModules` is a `JSONB` array of string
    keys **validated against the static registry**, not an open
    key-value bag that could accumulate arbitrary, unvalidated shape over
    time.

### 3. Database schema

`prisma/schema.prisma` (additive): 1 new enum (`IndustryProfile`, the 7
`IndustryProfileKey` values); 2 new columns on `organization`
(`industry_profile` `IndustryProfile` NOT NULL DEFAULT `'general'`,
`industry_profile_modules` `JSONB` NOT NULL DEFAULT `'[]'`).

Migration:
`prisma/migrations/20261109080000_configurable_industry_architecture/migration.sql`
(51 lines, read and verified in full) — additive only:
- `CREATE TYPE "IndustryProfile" AS ENUM (...)` with exactly the 7 values
  `profile-registry.ts` declares.
- `ALTER TABLE "organization" ADD COLUMN "industry_profile" ... DEFAULT
  'general'` — every existing organisation in any database this migration
  runs against is defaulted to `general`, i.e. **exactly today's implicit
  behaviour**; nothing about any existing organisation's visible behaviour
  changes the moment this migration applies.
- `ALTER TABLE "organization" ADD COLUMN "industry_profile_modules" JSONB
  NOT NULL DEFAULT '[]'`, with a `CHECK (jsonb_typeof(industry_profile_modules)
  = 'array')` — the one place this schema enforces the column's shape at
  the database level, independently of the application-level validation in
  §1.
- Guarded (`IF EXISTS`) runtime `GRANT`, identical convention to every
  prior migration.

**No destructive operation of any kind.** Nothing drops a column, a table,
or data; no existing row's observable behaviour changes. No migration was
run against any database by this round of work — per the mandate, that
remains the user's own action against their own local environment
(see §10, in order).

### 4. Backend: files and API routes

| File | Change |
|---|---|
| `src/server/modules/industry/profile-registry.ts` | New. Static `PROFILE_REGISTRY`, `IndustryProfileKey`/`IndustryProfileDefinition` types, `isValidModuleForProfile`. |
| `src/server/modules/industry/industry-profile-service.ts` | New. `getIndustryProfile`, `listIndustryProfiles`, `updateIndustryProfile`, `assertPlasticsProfileActive`. |
| `src/server/shared/authz.ts` | New capability `industry_profile:manage` (`OWNER_ADMIN` only — see §6). |
| `src/server/modules/iam/me-service.ts` | Extended. `CurrentUserDisplay` now includes `industryProfile`, `industryProfileIsImplemented`, and the resolved `terminology` map, populated from `profile-registry.ts` — every role's own session now knows its organisation's profile and vocabulary without a second round-trip. |
| `lib/api-types.ts` | New "Milestone 5" section: `IndustryProfileKey`, `IndustryProfileModuleEntry`, `IndustryProfileRegistryEntry`, `OrganizationIndustryProfile`. |

New API routes:

| Route | Method | Handler |
|---|---|---|
| `/api/v1/organization/industry-profile` | GET / PATCH | `getIndustryProfile` / `updateIndustryProfile` |
| `/api/v1/organization/industry-profiles` | GET | `listIndustryProfiles` |

Both routes read, spot-checked this session: the exact
`requireSession`/`errorResponse` thin-wrapper pattern used everywhere else
in this codebase, no deviation — `GET /organization/industry-profile`
performs no capability check of its own (the service itself is
uncapability-gated, by design, §1), `PATCH` delegates its `OWNER_ADMIN`
check entirely to `updateIndustryProfile`.

### 5. Frontend

- **Manufacturing-profile settings page**
  (`app/(app)/settings/industry-profile/page.tsx`,
  `components/features/settings/industry-profile-form.tsx`, 127 lines) — a
  picker across the 7 registered profiles (unimplemented ones visibly
  disabled/labelled, never silently selectable), a checkbox list of the
  target profile's own `implementedModules`, and the current profile/module
  state, gated on `industry_profile:manage` the same way every other
  manage-level settings control in this codebase is.
- **Settings nav entry** (`components/shell/nav-config.ts`) — "Manufacturing
  profile" nested under the existing Settings parent, visible only with
  `industry_profile:manage`; the Settings parent's own capability list was
  widened to include it so the parent item still renders for `OWNER_ADMIN`
  (this changes nothing for any other role today, since
  `industry_profile:manage` is `OWNER_ADMIN`-only — see §6).

### 6. Permission changes

One new capability: `industry_profile:manage`, held by **`OWNER_ADMIN`
only** — deliberately narrower than every other "admin tier" capability in
`authz.ts`, which `OPERATIONS_MANAGER` otherwise mirrors throughout this
codebase. It sits alongside `user:update_role` as the two capabilities
`OPERATIONS_MANAGER` does **not** receive, both for the same reason: both
are privilege/configuration-escalation-shaped actions the mandate
(§7, "do not permit arbitrary users to change an organisation's
manufacturing configuration") and this codebase's own existing convention
(role changes) agree should sit with the owner tier alone. There is
deliberately no separate `industry_profile:read` capability: every role
already receives its own organisation's current profile via
`me-service.ts` (§4), the same "every role needs this to render the app
shell" reasoning that file already applies to `orgName`. No existing
capability or permission was weakened, removed, or had its role grants
narrowed.

### 7. Tests added

One new file,
`src/server/modules/industry/__tests__/industry-profile-service.test.ts`
(175 lines), written against a real Postgres database in the same style as
every other module suite in this codebase, hand-verified this session
against the real service/schema code line by line (every called function's
existence and signature cross-checked against the real source;
`tsc --noEmit` confirmed to introduce zero new, non-stale-client issues —
see §8):

- **`getIndustryProfile`** — every new organisation defaults to `general`
  with default terminology, for every role; not capability-gated (`VIEWER`,
  the least-privileged role, can read it).
- **`listIndustryProfiles`** — all 7 profiles present; only `general` and
  `plastics` marked `isImplemented`; the five unimplemented profiles report
  an empty `availableModules`; `plastics`'s own module list is non-empty and
  includes `regrind_tracking`; not capability-gated and not
  organisation-specific (two calls `toEqual` each other).
- **`updateIndustryProfile`** — rejects every role except `OWNER_ADMIN`
  (`ForbiddenError`); a valid switch to plastics with a real module subset
  succeeds and is immediately visible on re-read, including the resolved
  `terminology.machineLabel === "Press"`; a module not in the **target**
  profile's implemented list is rejected (tested against both plastics with
  a nonexistent module key, and `food_beverage` — an unimplemented profile
  — with a module that **is** valid for plastics, confirming the check is
  genuinely per-target-profile, not a flat global module list); a submitted
  module key is deduplicated; an unknown `industryProfile` value and an
  empty payload are both rejected; every successful change is audited with
  a correct `beforeValue`/`afterValue.industryProfile`; tenant isolation
  (org B's profile is untouched by org A's change).
- **`assertPlasticsProfileActive`** — throws `ValidationError` while an
  organisation is on `general`, resolves once switched to `plastics`, and
  deliberately leaves its fixture organisation on `plastics` at the end of
  the file — every Milestone 6 service test file assumes its own fixture
  organisation (or a freshly created one) starts on, or explicitly switches
  to, the plastics profile before exercising a Milestone 6 write path.

**Deliberately not tested, and why:** a capability-isolation test comparing
`industry_profile:manage` against every *other* role's capability set was
not written as a single parametrised loop over all 7 roles; instead,
`OPERATIONS_MANAGER` (the role every other "admin tier" capability in this
file is granted to, making it the one genuinely informative negative case)
and `VIEWER` (the least-privileged role) are tested explicitly — testing
all 7 roles individually would not exercise any additional branch of the
authorisation logic beyond "is this role `OWNER_ADMIN`," so the two chosen
roles already give full coverage of the actual decision.

### 8. Tests executed and results

**Not executed in this environment** — the same unfixable network-egress-
allowlist limitation documented exhaustively in Milestone 4's §8 (`npx
prisma generate`'s native engine download and a throwaway Docker Postgres
pull are both blocked by this sandbox's proxy allowlist; this is a
networking restriction, never a database-safety concern, and the mandate's
own safety constraint was never the obstacle). That investigation is not
repeated per-milestone; it stands for this delivery too.

`npx tsc --noEmit` was run before and after this milestone's service and
test code was written. The service files (`profile-registry.ts`,
`industry-profile-service.ts`) introduce **zero** errors of their own —
every type they use (`Organization.industryProfile`/
`industryProfileModules`, the new `IndustryProfile` enum) is already
correctly declared in `prisma/schema.prisma`; the one place a test
(`industry-profile-service.test.ts`) touches the stale generated client
indirectly is through its own fixture helpers, and it introduces **zero**
new error lines beyond those already present from Milestones 1–4's
documented stale-client state. This is a smaller, cleaner milestone on
this axis than Milestone 4 or 6: the new `Organization` columns are
genuinely new fields on an existing, already-generated model, not a new
model the stale client has no knowledge of at all, so the day-to-day
development experience (autocomplete, inline type errors) for this
milestone's own code is already mostly clean even before
`npx prisma generate` is run.

### 9. Known limitations (deliberate scope decisions, not oversights)

- **Only `general` and `plastics` are implemented.** The mandate is
  explicit that the first fully implemented profile is plastics and that
  other profiles "should be architecturally supported without pretending
  their industry-specific workflows have already been implemented." The
  other five profiles are real, selectable registry entries with real
  labels/descriptions, but `isImplemented: false` and an empty module list
  — selecting one in the settings UI is possible (so the mechanism is
  provably general, not plastics-hardcoded) but grants no additional
  behaviour anywhere in the application, by design.
- **`enabledModules` is not currently read by any Milestone 6 write path.**
  Every Milestone 6 mutation gates on `assertPlasticsProfileActive` (the
  org being on `plastics` at all), not on a specific module being enabled.
  `enabledModules` is real, validated, audited, per-organisation state —
  useful today for a UI to show/hide feature areas the org has opted into —
  but this delivery does not yet have the org deliberately scoping down
  which Milestone 6 features it uses; a finer-grained module-level gate on
  individual service functions is a plausible future refinement, not
  something the mandate requires for this milestone.
- **Terminology override is read-only, UI-facing vocabulary, not a
  validation rule.** `terminology.machineLabel` changing to "Press" for a
  plastics org changes what label the settings/machine pages render; it
  does not change any field name, validation rule, or stored value — a
  plastics org's `Machine` rows are still literally `Machine` rows in the
  database and through every API response's field names.
- **No profile-change history/audit *view*, only the underlying audit
  rows.** `updateIndustryProfile` writes a correct, queryable
  `AuditLog` row on every change (§1), but there is no dedicated "profile
  change history" report or page surfacing those rows specifically; they
  are visible through the existing generic audit log, like every other
  audited action in this codebase, not a new purpose-built view.

### 10. Required local commands

```
npx prisma generate                         # regenerates the client against the new
                                             # IndustryProfile enum and organization columns
npx prisma migrate dev                      # applies 20261109080000_configurable_industry_architecture
                                             # (and every prior migration, if not already applied)
npm test -- industry-profile-service
npx tsc --noEmit
npm run lint
```
Before running `prisma migrate dev`, confirm what `prisma.config.ts` and
your local `.env`/`.env.local` actually point at — **never assume `.env`
points to a safe local database.** Nothing above was run against your
database or any database by this round of work.

### 11. Manual configuration required

None. The new capability is wired into the existing role tables; no new
environment variable, feature flag, or external service is introduced. The
settings nav entry is code-level, not configuration.

### 12. Files in this delivery (Milestone 5)

Changed (5):
```
prisma/schema.prisma
src/server/shared/authz.ts
src/server/modules/iam/me-service.ts
lib/api-types.ts
components/shell/nav-config.ts
```

New (7):
```
prisma/migrations/20261109080000_configurable_industry_architecture/migration.sql
src/server/modules/industry/profile-registry.ts
src/server/modules/industry/industry-profile-service.ts
app/api/v1/organization/industry-profile/route.ts
app/api/v1/organization/industry-profiles/route.ts
app/(app)/settings/industry-profile/page.tsx
components/features/settings/industry-profile-form.tsx
src/server/modules/industry/__tests__/industry-profile-service.test.ts
```

