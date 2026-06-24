import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeSchema } from "../../src/recipes/schema.js";
import { draftRecipeFromOperatorChainImpl } from "../../src/tools/layer3/draftRecipeFromOperatorChain.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-draft-recipe-chain-tool-"));
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
  writeJson(join(dataDir, "python-api", "index.json"), []);
  writeJson(join(dataDir, "tutorials", "index.json"), []);
  writeJson(join(dataDir, "patterns.json"), []);
  writeJson(join(dataDir, "glsl.json"), []);
  writeJson(join(dataDir, "versions", "version-manifest.json"), {
    versions: [
      { id: "099", label: "TouchDesigner 099" },
      { id: "2023", label: "TouchDesigner 2023" },
    ],
    versionOrder: ["099", "2023"],
    currentStable: "2023",
  });
  writeJson(join(dataDir, "versions", "release-highlights.json"), { releases: {} });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), {
    operators: {
      noise_top: { name: "Noise TOP", category: "TOP", addedIn: "099" },
      level_top: { name: "Level TOP", category: "TOP", addedIn: "099" },
      null_top: { name: "Null TOP", category: "TOP", addedIn: "099" },
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

describe("draftRecipeFromOperatorChainImpl", () => {
  it("drafts a RecipeSchema-valid recipe from a documented operator chain", () => {
    const dataDir = join(tempRoot(), "data");
    writeChainFixture(dataDir);

    const result = draftRecipeFromOperatorChainImpl(makeCtx(dataDir), {
      chain: ["Noise TOP", "Level TOP", "Null TOP"],
      id: "procedural_texture_draft",
      name: "Procedural Texture Draft",
      description: "A first-pass recipe draft from an operator chain.",
      tags: ["texture"],
      difficulty: "beginner",
      td_version_min: "2023",
      family: "TOP",
    });
    const data = structured<{
      valid: boolean;
      recipe: unknown;
      validation: { valid: boolean };
      chainReport: { valid: boolean };
      nextToolHints: string[];
    }>(result);
    const recipe = RecipeSchema.parse(data.recipe);

    expect(data.valid).toBe(true);
    expect(data.validation.valid).toBe(true);
    expect(data.chainReport.valid).toBe(true);
    expect(recipe).toEqual(
      expect.objectContaining({
        id: "procedural_texture_draft",
        name: "Procedural Texture Draft",
        td_version_min: "2023",
        tags: ["texture", "draft", "operator-chain"],
        nodes: [
          expect.objectContaining({ name: "noise1", type: "noiseTOP" }),
          expect.objectContaining({ name: "level1", type: "levelTOP" }),
          expect.objectContaining({ name: "null1", type: "nullTOP" }),
        ],
        connections: [
          { from: "noise1", to: "level1", from_output: 0, to_input: 0 },
          { from: "level1", to: "null1", from_output: 0, to_input: 0 },
        ],
      }),
    );
    expect(data.nextToolHints).toContain("apply_recipe");
    expect(textOf(result)).toContain("Drafted RecipeSchema-valid recipe");
  });

  it("returns a strict error when the chain cannot be resolved", () => {
    const dataDir = join(tempRoot(), "data");
    writeChainFixture(dataDir);

    const result = draftRecipeFromOperatorChainImpl(makeCtx(dataDir), {
      chain: ["Noise TOP", "Missing TOP"],
      strict: true,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot draft recipe from invalid operator chain");
    expect(textOf(result)).toContain("missing_operator");
  });
});
