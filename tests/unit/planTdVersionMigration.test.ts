import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { planTdVersionMigrationImpl } from "../../src/tools/layer3/planTdVersionMigration.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-version-migration-tool-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeMigrationFixture(dataDir: string): void {
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
  writeJson(join(dataDir, "versions", "version-manifest.json"), {
    currentStable: "2024",
    versionOrder: ["099", "2023", "2024"],
    versions: [
      { id: "099", label: "TouchDesigner 099", supportStatus: "legacy" },
      { id: "2023", label: "TouchDesigner 2023", supportStatus: "stable" },
      { id: "2024", label: "TouchDesigner 2024", supportStatus: "stable" },
    ],
  });
  writeJson(join(dataDir, "versions", "release-highlights.json"), {
    releases: {
      "2024": {
        label: "TouchDesigner 2024",
        theme: "Performance and POPs",
        highlights: ["Improved Web Render TOP stability"],
        newOperators: ["Particle POP"],
        pythonHighlights: ["OP.addScript for extension deployment"],
        breakingChanges: ["Audit custom Web Render TOP scripts"],
      },
    },
  });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), {
    operators: {
      particle_pop: {
        name: "Particle POP",
        category: "POP",
        addedIn: "2024",
        notes: "New POP particle workflow.",
      },
      web_render_top: {
        name: "Web Render TOP",
        category: "TOP",
        addedIn: "099",
        changedIn: [{ version: "2024", change: "Chromium runtime updated" }],
        notes: "Validate browser rendering and script callbacks.",
      },
    },
  });
  writeJson(join(dataDir, "versions", "python-api-compatibility.json"), {
    classes: {
      OP: {
        description: "Base operator class",
        methods: {
          addScript: {
            signature: "addScript(script)",
            addedIn: "2024",
            changedIn: [],
            description: "Attach a generated script to an operator.",
          },
        },
      },
    },
  });
  writeJson(join(dataDir, "versions", "experimental-builds.json"), { buildSeries: [] });
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

describe("planTdVersionMigrationImpl", () => {
  it("builds a version-scoped migration plan from offline compatibility data", () => {
    const dataDir = join(tempRoot(), "data");
    writeMigrationFixture(dataDir);

    const result = planTdVersionMigrationImpl(makeCtx(dataDir), {
      from_version: "2023",
      to_version: "2024",
      query: "web script particle",
      limit: 10,
    });
    const data = structured<{
      fromVersion: { id: string };
      toVersion: { id: string };
      versionPath: string[];
      releaseHighlights: Array<{ version: string; theme?: string; breakingChanges: string[] }>;
      operatorAdditions: Array<{ name: string }>;
      operatorChanges: Array<{ name: string; changes: string[] }>;
      pythonApiAdditions: Array<{ ref: string; signature?: string }>;
      checklist: string[];
    }>(result);

    expect(data.fromVersion.id).toBe("2023");
    expect(data.toVersion.id).toBe("2024");
    expect(data.versionPath).toEqual(["2024"]);
    expect(data.releaseHighlights).toEqual([
      expect.objectContaining({
        version: "2024",
        theme: "Performance and POPs",
        breakingChanges: ["Audit custom Web Render TOP scripts"],
      }),
    ]);
    expect(data.operatorAdditions).toEqual([expect.objectContaining({ name: "Particle POP" })]);
    expect(data.operatorChanges).toEqual([
      expect.objectContaining({
        name: "Web Render TOP",
        changes: ["Chromium runtime updated"],
      }),
    ]);
    expect(data.pythonApiAdditions).toEqual([
      expect.objectContaining({
        ref: "OP.addScript",
        signature: "addScript(script)",
      }),
    ]);
    expect(data.checklist.join("\n")).toContain("Web Render TOP");
    expect(textOf(result)).toContain("Migration plan 2023 -> 2024");
  });

  it("returns a useful error when either version cannot be resolved", () => {
    const dataDir = join(tempRoot(), "data");
    writeMigrationFixture(dataDir);

    const result = planTdVersionMigrationImpl(makeCtx(dataDir), {
      from_version: "2022",
      to_version: "2024",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown TouchDesigner version");
    expect(textOf(result)).toContain("availableVersions");
  });
});
