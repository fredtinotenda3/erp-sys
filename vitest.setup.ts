// Loads .env into process.env for test runs. Vite/Vitest populates
// `import.meta.env`, not `process.env`, by default — but every module under
// test reads `process.env.RUNTIME_DATABASE_URL` etc. directly (see
// src/server/shared/db.ts), so process.env needs to actually be populated.
import "dotenv/config";

if (!process.env.RUNTIME_DATABASE_URL || !process.env.MIGRATION_DATABASE_URL) {
  throw new Error(
    "RUNTIME_DATABASE_URL / MIGRATION_DATABASE_URL are not set. Copy .env.example to " +
      ".env and fill in real values before running the isolation test suite — these " +
      "tests run against a real local PostgreSQL instance, not a mock.",
  );
}
