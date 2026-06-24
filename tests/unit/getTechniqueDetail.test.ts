import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { getTechniqueDetailImpl } from "../../src/tools/layer3/getTechniqueDetail.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-technique-detail-tool-"));
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
    resources: { docs: ["GLSL TOP"] },
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
            "uniform float uTime;\nout vec4 fragColor;\nvoid main() { fragColor = TDOutputSwizzle(vec4(uTime)); }",
        },
        workflow: {
          description: "GLSL TOP into a stable Null TOP output.",
          chain: ["GLSL TOP", "Null TOP"],
        },
      },
      {
        id: "feedback_loop",
        name: "Feedback Loop",
        description: "Layer TOP feedback for temporal trails.",
        difficulty: "advanced",
        operators: ["Feedback TOP", "Composite TOP"],
        tags: ["feedback"],
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

describe("getTechniqueDetailImpl", () => {
  it("lists available technique packs when no category is provided", () => {
    const dataDir = join(tempRoot(), "data");
    writeTechniqueFixture(dataDir);

    const result = getTechniqueDetailImpl(makeCtx(dataDir), {});
    const data = structured<{
      mode: string;
      packs: Array<{ id: string; name: string; count?: number }>;
      nextToolHints: string[];
    }>(result);

    expect(data.mode).toBe("packs");
    expect(data.packs).toEqual([
      expect.objectContaining({ id: "glsl", name: "GLSL Shaders", count: 2 }),
    ]);
    expect(data.nextToolHints).toContain("get_technique_detail");
    expect(textOf(result)).toContain("Found 1 TouchDesigner technique pack");
  });

  it("returns a technique detail without code by default when include_code is false", () => {
    const dataDir = join(tempRoot(), "data");
    writeTechniqueFixture(dataDir);

    const result = getTechniqueDetailImpl(makeCtx(dataDir), {
      category: "glsl",
      technique_id: "raymarching_basic",
      include_code: false,
    });
    const data = structured<{
      mode: string;
      technique: { id: string; name: string; code?: unknown; workflow?: unknown };
      availableTechniqueIds: string[];
      nextToolHints: string[];
    }>(result);

    expect(data.mode).toBe("technique");
    expect(data.technique).toEqual(
      expect.objectContaining({
        id: "raymarching_basic",
        name: "Basic Raymarching",
        workflow: expect.objectContaining({ chain: ["GLSL TOP", "Null TOP"] }),
      }),
    );
    expect(data.technique.code).toBeUndefined();
    expect(data.availableTechniqueIds).toEqual(["raymarching_basic", "feedback_loop"]);
    expect(data.nextToolHints).toContain("draft_recipe_from_technique");
    expect(textOf(result)).toContain("Technique Basic Raymarching");
  });

  it("returns suggestions for an unknown technique", () => {
    const dataDir = join(tempRoot(), "data");
    writeTechniqueFixture(dataDir);

    const result = getTechniqueDetailImpl(makeCtx(dataDir), {
      category: "glsl",
      technique_id: "missing",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown technique");
    expect(textOf(result)).toContain("raymarching_basic");
  });
});
