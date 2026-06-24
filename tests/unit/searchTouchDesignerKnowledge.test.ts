import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { searchTouchDesignerKnowledgeImpl } from "../../src/tools/layer3/searchTouchDesignerKnowledge.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-knowledge-router-tool-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeRouterFixture(dataDir: string): void {
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
      keywords: ["noise", "texture"],
    },
  ]);
  writeJson(join(dataDir, "operators", "noise_top.json"), {
    name: "Noise TOP",
    displayName: "Noise TOP",
    category: "TOP",
    summary: "Procedural texture noise",
  });
  writeJson(join(dataDir, "python-api", "index.json"), []);
  writeJson(join(dataDir, "tutorials", "index.json"), []);
  writeJson(join(dataDir, "patterns.json"), []);
  writeJson(join(dataDir, "glsl.json"), []);
  writeJson(join(dataDir, "versions", "version-manifest.json"), {
    versions: [
      {
        id: "2024",
        label: "TouchDesigner 2024",
        releaseYear: 2024,
        supportStatus: "stable",
        notes: "Production release with operator compatibility updates.",
      },
    ],
  });
  writeJson(join(dataDir, "versions", "release-highlights.json"), { releases: {} });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), {
    operators: {
      noise_top: {
        name: "Noise TOP",
        category: "TOP",
        addedIn: "099",
        changedIn: [{ version: "2024", change: "Improved GPU path" }],
        notes: "Procedural texture noise compatibility notes",
      },
    },
  });
  writeJson(join(dataDir, "versions", "python-api-compatibility.json"), {
    classes: {
      OP: {
        description: "Base operator class",
        methods: {
          cook: {
            signature: "cook(force=False)",
            addedIn: "099",
            changedIn: [],
            description: "Force cook",
          },
        },
      },
    },
  });
  writeJson(join(dataDir, "versions", "experimental-builds.json"), {
    buildSeries: [
      {
        seriesId: "2024-experimental",
        label: "2024 Experimental",
        stabilityNotes: "Experimental POP and renderer changes.",
      },
    ],
  });
  writeJson(join(dataDir, "techniques", "audio-visual.json"), {
    category: "audio-visual",
    displayName: "Audio-Visual",
    description: "Audio-reactive visual techniques.",
    techniques: [
      {
        id: "fft_to_geometry",
        name: "FFT to Geometry",
        description: "Convert FFT spectrum data into geometry.",
        operators: ["Audio Spectrum CHOP", "CHOP to SOP"],
      },
    ],
  });
  writeJson(join(dataDir, "td-classes", "top_class.json"), {
    id: "top_class",
    name: "TOP Class",
    displayName: "TOP Class",
    description: "A TOP describes a reference to a TOP operator.",
    summary: "A TOP describes a reference to a TOP operator.",
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("searchTouchDesignerKnowledgeImpl", () => {
  it("searches across operator, workflow, version and compatibility surfaces", () => {
    const dataDir = join(tempRoot(), "data");
    writeRouterFixture(dataDir);

    const result = searchTouchDesignerKnowledgeImpl(makeCtx(dataDir), {
      query: "noise",
      surface: "all",
      limit: 10,
    });
    const data = structured<{
      count: number;
      results: Array<{ surface: string; id: string; resourceUri?: string; toolHint?: string }>;
    }>(result);

    expect(data.count).toBeGreaterThanOrEqual(3);
    expect(data.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: "operators",
          id: "noise_top",
          resourceUri: "tdmcp://operators/noise_top",
          toolHint: "search_operators",
        }),
        expect.objectContaining({
          surface: "operator_compatibility",
          id: "noise_top",
          resourceUri: "tdmcp://compat/operators/noise_top",
        }),
      ]),
    );
  });

  it("can restrict searches to technique packs", () => {
    const dataDir = join(tempRoot(), "data");
    writeRouterFixture(dataDir);

    const result = searchTouchDesignerKnowledgeImpl(makeCtx(dataDir), {
      query: "fft geometry",
      surface: "techniques",
      limit: 5,
    });
    const data = structured<{
      count: number;
      results: Array<{ surface: string; id: string; resourceUri?: string; toolHint?: string }>;
    }>(result);

    expect(data.count).toBe(1);
    expect(data.results).toEqual([
      expect.objectContaining({
        surface: "techniques",
        id: "audio-visual/fft_to_geometry",
        toolHint: "get_technique_detail",
      }),
    ]);
    expect(data.results[0]?.resourceUri).toBeUndefined();
  });

  it("matches operator compatibility records by version metadata", () => {
    const dataDir = join(tempRoot(), "data");
    writeRouterFixture(dataDir);

    const result = searchTouchDesignerKnowledgeImpl(makeCtx(dataDir), {
      query: "2024",
      surface: "operator_compatibility",
      limit: 5,
    });
    const data = structured<{
      count: number;
      results: Array<{ surface: string; id: string }>;
    }>(result);

    expect(data.count).toBe(1);
    expect(data.results).toEqual([
      expect.objectContaining({
        surface: "operator_compatibility",
        id: "noise_top",
      }),
    ]);
  });
});
