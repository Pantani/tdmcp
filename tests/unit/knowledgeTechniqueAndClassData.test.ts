import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-technique-class-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeBaseFixture(dataDir: string): void {
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
}

function writeTechniqueAndClassFixture(dataDir: string): void {
  writeBaseFixture(dataDir);
  writeJson(join(dataDir, "techniques", "audio-visual.json"), {
    category: "audio-visual",
    displayName: "Audio-Visual",
    description: "Audio-reactive visual techniques in TouchDesigner.",
    techniques: [
      {
        id: "fft_to_geometry",
        name: "FFT to Geometry",
        subcategory: "audio-reactive",
        description: "Convert FFT spectrum data into geometry.",
        difficulty: "beginner",
        operators: ["Audio Spectrum CHOP", "CHOP to SOP"],
        tags: ["FFT", "audio-reactive"],
        code: { language: "python", filename: "fft.py", snippet: "def cook(scriptOp): pass" },
        workflow: {
          description: "FFT chain",
          chain: ["Audio Device In CHOP", "Audio Spectrum CHOP"],
        },
      },
    ],
  });
  writeJson(join(dataDir, "td-classes", "top_class.json"), {
    id: "top_class",
    name: "TOP Class",
    displayName: "TOP Class",
    category: "CLASS",
    type: "class",
    description: "A TOP describes a reference to a TOP operator.",
    summary: "A TOP describes a reference to a TOP operator.",
    url: "https://docs.derivative.ca/TOP_Class",
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("KnowledgeBase technique packs and TD classes", () => {
  it("reads technique packs, techniques, search results and stats from local JSON", () => {
    const dataDir = join(tempRoot(), "data");
    writeTechniqueAndClassFixture(dataDir);

    const kb = new KnowledgeBase({ dataDir });

    expect(kb.listTechniquePacks()).toEqual([
      {
        id: "audio-visual",
        name: "Audio-Visual",
        description: "Audio-reactive visual techniques in TouchDesigner.",
        count: 1,
      },
    ]);
    expect(kb.getTechniquePack("Audio Visual")?.displayName).toBe("Audio-Visual");
    expect(kb.getTechnique("audio-visual", "fft to geometry")?.operators).toContain(
      "Audio Spectrum CHOP",
    );
    expect(kb.searchTechniques("fft geometry")).toEqual([
      expect.objectContaining({
        id: "audio-visual/fft_to_geometry",
        name: "FFT to Geometry",
      }),
    ]);
    expect(kb.stats()).toMatchObject({ techniquePacks: 1, techniques: 1 });
  });

  it("reads TouchDesigner class references and aliases from local JSON", () => {
    const dataDir = join(tempRoot(), "data");
    writeTechniqueAndClassFixture(dataDir);

    const kb = new KnowledgeBase({ dataDir });

    expect(kb.listTouchDesignerClasses()).toEqual([
      {
        id: "top_class",
        name: "TOP Class",
        description: "A TOP describes a reference to a TOP operator.",
      },
    ]);
    expect(kb.getTouchDesignerClass("TOP")?.id).toBe("top_class");
    expect(kb.getTouchDesignerClass("top_class")?.displayName).toBe("TOP Class");
    expect(kb.searchTouchDesignerClasses("operator")).toEqual([
      expect.objectContaining({ id: "top_class", name: "TOP Class" }),
    ]);
    expect(kb.stats()).toMatchObject({ tdClasses: 1 });
  });

  it("falls back to installed Bottobot technique and class JSON when local data is absent", () => {
    const missingLocalDir = join(tempRoot(), "missing-local-data");
    const kb = new KnowledgeBase({ dataDir: missingLocalDir });

    expect(kb.sourceKind).toBe("bottobot");
    expect(kb.getTechniquePack("audio-visual")?.techniques.length).toBeGreaterThan(0);
    expect(kb.searchTechniques("osc").length).toBeGreaterThan(0);
    expect(kb.getTouchDesignerClass("TOP")?.displayName).toBe("TOP Class");
    expect(kb.listTouchDesignerClasses().length).toBeGreaterThan(0);
  });
});
