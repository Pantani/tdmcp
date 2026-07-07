import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/knowledge/data/**"],
      // G2 coverage gate (no-regression floor): thresholds are locked to the
      // measured baseline, floored to the integer at/below current coverage.
      // Enforced in CI by the "Coverage Gate" job (.github/workflows/ci.yml),
      // a required check in ci-success — so a regression fails the build.
      // Baseline 2026-07-07 (ratcheted): statements 86.98% / branches 73.36% /
      // functions 85.47% / lines 88.85%. Tracked +5pp target: lines >= 91,
      // branches >= 75 (see docs/reference/coverage-harness.md). Never lower
      // these; raise them as coverage improves.
      thresholds: {
        statements: 86,
        branches: 73,
        functions: 85,
        lines: 88,
      },
    },
  },
});
