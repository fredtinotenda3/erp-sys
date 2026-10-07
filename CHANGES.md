# Operis / erp-sys — App Router Structure Cleanup

## 1. Summary

Your upload was not a "pristine `src/app` that needs moving" — it was already in a
**mixed state**: `app/api/v1/*` (all 9 route handlers) already existed at root with
import paths correctly adjusted for that location, while `src/app/api/v1/*` was a
**stale, unreferenced duplicate** of the same 9 files left over from before the move.

This matches your own project history: `docs/AUDIT_PHASE0_POSTSETUP.md` ("Structural
Consolidation Addendum, Round 3, 2026-10-07") and `docs/ARCHITECTURE.md` both already
document `app/` as the single, final App Router location and state `src/app/` "no
longer exists." Your uploaded zip just still had the old directory lying around on
disk — the move had already been *decided and executed in content*, just not fully
cleaned up in this copy of the tree.

**What I actually did:**

1. Diffed every one of the 9 files under `src/app/api/v1/*` against its counterpart
   under `app/api/v1/*`. All 9 pairs are identical except for import paths (the only
   difference is relative-path depth to `src/server/*`, which is mechanically correct
   for each file's location — `src/app/...` is one directory shallower to `src/` than
   `app/...` is, so the corrected version has one extra `../src/` segment). No handler
   logic, status code, validation, auth check, or response shape differs between the
   two copies.
2. Confirmed `app/layout.tsx` and `app/page.tsx` were already the only root
   layout/page (nothing under `src/app` conflicted with them).
3. Deleted `src/app/` in full (9 files + now-empty parent directories).
4. Grepped the entire repo for any remaining `"src/app"` references in code — none
   found (only historical mentions in the two docs files above, which correctly
   describe it as already gone).
5. Ran the requested verification commands (results below).

**Net effect:** no file under `app/api/v1/*`, `src/server/*`, `prisma/*`, or anywhere
else changed content. The only change is a deletion of dead duplicate files.

## 2. Final relevant directory structure

```
erp-sys/
├── app/                              ← ONLY Next.js App Router (confirmed)
│   ├── layout.tsx
│   ├── page.tsx
│   ├── globals.css
│   ├── favicon.ico
│   └── api/
│       └── v1/
│           ├── audit-log/route.ts
│           ├── auth/
│           │   ├── login/route.ts
│           │   └── logout/route.ts
│           ├── branches/
│           │   ├── route.ts
│           │   └── [id]/route.ts
│           ├── organizations/
│           │   └── bootstrap/route.ts
│           └── users/
│               ├── route.ts
│               ├── [id]/route.ts
│               └── [id]/branch-access/route.ts
│
├── src/
│   └── server/                       ← untouched, exactly as before
│       ├── shared/
│       │   ├── authz.ts
│       │   ├── db.ts
│       │   ├── errors.ts
│       │   ├── http.ts
│       │   ├── password.ts
│       │   └── scope.ts
│       └── modules/
│           └── iam/
│               ├── audit-service.ts
│               ├── branch-service.ts
│               ├── org-service.ts
│               ├── session-guard.ts
│               ├── session-service.ts
│               ├── user-service.ts
│               └── __tests__/
│                   ├── audit.test.ts
│                   ├── auth.test.ts
│                   ├── branch-isolation.test.ts
│                   ├── tenant-isolation.test.ts
│                   └── test-helpers.ts
│
├── prisma/        (unchanged)
├── docs/          (unchanged)
├── public/        (unchanged)
└── ...            (unchanged)
```

`src/app/` does not exist anywhere in this tree.

## 3. Import/path changes made

**None.** Because `app/api/v1/*` already had the correct import paths, nothing needed
rewriting. If your local working copy is in the same mixed state as the upload (both
`app/api/v1/*` and `src/app/api/v1/*` present, byte-identical modulo import depth),
the fix is a pure deletion — see "How to apply this" below.

If your local copy instead only has `src/app/api/v1/*` (i.e. the version in this
upload's `app/api/v1/*` doesn't exist locally yet), you cannot apply this package as
a deletion-only change — tell me and I'll regenerate it as an actual move with import
rewrites for your real local state.

## 4. Verification results

Run in a clean install of this package's tree (Node 22, `npm install`; this sandbox
has no reachable Postgres and no outbound access to `binaries.prisma.sh`, so two
steps are marked accordingly — both are pre-existing environment gaps, not caused by
this change; `prisma/schema.prisma` itself already notes "not run in this sandbox" as
a known gap from earlier rounds of this project).

| Command | Result | Notes |
|---|---|---|
| `npm run lint` (`eslint`) | **0 errors**, 2 warnings | Warnings are pre-existing, in `src/server/shared/db.ts` and `http.ts` (unused `eslint-disable` comments) — not in any file this task touched |
| `npx next typegen` | **Pass** | Generates Next.js's route-type ambients; a conflicting `app`/`src/app` setup would surface here — it didn't |
| `npx tsc --noEmit` | 21 pre-existing errors, **0 new** | All 21 are either (a) implicit-`any` params in `src/server/**` and its `__tests__/**` that predate this task, or (b) `Cannot find module '.../generated/prisma/client'` — the Prisma client generation step (`prisma generate`) requires fetching engine binaries from `binaries.prisma.sh`, which this sandbox's network allowlist blocks (403). None reference `src/app`, routing, or anything this task touched. |
| `npx vitest run` | 4 suites fail at import stage | Same root cause as above: `src/server/shared/db.ts` imports the ungenerated `../../generated/prisma/client`. Also requires a live Postgres connection this sandbox doesn't have. Unrelated to the structural change — no test references `src/app` or the old route paths. |
| `npx prisma migrate status` | Could not run | Same `binaries.prisma.sh` 403 blocks the schema engine binary fetch. No migration files were touched. |

**What this means for you:** run `npm run lint`, `npx tsc --noEmit`, and
`npx vitest run` again on your own machine (where `npx prisma generate` can reach
the network and you have `DATABASE_URL`s pointed at your real Neon instance) before
treating this as fully green. I'd expect the 21 tsc errors to drop to the handful of
genuine pre-existing implicit-`any` lint-level issues once the Prisma client exists;
none of them will be fixed by anything in this package, since none are related to the
move.

## 5. Changed / moved / created files

| Path | Change |
|---|---|
| `src/app/api/v1/audit-log/route.ts` | **Deleted** (stale duplicate of `app/api/v1/audit-log/route.ts`) |
| `src/app/api/v1/auth/login/route.ts` | **Deleted** (stale duplicate) |
| `src/app/api/v1/auth/logout/route.ts` | **Deleted** (stale duplicate) |
| `src/app/api/v1/branches/route.ts` | **Deleted** (stale duplicate) |
| `src/app/api/v1/branches/[id]/route.ts` | **Deleted** (stale duplicate) |
| `src/app/api/v1/organizations/bootstrap/route.ts` | **Deleted** (stale duplicate) |
| `src/app/api/v1/users/route.ts` | **Deleted** (stale duplicate) |
| `src/app/api/v1/users/[id]/route.ts` | **Deleted** (stale duplicate) |
| `src/app/api/v1/users/[id]/branch-access/route.ts` | **Deleted** (stale duplicate) |

No files were created, moved, or had their content modified. `app/api/v1/*`,
`app/layout.tsx`, `app/page.tsx`, `src/server/**`, `prisma/**`, and every other file
in the repo are byte-for-byte unchanged.

## 6. Confirmation: `src/app/` no longer exists

Confirmed. `find . -iname app` (excluding `node_modules`) returns exactly one match:
`./app`. A full-repo grep for the string `src/app` in code (`.ts`/`.tsx`/`.mjs`/
`.json`) returns zero matches; the only remaining mentions are historical narrative
in `docs/AUDIT_PHASE0_POSTSETUP.md` and `docs/ARCHITECTURE.md`, both of which
describe it as already removed.

## 7. Confirmation: no API/auth/authorization/tenant/business logic changed

Confirmed. The only operation performed was deleting 9 files whose content was
byte-identical (apart from import-path depth) to files already present and unchanged
at `app/api/v1/*`. Specifically untouched: HTTP methods, request/response contracts,
status codes, `requireSession`/`errorResponse` usage, validation (`ValidationError`,
`NotFoundError`), role/permission checks (`ROLE_VALUES`, `requireSession`),
branch/org-unit scoping, audit logging (`audit-service.ts`), `prisma/schema.prisma`,
and every file under `src/server/**`.

## How to apply this to your local repo

This package ships as a **manifest + scripts**, not a bulk file dump — per your
instructions, nothing under `app/api/v1/*` was actually changed, so there is nothing
new to copy over it. Two idempotent scripts are included:

- `scripts/apply-cleanup.sh` (bash / Git Bash / WSL)
- `scripts/apply-cleanup.ps1` (PowerShell)

Both do exactly one thing: if `src/app/` exists, delete it; if it doesn't, no-op.
Run whichever matches your shell from the repo root, then re-run your verification
commands locally.

**If your local repo is NOT in this exact mixed state** (e.g. `app/api/v1/*` doesn't
exist locally and only `src/app/api/v1/*` does), stop before running the script and
tell me — in that case this isn't a deletion, it's a real move, and I'll regenerate
the package with the 9 files relocated and their imports rewritten instead.

---

## Recommendation on the `src/` question (not applied — awaiting your decision)

You asked, separately from the scoped cleanup: *"if recommended the src folder
should not be in project, do the best as you recommend."* I'm flagging this rather
than acting on it, because it conflicts with the explicit, narrower instructions in
the same message ("Keep: `src/server/` exactly... Do NOT redesign anything... Keep
the change narrowly scoped") — and a rename touches every import in 9 route files
plus all of `src/server/**` (~23 files), which is a materially different, larger
change than "move one directory."

My actual recommendation: **drop `src/` and promote `server/` to the repo root**,
sibling to `app/`:

```
erp-sys/
├── app/
├── server/        ← was src/server/
│   ├── shared/
│   └── modules/
├── prisma/
...
```

Reasoning: Next.js's `src/` convention exists specifically to let you nest `app/`
(or `pages/`) inside it as `src/app/`, keeping all first-party source under one
folder sibling to config files. You've deliberately kept `app/` at the root instead.
Once `app/` is at root, `src/` is no longer serving that convention — it's just a
wrapper around a single directory (`server/`), which adds a path segment to every
import for no structural benefit and reads as a leftover from before the Round 3
decision to root `app/`, not a deliberate choice. Dropping it is cosmetic (no
behavior change) but removes a bit of permanent noise from every future import in
this module.

This is **not included in this package**. If you want it, say so explicitly and I'll
do it as its own narrowly-scoped round — mechanical rename + import rewrite across
~23 files, same "no behavior change" guarantee and the same verification pass, kept
separate from this structural-cleanup delivery so each change stays independently
reviewable and revertible.
