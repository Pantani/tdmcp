import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { compareOperatorDocsImpl } from "../../src/tools/layer3/compareOperatorDocs.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function makeCtx(): ToolContext {
  return {
    knowledge: new KnowledgeBase(),
    logger: silentLogger,
  } as unknown as ToolContext;
}

interface CompareData {
  operatorA: { name: string; category?: string };
  operatorB: { name: string; category?: string };
  overview: { sameCategory: boolean; parameterCountA: number; parameterCountB: number };
  sharedParameters: Array<{ name: string; type?: string }>;
  uniqueToA: Array<{ name: string }>;
  uniqueToB: Array<{ name: string }>;
  summary: { sharedCount: number; uniqueToACount: number; uniqueToBCount: number };
}

function sc(result: CallToolResult): CompareData {
  return (result as { structuredContent?: CompareData }).structuredContent as CompareData;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("compareOperatorDocsImpl", () => {
  it("compares two operator docs and reports shared and unique parameters", () => {
    const result = compareOperatorDocsImpl(makeCtx(), {
      operator_a: "Noise TOP",
      operator_b: "Noise CHOP",
      include_parameters: true,
      parameter_limit: 20,
    });
    const data = sc(result);

    expect(data.operatorA.name).toBe("Noise TOP");
    expect(data.operatorB.name).toBe("Noise CHOP");
    expect(data.overview.sameCategory).toBe(false);
    expect(data.sharedParameters.some((parameter) => parameter.name === "Seed")).toBe(true);
    expect(data.uniqueToA.length).toBeGreaterThan(0);
    expect(data.uniqueToB.length).toBeGreaterThan(0);
    expect(textOf(result)).toContain("Compared Noise TOP vs Noise CHOP");
  });

  it("respects the parameter comparison limit", () => {
    const result = compareOperatorDocsImpl(makeCtx(), {
      operator_a: "Noise TOP",
      operator_b: "Noise CHOP",
      parameter_limit: 2,
    });
    const data = sc(result);

    expect(data.sharedParameters.length).toBeLessThanOrEqual(2);
    expect(data.uniqueToA.length).toBeLessThanOrEqual(2);
    expect(data.uniqueToB.length).toBeLessThanOrEqual(2);
    expect(data.summary.sharedCount).toBeGreaterThanOrEqual(data.sharedParameters.length);
  });

  it("can return only the overview when parameter comparison is disabled", () => {
    const result = compareOperatorDocsImpl(makeCtx(), {
      operator_a: "Noise TOP",
      operator_b: "Noise CHOP",
      include_parameters: false,
    });
    const data = sc(result);

    expect(data.overview.parameterCountA).toBeGreaterThan(0);
    expect(data.overview.parameterCountB).toBeGreaterThan(0);
    expect(data.sharedParameters).toEqual([]);
    expect(data.uniqueToA).toEqual([]);
    expect(data.uniqueToB).toEqual([]);
  });

  it("returns an error with suggestions when an operator cannot be resolved", () => {
    const result = compareOperatorDocsImpl(makeCtx(), {
      operator_a: "Noise TOP",
      operator_b: "not a real operator",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
    expect(textOf(result)).toContain("suggestions");
  });
});
