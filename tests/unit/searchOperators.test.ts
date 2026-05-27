import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { searchOperatorsImpl } from "../../src/tools/layer3/searchOperators.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function makeCtx(): ToolContext {
  return {
    knowledge: new KnowledgeBase(),
    logger: silentLogger,
  } as unknown as ToolContext;
}

interface SearchData {
  query: string;
  mode: string;
  count: number;
  operators: Array<{ name: string; summary?: string }>;
}

function sc(result: CallToolResult): SearchData {
  return (result as { structuredContent?: SearchData }).structuredContent as SearchData;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("searchOperatorsImpl", () => {
  it("returns keyword matches fully offline for a plain query", async () => {
    const result = await searchOperatorsImpl(makeCtx(), {
      query: "blur",
      limit: 20,
      semantic: false,
    });
    const data = sc(result);
    expect(data.mode).toBe("keyword");
    expect(data.count).toBeGreaterThan(0);
    // blurTOP is a real operator, so a name match should surface.
    expect(data.operators.some((o) => o.name.toLowerCase().includes("blur"))).toBe(true);
  });

  it("never returns more than the requested limit", async () => {
    const result = await searchOperatorsImpl(makeCtx(), {
      query: "top",
      limit: 3,
      semantic: false,
    });
    expect(sc(result).operators.length).toBeLessThanOrEqual(3);
  });

  it("reports zero results for a query that matches nothing", async () => {
    const result = await searchOperatorsImpl(makeCtx(), {
      query: "zxqwv_nomatch_9999",
      limit: 20,
      semantic: false,
    });
    expect(sc(result).count).toBe(0);
  });

  it("echoes the query in the summary text", async () => {
    const result = await searchOperatorsImpl(makeCtx(), {
      query: "noise",
      limit: 5,
      semantic: false,
    });
    expect(textOf(result)).toContain("noise");
  });
});
