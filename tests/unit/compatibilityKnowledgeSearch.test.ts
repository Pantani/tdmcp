import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-compat-search-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeCompatibilityFixture(dataDir: string): void {
  mkdirSync(join(dataDir, "operators"), { recursive: true });
  mkdirSync(join(dataDir, "python-api"), { recursive: true });
  mkdirSync(join(dataDir, "tutorials"), { recursive: true });
  mkdirSync(join(dataDir, "versions"), { recursive: true });

  writeJson(join(dataDir, "operators", "index.json"), []);
  writeJson(join(dataDir, "python-api", "index.json"), []);
  writeJson(join(dataDir, "tutorials", "index.json"), []);
  writeJson(join(dataDir, "patterns.json"), []);
  writeJson(join(dataDir, "glsl.json"), []);
  writeJson(join(dataDir, "versions", "version-manifest.json"), { versions: [] });
  writeJson(join(dataDir, "versions", "release-highlights.json"), { releases: {} });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), {
    operators: {
      noise_top: {
        name: "Noise TOP",
        category: "TOP",
        addedIn: "099",
        changedIn: [{ version: "2024", change: "Improved GPU path" }],
        notes: "Procedural texture noise",
      },
    },
  });
  writeJson(join(dataDir, "versions", "python-api-compatibility.json"), {
    classes: {
      OP: {
        description: "Base operator class",
        addedIn: "099",
        methods: {
          cook: {
            signature: "cook(force=False)",
            addedIn: "099",
            changedIn: [],
            description: "Force cook",
          },
        },
        members: {
          path: {
            addedIn: "099",
            changedIn: [],
            description: "Full operator path",
          },
        },
      },
    },
  });
  writeJson(join(dataDir, "versions", "experimental-builds.json"), { buildSeries: [] });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("KnowledgeBase compatibility search helpers", () => {
  it("searches operator compatibility records for resource listing and completion", () => {
    const dataDir = join(tempRoot(), "data");
    writeCompatibilityFixture(dataDir);

    const kb = new KnowledgeBase({ dataDir });

    expect(kb.searchOperatorCompatibility("noise")).toEqual([
      {
        id: "noise_top",
        name: "Noise TOP",
        description: "Procedural texture noise",
      },
    ]);
    expect(kb.searchOperatorCompatibility("", 1)).toHaveLength(1);
  });

  it("searches Python API compatibility classes and members", () => {
    const dataDir = join(tempRoot(), "data");
    writeCompatibilityFixture(dataDir);

    const kb = new KnowledgeBase({ dataDir });

    expect(kb.searchPythonApiCompatibility("cook")).toEqual([
      expect.objectContaining({
        id: "OP.cook",
        name: "OP.cook",
        description: "Force cook",
      }),
    ]);
    expect(kb.searchPythonApiCompatibility("op")).toEqual([
      expect.objectContaining({ id: "OP", name: "OP" }),
      expect.objectContaining({ id: "OP.cook", name: "OP.cook" }),
      expect.objectContaining({ id: "OP.path", name: "OP.path" }),
    ]);
  });
});
