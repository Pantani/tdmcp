import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeSchema } from "../../src/recipes/schema.js";
import { draftRecipeFromTechniqueImpl } from "../../src/tools/layer3/draftRecipeFromTechnique.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-draft-recipe-technique-tool-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeTechniqueFixture(dataDir: string): void {
  mkdirSync(join(dataDir, "operators"), { recursive: true });
  mkdirSync(join(dataDir, "python-api"), { recursive: true });
  mkdirSync(join(dataDir, "tutorials"), { recursive: true });
  mkdirSync(join(dataDir, "versions"), { recursive: true });
  mkdirSync(join(dataDir, "techniques"), { recursive: true });
  mkdirSync(join(dataDir, "td-classes"), { recursive: true });

  writeJson(join(dataDir, "operators", "index.json"), []);
  writeJson(join(dataDir, "python-api", "index.json"), []);
  writeJson(join(dataDir, "tutorials", "index.json"), []);
  writeJson(join(dataDir, "patterns.json"), []);
  writeJson(join(dataDir, "glsl.json"), []);
  writeJson(join(dataDir, "versions", "version-manifest.json"), { versions: [] });
  writeJson(join(dataDir, "versions", "release-highlights.json"), { releases: {} });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), { operators: {} });
  writeJson(join(dataDir, "versions", "python-api-compatibility.json"), { classes: {} });
  writeJson(join(dataDir, "versions", "experimental-builds.json"), { buildSeries: [] });
  writeJson(join(dataDir, "techniques", "glsl.json"), {
    category: "glsl",
    displayName: "GLSL Shaders",
    description: "Shader techniques for GLSL TOP workflows.",
    techniques: [
      {
        id: "raymarching_basic",
        name: "Basic Raymarching",
        description: "Render a simple signed-distance-field scene in a GLSL TOP.",
        difficulty: "intermediate",
        operators: ["GLSL TOP", "Null TOP"],
        tags: ["raymarching", "shader"],
        code: {
          language: "glsl",
          filename: "raymarch_basic.frag",
          snippet:
            "uniform float uTime;\nuniform vec3 uTint;\nout vec4 fragColor;\nvoid main() { fragColor = TDOutputSwizzle(vec4(uTint * uTime, 1.0)); }",
        },
        workflow: {
          description: "GLSL TOP into a stable Null TOP output.",
          chain: ["GLSL TOP", "Null TOP"],
        },
      },
    ],
  });
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

describe("draftRecipeFromTechniqueImpl", () => {
  it("drafts a RecipeSchema-valid GLSL recipe from a documented technique", () => {
    const dataDir = join(tempRoot(), "data");
    writeTechniqueFixture(dataDir);

    const result = draftRecipeFromTechniqueImpl(makeCtx(dataDir), {
      category: "glsl",
      technique_id: "raymarching_basic",
      id: "raymarch_basic_draft",
      td_version_min: "2023",
    });
    const data = structured<{
      valid: boolean;
      recipe: unknown;
      validation: { valid: boolean };
      source: { category: string; techniqueId: string };
      nextToolHints: string[];
    }>(result);
    const recipe = RecipeSchema.parse(data.recipe);

    expect(data.valid).toBe(true);
    expect(data.validation.valid).toBe(true);
    expect(data.source).toEqual({ category: "glsl", techniqueId: "raymarching_basic" });
    expect(recipe).toEqual(
      expect.objectContaining({
        id: "raymarch_basic_draft",
        name: "Basic Raymarching Draft",
        td_version_min: "2023",
        tags: ["raymarching", "shader", "glsl", "draft", "technique"],
        nodes: [
          expect.objectContaining({ name: "glsl1", type: "glslTOP" }),
          expect.objectContaining({ name: "out1", type: "nullTOP" }),
        ],
        connections: [{ from: "glsl1", to: "out1", from_output: 0, to_input: 0 }],
      }),
    );
    expect(recipe.glsl_code?.glsl1).toContain("uTime");
    expect(recipe.glsl_uniforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ node: "glsl1", name: "uTime", kind: "float" }),
        expect.objectContaining({ node: "glsl1", name: "uTint", kind: "vec" }),
      ]),
    );
    expect(data.nextToolHints).toContain("apply_recipe");
    expect(textOf(result)).toContain("Drafted RecipeSchema-valid recipe");
  });

  it("returns a strict error when the technique cannot be resolved", () => {
    const dataDir = join(tempRoot(), "data");
    writeTechniqueFixture(dataDir);

    const result = draftRecipeFromTechniqueImpl(makeCtx(dataDir), {
      category: "glsl",
      technique_id: "missing",
      strict: true,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot draft recipe from unknown technique");
    expect(textOf(result)).toContain("raymarching_basic");
  });
});
