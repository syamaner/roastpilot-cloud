import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated test/coverage output.
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    // snowflake/ is a Python tool (schemachange + its own pytest suite,
    // isolated from npm/package.json) -- a local `snowflake/.venv/` (per
    // its own README setup instructions) bundles third-party JS assets
    // (e.g. coverage.py's HTML report template) that ESLint would
    // otherwise scan and warn on. Git-ignored already; excluded here too
    // so `npm run lint` stays clean for anyone who has that venv set up
    // locally, not just in CI (which never creates it).
    "snowflake/.venv/**",
  ]),
]);

export default eslintConfig;
