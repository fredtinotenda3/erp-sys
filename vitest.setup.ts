// Runs in every test worker before each test file.
// Environment is already populated from .env.test by vitest.config.ts (see vitest.test-env.ts).
import { afterAll } from "vitest";
import { assertSafeTestDatabase, loadTestEnv } from "./vitest.test-env";

loadTestEnv();
assertSafeTestDatabase();

// Close this file's connection pool when the file finishes, instead of leaving it for the
// process to drop. Unclosed pools accumulate server-side connections across a long run.
// No import of the db module here: files that never touch the database stay cheap.
afterAll(async () => {
  const client = (globalThis as { __mopsPrismaClient?: { $disconnect(): Promise<void> } }).__mopsPrismaClient;
  if (client) await client.$disconnect().catch(() => undefined);
});
