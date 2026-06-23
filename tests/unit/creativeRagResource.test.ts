import { describe, expect, it, vi } from "vitest";
import type { CreativeRagCard, SearchResult } from "../../src/creativeRag/index.js";
import { registerCreativeRagResource } from "../../src/resources/creativeRagResource.js";
import type { ResourceContext } from "../../src/resources/shared.js";

function fakeServer() {
  return {
    registerResource: vi.fn(),
  };
}

function emptyCtx(): ResourceContext {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub for the resource registrar.
    knowledge: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub for the resource registrar.
    recipes: {} as any,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

function parsePayload(result: { contents: Array<{ text?: string }> }) {
  return JSON.parse(result.contents[0]?.text ?? "{}") as unknown;
}

describe("creativeRag resources", () => {
  it("does not register when ctx.creativeRag is undefined", () => {
    const server = fakeServer();

    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stub.
    registerCreativeRagResource(server as any, emptyCtx());

    expect(server.registerResource).not.toHaveBeenCalled();
  });

  it("registers card and search callbacks against a read-only Creative RAG service", async () => {
    const getCard = vi.fn(
      async (id: string): Promise<CreativeRagCard | undefined> =>
        id === "card_1"
          ? {
              schemaVersion: 1,
              id,
              type: "project",
              title: "Reference",
              sourceUrl: "https://example.invalid/reference",
              sourceName: "Example",
              license: "CC-BY",
              rightsNotes: "credit required",
              tools: ["glslTOP"],
              tags: ["mirror", "light"],
              tdmcpAffordances: ["create_kaleidoscope"],
              contentHash: "hash",
            }
          : undefined,
    );
    const search = vi.fn(
      async (): Promise<SearchResult[]> => [
        {
          id: "card_1",
          score: 0.9,
          title: "Reference",
          type: "project",
          sourceUrl: "https://example.invalid/reference",
          sourceName: "Example",
          license: "CC-BY",
          rightsNotes: "credit required",
          tags: ["mirror", "light"],
        },
      ],
    );
    const server = fakeServer();
    const ctx: ResourceContext = {
      ...emptyCtx(),
      creativeRag: {
        sync: async () => ({
          added: 0,
          updated: 0,
          tombstoned: 0,
          skippedNoLicense: 0,
          binariesStored: 0,
          perSource: {},
        }),
        index: async () => ({ embedded: 0, cachedSkipped: 0, total: 0 }),
        search,
        getCard,
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stub.
    registerCreativeRagResource(server as any, ctx);

    expect(server.registerResource).toHaveBeenCalledTimes(2);
    const calls = server.registerResource.mock.calls;
    expect(calls.map((call) => call[0])).toEqual(["creative-card", "creative-search"]);

    const cardCallback = calls[0]?.[3];
    const searchCallback = calls[1]?.[3];
    const cardPayload = parsePayload(
      await cardCallback(new URL("tdmcp://creative/cards/card_1"), { id: "card_1" }),
    ) as { id?: string; sourceUrl?: string; rightsNotes?: string };
    expect(cardPayload).toMatchObject({
      id: "card_1",
      sourceUrl: "https://example.invalid/reference",
      rightsNotes: "credit required",
    });

    const missingPayload = parsePayload(
      await cardCallback(new URL("tdmcp://creative/cards/missing"), { id: ["missing"] }),
    ) as { error?: string };
    expect(missingPayload.error).toContain("missing");

    const emptySearch = parsePayload(
      await searchCallback(new URL("tdmcp://creative/search?q=%20")),
    ) as { error?: string; results?: unknown[] };
    expect(emptySearch).toMatchObject({ results: [] });
    expect(emptySearch.error).toContain("q");

    const searchPayload = parsePayload(
      await searchCallback(
        new URL(
          "tdmcp://creative/search?q=visual%20mood&k=500&license=CC-BY,NOPE&type=project,invalid&tags=mirror,%20light",
        ),
      ),
    ) as { query?: string; count?: number; results?: unknown[] };
    expect(searchPayload).toMatchObject({ query: "visual mood", count: 1 });
    expect(search).toHaveBeenCalledWith("visual mood", 50, {
      license: ["CC-BY"],
      type: ["project"],
      tags: ["mirror", "light"],
    });
  });
});
