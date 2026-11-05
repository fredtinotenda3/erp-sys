// Shared pure helpers for naming a database target without ever reading or
// storing credentials. Used by both the dev-seed guard (seed-guard.ts) and
// the test-database guard (test-db-guard.ts) so the two "is this safe to
// write permanent rows to" checks can't silently diverge on what counts as
// the same database or what counts as a production-looking name.
//
// Extracted out of seed-guard.ts (which used to define these inline) when
// test-db-guard.ts needed the identical logic -- see that file's header for
// why. seed-guard.ts re-exports parseTarget/targetLabel so existing imports
// of them from "./seed-guard" keep working unchanged.

export interface DbTarget {
  host: string;
  database: string;
}

/** Neon serves the same database on a pooled host ("-pooler") and a direct one. */
export function normalizeHost(host: string): string {
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

const PRODUCTION_LABEL_PATTERN = /(^|[^a-z])(prod|production|live)([^a-z]|$)/i;

/** True if a "<database>@<host>" (or any free-text) label looks like it names a production system. */
export function isProductionLikeLabel(label: string): boolean {
  return PRODUCTION_LABEL_PATTERN.test(label);
}

/** Hostnames treated as safe for destructive, repeatable local test-database operations. */
export const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres-test", "host.docker.internal"]);
