import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { getOperatorWorkflowGuideImpl } from "../../src/tools/layer3/getOperatorWorkflowGuide.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-operator-workflow-tool-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeWorkflowFixture(dataDir: string): void {
  mkdirSync(join(dataDir, "operators"), { recursive: true });
  mkdirSync(join(dataDir, "python-api"), { recursive: true });
  mkdirSync(join(dataDir, "tutorials"), { recursive: true });
  mkdirSync(join(dataDir, "versions"), { recursive: true });

  writeJson(join(dataDir, "operators", "index.json"), [
    {
      slug: "feedback_top",
      name: "Feedback TOP",
      displayName: "Feedback TOP",
      category: "TOP",
      subcategory: "Compositing",
      summary: "Recursive image feedback",
      keywords: ["feedback", "recursive"],
    },
  ]);
  writeJson(join(dataDir, "operators", "feedback_top.json"), {
    name: "Feedback TOP",
    displayName: "Feedback TOP",
    category: "TOP",
    usage: "Wire a source into Feedback, process the output, then target the downstream Null TOP.",
    commonInputs: [{ op: "Noise TOP", reason: "Generative seed texture" }],
    commonOutputs: [
      { op: "Transform TOP", reason: "Zoom or rotate the feedback buffer" },
      { op: "Null TOP", reason: "Stable target that closes the loop" },
    ],
    relatedOperators: ["Level TOP", "Transform TOP", "Null TOP"],
    workflowPatterns: ["feedback_loop_effect"],
    pythonExamples: [
      {
        title: "Set target",
        language: "python",
        code: "op('feedback1').par.targettop = op('null1')",
        description: "Point Feedback TOP at the downstream Null TOP.",
      },
    ],
    expressions: [
      {
        title: "Target path",
        code: "op('null1').path",
        description: "Use a downstream TOP path.",
      },
    ],
    tips: ["Target a downstream TOP, not the upstream source."],
  });
  writeJson(join(dataDir, "python-api", "index.json"), []);
  writeJson(join(dataDir, "tutorials", "index.json"), []);
  writeJson(join(dataDir, "patterns.json"), [
    {
      id: "feedback_loop_effect",
      name: "Feedback Loop Effect",
      category: "TOP",
      workflow: ["Movie File In", "Transform", "Feedback", "Composite", "Level", "Out"],
      use_case: "Create recursive video feedback effects",
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("getOperatorWorkflowGuideImpl", () => {
  it("returns connections, examples and next-operator suggestions for an operator", () => {
    const dataDir = join(tempRoot(), "data");
    writeWorkflowFixture(dataDir);

    const result = getOperatorWorkflowGuideImpl(makeCtx(dataDir), {
      operator: "Feedback TOP",
      include_examples: true,
      next_limit: 3,
    });
    const data = structured<{
      found: boolean;
      guide?: { outputs?: Array<{ op: string }>; workflowHits?: unknown[] };
      examples?: { pythonExamples?: Array<{ title: string }> };
      nextOperators: Array<{ operator: string; confidence: number }>;
    }>(result);

    expect(data.found).toBe(true);
    expect(data.guide?.outputs?.map((entry) => entry.op)).toEqual(["Transform TOP", "Null TOP"]);
    expect(data.guide?.workflowHits).toHaveLength(1);
    expect(data.examples?.pythonExamples).toEqual([
      expect.objectContaining({ title: "Set target" }),
    ]);
    expect(data.nextOperators[0]).toMatchObject({
      operator: "Transform TOP",
      confidence: 0.9,
    });
  });

  it("returns suggestions instead of an error when the operator is missing", () => {
    const dataDir = join(tempRoot(), "data");
    writeWorkflowFixture(dataDir);

    const result = getOperatorWorkflowGuideImpl(makeCtx(dataDir), {
      operator: "feed",
      include_examples: false,
      next_limit: 3,
    });
    const data = structured<{ found: boolean; suggestions: string[]; nextOperators: unknown[] }>(
      result,
    );

    expect(result.isError).toBeFalsy();
    expect(data.found).toBe(false);
    expect(data.nextOperators).toEqual([]);
    expect(data.suggestions).toContain("feedback_top");
  });
});
