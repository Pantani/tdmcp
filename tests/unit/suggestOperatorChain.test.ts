import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { suggestOperatorChainImpl } from "../../src/tools/layer3/suggestOperatorChain.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-operator-chain-tool-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeChainFixture(dataDir: string): void {
  mkdirSync(join(dataDir, "operators"), { recursive: true });
  mkdirSync(join(dataDir, "python-api"), { recursive: true });
  mkdirSync(join(dataDir, "tutorials"), { recursive: true });
  mkdirSync(join(dataDir, "versions"), { recursive: true });
  mkdirSync(join(dataDir, "techniques"), { recursive: true });
  mkdirSync(join(dataDir, "td-classes"), { recursive: true });

  writeJson(join(dataDir, "operators", "index.json"), [
    {
      slug: "audio_spectrum_chop",
      name: "Audio Spectrum CHOP",
      displayName: "Audio Spectrum CHOP",
      category: "CHOP",
      subcategory: "Audio",
      summary: "Analyze audio spectrum for mixedfallback provenance tests",
      keywords: ["mixedfallback", "audio", "spectrum"],
    },
    {
      slug: "noise_top",
      name: "Noise TOP",
      displayName: "Noise TOP",
      category: "TOP",
      subcategory: "Generator",
      summary: "Procedural texture noise",
      keywords: ["noise", "procedural", "texture", "mixedfallback"],
    },
    {
      slug: "level_top",
      name: "Level TOP",
      displayName: "Level TOP",
      category: "TOP",
      subcategory: "Filter",
      summary: "Adjust brightness and contrast",
      keywords: ["level", "brightness", "contrast", "texture"],
    },
    {
      slug: "null_top",
      name: "Null TOP",
      displayName: "Null TOP",
      category: "TOP",
      subcategory: "Utility",
      summary: "Stable output handoff",
      keywords: ["null", "output", "texture", "mixedfallback"],
    },
  ]);
  writeJson(join(dataDir, "operators", "noise_top.json"), {
    name: "Noise TOP",
    displayName: "Noise TOP",
    category: "TOP",
    subcategory: "Generator",
    summary: "Procedural texture noise",
    commonOutputs: [{ op: "Level TOP", port: "output 0 -> input 0", reason: "Shape contrast" }],
    workflowPatterns: ["procedural_texture"],
  });
  writeJson(join(dataDir, "operators", "level_top.json"), {
    name: "Level TOP",
    displayName: "Level TOP",
    category: "TOP",
    subcategory: "Filter",
    summary: "Adjust brightness and contrast",
    commonOutputs: [{ op: "Null TOP", reason: "Stable output endpoint" }],
  });
  writeJson(join(dataDir, "operators", "null_top.json"), {
    name: "Null TOP",
    displayName: "Null TOP",
    category: "TOP",
    subcategory: "Utility",
    summary: "Stable output handoff",
  });
  writeJson(join(dataDir, "operators", "audio_spectrum_chop.json"), {
    name: "Audio Spectrum CHOP",
    displayName: "Audio Spectrum CHOP",
    category: "CHOP",
    subcategory: "Audio",
    summary: "Analyze audio spectrum for mixedfallback provenance tests",
  });
  writeJson(join(dataDir, "python-api", "index.json"), []);
  writeJson(join(dataDir, "tutorials", "index.json"), []);
  writeJson(join(dataDir, "patterns.json"), [
    {
      id: "procedural_texture",
      name: "Procedural Texture",
      category: "TOP",
      description: "Build a procedural texture and expose a stable output.",
      use_case: "procedural texture",
      workflow: ["Noise TOP", "Level TOP", "Null TOP"],
    },
  ]);
  writeJson(join(dataDir, "glsl.json"), []);
  writeJson(join(dataDir, "versions", "version-manifest.json"), { versions: [] });
  writeJson(join(dataDir, "versions", "release-highlights.json"), { releases: {} });
  writeJson(join(dataDir, "versions", "operator-compatibility.json"), { operators: {} });
  writeJson(join(dataDir, "versions", "python-api-compatibility.json"), { classes: {} });
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

describe("suggestOperatorChainImpl", () => {
  it("suggests an ordered read-only operator chain for a goal", () => {
    const dataDir = join(tempRoot(), "data");
    writeChainFixture(dataDir);

    const result = suggestOperatorChainImpl(makeCtx(dataDir), {
      goal: "procedural texture output",
      family: "TOP",
      max_steps: 3,
    });
    const data = structured<{
      goal: string;
      chain: Array<{ operator: string; role: string; connectionHint?: string }>;
      sourceMatches: Array<{ surface: string; id: string }>;
      nextToolHints: string[];
    }>(result);

    expect(data.goal).toBe("procedural texture output");
    expect(data.chain.map((step) => step.operator)).toEqual(["Noise TOP", "Level TOP", "Null TOP"]);
    expect(data.chain[0]?.role).toContain("Generator");
    expect(data.chain[1]?.connectionHint).toContain("output 0 -> input 0");
    expect(data.sourceMatches).toEqual([
      expect.objectContaining({ surface: "operator_workflow", id: "procedural_texture" }),
    ]);
    expect(data.nextToolHints).toContain("apply_recipe");
    expect(textOf(result)).toContain("Suggested 3-step operator chain");
  });

  it("can start from a seed operator and extend through documented next operators", () => {
    const dataDir = join(tempRoot(), "data");
    writeChainFixture(dataDir);

    const result = suggestOperatorChainImpl(makeCtx(dataDir), {
      goal: "make noise easier to tune",
      seed_operator: "Noise TOP",
      max_steps: 2,
    });
    const data = structured<{ chain: Array<{ operator: string; reason?: string }> }>(result);

    expect(data.chain.map((step) => step.operator)).toEqual(["Noise TOP", "Level TOP"]);
    expect(data.chain[1]?.reason).toContain("Shape contrast");
  });

  it("returns suggestions when the seed operator cannot be resolved", () => {
    const dataDir = join(tempRoot(), "data");
    writeChainFixture(dataDir);

    const result = suggestOperatorChainImpl(makeCtx(dataDir), {
      goal: "texture",
      seed_operator: "not real",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Seed operator not found");
    expect(textOf(result)).toContain("suggestions");
  });

  it("keeps fallback source matches aligned with the family-filtered chain", () => {
    const dataDir = join(tempRoot(), "data");
    writeChainFixture(dataDir);
    writeJson(join(dataDir, "patterns.json"), []);

    const result = suggestOperatorChainImpl(makeCtx(dataDir), {
      goal: "mixedfallback",
      family: "TOP",
      max_steps: 2,
    });
    const data = structured<{
      chain: Array<{ operator: string }>;
      sourceMatches: Array<{ id: string; name: string }>;
    }>(result);

    expect(data.chain.map((step) => step.operator)).toEqual(["Noise TOP", "Null TOP"]);
    expect(data.sourceMatches.map((match) => match.id)).toEqual(["noise_top", "null_top"]);
    expect(data.sourceMatches.map((match) => match.id)).not.toContain("audio_spectrum_chop");
  });
});
