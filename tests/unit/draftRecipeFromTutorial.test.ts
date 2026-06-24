import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeSchema } from "../../src/recipes/schema.js";
import { draftRecipeFromTutorialImpl } from "../../src/tools/layer3/draftRecipeFromTutorial.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-draft-recipe-tutorial-tool-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeTutorialRecipeFixture(dataDir: string): void {
  mkdirSync(join(dataDir, "operators"), { recursive: true });
  mkdirSync(join(dataDir, "python-api"), { recursive: true });
  mkdirSync(join(dataDir, "tutorials"), { recursive: true });
  mkdirSync(join(dataDir, "versions"), { recursive: true });
  mkdirSync(join(dataDir, "techniques"), { recursive: true });
  mkdirSync(join(dataDir, "td-classes"), { recursive: true });

  writeJson(join(dataDir, "operators", "index.json"), [
    {
      slug: "glsl_top",
      name: "GLSL TOP",
      displayName: "GLSL TOP",
      category: "TOP",
      subcategory: "Generator",
      summary: "Runs a GLSL pixel shader.",
      keywords: ["glsl", "shader", "top"],
    },
    {
      slug: "null_top",
      name: "Null TOP",
      displayName: "Null TOP",
      category: "TOP",
      subcategory: "Utility",
      summary: "Stable output handoff.",
      keywords: ["null", "output", "top"],
    },
  ]);
  writeJson(join(dataDir, "operators", "glsl_top.json"), {
    name: "GLSL TOP",
    displayName: "GLSL TOP",
    category: "TOP",
    subcategory: "Generator",
    summary: "Runs a GLSL pixel shader.",
    commonOutputs: [{ op: "Null TOP", reason: "Stable shader output endpoint" }],
  });
  writeJson(join(dataDir, "operators", "null_top.json"), {
    name: "Null TOP",
    displayName: "Null TOP",
    category: "TOP",
    subcategory: "Utility",
    summary: "Stable output handoff.",
  });
  writeJson(join(dataDir, "python-api", "index.json"), []);
  writeJson(join(dataDir, "patterns.json"), []);
  writeJson(join(dataDir, "glsl.json"), []);
  writeJson(join(dataDir, "versions", "version-manifest.json"), {
    versions: [{ id: "2023", label: "TouchDesigner 2023" }],
    versionOrder: ["2023"],
    currentStable: "2023",
  });
  writeJson(join(dataDir, "versions", "release-highlights.json"), { releases: {} });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), {
    operators: {
      glsl_top: { name: "GLSL TOP", category: "TOP", addedIn: "099" },
      null_top: { name: "Null TOP", category: "TOP", addedIn: "099" },
    },
  });
  writeJson(join(dataDir, "versions", "python-api-compatibility.json"), { classes: {} });
  writeJson(join(dataDir, "versions", "experimental-builds.json"), { buildSeries: [] });
  writeJson(join(dataDir, "techniques", "glsl.json"), {
    category: "glsl",
    displayName: "GLSL",
    techniques: [],
  });
  writeJson(join(dataDir, "tutorials", "index.json"), [
    {
      id: "write_a_glsl_top",
      name: "Write a GLSL TOP",
      category: "TUTORIAL",
      summary: "Create a GLSL TOP shader and route it to a stable output.",
    },
    {
      id: "keyboard_shortcuts",
      name: "Keyboard Shortcuts",
      category: "TUTORIAL",
      summary: "Move through the TouchDesigner UI quickly.",
    },
  ]);
  writeJson(join(dataDir, "tutorials", "write_a_glsl_top.json"), {
    id: "write_a_glsl_top",
    name: "Write a GLSL TOP",
    displayName: "Write a GLSL TOP",
    category: "TUTORIAL",
    summary: "Create a GLSL TOP shader and route it to a stable output.",
    content: {
      sections: [
        {
          title: "Outputting Color",
          level: 2,
          content: [
            {
              type: "paragraph",
              text: "Place a GLSL TOP in the network, paste a pixel shader, then connect the GLSL TOP to a Null TOP for a stable output.",
            },
            {
              type: "code",
              language: "glsl",
              text: "layout(location = 0) out vec4 fragColor;\nvoid main() { fragColor = TDOutputSwizzle(vec4(1.0)); }",
            },
          ],
        },
      ],
    },
    keywords: ["glsl", "shader"],
    tags: ["glsl", "tutorial"],
  });
  writeJson(join(dataDir, "tutorials", "keyboard_shortcuts.json"), {
    id: "keyboard_shortcuts",
    name: "Keyboard Shortcuts",
    category: "TUTORIAL",
    summary: "Move through the TouchDesigner UI quickly.",
    content: "Use panes and shortcut keys to move around.",
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

describe("draftRecipeFromTutorialImpl", () => {
  it("drafts a RecipeSchema-valid recipe from a tutorial operator chain", () => {
    const dataDir = join(tempRoot(), "data");
    writeTutorialRecipeFixture(dataDir);

    const result = draftRecipeFromTutorialImpl(makeCtx(dataDir), {
      name: "Write a GLSL TOP",
      id: "tutorial_glsl_top_draft",
      family: "TOP",
      max_steps: 2,
      td_version_min: "2023",
    });
    const data = structured<{
      valid: boolean;
      recipe: unknown;
      tutorial: { id: string; name: string };
      extractedOperators: string[];
      chainReport: { valid: boolean };
      nextToolHints: string[];
    }>(result);
    const recipe = RecipeSchema.parse(data.recipe);

    expect(data.valid).toBe(true);
    expect(data.tutorial).toEqual({ id: "write_a_glsl_top", name: "Write a GLSL TOP" });
    expect(data.extractedOperators).toEqual(["GLSL TOP", "Null TOP"]);
    expect(data.chainReport.valid).toBe(true);
    expect(recipe).toEqual(
      expect.objectContaining({
        id: "tutorial_glsl_top_draft",
        name: "Write a GLSL TOP Draft",
        td_version_min: "2023",
        tags: ["glsl", "tutorial", "draft"],
        nodes: [
          expect.objectContaining({ name: "glsl1", type: "glslTOP" }),
          expect.objectContaining({ name: "null1", type: "nullTOP" }),
        ],
        connections: [{ from: "glsl1", to: "null1", from_output: 0, to_input: 0 }],
      }),
    );
    expect(data.nextToolHints).toEqual(
      expect.arrayContaining(["get_tutorial", "draft_recipe_from_operator_chain", "apply_recipe"]),
    );
    expect(textOf(result)).toContain("Drafted RecipeSchema-valid recipe");
  });

  it("returns a strict error when a tutorial has no draftable operator chain", () => {
    const dataDir = join(tempRoot(), "data");
    writeTutorialRecipeFixture(dataDir);

    const result = draftRecipeFromTutorialImpl(makeCtx(dataDir), {
      name: "Keyboard Shortcuts",
      strict: true,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does not contain enough operator references");
    expect(textOf(result)).toContain("get_tutorial");
  });
});
