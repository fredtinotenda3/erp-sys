import { defineConfig } from "vitest/config";
import { loadTestEnv } from "./vitest.test-env";

// Must run before anything reads process.env: the config is evaluated in the main process and
// the forked test workers inherit its environment, so every module under test sees .env.test.
loadTestEnv();

const num = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Intentionally-slow argon2id hashing plus real Postgres round trips. Generous enough for a
    // cold machine, tight enough that a genuinely hung test still fails. Override with
    // TEST_TIMEOUT_MS / TEST_HOOK_TIMEOUT_MS (e.g. when pointing at a remote database).
    testTimeout: num("TEST_TIMEOUT_MS", 30_000),
    hookTimeout: num("TEST_HOOK_TIMEOUT_MS", 60_000),
    // Tests share one real database and reference data (e.g. the `currency` table), so files run
    // one at a time, each in its own process (and therefore its own connection pool, which the
    // setup file closes when the file finishes).
    fileParallelism: false,
    pool: "forks",
  },
});
