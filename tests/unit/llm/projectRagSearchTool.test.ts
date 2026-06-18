import { describe, expect, it, vi } from "vitest";
import { createProjectRagSearchTool } from "../../../src/llm/projectRagSearchTool.js";
import type { ProjectRagService, ProjectSearchResult } from "../../../src/projectRag/types.js";
import type { ToolContext } from "../../../src/tools/types.js";

function baseCtx(): ToolContext {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub for LlmTool tests.
    client: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub for LlmTool tests.
    knowledge: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub for LlmTool tests.
    recipes: {} as any,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    allowRawPython: false,
  };
}

function fakeResult(over: Partial<ProjectSearchResult>): ProjectSearchResult {
  return {
    id: "abc",
    score: 0.5,
    cosineScore: 0.5,
    title: "Untitled",
    type: "project",
    license: "MIT",
    licenseConfidence: "declared",
    sourceUrl: "https://example.com",
    sourceName: "example",
    tags: [],
    ...over,
  };
}

describe("projectRagSearch LlmTool", () => {
  it("factory shape: name, description, mutates=false", () => {
    const tool = createProjectRagSearchTool();
    expect(tool.name).toBe("project_rag_search");
    expect(tool.mutates).toBe(false);
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("returns isError when ctx.projectRag is undefined (runtime safety net)", async () => {
    const tool = createProjectRagSearchTool();
    const result = await tool.run(baseCtx(), { query: "feedback" });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("not enabled");
  });

  it("renders results with title + URI and exposes structuredContent.count", async () => {
    const search = vi
      .fn<ProjectRagService["search"]>()
      .mockResolvedValue([
        fakeResult({ id: "id1", title: "Audio Reactive Tunnel", score: 0.91, license: "CC0" }),
        fakeResult({ id: "id2", title: "Feedback Loop Demo", score: 0.72, type: "snippet" }),
      ]);
    const ctx: ToolContext = {
      ...baseCtx(),
      projectRag: { search } as unknown as ProjectRagService,
    };
    const tool = createProjectRagSearchTool();
    const result = await tool.run(ctx, { query: "tunnel" });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Audio Reactive Tunnel");
    expect(text).toContain("Feedback Loop Demo");
    expect(text).toContain("tdmcp://project/cards/id1");
    expect(text).toContain("tdmcp://project/cards/id2");
    expect(text).toContain("0.910");
    const structured = result.structuredContent as { query: string; count: number };
    expect(structured.query).toBe("tunnel");
    expect(structured.count).toBe(2);
  });

  it("renders empty-state text when search returns no results", async () => {
    const search = vi.fn<ProjectRagService["search"]>().mockResolvedValue([]);
    const ctx: ToolContext = {
      ...baseCtx(),
      projectRag: { search } as unknown as ProjectRagService,
    };
    const tool = createProjectRagSearchTool();
    const result = await tool.run(ctx, { query: "nothing-matches" });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('No Project RAG cards matched "nothing-matches"');
    const structured = result.structuredContent as { count: number };
    expect(structured.count).toBe(0);
  });

  it("forwards license filter and k to the service.search call", async () => {
    const search = vi.fn<ProjectRagService["search"]>().mockResolvedValue([]);
    const ctx: ToolContext = {
      ...baseCtx(),
      projectRag: { search } as unknown as ProjectRagService,
    };
    const tool = createProjectRagSearchTool();
    await tool.run(ctx, { query: "trails", k: 3, license: ["CC0"] });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("trails", 3, { license: ["CC0"] });
  });

  it("omits the filters arg entirely when no filter fields are passed", async () => {
    const search = vi.fn<ProjectRagService["search"]>().mockResolvedValue([]);
    const ctx: ToolContext = {
      ...baseCtx(),
      projectRag: { search } as unknown as ProjectRagService,
    };
    const tool = createProjectRagSearchTool();
    await tool.run(ctx, { query: "anything" });
    expect(search).toHaveBeenCalledWith("anything", 5, undefined);
  });
});
