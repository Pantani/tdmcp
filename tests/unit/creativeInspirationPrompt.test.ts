import { describe, expect, it, vi } from "vitest";
import type { CreativeRagCard, SearchResult } from "../../src/creativeRag/types.js";
import { creativeInspirationImpl } from "../../src/prompts/creativeInspiration.js";
import type { PromptContext } from "../../src/prompts/types.js";

function makeCard(id: string, title: string, tagline: string): CreativeRagCard {
  return {
    schemaVersion: 1,
    id,
    type: "artwork",
    title,
    sourceUrl: `https://example.com/${id}`,
    sourceName: "test",
    license: "CC0",
    tools: [],
    tags: [],
    tdmcpAffordances: [],
    contentHash: "abc",
    visualLanguage: tagline,
  };
}

function makeResult(id: string, title: string): SearchResult {
  return {
    id,
    score: 0.9,
    title,
    type: "artwork",
    license: "CC0",
    sourceUrl: "",
    sourceName: "",
    tags: [],
  };
}

function makeCtx(creativeRag?: {
  search: (q: string, k: number) => Promise<SearchResult[]>;
  getCard: (id: string) => Promise<CreativeRagCard | undefined>;
}): PromptContext & { creativeRag?: typeof creativeRag } {
  return {
    knowledge: {} as PromptContext["knowledge"],
    recipes: {} as PromptContext["recipes"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as PromptContext["logger"],
    creativeRag: creativeRag as unknown as PromptContext["creativeRag"],
  };
}

describe("creativeInspirationImpl", () => {
  it("disabled branch — no creativeRag on ctx", async () => {
    const ctx = makeCtx(undefined);
    const result = await creativeInspirationImpl(ctx, { theme: "neon city" });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("TDMCP_RAG_ENABLED");
    expect(text).toContain("tdmcp creative-rag sync");
    expect(text).toContain("neon city");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
  });

  it("happy path — 3 cards, default k=5", async () => {
    const search = vi
      .fn()
      .mockResolvedValue([
        makeResult("id1", "Card A"),
        makeResult("id2", "Card B"),
        makeResult("id3", "Card C"),
      ]);
    const getCard = vi.fn().mockImplementation((id: string) => {
      const map: Record<string, CreativeRagCard> = {
        id1: makeCard("id1", "Card A", "Glowing neon grids"),
        id2: makeCard("id2", "Card B", "Deep underwater haze"),
        id3: makeCard("id3", "Card C", "Slow pulse waves"),
      };
      return Promise.resolve(map[id]);
    });
    const ctx = makeCtx({ search, getCard });

    const result = await creativeInspirationImpl(ctx, { theme: "neon city" });
    const text = result.messages[0]?.content.text ?? "";

    expect(search).toHaveBeenCalledWith("neon city", 5);
    expect(text).toContain("## Mood board");
    expect(text).toContain("Card A");
    expect(text).toContain("Card B");
    expect(text).toContain("Card C");
    expect(text).toContain("tdmcp://creative/cards/id1");
    expect(text).toContain("tdmcp://creative/cards/id2");
    expect(text).toContain("tdmcp://creative/cards/id3");
    expect(text).toContain("neon city");
  });

  it("k clamping — k=42 → search called with 10", async () => {
    const search = vi.fn().mockResolvedValue([makeResult("id1", "Card A")]);
    const getCard = vi.fn().mockResolvedValue(makeCard("id1", "Card A", "test"));
    const ctx = makeCtx({ search, getCard });

    await creativeInspirationImpl(ctx, { theme: "fog", k: "42" });
    expect(search).toHaveBeenCalledWith("fog", 10);
  });

  it("k clamping — k=0 → search called with 1", async () => {
    const search = vi.fn().mockResolvedValue([makeResult("id1", "Card A")]);
    const getCard = vi.fn().mockResolvedValue(makeCard("id1", "Card A", "test"));
    const ctx = makeCtx({ search, getCard });

    await creativeInspirationImpl(ctx, { theme: "fog", k: "0" });
    expect(search).toHaveBeenCalledWith("fog", 1);
  });

  it("k clamping — k=abc → search called with 5", async () => {
    const search = vi.fn().mockResolvedValue([makeResult("id1", "Card A")]);
    const getCard = vi.fn().mockResolvedValue(makeCard("id1", "Card A", "test"));
    const ctx = makeCtx({ search, getCard });

    await creativeInspirationImpl(ctx, { theme: "fog", k: "abc" });
    expect(search).toHaveBeenCalledWith("fog", 5);
  });

  it("tools_hint injection — names appear in text", async () => {
    const search = vi.fn().mockResolvedValue([makeResult("id1", "Card A")]);
    const getCard = vi.fn().mockResolvedValue(makeCard("id1", "Card A", "pulsing grids"));
    const ctx = makeCtx({ search, getCard });

    const result = await creativeInspirationImpl(ctx, {
      theme: "industrial",
      tools_hint: "create_audio_reactive, create_feedback_network",
    });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("create_audio_reactive");
    expect(text).toContain("create_feedback_network");
  });

  it("empty results — suggests tdmcp creative-rag sync, references theme", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const getCard = vi.fn();
    const ctx = makeCtx({ search, getCard });

    const result = await creativeInspirationImpl(ctx, { theme: "void space" });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("tdmcp creative-rag sync");
    expect(text).toContain("void space");
    expect(getCard).not.toHaveBeenCalled();
  });

  it("search failure — does not throw, returns graceful fallback", async () => {
    const search = vi.fn().mockRejectedValue(new Error("embedding model offline"));
    const getCard = vi.fn();
    const ctx = makeCtx({ search, getCard });

    const result = await creativeInspirationImpl(ctx, { theme: "lava fields" });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("lava fields");
    expect(text).not.toContain("## Mood board");
  });

  it("all card lookups miss — falls back to empty-search message, no empty mood board", async () => {
    const search = vi
      .fn()
      .mockResolvedValue([makeResult("id1", "Card A"), makeResult("id2", "Card B")]);
    const getCard = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ search, getCard });

    const result = await creativeInspirationImpl(ctx, { theme: "ghost town" });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).not.toContain("## Mood board");
    expect(text).toContain("tdmcp creative-rag sync");
    expect(text).toContain("ghost town");
  });

  it("card lookup miss — skips missing card, lists found ones", async () => {
    const search = vi
      .fn()
      .mockResolvedValue([
        makeResult("id1", "Card A"),
        makeResult("id2", "Card B"),
        makeResult("id3", "Card C"),
      ]);
    const getCard = vi.fn().mockImplementation((id: string) => {
      if (id === "id2") return Promise.resolve(undefined);
      return Promise.resolve(makeCard(id, id === "id1" ? "Card A" : "Card C", "some vibe"));
    });
    const ctx = makeCtx({ search, getCard });

    const result = await creativeInspirationImpl(ctx, { theme: "desert storm" });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("tdmcp://creative/cards/id1");
    expect(text).not.toContain("tdmcp://creative/cards/id2");
    expect(text).toContain("tdmcp://creative/cards/id3");
  });
});
