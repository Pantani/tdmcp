import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { searchPythonApiImpl } from "../../src/tools/layer3/searchPythonApi.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function makeCtx(): ToolContext {
  return {
    knowledge: new KnowledgeBase(),
    logger: silentLogger,
  } as unknown as ToolContext;
}

interface PythonApiSearchData {
  query: string;
  filters: {
    search_in: string;
    category?: string;
    version?: string;
    resolvedVersion?: string;
  };
  count: number;
  classes: Array<{ className: string; category?: string }>;
  methods: Array<{ className: string; name: string; signature?: string }>;
  members: Array<{ className: string; name: string; returnType?: string }>;
  tips: string[];
}

function sc(result: CallToolResult): PythonApiSearchData {
  return (result as { structuredContent?: PythonApiSearchData })
    .structuredContent as PythonApiSearchData;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("searchPythonApiImpl", () => {
  it("searches Python API classes by name", () => {
    const result = searchPythonApiImpl(makeCtx(), {
      query: "OP",
      search_in: "classes",
      limit: 10,
    });
    const data = sc(result);

    expect(data.filters.search_in).toBe("classes");
    expect(data.classes.some((entry) => entry.className === "OP")).toBe(true);
    expect(data.methods).toEqual([]);
    expect(data.members).toEqual([]);
  });

  it("searches Python API methods by name and signature", () => {
    const result = searchPythonApiImpl(makeCtx(), {
      query: "destroy",
      search_in: "methods",
      limit: 10,
    });
    const data = sc(result);

    expect(data.methods.some((entry) => entry.name === "destroy")).toBe(true);
    expect(data.classes).toEqual([]);
    expect(data.members).toEqual([]);
  });

  it("searches Python API members", () => {
    const result = searchPythonApiImpl(makeCtx(), {
      query: "valid",
      search_in: "members",
      limit: 10,
    });
    const data = sc(result);

    expect(data.members.some((entry) => entry.className === "OP" && entry.name === "valid")).toBe(
      true,
    );
  });

  it("filters Python API classes by category", () => {
    const result = searchPythonApiImpl(makeCtx(), {
      query: "TOP",
      search_in: "classes",
      category: "Operator",
      limit: 10,
    });
    const data = sc(result);

    expect(data.filters.category).toBe("Operator");
    expect(data.classes.length).toBeGreaterThan(0);
    expect(data.classes.every((entry) => entry.category === "Operator")).toBe(true);
  });

  it("filters compatibility-backed methods by TouchDesigner version", () => {
    const beforeAdded = searchPythonApiImpl(makeCtx(), {
      query: "addScript",
      search_in: "methods",
      version: "2019",
      limit: 10,
    });
    expect(sc(beforeAdded).methods.some((entry) => entry.name === "addScript")).toBe(false);

    const afterAdded = searchPythonApiImpl(makeCtx(), {
      query: "addScript",
      search_in: "methods",
      version: "2020",
      limit: 10,
    });
    expect(sc(afterAdded).methods.some((entry) => entry.name === "addScript")).toBe(true);
  });

  it("returns zero-result tips for unmatched queries", () => {
    const result = searchPythonApiImpl(makeCtx(), {
      query: "zxqwv_nomatch_9999",
      limit: 10,
    });
    const data = sc(result);

    expect(data.count).toBe(0);
    expect(data.tips.length).toBeGreaterThan(0);
    expect(textOf(result)).toContain("No Python API results");
  });

  it("rejects unknown TouchDesigner version filters", () => {
    const result = searchPythonApiImpl(makeCtx(), {
      query: "destroy",
      version: "TD 2018",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid TouchDesigner version");
  });
});
