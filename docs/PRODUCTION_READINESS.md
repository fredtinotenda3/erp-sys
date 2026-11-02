# Production readiness: security, database and operations

What is **implemented and tested in this repository**, what is **documentation of how to operate it**, and what is **not verified**. Nothing here claims a backup exists or that any live system has been checked.

## 1. Account security (implemented, tested)

| Control | How it works |
|---|---|
| Passwords | Argon2id (OWASP parameters), 12–200 characters. Never logged, audited or returned |
| Change password | `POST /api/v1/auth/password/change`, signed in, needs the current password; wrong guesses are throttled (5 per 15 min per user); ends all other sessions, keeps the current one |
| Reset request | `POST /api/v1/auth/password-reset/request`: same `202` answer for real and unknown accounts; throttled per address (10/h) and per typed account (3/h) **before** any lookup, so the 429 does not reveal account existence |
| Reset token | 256 random bits, only its SHA-256 stored, valid 30 minutes, single use; a newer request retires older tokens |
| Reset confirm | `POST /api/v1/auth/password-reset/confirm`: claims the token atomically, sets the password, signs out **every** session; refused for deactivated users; throttled per address (20/h) |
| Login throttling | After 5 failures per account+address, 30 per address, or 20 per account in 15 minutes, login returns `429` + `Retry-After`, even for the right password. Counted on what was typed, so unknown accounts throttle identically |
| Timing | A dummy Argon2 verification runs for unknown/inactive accounts so response time does not reveal which emails exist |
| Sessions | Opaque random token, SHA-256 stored, 24 h fixed, revocable. Deactivation revokes sessions immediately; role and branch grants are read from the database on every request, so permission changes apply at once |
| Organization bootstrap | The one unauthenticated tenant-creating route is **disabled in production unless `ORG_BOOTSTRAP_TOKEN` is set** and presented as `x-bootstrap-token`; always rate limited |
| Every other API route | A test imports every `route.ts` and proves it answers 401 with no cookie and with a forged cookie |

### Email delivery: required before production use
No mail provider exists in this repository. **Until one is wired, production password reset cannot deliver links**, and the code deliberately creates no token in that case (warning logged without email or token).

To enable it: at server start call `setPasswordResetMailer(async ({ email, organizationSlug, token, expiresAt }) => { … })` from `src/server/modules/iam/password-service.ts`, send a link of the form `${APP_BASE_URL}/reset-password?token=<token>` over your provider (SMTP/Resend/SES …), and never log the message body. Set `APP_BASE_URL` to your https origin.

Development: set `NODE_ENV=development` and `PASSWORD_RESET_DEV_OUTBOX=1`; links are appended to `.dev-outbox/password-reset.log` (git-ignored). This is impossible to enable when `NODE_ENV=production`.

### Rate limiting: how it works and its limits
Counters live in the `auth_throttle` table (atomic upsert), because in-memory counters do not work on serverless hosting. Identifiers are hashed. The client address comes from `x-vercel-forwarded-for` / `x-real-ip` / `x-forwarded-for`; **these are only trustworthy behind a proxy that sets them (Vercel does). Elsewhere a caller can forge them.** Rows older than a day can be purged with `purgeExpiredThrottles()` (run it from a scheduled job; not scheduled by this repo).

## 2. Tenant and branch boundaries: what actually exists
- **Organization (tenant) isolation exists**: every table carries `org_id`, composite foreign keys keep references inside one organization, and every service filters by it. Covered by `tenant-isolation.test.ts` and the "not found across organizations" tests in each module.
- **Branch isolation exists** for users who are not OWNER_ADMIN: explicit grants in `user_branch_access`; services return "not found" for other branches; audit log, reports and CSV exports are scoped (tested).
- **Not implemented**: PostgreSQL row-level security (isolation is enforced by application code and constraints, not by the database engine), per-organization encryption keys.

## 3. Identifying the database target safely (never print secret values)
1. Two URLs exist: `MIGRATION_DATABASE_URL` (schema owner, used only by `prisma migrate`) and `RUNTIME_DATABASE_URL` (least-privilege, used by the running app).
2. To see **where** a URL points without exposing the password, print only host and database name:
   `node -e "const u=new URL(process.env.RUNTIME_DATABASE_URL);console.log(u.host,u.pathname)"` (run it with the variable loaded; it prints no credentials).
3. Compare the **usernames** the same way (`u.username`): they must differ between the two URLs. **If they are the same, the runtime role has schema-changing rights it must not have.** This was flagged in an earlier audit and **has not been verified for your live Neon project**; do it before launch.
4. Run `node -e "..."` against the *development* `.env` first; a production URL must never be present on a developer machine.
5. The seed guard (`src/server/dev/seed-guard.ts`) refuses to run seeds against a non-local target; do not bypass it.

## 4. Migration and runtime role separation
- Create the roles with `docs/db-roles-and-security.sql` (stage 1 and 2 as the database owner, stage 3 after migrations). `mops_migrator` owns the schema; `mops_runtime` gets CRUD only on ordinary tables, `INSERT`-only on ledgers (`stock_movement`, `audit_log`, `exchange_rate`, `job_cost_actual`, …) and `SELECT`-only on `stock_balance`.
- Migration `20261031100000_account_security` adds `password_reset_token` and `auth_throttle` (additive) and grants them to `mops_runtime` if that role exists.
- Neon: create two roles in the project, put the migrator URL only in the deployment pipeline's secret store, and the runtime URL only in the app's environment.

## 5. Migration review and deployment procedure
1. Create a **Neon branch** of production (copy-on-write) and apply the new migrations there first.
2. Read each new `migration.sql`: additive only? any `DROP`, `ALTER … TYPE`, `NOT NULL` on populated columns, or long locks?
3. Run the test suite against the branch with test data only (`npx vitest run`, plus UI config).
4. Take/confirm a restorable backup (section 6) immediately **before** production deploy.
5. Apply with `npx prisma migrate deploy` using the migrator URL, from the pipeline, never from a laptop.
6. Deploy the app, then check `GET /api/v1/health` returns `{"status":"ok"}`.
7. Roll forward on problems; if a migration failed mid-way follow `docs/SETUP_COMMANDS.md` section 9 (`migrate resolve`).

## 6. Backups and restore testing (to be configured; none verified)
**Status: unverified.** This repository contains no backup configuration and nothing here proves one exists. Neon provides point-in-time restore within the project's retention window and branching; **check the retention window for your plan in the Neon console and record it.**
Recommended and required before real data:
- Confirm automated backups / PITR are enabled and the retention window meets your policy.
- Add a scheduled logical dump (`pg_dump`, run with a **read-only** role) to storage outside Neon; record where.
- **Restore test, monthly and before launch**: restore into a *new, isolated* Neon branch or database (never over production), run the migrations check (`prisma migrate status` with the migrator URL pointed at it), run `npx vitest run` against it only if it contains no real data (otherwise run read-only spot checks: row counts per table, latest `audit_log` timestamp, `stock_balance` equals the sum of `stock_movement`), then delete it. Write down the date, who did it, how long it took.
- A backup that has not been restored successfully is not evidence of recoverability.

## 7. Monitoring
`GET /api/v1/health` (unauthenticated, returns only `ok`/`degraded`, 503 when the database is unreachable) is available for an uptime monitor. No error tracking, alerting or log shipping is configured in this repository.

## 8. Deployment checklist
1. [ ] Roles: `mops_migrator` and `mops_runtime` exist with **different usernames**; runtime URL cannot run DDL (try `CREATE TABLE` as that role in a scratch database; it must fail).
2. [ ] Secrets set in the host's secret store only: `MIGRATION_DATABASE_URL` (pipeline), `RUNTIME_DATABASE_URL`, `SESSION_SECRET`, `APP_BASE_URL`. No `.env` file deployed.
3. [ ] `NODE_ENV=production`; `ORG_BOOTSTRAP_TOKEN` **unset** (or set only during onboarding).
4. [ ] Mail provider wired through `setPasswordResetMailer`; a real reset email received and the link worked once and then failed.
5. [ ] HTTPS only; confirm the session cookie is `Secure; HttpOnly; SameSite=Lax`.
6. [ ] Host passes a trusted client-address header (Vercel: automatic).
7. [ ] Migrations reviewed, rehearsed on a Neon branch, applied by the pipeline.
8. [ ] Backup/PITR retention recorded; one restore test completed in isolation.
9. [ ] Uptime monitor on `/api/v1/health`; someone is alerted when it fails.
10. [ ] Run `npm audit` and review (not done in this repository's checks).
11. [ ] First OWNER_ADMIN created via the gated bootstrap; password changed; deactivate any bootstrap/test accounts.
12. [ ] Browser smoke test of login, forgot/reset password, change password, one order, one job (not automated here).
