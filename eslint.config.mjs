import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Test files intentionally read back loosely-typed service return values
  // (several services return Record<string, unknown> views -- see
  // stock-core.ts's toMovementView and job-view.ts's toJobView -- whose
  // shape depends on the caller's role/capabilities) via `: any` /
  // `as any`, a documented, long-standing convention across this test
  // suite (see e.g. mould-service.test.ts's and
  // plastics-process-service.test.ts's own comments on it), not a lint
  // gap to close file-by-file. No test file disables the rule generally;
  // this only exempts the `any`-for-untyped-service-output idiom tests
  // already relied on before eslint-config-next started flagging it.
  {
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
