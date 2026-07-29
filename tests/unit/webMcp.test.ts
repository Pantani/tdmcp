import { describe, expect, it, vi } from "vitest";
import {
  createTdmcpWebMcpTools,
  registerTdmcpWebMcp,
  resolveTdmcpWebMcpContext,
  searchTdmcpDocs,
  TDMCP_WEB_MCP_TOOL_NAMES,
  type WebMcpContext,
  type WebMcpTool,
} from "../../src/docs/webMcp.js";

describe("tdmcp docs WebMCP", () => {
  it("searches a bounded static catalog and returns canonical project URLs", () => {
    expect(searchTdmcpDocs("OAuth remote auth")).toContainEqual(
      expect.objectContaining({
        id: "oauth-pkce",
        url: "https://pantani.github.io/tdmcp/guide/oauth-pkce",
      }),
    );
    expect(searchTdmcpDocs("zyxwvutsrq")).toEqual([]);
  });

  it("builds read-only search and lookup tools with strict schemas", async () => {
    const tools = createTdmcpWebMcpTools("https://docs.example");
    expect(tools.map((tool) => tool.name)).toEqual(TDMCP_WEB_MCP_TOOL_NAMES);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    const [searchTool, lookupTool] = tools;
    if (!searchTool || !lookupTool) throw new Error("Expected both tdmcp WebMCP tools.");

    const search = JSON.parse(await searchTool.execute({ query: "bridge health" })) as {
      results: Array<{ id: string; url: string }>;
    };
    expect(search.results[0]).toMatchObject({
      id: "bridge-api",
      url: "https://docs.example/tdmcp/reference/bridge-api",
    });

    const lookup = JSON.parse(await lookupTool.execute({ topic: "install" })) as {
      id: string;
      url: string;
    };
    expect(lookup).toMatchObject({
      id: "install",
      url: "https://docs.example/tdmcp/guide/install",
    });
    expect(() => lookupTool.execute({ topic: "missing" })).toThrow(
      /Unknown tdmcp documentation topic/u,
    );
    expect(() => searchTool.execute({ query: "" })).toThrow(/between 1 and 120/u);
    expect(() => searchTool.execute({ query: "bridge", extra: true })).toThrow(
      /Unexpected WebMCP input properties: extra/u,
    );
    expect(() => lookupTool.execute({ topic: "install", extra: true })).toThrow(
      /Unexpected WebMCP input properties: extra/u,
    );
  });

  it("prefers the current document API and falls back to the legacy navigator API", () => {
    const current = { registerTool: vi.fn() } as unknown as WebMcpContext;
    const legacy = { registerTool: vi.fn() } as unknown as WebMcpContext;
    expect(
      resolveTdmcpWebMcpContext({
        document: { modelContext: current },
        navigator: { modelContext: legacy },
      }),
    ).toBe(current);
    expect(resolveTdmcpWebMcpContext({ navigator: { modelContext: legacy } })).toBe(legacy);
    expect(resolveTdmcpWebMcpContext({})).toBeUndefined();
  });

  it("registers every tool with one abort signal and aborts partial registration failures", async () => {
    const registered: WebMcpTool[] = [];
    const signals: AbortSignal[] = [];
    const context: WebMcpContext = {
      async registerTool(tool, options) {
        registered.push(tool);
        if (options?.signal) signals.push(options.signal);
      },
    };
    const controller = await registerTdmcpWebMcp({
      context,
      origin: "https://docs.example",
    });
    expect(registered.map((tool) => tool.name)).toEqual(TDMCP_WEB_MCP_TOOL_NAMES);
    expect(new Set(signals)).toEqual(new Set([controller?.signal]));
    expect(controller?.signal.aborted).toBe(false);

    const failedController = new AbortController();
    const failingContext: WebMcpContext = {
      registerTool: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("duplicate tool")),
    };
    await expect(
      registerTdmcpWebMcp({
        context: failingContext,
        controller: failedController,
      }),
    ).rejects.toThrow("duplicate tool");
    expect(failedController.signal.aborted).toBe(true);
  });

  it("does nothing when the browser has no WebMCP implementation", async () => {
    await expect(registerTdmcpWebMcp({ runtime: {} })).resolves.toBeUndefined();
  });
});
