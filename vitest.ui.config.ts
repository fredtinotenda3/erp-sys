import { defineConfig } from "vitest/config";
import path from "node:path";

// Pure-logic tests for the UI layer (formatting, validation, idempotency,
// permission-aware nav, response projection). No database and no .env needed,
// so they run anywhere: `npm run test:ui`. The real-database suites keep using
// vitest.config.ts unchanged.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "components/**/*.test.ts", "src/server/modules/catalog/item-view.test.ts"],
  },
});
