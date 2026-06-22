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
      // Baseline 2026-06-21: statements 84.71% / branches 70.73% /
      // functions 83.02% / lines 86.6%. Tracked +5pp target: lines >= 91,
      // branches >= 75 (see docs/reference/coverage-harness.md). Never lower
      // these; raise them as coverage improves.
      thresholds: {
        statements: 84,
        branches: 70,
        functions: 83,
        lines: 86,
      },
    },
  },
});
