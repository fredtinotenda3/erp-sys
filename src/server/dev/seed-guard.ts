// Safety guard for the development seed. Pure (no I/O) so it can be unit-tested.
//
// The seed writes real rows through the application's services, so it must never
// run against the wrong database. A connection string alone can't prove a Neon
// database is "development" (there is no environment flag in the URL), so the
// guard requires a POSITIVE, explicit confirmation of the exact target:
//
//   OPERIS_DEV_SEED_TARGET=<database>@<host>
//
// which the operator copies from the dry-run output. It also refuses when
// NODE_ENV=production, when the two configured URLs disagree about the target,
// or when the database/host name looks like production. Passwords and usernames
// are never read into the result, so nothing secret can be printed.

export interface DbTarget {
  host: string;
  database: string;
}

/** Neon serves the same database on a pooled host ("-pooler") and a direct one. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/-pooler(?=\.)/, "");
}

export function parseTarget(url: string | undefined): DbTarget | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (!u.hostname || !database) return null;
    return { host: normalizeHost(u.hostname), database };
  } catch {
    return null;
  }
}

export const targetLabel = (t: DbTarget) => `${t.database}@${t.host}`;

export interface GuardResult {
  ok: boolean;
  /** "<database>@<host>", never including credentials. */
  target: string | null;
  problems: string[];
}

export function checkSeedSafety(env: Record<string, string | undefined>): GuardResult {
  const problems: string[] = [];
  if (env.NODE_ENV === "production") problems.push("NODE_ENV is 'production'; the development seed never runs in production mode.");

  const runtime = parseTarget(env.RUNTIME_DATABASE_URL);
  const migration = parseTarget(env.MIGRATION_DATABASE_URL);
  if (!runtime) problems.push("RUNTIME_DATABASE_URL is missing or unreadable.");
  if (!migration) problems.push("MIGRATION_DATABASE_URL is missing or unreadable.");
  if (runtime && migration && targetLabel(runtime) !== targetLabel(migration)) {
    problems.push("RUNTIME_DATABASE_URL and MIGRATION_DATABASE_URL point at different databases.");
  }

  const label = runtime ? targetLabel(runtime) : null;
  if (label && /(^|[^a-z])(prod|production|live)([^a-z]|$)/i.test(label)) {
    problems.push(`The target "${label}" looks like a production database.`);
  }

  if (label) {
    const confirmed = env.OPERIS_DEV_SEED_TARGET;
    if (!confirmed) {
      problems.push(`Confirmation required: set OPERIS_DEV_SEED_TARGET=${label} (only if this really is your development database).`);
    } else if (confirmed !== label) {
      problems.push(`OPERIS_DEV_SEED_TARGET does not match the configured database (${label}).`);
    }
  }
  return { ok: problems.length === 0, target: label, problems };
}
