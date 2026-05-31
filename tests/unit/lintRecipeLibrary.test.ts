import { describe, expect, it } from "vitest";
import type { KnowledgeBase } from "../../src/knowledge/index.js";
import {
  type LintRecipeLibraryArgs,
  lintRecipeLibraryImpl,
  runLint,
} from "../../src/tools/layer3/lintRecipeLibrary.js";
import type { ToolContext } from "../../src/tools/types.js";

const KNOWN = new Set([
  "noiseTOP",
  "feedbackTOP",
  "geometryCOMP",
  "baseCOMP",
  "sphereSOP",
  "glslTOP",
  "levelTOP",
]);

const knowledge = {
  operatorExists: (t: string) => KNOWN.has(t),
} as unknown as Pick<KnowledgeBase, "operatorExists">;

interface RecipeJson {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  nodes: Array<{
    name: string;
    type: string;
    parameters?: Record<string, unknown>;
    parent?: string;
    render?: boolean;
  }>;
  connections?: Array<{ from: string; to: string }>;
  parameters?: Array<{ name: string; node: string; param: string }>;
  glsl_uniforms?: Array<{ name: string; node: string; kind?: "float" | "vec" | "color" }>;
  controls?: Array<{
    name: string;
    type?: "float" | "int" | "toggle" | "menu" | "rgb" | "pulse" | "string";
    bind_to?: string[];
  }>;
  preview_description?: string;
}

function src(file: string, recipe: RecipeJson) {
  // Build a LoadedRecipe by going through RecipeSchema via loadRecipesForLint-like logic.
  // Simpler: emulate by constructing the parsed object directly with sane defaults.
  return {
    raw: recipe,
    file,
    id: recipe.id,
    recipe: {
      id: recipe.id,
      name: recipe.name,
      description: recipe.description ?? "",
      tags: recipe.tags ?? [],
      difficulty: "intermediate" as const,
      td_version_min: "2023",
      nodes: recipe.nodes.map((n) => ({
        name: n.name,
        type: n.type,
        parameters: n.parameters ?? {},
        ...(n.parent !== undefined ? { parent: n.parent } : {}),
        ...(n.render !== undefined ? { render: n.render } : {}),
      })),
      connections: (recipe.connections ?? []).map((c) => ({
        from: c.from,
        to: c.to,
        from_output: 0,
        to_input: 0,
      })),
      parameters: recipe.parameters ?? [],
      glsl_uniforms: (recipe.glsl_uniforms ?? []).map((u) => ({
        node: u.node,
        name: u.name,
        kind: u.kind ?? ("float" as const),
      })),
      controls: (recipe.controls ?? []).map((c) => ({
        name: c.name,
        type: c.type ?? ("float" as const),
        ...(c.bind_to !== undefined ? { bind_to: c.bind_to } : {}),
      })),
      preview_description: recipe.preview_description ?? "preview",
    },
  };
}

const DEFAULT_ARGS: LintRecipeLibraryArgs = {
  severity: "info",
  fail_on: "error",
};

describe("lint_recipe_library (rules)", () => {
  it("clean recipe produces no findings", () => {
    const report = runLint(
      [
        src("clean.json", {
          id: "clean",
          name: "Clean",
          description: "ok",
          tags: ["test"],
          nodes: [{ name: "noise1", type: "noiseTOP" }],
          preview_description: "p",
        }),
      ],
      knowledge,
      DEFAULT_ARGS,
    );
    expect(report.summary.withErrors).toBe(0);
    expect(report.recipes[0]?.errors).toEqual([]);
    expect(report.recipes[0]?.warnings).toEqual([]);
  });

  it("flags unknown operator as warn", () => {
    const report = runLint(
      [
        src("foo.json", {
          id: "foo",
          name: "Foo",
          description: "d",
          tags: ["t"],
          nodes: [{ name: "x", type: "doesNotExistTOP" }],
          preview_description: "p",
        }),
      ],
      knowledge,
      DEFAULT_ARGS,
    );
    const findings = report.recipes[0]?.warnings ?? [];
    expect(findings.some((f) => f.rule === "unknown_operator" && f.path === "nodes[0].type")).toBe(
      true,
    );
  });

  it("flags dangling connection as error", () => {
    const report = runLint(
      [
        src("d.json", {
          id: "d",
          name: "D",
          description: "d",
          tags: ["t"],
          nodes: [{ name: "a", type: "noiseTOP" }],
          connections: [{ from: "a", to: "ghost" }],
          preview_description: "p",
        }),
      ],
      knowledge,
      DEFAULT_ARGS,
    );
    expect(
      report.recipes[0]?.errors.some(
        (f) => f.rule === "dangling_connection" && f.path === "connections[0].to",
      ),
    ).toBe(true);
  });

  it("flags bad parent (non-COMP)", () => {
    const report = runLint(
      [
        src("p.json", {
          id: "p",
          name: "P",
          description: "d",
          tags: ["t"],
          nodes: [
            { name: "noise1", type: "noiseTOP" },
            { name: "child", type: "sphereSOP", parent: "noise1" },
          ],
          preview_description: "p",
        }),
      ],
      knowledge,
      DEFAULT_ARGS,
    );
    expect(report.recipes[0]?.errors.some((f) => f.rule === "bad_parent")).toBe(true);
  });

  it("flags render=true outside geometryCOMP", () => {
    const report = runLint(
      [
        src("r.json", {
          id: "r",
          name: "R",
          description: "d",
          tags: ["t"],
          nodes: [
            { name: "base1", type: "baseCOMP" },
            { name: "geo1", type: "sphereSOP", parent: "base1", render: true },
          ],
          preview_description: "p",
        }),
      ],
      knowledge,
      DEFAULT_ARGS,
    );
    expect(report.recipes[0]?.errors.some((f) => f.rule === "render_outside_geo")).toBe(true);
  });

  it("flags unresolved control bind_to", () => {
    const report = runLint(
      [
        src("c.json", {
          id: "c",
          name: "C",
          description: "d",
          tags: ["t"],
          nodes: [{ name: "noise1", type: "noiseTOP" }],
          controls: [{ name: "Knob", type: "float", bind_to: ["missing.par"] }],
          preview_description: "p",
        }),
      ],
      knowledge,
      DEFAULT_ARGS,
    );
    expect(report.recipes[0]?.errors.some((f) => f.rule === "control_bind_unresolved")).toBe(true);
  });

  it("flags id/filename mismatch", () => {
    const report = runLint(
      [
        src("y.json", {
          id: "x",
          name: "X",
          description: "d",
          tags: ["t"],
          nodes: [{ name: "noise1", type: "noiseTOP" }],
          preview_description: "p",
        }),
      ],
      knowledge,
      DEFAULT_ARGS,
    );
    expect(report.recipes[0]?.warnings.some((f) => f.rule === "id_filename_match")).toBe(true);
  });

  it("rules filter restricts emitted rules", () => {
    const report = runLint(
      [
        src("y.json", {
          id: "x", // would trigger id_filename_match
          name: "X",
          description: "", // would trigger description_empty
          tags: [],
          nodes: [{ name: "x", type: "doesNotExistTOP" }],
          preview_description: "",
        }),
      ],
      knowledge,
      { ...DEFAULT_ARGS, rules: ["unknown_operator"] },
    );
    const rec = report.recipes[0];
    expect(rec?.warnings.every((f) => f.rule === "unknown_operator")).toBe(true);
    expect(rec?.warnings.length).toBe(1);
    expect(rec?.errors).toEqual([]);
    expect(rec?.info).toEqual([]);
  });

  it("isError on fail_on=error when errors present", () => {
    const ctx = { knowledge, recipes: {} } as unknown as ToolContext;
    const result = lintRecipeLibraryImpl(
      ctx,
      { severity: "info", fail_on: "error" },
      {
        sources: [
          src("d.json", {
            id: "d",
            name: "D",
            description: "d",
            tags: ["t"],
            nodes: [{ name: "a", type: "noiseTOP" }],
            connections: [{ from: "a", to: "ghost" }],
            preview_description: "p",
          }),
        ],
      },
    );
    expect(result.isError).toBe(true);
  });

  it("not isError when only warnings and fail_on=error", () => {
    const ctx = { knowledge, recipes: {} } as unknown as ToolContext;
    const result = lintRecipeLibraryImpl(
      ctx,
      { severity: "info", fail_on: "error" },
      {
        sources: [
          src("foo.json", {
            id: "foo",
            name: "F",
            description: "d",
            tags: ["t"],
            nodes: [{ name: "x", type: "doesNotExistTOP" }],
            preview_description: "p",
          }),
        ],
      },
    );
    expect(result.isError).toBeFalsy();
  });

  it("structuredContent carries the report shape", () => {
    const ctx = { knowledge, recipes: {} } as unknown as ToolContext;
    const result = lintRecipeLibraryImpl(ctx, DEFAULT_ARGS, {
      sources: [
        src("clean.json", {
          id: "clean",
          name: "Clean",
          description: "ok",
          tags: ["t"],
          nodes: [{ name: "noise1", type: "noiseTOP" }],
          preview_description: "p",
        }),
      ],
    });
    const data = (result as { structuredContent?: { summary: { totalRecipes: number } } })
      .structuredContent;
    expect(data?.summary.totalRecipes).toBe(1);
  });
});
