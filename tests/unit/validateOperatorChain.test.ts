import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { validateOperatorChainImpl } from "../../src/tools/layer3/validateOperatorChain.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-validate-chain-tool-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeChainFixture(dataDir: string): void {
  mkdirSync(join(dataDir, "operators"), { recursive: true });
  mkdirSync(join(dataDir, "python-api"), { recursive: true });
  mkdirSync(join(dataDir, "tutorials"), { recursive: true });
  mkdirSync(join(dataDir, "versions"), { recursive: true });
  mkdirSync(join(dataDir, "techniques"), { recursive: true });
  mkdirSync(join(dataDir, "td-classes"), { recursive: true });

  writeJson(join(dataDir, "operators", "index.json"), [
    {
      slug: "noise_top",
      name: "Noise TOP",
      displayName: "Noise TOP",
      category: "TOP",
      subcategory: "Generator",
      summary: "Procedural texture noise",
      keywords: ["noise", "procedural", "texture"],
    },
    {
      slug: "level_top",
      name: "Level TOP",
      displayName: "Level TOP",
      category: "TOP",
      subcategory: "Filter",
      summary: "Adjust brightness and contrast",
      keywords: ["level", "brightness", "contrast", "texture"],
    },
    {
      slug: "null_top",
      name: "Null TOP",
      displayName: "Null TOP",
      category: "TOP",
      subcategory: "Utility",
      summary: "Stable output handoff",
      keywords: ["null", "output", "texture"],
    },
    {
      slug: "particle_pop",
      name: "Particle POP",
      displayName: "Particle POP",
      category: "POP",
      subcategory: "Generator",
      summary: "Particle simulation source",
      keywords: ["particle", "pop", "simulation"],
    },
  ]);
  writeJson(join(dataDir, "operators", "noise_top.json"), {
    name: "Noise TOP",
    displayName: "Noise TOP",
    category: "TOP",
    subcategory: "Generator",
    summary: "Procedural texture noise",
    commonOutputs: [{ op: "Level TOP", port: "output 0 -> input 0", reason: "Shape contrast" }],
  });
  writeJson(join(dataDir, "operators", "level_top.json"), {
    name: "Level TOP",
    displayName: "Level TOP",
    category: "TOP",
    subcategory: "Filter",
    summary: "Adjust brightness and contrast",
    commonOutputs: [{ op: "Null TOP", reason: "Stable output endpoint" }],
  });
  writeJson(join(dataDir, "operators", "null_top.json"), {
    name: "Null TOP",
    displayName: "Null TOP",
    category: "TOP",
    subcategory: "Utility",
    summary: "Stable output handoff",
  });
  writeJson(join(dataDir, "operators", "particle_pop.json"), {
    name: "Particle POP",
    displayName: "Particle POP",
    category: "POP",
    subcategory: "Generator",
    summary: "Particle simulation source",
  });
  writeJson(join(dataDir, "python-api", "index.json"), []);
  writeJson(join(dataDir, "tutorials", "index.json"), []);
  writeJson(join(dataDir, "patterns.json"), []);
  writeJson(join(dataDir, "glsl.json"), []);
  writeJson(join(dataDir, "versions", "version-manifest.json"), {
    versions: [
      { id: "099", label: "TouchDesigner 099" },
      { id: "2022", label: "TouchDesigner 2022" },
      { id: "2023", label: "TouchDesigner 2023" },
      { id: "2024", label: "TouchDesigner 2024" },
    ],
    versionOrder: ["099", "2022", "2023", "2024"],
    currentStable: "2024",
  });
  writeJson(join(dataDir, "versions", "release-highlights.json"), { releases: {} });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), {
    operators: {
      noise_top: { name: "Noise TOP", category: "TOP", addedIn: "099" },
      level_top: { name: "Level TOP", category: "TOP", addedIn: "099" },
      null_top: { name: "Null TOP", category: "TOP", addedIn: "099" },
      particle_pop: { name: "Particle POP", category: "POP", addedIn: "2024" },
    },
  });
  writeJson(join(dataDir, "versions", "python-api-compatibility.json"), { classes: {} });
  writeJson(join(dataDir, "versions", "experimental-builds.json"), { buildSeries: [] });
}

function makeCtx(dataDir: string): ToolContext {
  return {
    knowledge: new KnowledgeBase({ dataDir }),
    logger: silentLogger,
  } as unknown as ToolContext;
}

function structured<T>(result: CallToolResult): T {
  return (result as { structuredContent?: T }).structuredContent as T;
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

describe("validateOperatorChainImpl", () => {
  it("validates a documented operator chain without mutating TouchDesigner", () => {
    const dataDir = join(tempRoot(), "data");
    writeChainFixture(dataDir);

    const result = validateOperatorChainImpl(makeCtx(dataDir), {
      chain: ["Noise TOP", "Level TOP", "Null TOP"],
      family: "TOP",
      target_version: "2023",
      require_documented_connections: true,
    });
    const data = structured<{
      valid: boolean;
      severity: string;
      normalizedChain: Array<{ operator: string; category?: string; slug?: string }>;
      issues: Array<{ type: string }>;
      connectionChecks: Array<{ from: string; to: string; documented: boolean; portHint?: string }>;
      nextToolHints: string[];
    }>(result);

    expect(data.valid).toBe(true);
    expect(data.severity).toBe("ok");
    expect(data.issues).toEqual([]);
    expect(data.normalizedChain.map((step) => step.operator)).toEqual([
      "Noise TOP",
      "Level TOP",
      "Null TOP",
    ]);
    expect(data.normalizedChain.map((step) => step.category)).toEqual(["TOP", "TOP", "TOP"]);
    expect(data.connectionChecks).toEqual([
      expect.objectContaining({
        from: "Noise TOP",
        to: "Level TOP",
        documented: true,
        portHint: "output 0 -> input 0",
      }),
      expect.objectContaining({ from: "Level TOP", to: "Null TOP", documented: true }),
    ]);
    expect(data.nextToolHints).toContain("draft_recipe_from_operator_chain");
    expect(textOf(result)).toContain("Validated operator chain");
  });

  it("reports missing operators, family mismatches, undocumented links, and version incompatibility", () => {
    const dataDir = join(tempRoot(), "data");
    writeChainFixture(dataDir);

    const result = validateOperatorChainImpl(makeCtx(dataDir), {
      chain: ["Noise TOP", "Particle POP", "Levl TOP"],
      family: "TOP",
      target_version: "2023",
      require_documented_connections: true,
    });
    const data = structured<{
      valid: boolean;
      severity: string;
      issues: Array<{ type: string; operator?: string }>;
      suggestions: string[];
      connectionChecks: Array<{ documented: boolean }>;
    }>(result);

    expect(data.valid).toBe(false);
    expect(data.severity).toBe("error");
    expect(data.issues.map((issue) => issue.type)).toEqual(
      expect.arrayContaining([
        "missing_operator",
        "family_mismatch",
        "version_incompatible",
        "undocumented_connection",
      ]),
    );
    expect(data.connectionChecks.some((check) => !check.documented)).toBe(true);
    expect(data.suggestions.some((suggestion) => suggestion.includes('"Levl TOP"'))).toBe(true);
    expect(data.suggestions.some((suggestion) => suggestion.includes("Level TOP"))).toBe(true);
    expect(textOf(result)).toContain("Operator chain has");
  });
});
