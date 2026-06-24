import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-operator-workflow-"));
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
    usage: "Wire source into Feedback, process the output, then target the downstream Null TOP.",
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("KnowledgeBase operator workflow intelligence", () => {
  it("builds operator connection guidance from docs and workflow patterns", () => {
    const dataDir = join(tempRoot(), "data");
    writeWorkflowFixture(dataDir);

    const kb = new KnowledgeBase({ dataDir });
    const guide = kb.getOperatorConnections("Feedback TOP");

    expect(guide?.operator.name).toBe("Feedback TOP");
    expect(guide?.inputs).toEqual([
      expect.objectContaining({ op: "Noise TOP", reason: "Generative seed texture" }),
    ]);
    expect(guide?.outputs.map((entry) => entry.op)).toEqual(["Transform TOP", "Null TOP"]);
    expect(guide?.workflowHits).toEqual([
      expect.objectContaining({
        patternId: "feedback_loop_effect",
        previousOperator: "Transform",
        nextOperator: "Composite",
      }),
    ]);
    expect(kb.suggestNextOperators("Feedback TOP")[0]).toMatchObject({
      operator: "Transform TOP",
      confidence: 0.9,
      complexity: "simple",
    });
  });

  it("builds operator example guidance from stored and generated examples", () => {
    const dataDir = join(tempRoot(), "data");
    writeWorkflowFixture(dataDir);

    const kb = new KnowledgeBase({ dataDir });
    const examples = kb.getOperatorExamples("Feedback TOP");

    expect(examples?.pythonExamples).toEqual([
      expect.objectContaining({ title: "Set target", language: "python" }),
    ]);
    expect(examples?.expressions).toEqual([expect.objectContaining({ title: "Target path" })]);
    expect(examples?.usagePatterns.some((entry) => entry.title.includes("Create"))).toBe(true);
    expect(examples?.tips).toEqual(["Target a downstream TOP, not the upstream source."]);
  });
});
