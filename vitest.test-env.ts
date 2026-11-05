// Single source of truth for "which database may the test suite touch".
//
// The suite creates permanent rows (audit_log and the stock ledger are append-only, so tests
// cannot delete what they create). It must therefore never run against the database you use
// for demos or development. It reads .env.test only, and refuses non-local databases unless
// ALLOW_REMOTE_TEST_DB=1 is set.
//
// Hardening pass: once ALLOW_REMOTE_TEST_DB=1 is actually used (a shared/branched database,
// e.g. in CI), a further positive-confirmation + production-name check now applies too -- see
// test-db-guard.ts's header comment for why this was added and what gap it closes.
import { config } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { LOCAL_DB_HOSTS } from "./src/server/dev/db-target";
import { checkRemoteTestDbSafety } from "./src/server/dev/test-db-guard";

const LOCAL_HOSTS = LOCAL_DB_HOSTS;

export function loadTestEnv(): void {
  const file = path.join(process.cwd(), ".env.test");
  if (existsSync(file)) {
    // override: a stray shell variable or a DATABASE URL from .env must not win over .env.test.
    config({ path: file, override: true, quiet: true });
  }
}

export function assertSafeTestDatabase(): void {
  const urls: [string, string | undefined][] = [
    ["MIGRATION_DATABASE_URL", process.env.MIGRATION_DATABASE_URL],
    ["RUNTIME_DATABASE_URL", process.env.RUNTIME_DATABASE_URL],
  ];

  if (!existsSync(path.join(process.cwd(), ".env.test"))) {
    throw new Error(
      "\n\n.env.test not found — tests were not run.\n\n" +
        "The suite no longer reads .env (that is the database you demo from). Set up a throwaway one:\n" +
        "  1. Copy-Item .env.test.example .env.test\n" +
        "  2. npm run test:db:up\n" +
        "  3. npm run test:db:setup\n" +
        "  4. npm test\n" +
        "See docs/TESTING.md.\n",
    );
  }

  for (const [name, value] of urls) {
    if (!value) throw new Error(`${name} is not set in .env.test.`);
    let host: string;
    try {
      host = new URL(value).hostname.toLowerCase();
    } catch {
      throw new Error(`${name} in .env.test is not a valid URL.`);
    }
    if (!LOCAL_HOSTS.has(host) && process.env.ALLOW_REMOTE_TEST_DB !== "1") {
      throw new Error(
        `\n\nRefusing to run tests: ${name} points at "${host}", which is not a local database.\n` +
          "The suite writes permanent rows and would pollute (and be crippled by the latency of) a shared or " +
          "remote database. Use docker-compose.test.yml (docs/TESTING.md). If you really mean it, set " +
          "ALLOW_REMOTE_TEST_DB=1 in .env.test.\n",
      );
    }
  }

  // Everything above refuses a remote database outright unless ALLOW_REMOTE_TEST_DB=1 is set --
  // unchanged. Once that opt-in is actually used, apply the same positive-confirmation and
  // production-name checks seed-guard.ts already requires of the dev seed (see test-db-guard.ts).
  const remote = checkRemoteTestDbSafety({
    MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
    RUNTIME_DATABASE_URL: process.env.RUNTIME_DATABASE_URL,
    ALLOW_REMOTE_TEST_DB: process.env.ALLOW_REMOTE_TEST_DB,
    TEST_DB_CONFIRM_TARGET: process.env.TEST_DB_CONFIRM_TARGET,
  });
  if (!remote.ok) {
    throw new Error(
      "\n\nRefusing to run tests against a remote database (ALLOW_REMOTE_TEST_DB=1 is set):\n\n - " +
        remote.problems.join("\n - ") +
        "\n",
    );
  }
}
