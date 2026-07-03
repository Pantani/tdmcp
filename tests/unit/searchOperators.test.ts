import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { computeStaleHint, searchOperatorsImpl } from "../../src/tools/layer3/searchOperators.js";
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
  total?: number;
  filters?: {
    category?: string;
    subcategory?: string;
    version?: string;
    parameter_search?: boolean;
    type?: string;
  };
  facets?: {
    categories: Record<string, number>;
    subcategories: Record<string, number>;
  };
  operators: Array<{
    name: string;
    category?: string;
    subcategory?: string;
    summary?: string;
    matchedParameters?: Array<{ name: string }>;
  }>;
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

describe("computeStaleHint", () => {
  it("returns undefined when the majors match or are unknown", () => {
    expect(computeStaleHint(2023, "2023.11510")).toBeUndefined();
    expect(computeStaleHint(undefined, "2023.11510")).toBeUndefined();
    expect(computeStaleHint(2023, undefined)).toBeUndefined();
    expect(computeStaleHint(2023, "not-a-version")).toBeUndefined();
  });

  it("warns when the live TD major differs from the data major", () => {
    const hint = computeStaleHint(2023, "2025.30000");
    expect(hint).toContain("2023");
    expect(hint).toContain("2025");
    expect(hint).toContain("get_td_node_parameters");
  });
});

describe("searchOperatorsImpl menu catalog awareness (C12)", () => {
  interface MetaData {
    data_version?: { source: string; tdMajor?: number };
    stale_hint?: string;
  }
  const meta = (result: CallToolResult): MetaData =>
    (result as { structuredContent?: MetaData }).structuredContent as MetaData;

  it("stamps results with the offline data_version", async () => {
    const result = await searchOperatorsImpl(makeCtx(), { query: "blur", limit: 5, semantic: false });
    expect(meta(result).data_version?.source).toBe("bottobot");
  });

  it("adds a stale_hint when a live TD reports a different major", async () => {
    const ctx = {
      knowledge: new KnowledgeBase(),
      logger: silentLogger,
      client: { getInfo: async () => ({ td_version: "2099.99999" }) },
    } as unknown as ToolContext;
    const result = await searchOperatorsImpl(ctx, {
      query: "blur",
      limit: 5,
      semantic: false,
      parameter_search: true,
    });
    expect(meta(result).stale_hint).toContain("2099");
  });

  it("omits the stale check (no network) when parameter_search is off", async () => {
    let called = false;
    const ctx = {
      knowledge: new KnowledgeBase(),
      logger: silentLogger,
      client: {
        getInfo: async () => {
          called = true;
          return { td_version: "2099.0" };
        },
      },
    } as unknown as ToolContext;
    await searchOperatorsImpl(ctx, { query: "blur", limit: 5, semantic: false });
    expect(called).toBe(false);
  });
});

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

  it("filters keyword results by category and subcategory and reports facets", async () => {
    const result = await searchOperatorsImpl(makeCtx(), {
      query: "noise",
      limit: 20,
      semantic: false,
      category: "TOP",
      subcategory: "Generators",
    });
    const data = sc(result);

    expect(data.filters).toMatchObject({
      category: "TOP",
      subcategory: "Generators",
    });
    expect(data.total).toBe(data.operators.length);
    expect(data.operators.length).toBeGreaterThan(0);
    expect(data.operators.every((o) => o.category === "TOP")).toBe(true);
    expect(data.operators.every((o) => o.subcategory === "Generators")).toBe(true);
    expect(data.facets?.categories.TOP).toBe(data.total);
  });

  it("supports tag searches across operator tags and keywords", async () => {
    const exactResult = await searchOperatorsImpl(makeCtx(), {
      query: "alligator",
      limit: 10,
      semantic: false,
      type: "exact",
    });
    expect(sc(exactResult).count).toBe(0);

    const tagResult = await searchOperatorsImpl(makeCtx(), {
      query: "alligator",
      limit: 10,
      semantic: false,
      type: "tag",
    });

    const data = sc(tagResult);
    expect(data.filters?.type).toBe("tag");
    expect(data.operators.some((o) => o.name === "Noise TOP")).toBe(true);
  });

  it("does not semantic re-rank exact or tag searches", async () => {
    const result = await searchOperatorsImpl(makeCtx(), {
      query: "alligator",
      limit: 10,
      semantic: true,
      type: "tag",
    });

    expect(sc(result).mode).toBe("tag");
  });

  it("searches operator parameter metadata when parameter_search is enabled", async () => {
    const result = await searchOperatorsImpl(makeCtx(), {
      query: "harmonic gain",
      limit: 10,
      semantic: false,
      category: "TOP",
      parameter_search: true,
    });
    const data = sc(result);
    const noise = data.operators.find((o) => o.name === "Noise TOP");

    expect(data.filters).toMatchObject({
      category: "TOP",
      parameter_search: true,
    });
    expect(noise?.matchedParameters?.some((p) => p.name === "Harmonic Gain")).toBe(true);
  });

  it("uses compatibility records to filter out operators added after the target version", async () => {
    const beforeAdded = await searchOperatorsImpl(makeCtx(), {
      query: "body track",
      limit: 10,
      semantic: false,
      version: "2021",
    });
    expect(sc(beforeAdded).operators.some((o) => o.name === "Body Track CHOP")).toBe(false);

    const afterAdded = await searchOperatorsImpl(makeCtx(), {
      query: "body track",
      limit: 10,
      semantic: false,
      version: "2023",
    });
    expect(sc(afterAdded).operators.some((o) => o.name === "Body Track CHOP")).toBe(true);
  });

  it("rejects unknown operator categories", async () => {
    const result = await searchOperatorsImpl(makeCtx(), {
      query: "noise",
      limit: 10,
      semantic: false,
      category: "BOGUS",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("unknown category");
  });

  it("returns a tool error instead of throwing for invalid input", async () => {
    const result = await searchOperatorsImpl(makeCtx(), {
      query: "",
      limit: 5,
      semantic: false,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid search_operators input");
  });

  it("rejects unknown TouchDesigner version filters", async () => {
    const result = await searchOperatorsImpl(makeCtx(), {
      query: "noise",
      limit: 10,
      semantic: false,
      version: "TD 2018",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid TouchDesigner version");
  });
});
