import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { getTutorialImpl } from "../../src/tools/layer3/getTutorial.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-tutorial-tool-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeTutorialFixture(dataDir: string): void {
  mkdirSync(join(dataDir, "operators"), { recursive: true });
  mkdirSync(join(dataDir, "python-api"), { recursive: true });
  mkdirSync(join(dataDir, "tutorials"), { recursive: true });
  mkdirSync(join(dataDir, "versions"), { recursive: true });
  mkdirSync(join(dataDir, "techniques"), { recursive: true });
  mkdirSync(join(dataDir, "td-classes"), { recursive: true });

  writeJson(join(dataDir, "operators", "index.json"), []);
  writeJson(join(dataDir, "python-api", "index.json"), []);
  writeJson(join(dataDir, "patterns.json"), []);
  writeJson(join(dataDir, "glsl.json"), []);
  writeJson(join(dataDir, "versions", "version-manifest.json"), { versions: [] });
  writeJson(join(dataDir, "versions", "release-highlights.json"), { releases: {} });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), { operators: {} });
  writeJson(join(dataDir, "versions", "python-api-compatibility.json"), { classes: {} });
  writeJson(join(dataDir, "versions", "experimental-builds.json"), { buildSeries: [] });
  writeJson(join(dataDir, "tutorials", "index.json"), [
    {
      id: "write_a_glsl_top",
      name: "Write a GLSL TOP",
      category: "Advanced Development",
      summary: "Create a GLSL TOP shader with uniforms.",
    },
    {
      id: "keyboard_shortcuts",
      name: "Keyboard Shortcuts",
      category: "Getting Started",
      summary: "Move quickly through common TouchDesigner shortcuts.",
    },
  ]);
  writeJson(join(dataDir, "tutorials", "write_a_glsl_top.json"), {
    id: "write_a_glsl_top",
    name: "Write a GLSL TOP",
    category: "Advanced Development",
    subcategory: "GLSL",
    summary: "Create a GLSL TOP shader with uniforms.",
    content: {
      sections: [
        {
          title: "Build the shader",
          level: 2,
          content: [
            {
              type: "paragraph",
              text: "Use a GLSL TOP, declare uniform float uTime, then connect a Null TOP.",
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
    keywords: ["glsl", "shader", "uniform"],
    tags: ["glsl", "shader"],
  });
  writeJson(join(dataDir, "tutorials", "keyboard_shortcuts.json"), {
    id: "keyboard_shortcuts",
    name: "Keyboard Shortcuts",
    category: "Getting Started",
    summary: "Move quickly through common TouchDesigner shortcuts.",
    content: "Use keyboard shortcuts to navigate panes.",
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

describe("getTutorialImpl", () => {
  it("searches tutorials by query and returns resource URIs", () => {
    const dataDir = join(tempRoot(), "data");
    writeTutorialFixture(dataDir);

    const result = getTutorialImpl(makeCtx(dataDir), { query: "glsl", limit: 5 });
    const data = structured<{
      mode: string;
      tutorials: Array<{ id: string; name: string; resourceUri: string }>;
      nextToolHints: string[];
    }>(result);

    expect(data.mode).toBe("search");
    expect(data.tutorials).toEqual([
      expect.objectContaining({
        id: "write_a_glsl_top",
        name: "Write a GLSL TOP",
        resourceUri: "tdmcp://tutorials/write_a_glsl_top",
      }),
    ]);
    expect(data.nextToolHints).toContain("get_tutorial");
    expect(textOf(result)).toContain('Found 1 TouchDesigner tutorial for "glsl"');
  });

  it("returns tutorial metadata without content by default", () => {
    const dataDir = join(tempRoot(), "data");
    writeTutorialFixture(dataDir);

    const result = getTutorialImpl(makeCtx(dataDir), {
      name: "Write a GLSL TOP",
      include_content: false,
    });
    const data = structured<{
      mode: string;
      tutorial: { id: string; name: string; content?: string; keywords?: string[] };
    }>(result);

    expect(data.mode).toBe("tutorial");
    expect(data.tutorial).toEqual(
      expect.objectContaining({
        id: "write_a_glsl_top",
        name: "Write a GLSL TOP",
        keywords: ["glsl", "shader", "uniform"],
      }),
    );
    expect(data.tutorial.content).toBeUndefined();
    expect(textOf(result)).toContain("Tutorial Write a GLSL TOP");
  });

  it("returns tutorial content when explicitly requested", () => {
    const dataDir = join(tempRoot(), "data");
    writeTutorialFixture(dataDir);

    const result = getTutorialImpl(makeCtx(dataDir), {
      name: "write_a_glsl_top",
      include_content: true,
    });
    const data = structured<{
      tutorial: { id: string; content?: string };
      nextToolHints: string[];
    }>(result);

    expect(data.tutorial.content).toContain("uniform float uTime");
    expect(data.tutorial.content).toContain("TDOutputSwizzle");
    expect(data.nextToolHints).toContain("search_touchdesigner_knowledge");
  });

  it("searches structured tutorial section content and code blocks", () => {
    const dataDir = join(tempRoot(), "data");
    writeTutorialFixture(dataDir);

    const result = getTutorialImpl(makeCtx(dataDir), {
      query: "TDOutputSwizzle",
      include_content: true,
    });
    const data = structured<{
      mode: string;
      tutorials: Array<{ id: string; content?: string }>;
    }>(result);

    expect(data.mode).toBe("search");
    expect(data.tutorials).toEqual([
      expect.objectContaining({
        id: "write_a_glsl_top",
        content: expect.stringContaining("TDOutputSwizzle"),
      }),
    ]);
  });

  it("loads full tutorial content for list mode when requested", () => {
    const dataDir = join(tempRoot(), "data");
    writeTutorialFixture(dataDir);

    const result = getTutorialImpl(makeCtx(dataDir), {
      include_content: true,
      limit: 1,
    });
    const data = structured<{
      mode: string;
      tutorials: Array<{ id: string; content?: string }>;
    }>(result);

    expect(data.mode).toBe("list");
    expect(data.tutorials).toEqual([
      expect.objectContaining({
        id: "write_a_glsl_top",
        content: expect.stringContaining("uniform float uTime"),
      }),
    ]);
  });

  it("returns suggestions for an unknown tutorial", () => {
    const dataDir = join(tempRoot(), "data");
    writeTutorialFixture(dataDir);

    const result = getTutorialImpl(makeCtx(dataDir), { name: "missing tutorial" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown tutorial");
    expect(textOf(result)).toContain("write_a_glsl_top");
  });
});
