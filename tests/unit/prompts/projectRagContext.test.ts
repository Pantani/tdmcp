import { describe, expect, it, vi } from "vitest";
import type { ProjectSearchResult } from "../../../src/projectRag/types.js";
import { projectRagContextImpl } from "../../../src/prompts/projectRagContext.js";
import type { PromptContext } from "../../../src/prompts/types.js";

function makeResult(
  id: string,
  title: string,
  overrides: Partial<ProjectSearchResult> = {},
): ProjectSearchResult {
  return {
    id,
    score: 0.9,
    cosineScore: 0.95,
    title,
    type: "project",
    license: "MIT",
    licenseConfidence: "spdx-detected",
    sourceUrl: `https://example.com/${id}`,
    sourceName: "github:example/repo",
    tags: ["touchdesigner"],
    rightsNotes: "permissive; attribution recommended",
    ...overrides,
  };
}

function makeCtx(projectRag?: {
  search: (
    q: string,
    k: number,
    filters?: { license?: string[] },
  ) => Promise<ProjectSearchResult[]>;
}): PromptContext {
  return {
    knowledge: {} as PromptContext["knowledge"],
    recipes: {} as PromptContext["recipes"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as PromptContext["logger"],
    // Injected through cast — integrator extends PromptContext to include it.
    ...(projectRag ? { projectRag } : {}),
  } as unknown as PromptContext;
}

describe("projectRagContextImpl", () => {
  it("disabled branch — no projectRag on ctx", async () => {
    const ctx = makeCtx(undefined);
    const result = await projectRagContextImpl(ctx, { query: "audio-reactive tunnel" });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("Project RAG is not enabled");
    expect(text).toContain("TDMCP_PROJECT_RAG_ENABLED=1");
    expect(text).toContain("audio-reactive tunnel");
  });

  it("happy path — 2 cards with titles, licenses, and resource URIs", async () => {
    const search = vi
      .fn()
      .mockResolvedValue([
        makeResult("id1", "Audio Reactive Tunnel", { license: "CC0" }),
        makeResult("id2", "Hand Tracking Feedback", { license: "Apache-2.0" }),
      ]);
    const ctx = makeCtx({ search });

    const result = await projectRagContextImpl(ctx, { query: "reactive tunnel" });
    const text = result.messages[0]?.content.text ?? "";

    expect(search).toHaveBeenCalledWith("reactive tunnel", 5, undefined);
    expect(text).toContain("## Project cards");
    expect(text).toContain("Audio Reactive Tunnel");
    expect(text).toContain("[CC0]");
    expect(text).toContain("Hand Tracking Feedback");
    expect(text).toContain("[Apache-2.0]");
    expect(text).toContain("tdmcp://project/cards/id1");
    expect(text).toContain("tdmcp://project/cards/id2");
    expect(text).toContain("reactive tunnel");
  });

  it("passes license CSV filter through to search", async () => {
    const search = vi.fn().mockResolvedValue([makeResult("id1", "Card A")]);
    const ctx = makeCtx({ search });

    await projectRagContextImpl(ctx, {
      query: "fog",
      license: "CC0, MIT ,Apache-2.0",
    });
    expect(search).toHaveBeenCalledWith("fog", 5, { license: ["CC0", "MIT", "Apache-2.0"] });
  });

  it("clamps k to [1,10] and defaults to 5 on garbage", async () => {
    const search = vi.fn().mockResolvedValue([makeResult("id1", "Card A")]);
    const ctx = makeCtx({ search });

    await projectRagContextImpl(ctx, { query: "fog", k: "42" });
    expect(search).toHaveBeenLastCalledWith("fog", 10, undefined);

    await projectRagContextImpl(ctx, { query: "fog", k: "0" });
    expect(search).toHaveBeenLastCalledWith("fog", 1, undefined);

    await projectRagContextImpl(ctx, { query: "fog", k: "abc" });
    expect(search).toHaveBeenLastCalledWith("fog", 5, undefined);
  });

  it("empty results — fallback mentions project-rag sync and the query", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({ search });

    const result = await projectRagContextImpl(ctx, { query: "void terrain" });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("tdmcp project-rag sync");
    expect(text).toContain("void terrain");
    expect(text).not.toContain("## Project cards");
  });

  it("search failure — does not throw, returns graceful fallback referencing query", async () => {
    const search = vi.fn().mockRejectedValue(new Error("embedding model offline"));
    const ctx = makeCtx({ search });

    const result = await projectRagContextImpl(ctx, { query: "lava fields" });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("failed");
    expect(text).toContain("lava fields");
    expect(text).not.toContain("## Project cards");
  });
});
