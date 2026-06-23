import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CoverageMetric,
  type CoverageSummary,
  fileRows,
  makeMarkdown,
  parseArgs,
  summarizeSurfaces,
} from "../../scripts/coverage-harness.mjs";

const metric = (total: number, covered: number): CoverageMetric => ({
  total,
  covered,
  skipped: 0,
  pct: total === 0 ? 100 : (covered / total) * 100,
});

function summaryFile(
  lines: [number, number],
  functions: [number, number],
  branches: [number, number],
) {
  return {
    lines: metric(lines[0], lines[1]),
    statements: metric(lines[0], lines[1]),
    functions: metric(functions[0], functions[1]),
    branches: metric(branches[0], branches[1]),
  };
}

describe("coverage harness helpers", () => {
  it("parses CLI options without running coverage", () => {
    expect(
      parseArgs(["--summary-only", "--limit=4", "--min-lines=87.5", "--output=_workspace/x.md"]),
    ).toEqual({
      limit: 4,
      minLines: 87.5,
      output: "_workspace/x.md",
      summaryOnly: true,
    });

    expect(parseArgs(["--limit=0"]).limit).toBe(20);
    expect(parseArgs(["--skip-run"]).summaryOnly).toBe(true);
  });

  it("filters executable TypeScript source rows and ranks surface gaps", () => {
    const root = process.cwd();
    const summary = {
      total: summaryFile([100, 85], [20, 15], [30, 20]),
      [join(root, "src", "cli", "agent.ts")]: summaryFile([20, 10], [4, 2], [8, 4]),
      [join(root, "src", "resources", "creativeRagResource.ts")]: summaryFile(
        [12, 10],
        [3, 3],
        [4, 3],
      ),
      [join(root, "src", "knowledge", "data", "generated.ts")]: summaryFile(
        [99, 0],
        [1, 0],
        [1, 0],
      ),
      [join(root, "src", "empty.ts")]: summaryFile([0, 0], [0, 0], [0, 0]),
      [join(root, "docs", "guide.ts")]: summaryFile([20, 0], [2, 0], [2, 0]),
    } satisfies CoverageSummary;

    const rows = fileRows(summary);
    expect(rows.map((row) => row.file)).toEqual([
      "src/cli/agent.ts",
      "src/resources/creativeRagResource.ts",
    ]);

    const surfaces = summarizeSurfaces(rows);
    expect(surfaces[0]).toMatchObject({
      surface: "entrypoints-cli-llm",
      files: 1,
      missing: 10,
    });
    expect(surfaces[1]).toMatchObject({
      surface: "resources-knowledge",
      files: 1,
      missing: 2,
    });
  });

  it("renders a markdown report with top gaps and suggested waves", () => {
    const root = process.cwd();
    const summary = {
      total: summaryFile([100, 86], [20, 16], [30, 21]),
      [join(root, "src", "tools", "demo.ts")]: summaryFile([30, 20], [5, 3], [8, 5]),
    } satisfies CoverageSummary;

    const rows = fileRows(summary);
    const markdown = makeMarkdown(summary, rows, { limit: 1 });

    expect(markdown).toContain("# Test Coverage Harness Report");
    expect(markdown).toContain("| Lines | 86 / 100 | 86.00% |");
    expect(markdown).toContain("`src/tools/demo.ts`");
    expect(markdown).toContain("tools: 10 uncovered lines");
    expect(markdown).toContain("npm run coverage:harness -- --summary-only");
  });
});
