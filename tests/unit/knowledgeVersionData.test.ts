import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-knowledge-version-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeVersionFixture(dataDir: string): void {
  mkdirSync(join(dataDir, "operators"), { recursive: true });
  mkdirSync(join(dataDir, "python-api"), { recursive: true });
  mkdirSync(join(dataDir, "tutorials"), { recursive: true });
  mkdirSync(join(dataDir, "versions"), { recursive: true });

  writeJson(join(dataDir, "operators", "index.json"), []);
  writeJson(join(dataDir, "python-api", "index.json"), []);
  writeJson(join(dataDir, "tutorials", "index.json"), []);
  writeJson(join(dataDir, "patterns.json"), []);
  writeJson(join(dataDir, "glsl.json"), []);
  writeJson(join(dataDir, "versions", "version-manifest.json"), {
    schemaVersion: "1.0",
    versions: [
      {
        id: "099",
        label: "TouchDesigner 099",
        majorVersion: 99,
        releaseYear: 2017,
        pythonVersion: "3.5.1",
        pythonMajorMinor: "3.5",
        supportStatus: "legacy",
      },
      {
        id: "2024",
        label: "TouchDesigner 2024",
        majorVersion: 2024,
        releaseYear: 2024,
        pythonVersion: "3.11.7",
        pythonMajorMinor: "3.11",
        supportStatus: "current",
      },
    ],
    versionOrder: ["099", "2024"],
    currentStable: "2024",
    pythonVersionMap: { "099": "3.5", "2024": "3.11" },
  });
  writeJson(join(dataDir, "versions", "release-highlights.json"), {
    schemaVersion: "1.0",
    releases: {
      "2024": {
        label: "TouchDesigner 2024",
        theme: "Current stable release",
        highlights: ["Python 3.11.7 bundled"],
        newOperators: ["Ray Trace TOP"],
        pythonHighlights: ["App.pythonVersion reports 3.11.7"],
        breakingChanges: [],
      },
    },
  });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), {
    schemaVersion: "1.0",
    operators: {
      noise_top: {
        name: "Noise TOP",
        category: "TOP",
        addedIn: "099",
        changedIn: [{ version: "2024", change: "Improved GPU noise path" }],
        removedIn: null,
        notes: "Procedural texture noise",
      },
    },
  });
  writeJson(join(dataDir, "versions", "python-api-compatibility.json"), {
    schemaVersion: "1.0",
    classes: {
      OP: {
        description: "Base class for all TouchDesigner operators",
        addedIn: "099",
        methods: {
          cook: {
            signature: "cook(force=False)",
            addedIn: "099",
            changedIn: [],
            description: "Force the operator to cook",
          },
        },
        members: {
          path: {
            addedIn: "099",
            changedIn: [],
            description: "Full path of the operator",
          },
        },
      },
    },
  });
  writeJson(join(dataDir, "versions", "experimental-builds.json"), {
    schemaVersion: "1.0",
    currentExperimentalSeries: "2025.10000",
    buildSeries: [
      {
        seriesId: "2025.10000",
        label: "TouchDesigner 2025 Experimental",
        basedOnStable: "2024",
        stabilityStatus: "experimental",
        featureFlags: { vulkan_renderer_default: true },
      },
    ],
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("KnowledgeBase TouchDesigner version data", () => {
  it("reads stable versions and compatibility data from local imported JSON", () => {
    const dataDir = join(tempRoot(), "data");
    writeVersionFixture(dataDir);

    const kb = new KnowledgeBase({ dataDir });

    expect(kb.listStableVersions().map((version) => version.id)).toEqual(["099", "2024"]);
    expect(kb.getVersion("99")?.id).toBe("099");
    expect(kb.getVersion("TouchDesigner 2024")?.pythonVersion).toBe("3.11.7");
    expect(kb.getReleaseHighlights("td 2024")?.newOperators).toContain("Ray Trace TOP");
    expect(kb.getOperatorCompatibility("Noise TOP")?.changedIn?.[0]?.version).toBe("2024");
    expect(kb.getPythonApiCompatibility("op")).toMatchObject({
      methods: { cook: { addedIn: "099" } },
    });
    expect(kb.getExperimentalBuildSeries("2025.10000")?.featureFlags?.vulkan_renderer_default).toBe(
      true,
    );
    expect(kb.getExperimentalBuildData().currentExperimentalSeries).toBe("2025.10000");
    expect(kb.stats()).toMatchObject({
      tdVersions: 2,
      releaseHighlights: 1,
      operatorCompatibility: 1,
      pythonApiCompatibility: 1,
      experimentalBuildSeries: 1,
    });
  });

  it("falls back directly to @bottobot/td-mcp version JSON when local data is absent", () => {
    const missingLocalDir = join(tempRoot(), "missing-local-data");
    const kb = new KnowledgeBase({ dataDir: missingLocalDir });

    expect(kb.sourceKind).toBe("bottobot");
    expect(kb.getVersion("2024")?.label).toBe("TouchDesigner 2024");
    expect(kb.getReleaseHighlights("2024")?.highlights?.length).toBeGreaterThan(0);
    expect(kb.getOperatorCompatibility("Noise TOP")?.addedIn).toBe("099");
    expect(kb.getPythonApiCompatibility("OP")).toMatchObject({ methods: expect.any(Object) });
    expect(kb.listExperimentalBuildSeries().length).toBeGreaterThan(0);
  });
});
