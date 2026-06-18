import { describe, expect, it, vi } from "vitest";
import type { CreativeRagService } from "../../../src/creativeRag/index.js";
import { buildCreativeContextMessage, clampK } from "../../../src/llm/creativeContext.js";

function makeResult(id: string, title: string) {
  return {
    id,
    score: 0.9,
    title,
    type: "artwork" as const,
    license: "CC0" as const,
    sourceUrl: `https://example.com/${id}`,
    sourceName: "smithsonian",
    tags: [],
  };
}

function makeService(results: ReturnType<typeof makeResult>[]): CreativeRagService {
  return {
    search: vi.fn().mockResolvedValue(results),
    sync: vi.fn(),
    index: vi.fn(),
    getCard: vi.fn(),
  } as unknown as CreativeRagService;
}

describe("clampK", () => {
  it("returns 3 for undefined", () => {
    expect(clampK(undefined)).toBe(3);
  });

  it("clamps values > 5 to 5", () => {
    expect(clampK(10)).toBe(5);
    expect(clampK("10")).toBe(5);
  });

  it("returns 3 for 0", () => {
    expect(clampK(0)).toBe(3);
  });

  it("returns 3 for NaN string", () => {
    expect(clampK("abc")).toBe(3);
  });

  it("passes through valid values", () => {
    expect(clampK(3)).toBe(3);
    expect(clampK(5)).toBe(5);
    expect(clampK(1)).toBe(1);
  });
});

describe("buildCreativeContextMessage", () => {
  it("returns a system message with 3 card uris and creative-cards fence", async () => {
    const service = makeService([
      makeResult("id1", "Hokusai — Great Wave"),
      makeResult("id2", "Mondrian — Composition"),
      makeResult("id3", "Kandinsky — Composition VII"),
    ]);

    const msg = await buildCreativeContextMessage(service, "abstract expressionism", { k: 3 });

    expect(msg).toBeDefined();
    // role MUST be "user" — `runAgentTurn.ensureSystem` strips every incoming
    // `role: "system"` before injecting its own; a system-role context block
    // would never reach the LLM. See src/llm/creativeContext.ts.
    expect(msg?.role).toBe("user");
    expect(msg?.content).toContain("```creative-cards");
    expect(msg?.content).toContain("tdmcp://creative/cards/id1");
    expect(msg?.content).toContain("tdmcp://creative/cards/id2");
    expect(msg?.content).toContain("tdmcp://creative/cards/id3");
    // check summary lines are within limit
    const lines = (msg?.content as string).split("\n").filter((l) => l.startsWith("- ["));
    for (const line of lines) {
      const bracketContent = line.match(/^- \[(.+?)\]/)?.[1] ?? "";
      expect(bracketContent.length).toBeLessThanOrEqual(160);
    }
  });

  it("clamps k=10 to 5 when calling search", async () => {
    const service = makeService([makeResult("x", "title")]);
    await buildCreativeContextMessage(service, "query", { k: 10 });
    expect(service.search).toHaveBeenCalledWith("query", 5);
  });

  it("falls back k=0 to 3 when calling search", async () => {
    const service = makeService([makeResult("x", "title")]);
    await buildCreativeContextMessage(service, "query", { k: 0 });
    expect(service.search).toHaveBeenCalledWith("query", 3);
  });

  it("returns undefined for empty results", async () => {
    const service = makeService([]);
    const msg = await buildCreativeContextMessage(service, "query");
    expect(msg).toBeUndefined();
  });

  it("returns undefined and calls logger.warn when search rejects", async () => {
    const service = {
      search: vi.fn().mockRejectedValue(new Error("index missing")),
    } as unknown as CreativeRagService;
    const warnSpy = vi.fn();
    const msg = await buildCreativeContextMessage(service, "query", {
      logger: { warn: warnSpy },
    });
    expect(msg).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("index missing");
  });

  it("returns undefined on timeout", async () => {
    vi.useFakeTimers();
    const service = {
      search: vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve([makeResult("x", "t")]), 5_000)),
        ),
    } as unknown as CreativeRagService;
    const warnSpy = vi.fn();

    const promise = buildCreativeContextMessage(service, "query", {
      timeoutMs: 100,
      logger: { warn: warnSpy },
    });
    vi.advanceTimersByTime(200);
    const msg = await promise;
    expect(msg).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("truncates long titles to 160 chars", async () => {
    const longTitle = "A".repeat(200);
    const service = makeService([makeResult("abc", longTitle)]);
    const msg = await buildCreativeContextMessage(service, "query");
    expect(msg).toBeDefined();
    const line = (msg?.content as string).split("\n").find((l) => l.startsWith("- ["));
    const bracketContent = line?.match(/^- \[(.+?)\]/)?.[1] ?? "";
    expect(bracketContent.length).toBeLessThanOrEqual(160);
  });
});
