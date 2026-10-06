import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Real Postgres round-trips (including intentionally-slow argon2id
    // hashing per shared/password.ts) are slower than in-memory unit tests.
    // 30s keeps CI from timing out on a cold connection pool without
    // masking a genuinely hung test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // These tests hit one real database and create real rows (see
    // src/server/modules/iam/__tests__/test-helpers.ts) — run them
    // sequentially within a file and across files to avoid unrelated
    // concurrent test runs racing on shared reference data (e.g. the
    // `currency` table) or on connection-pool limits against a small local
    // Postgres instance.
    fileParallelism: false,
  },
});
