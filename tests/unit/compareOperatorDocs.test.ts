import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { compareOperatorDocsImpl } from "../../src/tools/layer3/compareOperatorDocs.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-compare-operator-tool-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeCompareFixture(dataDir: string): void {
  mkdirSync(join(dataDir, "operators"), { recursive: true });
  mkdirSync(join(dataDir, "python-api"), { recursive: true });
  mkdirSync(join(dataDir, "tutorials"), { recursive: true });
  mkdirSync(join(dataDir, "versions"), { recursive: true });
  mkdirSync(join(dataDir, "techniques"), { recursive: true });
  mkdirSync(join(dataDir, "td-classes"), { recursive: true });

  writeJson(join(dataDir, "operators", "index.json"), [
    {
      slug: "unknown_alpha",
      name: "Unknown Alpha",
      displayName: "Unknown Alpha",
      category: "",
      subcategory: "",
      summary: "Fixture without category metadata.",
      keywords: ["unknown"],
    },
    {
      slug: "unknown_beta",
      name: "Unknown Beta",
      displayName: "Unknown Beta",
      category: "",
      subcategory: "",
      summary: "Second fixture without category metadata.",
      keywords: ["unknown"],
    },
  ]);
  writeJson(join(dataDir, "operators", "unknown_alpha.json"), {
    name: "Unknown Alpha",
    displayName: "Unknown Alpha",
    summary: "Fixture without category metadata.",
  });
  writeJson(join(dataDir, "operators", "unknown_beta.json"), {
    name: "Unknown Beta",
    displayName: "Unknown Beta",
    summary: "Second fixture without category metadata.",
  });
  writeJson(join(dataDir, "python-api", "index.json"), []);
  writeJson(join(dataDir, "tutorials", "index.json"), []);
  writeJson(join(dataDir, "patterns.json"), []);
  writeJson(join(dataDir, "glsl.json"), []);
  writeJson(join(dataDir, "versions", "version-manifest.json"), { versions: [] });
  writeJson(join(dataDir, "versions", "release-highlights.json"), { releases: {} });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), { operators: {} });
  writeJson(join(dataDir, "versions", "python-api-compatibility.json"), { classes: {} });
  writeJson(join(dataDir, "versions", "experimental-builds.json"), { buildSeries: [] });
}

function makeCtx(dataDir?: string): ToolContext {
  return {
    knowledge: new KnowledgeBase(dataDir ? { dataDir } : undefined),
    logger: silentLogger,
  } as unknown as ToolContext;
}

interface CompareData {
  operatorA: { name: string; category?: string };
  operatorB: { name: string; category?: string };
  overview: {
    sameCategory: boolean;
    sameSubcategory: boolean;
    parameterCountA: number;
    parameterCountB: number;
  };
  sharedParameters: Array<{ name: string; type?: string }>;
  uniqueToA: Array<{ name: string }>;
  uniqueToB: Array<{ name: string }>;
  summary: { sharedCount: number; uniqueToACount: number; uniqueToBCount: number };
}

function sc(result: CallToolResult): CompareData {
  return (result as { structuredContent?: CompareData }).structuredContent as CompareData;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("compareOperatorDocsImpl", () => {
  it("compares two operator docs and reports shared and unique parameters", () => {
    const result = compareOperatorDocsImpl(makeCtx(), {
      operator_a: "Noise TOP",
      operator_b: "Noise CHOP",
      include_parameters: true,
      parameter_limit: 20,
    });
    const data = sc(result);

    expect(data.operatorA.name).toBe("Noise TOP");
    expect(data.operatorB.name).toBe("Noise CHOP");
    expect(data.overview.sameCategory).toBe(false);
    expect(data.sharedParameters.some((parameter) => parameter.name === "Seed")).toBe(true);
    expect(data.uniqueToA.length).toBeGreaterThan(0);
    expect(data.uniqueToB.length).toBeGreaterThan(0);
    expect(textOf(result)).toContain("Compared Noise TOP vs Noise CHOP");
  });

  it("respects the parameter comparison limit", () => {
    const result = compareOperatorDocsImpl(makeCtx(), {
      operator_a: "Noise TOP",
      operator_b: "Noise CHOP",
      parameter_limit: 2,
    });
    const data = sc(result);

    expect(data.sharedParameters.length).toBeLessThanOrEqual(2);
    expect(data.uniqueToA.length).toBeLessThanOrEqual(2);
    expect(data.uniqueToB.length).toBeLessThanOrEqual(2);
    expect(data.summary.sharedCount).toBeGreaterThanOrEqual(data.sharedParameters.length);
  });

  it("can return only the overview when parameter comparison is disabled", () => {
    const result = compareOperatorDocsImpl(makeCtx(), {
      operator_a: "Noise TOP",
      operator_b: "Noise CHOP",
      include_parameters: false,
    });
    const data = sc(result);

    expect(data.overview.parameterCountA).toBeGreaterThan(0);
    expect(data.overview.parameterCountB).toBeGreaterThan(0);
    expect(data.sharedParameters).toEqual([]);
    expect(data.uniqueToA).toEqual([]);
    expect(data.uniqueToB).toEqual([]);
  });

  it("does not treat missing category metadata as a category match", () => {
    const dataDir = join(tempRoot(), "data");
    writeCompareFixture(dataDir);

    const result = compareOperatorDocsImpl(makeCtx(dataDir), {
      operator_a: "Unknown Alpha",
      operator_b: "Unknown Beta",
    });
    const data = sc(result);

    expect(data.overview.sameCategory).toBe(false);
    expect(data.overview.sameSubcategory).toBe(false);
  });

  it("returns an error with suggestions when an operator cannot be resolved", () => {
    const result = compareOperatorDocsImpl(makeCtx(), {
      operator_a: "Noise TOP",
      operator_b: "not a real operator",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
    expect(textOf(result)).toContain("suggestions");
  });
});
