// Pure safety check for the automated test suite's database target, mirroring
// seed-guard.ts's shape exactly: no I/O, so it can be unit-tested without a
// filesystem or a real database. vitest.test-env.ts (necessarily impure -- it
// reads process.env and the filesystem) calls this and throws on failure.
//
// Context: vitest.test-env.ts's assertSafeTestDatabase already refuses any
// non-local MIGRATION_DATABASE_URL / RUNTIME_DATABASE_URL outright unless
// ALLOW_REMOTE_TEST_DB=1 is set -- which is the common, recommended path
// (docker-compose.test.yml / scripts/test-db-setup.mjs) and needs nothing
// further. This module only adds checks for what happens once a team DOES
// opt into ALLOW_REMOTE_TEST_DB=1 (e.g. a shared branched/ephemeral database
// in CI): even then, the suite writes permanent, unrecoverable rows
// (audit_log and the stock ledger are append-only -- see docs/TESTING.md),
// so the same "positive, explicit confirmation of the exact target"
// discipline seed-guard.ts already applies to the dev seed now applies here
// too. This closes a gap that docs/SUPPLIERS_VERIFICATION_CHECKPOINT.md §7
// flagged explicitly rather than papering over: "there is no code-level
// guard here that stops MIGRATION_DATABASE_URL/RUNTIME_DATABASE_URL from
// pointing at a production Neon database if you put production credentials
// in [.env.test] ... unlike src/server/dev/seed-guard.ts."
import { isProductionLikeLabel, LOCAL_DB_HOSTS, parseTarget, targetLabel, type DbTarget } from "./db-target";

export interface RemoteTestDbEnv {
  MIGRATION_DATABASE_URL?: string;
  RUNTIME_DATABASE_URL?: string;
  ALLOW_REMOTE_TEST_DB?: string;
  TEST_DB_CONFIRM_TARGET?: string;
}

export interface RemoteTestDbCheck {
  ok: boolean;
  /** "<database>@<host>", never including credentials. Null until at least one URL parses. */
  target: string | null;
  problems: string[];
}

function isLocal(t: DbTarget | null): boolean {
  return t !== null && LOCAL_DB_HOSTS.has(t.host);
}

/**
 * Evaluates whether it is safe for the automated test suite to run against the
 * configured MIGRATION_DATABASE_URL / RUNTIME_DATABASE_URL.
 *
 * - Both local (the normal path): always fine, nothing further required -- unchanged
 *   from before this module existed.
 * - Either non-local and ALLOW_REMOTE_TEST_DB is not exactly "1": this function reports
 *   no problem. That refusal is deliberately left to vitest.test-env.ts's own per-URL
 *   loop, which already names the specific offending variable -- this function would
 *   otherwise duplicate that message with less detail.
 * - Either non-local and ALLOW_REMOTE_TEST_DB=1 (the opt-in a team actually uses, e.g.
 *   a shared CI database): three further checks now apply, none of which existed
 *   before this hardening pass --
 *     1. the two URLs must name the same database (a mismatched pair would silently
 *        test against a target nobody meant to use),
 *     2. the target must not look like a production system by name, and
 *     3. the operator must positively confirm the exact target with
 *        TEST_DB_CONFIRM_TARGET=<label>, copied by hand from the error message --
 *        never satisfied by a stray or inherited environment variable.
 */
export function checkRemoteTestDbSafety(env: RemoteTestDbEnv): RemoteTestDbCheck {
  const migration = parseTarget(env.MIGRATION_DATABASE_URL);
  const runtime = parseTarget(env.RUNTIME_DATABASE_URL);

  if (isLocal(migration) && isLocal(runtime)) {
    return { ok: true, target: runtime ? targetLabel(runtime) : null, problems: [] };
  }
  if (env.ALLOW_REMOTE_TEST_DB !== "1") {
    return { ok: true, target: null, problems: [] };
  }

  const problems: string[] = [];
  if (!migration) problems.push("MIGRATION_DATABASE_URL is missing or unreadable.");
  if (!runtime) problems.push("RUNTIME_DATABASE_URL is missing or unreadable.");
  if (migration && runtime && targetLabel(migration) !== targetLabel(runtime)) {
    problems.push("MIGRATION_DATABASE_URL and RUNTIME_DATABASE_URL point at different databases.");
  }

  const label = runtime ? targetLabel(runtime) : migration ? targetLabel(migration) : null;
  if (label && isProductionLikeLabel(label)) {
    problems.push(`The target "${label}" looks like a production database -- refusing even with ALLOW_REMOTE_TEST_DB=1.`);
  }
  if (label) {
    const confirmed = env.TEST_DB_CONFIRM_TARGET;
    if (!confirmed) {
      problems.push(
        `ALLOW_REMOTE_TEST_DB=1 is set: also set TEST_DB_CONFIRM_TARGET=${label} in .env.test (copy this exact value -- ` +
          "only if this really is a throwaway/branched database the suite may write permanent rows to).",
      );
    } else if (confirmed !== label) {
      problems.push(`TEST_DB_CONFIRM_TARGET does not match the configured database (${label}).`);
    }
  }
  return { ok: problems.length === 0, target: label, problems };
}
