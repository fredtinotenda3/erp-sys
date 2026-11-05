# Running the tests

The suite is 400+ tests against a **real PostgreSQL** (tenant isolation, ledger triggers, grants and
concurrency are enforced by the database, so a mock would prove nothing). It must run against a
**local throwaway database**, not Neon.

## Why not Neon

Diagnosed from the failed runs: every failure was a connection timeout (`Connection terminated due to
connection timeout`, `Connection terminated unexpectedly`) or a 30s/60s/90s test timeout, in files with
nothing in common. Tests that need ~0.5–1 s of database work on a local Postgres took 5–30 s each against
`us-east-2` — every statement pays a transatlantic round trip, interactive transactions hold connections for
dozens of round trips, and the concurrency tests (`Promise.all` of 6–8 writers) then queue behind a 10-connection
pool and a 5 s connect timeout. The run took 70–95 minutes instead of minutes, and which test lost the race
changed from run to run. The same tests pass locally (see "Verified" below).

Two more reasons not to test against the shared database:

- The suite creates permanent rows. `audit_log` and the stock ledger are append-only (by design), so test
  organizations can never be deleted. Against the demo database they pile up in front of the customer.
- Both URLs in `.env` use the Neon owner role, so the `mops_runtime` privilege checks were not testing
  the real least-privilege role. Locally they do.

## One-time setup

```powershell
Copy-Item .env.test.example .env.test
npm run test:db:up        # starts postgres:16 in Docker on port 54329 (data in RAM)
npm run test:db:setup     # roles, database, prisma migrate deploy, runtime grants, currencies
```

No Docker? Install PostgreSQL 16 locally, then point `TEST_DB_ADMIN_URL` (and the host/port in the two other URLs)
in `.env.test` at it and run `npm run test:db:setup`.

## Every time

```powershell
npm test
```

`npm run test:db:reset` drops and rebuilds the test database (do it now and then; test organizations accumulate).
`npm run test:db:down` deletes the container and its data.

## Guard rails

- The suite reads **only `.env.test`**, never `.env`. If `.env.test` is missing it stops with instructions.
- It refuses any non-local database host unless `ALLOW_REMOTE_TEST_DB=1`.
- If you do set `ALLOW_REMOTE_TEST_DB=1` (e.g. a shared/branched database in CI), the suite additionally
  requires `TEST_DB_CONFIRM_TARGET=<database>@<host>` (copy the exact value from the error message on
  first refusal — never type it from memory) and refuses outright if the target's name looks like
  production (`prod`/`production`/`live`), even when confirmed. This mirrors the confirmation the dev
  seed (`src/server/dev/seed-guard.ts`) already requires — see `src/server/dev/test-db-guard.ts`.
- `scripts/test-db-setup.mjs` also refuses non-local hosts (it creates roles and can drop the database).
- Plain `npx prisma migrate deploy` still targets `.env` (Neon). The setup script passes the test URL explicitly,
  so it cannot hit Neon.

## Tuning

`TEST_TIMEOUT_MS`, `TEST_HOOK_TIMEOUT_MS` (defaults 30 s / 60 s), `DB_POOL_MAX`, `DB_CONNECT_TIMEOUT_MS`.
