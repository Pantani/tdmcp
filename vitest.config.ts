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
      thresholds: {
        statements: 84,
        branches: 70,
        functions: 82,
        lines: 85,
      },
    },
  },
});
