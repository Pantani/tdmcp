import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { CreativeRagCard, CreativeRagService } from "../../src/creativeRag/types.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// Mock the Layer 1 Impl that the dispatch table delegates to. We can't use
// vi.mock with a factory referencing top-level vars (hoisting), so we use
// vi.hoisted to share the spy reference.
const { feedbackImplSpy } = vi.hoisted(() => ({
  feedbackImplSpy: vi.fn(),
}));

vi.mock("../../src/tools/layer1/createFeedbackNetwork.js", () => ({
  createFeedbackNetworkImpl: feedbackImplSpy,
}));

// Import the SUT after the mocks so it picks them up.
const { applyCreativeCardImpl, APPLY_CREATIVE_CARD_DISPATCH, APPLY_CREATIVE_CARD_WHITELIST } =
  await import("../../src/tools/layer2/applyCreativeCard.js");

function makeCard(overrides: Partial<CreativeRagCard> = {}): CreativeRagCard {
  return {
    schemaVersion: 1,
    id: "abc123",
    type: "artwork",
    title: "Test card",
    sourceUrl: "https://example.com/x",
    sourceName: "Test",
    license: "CC0",
    tools: [],
    tags: [],
    tdmcpAffordances: ["create_feedback_network"],
    contentHash: "hash",
    ...overrides,
  };
}

function makeRag(card: CreativeRagCard | undefined): CreativeRagService {
  return {
    sync: vi.fn(),
    index: vi.fn(),
    search: vi.fn(),
    getCard: vi.fn().mockResolvedValue(card),
  } as unknown as CreativeRagService;
}

function makeCtx(opts: { card?: CreativeRagCard; noRag?: boolean } = {}): ToolContext {
  const ctx: ToolContext = {
    client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 100 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
  if (!opts.noRag) {
    ctx.creativeRag = makeRag(opts.card);
  }
  return ctx;
}

function textOf(r: CallToolResult): string {
  return r.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("applyCreativeCardImpl", () => {
  it("dry_run returns plan and does NOT call target", async () => {
    feedbackImplSpy.mockReset();
    const ctx = makeCtx({ card: makeCard() });
    const r = await applyCreativeCardImpl(ctx, {
      card_id: "abc123",
      affordance_index: 0,
      dry_run: true,
    });
    expect(r.isError).toBeFalsy();
    expect(feedbackImplSpy).not.toHaveBeenCalled();
    expect(r.structuredContent).toMatchObject({
      tool: "create_feedback_network",
      executed: false,
      args: {},
    });
  });

  it("executes whitelisted affordance with overrides merged", async () => {
    feedbackImplSpy.mockReset();
    feedbackImplSpy.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });
    const ctx = makeCtx({ card: makeCard() });
    const r = await applyCreativeCardImpl(ctx, {
      card_id: "abc123",
      affordance_index: 0,
      overrides: { decay: 0.92 },
      dry_run: false,
    });
    expect(r.isError).toBeFalsy();
    expect(feedbackImplSpy).toHaveBeenCalledTimes(1);
    expect(feedbackImplSpy).toHaveBeenCalledWith(ctx, { decay: 0.92 });
    expect(r.structuredContent).toMatchObject({
      tool: "create_feedback_network",
      executed: true,
      args: { decay: 0.92 },
    });
  });

  it("regression — target isError:true propagates to the outer envelope", async () => {
    feedbackImplSpy.mockReset();
    feedbackImplSpy.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "target blew up" }],
    });
    const ctx = makeCtx({ card: makeCard() });
    const r = await applyCreativeCardImpl(ctx, {
      card_id: "abc123",
      affordance_index: 0,
      dry_run: false,
    });
    // The outer envelope MUST carry isError so MCP clients (which gate on
    // isError, not text content) don't read a target failure as success.
    expect(r.isError).toBe(true);
    expect(feedbackImplSpy).toHaveBeenCalledTimes(1);
    expect(r.structuredContent).toMatchObject({
      tool: "create_feedback_network",
      executed: true,
    });
  });

  it("rejects non-whitelisted affordance", async () => {
    feedbackImplSpy.mockReset();
    const ctx = makeCtx({
      card: makeCard({ tdmcpAffordances: ["executePythonScript"] }),
    });
    const r = await applyCreativeCardImpl(ctx, {
      card_id: "abc123",
      affordance_index: 0,
      dry_run: false,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not whitelisted");
    expect(feedbackImplSpy).not.toHaveBeenCalled();
  });

  it("returns errorResult when the card is not found", async () => {
    const ctx = makeCtx({ card: undefined });
    const r = await applyCreativeCardImpl(ctx, {
      card_id: "missing",
      affordance_index: 0,
      dry_run: false,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not found");
  });

  it("returns errorResult when affordance_index is out of range", async () => {
    const ctx = makeCtx({ card: makeCard() });
    const r = await applyCreativeCardImpl(ctx, {
      card_id: "abc123",
      affordance_index: 5,
      dry_run: false,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("available");
  });

  it("returns errorResult when Creative RAG is disabled", async () => {
    const ctx = makeCtx({ noRag: true });
    const r = await applyCreativeCardImpl(ctx, {
      card_id: "abc123",
      affordance_index: 0,
      dry_run: false,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("disabled");
  });

  it("whitelist integrity: every whitelisted name resolves to a function", () => {
    expect(APPLY_CREATIVE_CARD_WHITELIST.size).toBeGreaterThan(0);
    for (const name of APPLY_CREATIVE_CARD_WHITELIST) {
      expect(typeof APPLY_CREATIVE_CARD_DISPATCH[name]).toBe("function");
    }
    // And conversely no extra dispatch entries snuck in without whitelisting.
    for (const name of Object.keys(APPLY_CREATIVE_CARD_DISPATCH)) {
      expect(APPLY_CREATIVE_CARD_WHITELIST.has(name)).toBe(true);
    }
  });
});
