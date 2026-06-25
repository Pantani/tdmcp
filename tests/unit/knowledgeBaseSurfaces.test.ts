import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-knowledge-surfaces-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeSurfaceFixture(dataDir: string): void {
  for (const subdir of [
    "operators",
    "python-api",
    "tutorials",
    "versions",
    "techniques",
    "td-classes",
  ]) {
    mkdirSync(join(dataDir, subdir), { recursive: true });
  }

  writeJson(join(dataDir, "operators", "index.json"), [
    {
      slug: "audio_chop",
      name: "Audio CHOP",
      displayName: "Audio CHOP",
      category: "CHOP",
      summary: "Audio channel analysis",
      keywords: ["audio", "channels"],
    },
    {
      slug: "glsl_top",
      name: "GLSL TOP",
      displayName: "GLSL TOP",
      category: "TOP",
      summary: "Shader rendering",
      keywords: ["shader", "render"],
    },
  ]);
  writeJson(join(dataDir, "operators", "audio_chop.json"), {
    name: "Audio CHOP",
    displayName: "Audio CHOP",
    category: "CHOP",
    usage: "Analyze incoming audio channels before driving visuals.",
    commonInputs: [{ operator: "Audio Device In CHOP", reason: "live audio source" }],
    commonOutputs: [
      { op: "GLSL TOP", reason: "shader render" },
      { op: "Particle SOP", reason: "particle geometry" },
    ],
    relatedOperators: ["Feedback TOP"],
    codeExamples: [{ snippet: "op('audio1').chan('chan1')[0]" }],
    expressions: [{ code: "me.time.frame" }],
    tips: ["Normalize audio before mapping to visuals."],
  });
  writeJson(join(dataDir, "operators", "glsl_top.json"), {
    name: "GLSL TOP",
    displayName: "GLSL TOP",
    category: "TOP",
  });

  writeJson(join(dataDir, "python-api", "OP.json"), {
    className: "OP",
    displayName: "OP Class",
    summary: "Base operator API",
  });
  writeJson(join(dataDir, "tutorials", "intro.json"), {
    id: "intro",
    name: "Intro Tutorial",
    title: "Intro Tutorial",
    summary: "Build a first network.",
  });
  writeJson(join(dataDir, "patterns.json"), [
    {
      id: "audio_reactive",
      name: "Audio Reactive",
      category: "CHOP",
      description: "Map audio channels to visual parameters.",
      workflow: ["Audio Device In", "Audio CHOP", "GLSL TOP"],
      use_case: "Audio-driven visuals",
    },
  ]);
  writeJson(join(dataDir, "glsl.json"), [
    {
      id: "scanline",
      name: "Scanline Shader",
      description: "CRT scanline look.",
      difficulty: "beginner",
    },
  ]);
  writeJson(join(dataDir, "techniques", "visual-synthesis.json"), {
    category: "visual-synthesis",
    displayName: "Visual Synthesis",
    description: "Shader and texture techniques.",
    versionRequirement: "2024+",
    techniques: [
      {
        id: "scanlines",
        name: "Scanlines",
        description: "CRT line texture.",
        operators: ["GLSL TOP"],
        tags: ["crt"],
      },
    ],
    resources: [{ label: "Guide", url: "https://example.invalid/guide" }],
  });
  writeJson(join(dataDir, "td-classes", "top.json"), {
    id: "top",
    name: "TOP",
    displayName: "TOP Class",
    category: "Texture",
    summary: "Texture operators.",
    tips: ["Use viewers for inspection."],
    warnings: ["Large textures use GPU memory."],
    relatedOperators: ["GLSL TOP"],
  });
  writeJson(join(dataDir, "versions", "version-manifest.json"), {
    versions: [
      {
        id: "2023",
        label: "TouchDesigner 2023",
        majorVersion: 2023,
        releaseYear: 2023,
        supportStatus: "legacy",
        notes: "maintenance release",
      },
      {
        id: "2024",
        label: "TouchDesigner 2024",
        majorVersion: 2024,
        releaseYear: 2024,
        supportStatus: "current",
        notes: "shader release",
      },
    ],
  });
  writeJson(join(dataDir, "versions", "release-highlights.json"), {
    releases: {
      "2024": {
        label: "TouchDesigner 2024",
        theme: "Shader work",
        highlights: ["GPU pipeline updates"],
      },
    },
  });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), {
    operators: {
      glsl_top: {
        name: "GLSL TOP",
        category: "TOP",
        addedIn: "2024",
        changedIn: [{ version: "2024", change: "Improved shader compiler" }],
        notes: "Shader render operator",
      },
    },
  });
  writeJson(join(dataDir, "versions", "python-api-compatibility.json"), {
    classes: {
      OP: {
        description: "Base operator class",
        methods: {
          cook: { addedIn: "2024", description: "Force cook" },
        },
        members: {
          path: { addedIn: "2024", description: "Full path" },
        },
      },
    },
  });
  writeJson(join(dataDir, "versions", "experimental-builds.json"), {
    buildSeries: [
      {
        seriesId: "2025.10000",
        label: "TouchDesigner 2025 Experimental",
        stabilityNotes: "Preview train",
        experimentalOperators: ["Foo POP"],
      },
    ],
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("KnowledgeBase secondary data surfaces", () => {
  it("reads operators, examples, tutorials, techniques, classes, and version wrappers", () => {
    const dataDir = join(tempRoot(), "data");
    writeSurfaceFixture(dataDir);
    const kb = new KnowledgeBase({ dataDir });

    expect(kb.listOperatorCategories()).toEqual(["CHOP", "TOP"]);
    expect(kb.listOperators("chop").map((operator) => operator.slug)).toEqual(["audio_chop"]);
    expect(kb.operatorExists("Audio CHOP")).toBe(true);
    expect(kb.searchOperators("audio channels", 1)[0]?.slug).toBe("audio_chop");
    expect(kb.searchOperatorConnectionGuides("audio", 1)[0]).toMatchObject({
      id: "audio_chop",
      name: "Audio CHOP",
    });
    expect(kb.searchOperatorExampleGuides("audio", 1)[0]?.id).toBe("audio_chop");

    const guide = kb.getOperatorConnections("Audio CHOP");
    expect(guide?.inputs).toEqual([
      expect.objectContaining({ op: "Audio Device In CHOP", reason: "live audio source" }),
    ]);
    expect(guide?.workflowHits[0]).toMatchObject({
      patternId: "audio_reactive",
      previousOperator: "Audio Device In",
      nextOperator: "GLSL TOP",
    });
    expect(kb.suggestNextOperators("Audio CHOP", 3)).toEqual([
      expect.objectContaining({
        operator: "GLSL TOP",
        complexity: "complex",
        estimatedNodes: "12-25",
      }),
      expect.objectContaining({
        operator: "Particle SOP",
        complexity: "medium",
        estimatedNodes: "6-12",
      }),
      expect.objectContaining({ operator: "Feedback TOP", source: "relatedOperator" }),
    ]);
    expect(kb.getOperatorExamples("audio_chop")?.usagePatterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Read Audio CHOP channel data",
          language: "python",
        }),
      ]),
    );
    expect(kb.getOperatorExamples("audio_chop")?.codeExamples[0]).toMatchObject({
      title: "Example 1",
      code: "op('audio1').chan('chan1')[0]",
    });

    expect(kb.listPythonClasses()[0]).toMatchObject({ className: "OP" });
    expect(kb.getPythonClass("OP Class")?.className).toBe("OP");
    expect(kb.getPythonApiCompatibility("OP.path")).toMatchObject({
      class: "OP",
      name: "path",
      kind: "member",
    });
    expect(kb.getPythonApiCompatibility("")).toBeUndefined();

    expect(kb.listPatterns()[0]).toMatchObject({ id: "audio_reactive", category: "CHOP" });
    expect(kb.getPattern("Audio Reactive")?.use_case).toBe("Audio-driven visuals");
    expect(kb.listGlslPatterns()[0]).toMatchObject({
      id: "scanline",
      difficulty: "beginner",
    });
    expect(kb.getGlslPattern("Scanline Shader")?.description).toBe("CRT scanline look.");
    expect(kb.listTutorials()[0]).toMatchObject({ id: "intro", name: "Intro Tutorial" });
    expect(kb.getTutorial("Intro Tutorial")?.summary).toBe("Build a first network.");

    expect(kb.listTechniquePacks()[0]).toMatchObject({
      id: "visual-synthesis",
      count: 1,
    });
    expect(kb.getTechniquePack("Visual Synthesis")?.versionRequirement).toBe("2024+");
    expect(kb.getTechnique("visual synthesis")?.id).toBe("scanlines");
    expect(kb.getTechnique("visual-synthesis", "Scanlines")?.operators).toEqual(["GLSL TOP"]);
    expect(kb.searchTechniques("", 1)[0]?.id).toBe("visual-synthesis");
    expect(kb.searchTechniques("crt", 1)[0]).toMatchObject({
      id: "visual-synthesis/scanlines",
      name: "Scanlines",
    });

    expect(kb.listTouchDesignerClasses()[0]).toMatchObject({
      id: "top",
      name: "TOP Class",
    });
    expect(kb.getTouchDesignerClass("TOP")?.summary).toBe("Texture operators.");
    expect(kb.searchTouchDesignerClasses("", 1)[0]?.id).toBe("top");
    expect(kb.searchTouchDesignerClasses("texture", 1)[0]?.name).toBe("TOP Class");

    expect(kb.listTdVersions().map((version) => version.id)).toEqual(["2023", "2024"]);
    expect(kb.getCurrentStableTdVersion()?.id).toBe("2024");
    expect(kb.getTdReleaseHighlight("missing")).toBeUndefined();
    expect(kb.getTdVersionOperatorChanges("missing")).toEqual([]);
    expect(kb.getTdVersionNewOperators("missing")).toEqual([]);
    expect(kb.getTdVersionPythonApiAdditions("missing")).toEqual([]);
    expect(kb.listTouchDesignerVersions()[0]).toMatchObject({
      version: "2023",
      releaseDate: "2023",
      summary: "maintenance release",
    });
    expect(kb.getTouchDesignerVersion("2024")).toMatchObject({
      releaseHighlights: expect.objectContaining({ theme: "Shader work" }),
      newOperators: [expect.objectContaining({ name: "GLSL TOP" })],
      operatorChanges: [expect.objectContaining({ name: "GLSL TOP" })],
      pythonApiAdditions: [
        expect.objectContaining({ class: "OP", name: "cook", kind: "method" }),
        expect.objectContaining({ class: "OP", name: "path", kind: "member" }),
      ],
    });
    expect(kb.searchTouchDesignerVersions("", 1)[0]?.version).toBe("2023");
    expect(kb.searchTouchDesignerVersions("shader", 1)[0]?.version).toBe("2024");

    expect(kb.getExperimentalBuildSeries()?.seriesId).toBe("2025.10000");
    expect(kb.listTouchDesignerExperimentals()[0]).toMatchObject({
      id: "2025.10000",
      count: 1,
    });
    expect(kb.getTouchDesignerExperimental("experimental")?.seriesId).toBe("2025.10000");
    expect(kb.searchTouchDesignerExperimentals("", 1)[0]?.id).toBe("2025.10000");
    expect(kb.searchTouchDesignerExperimentals("preview", 1)[0]?.name).toBe(
      "TouchDesigner 2025 Experimental",
    );

    expect(kb.stats()).toMatchObject({
      techniques: 1,
      techniquePacks: 1,
      tdClasses: 1,
      tutorials: 1,
    });
  });
});
