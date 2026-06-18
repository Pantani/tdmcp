import { describe, expect, it, vi } from "vitest";
import { registerProjectRagResource } from "../../../src/resources/projectRagResource.js";
import type { ResourceContext } from "../../../src/resources/shared.js";

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

describe("projectRag resource gating", () => {
  it("does NOT register when ctx.projectRag is undefined", () => {
    const server = fakeServer();
    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stub.
    registerProjectRagResource(server as any, emptyCtx());
    expect(server.registerResource).not.toHaveBeenCalled();
  });

  it("registers both card and search resources when ctx.projectRag is present", () => {
    const server = fakeServer();
    const ctx: ResourceContext = {
      ...emptyCtx(),
      projectRag: {
        sync: async () => ({
          added: 0,
          updated: 0,
          tombstoned: 0,
          skippedNoLicense: 0,
          binariesStored: 0,
          perSource: {},
        }),
        index: async () => ({ embedded: 0, cachedSkipped: 0, total: 0 }),
        rescore: async () => ({ rescored: 0, total: 0 }),
        search: async () => [],
        getCard: async () => undefined,
        listSources: async () => [],
        listDiscovery: async () => [],
        analyze: async () => ({
          status: "skipped",
          reason: "no bridge",
          bridgeUrl: "http://127.0.0.1:9981",
        }),
        probeBridge: async () => ({
          reachable: false,
          bridgeUrl: "http://127.0.0.1:9981",
          reason: "offline",
        }),
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stub.
    registerProjectRagResource(server as any, ctx);
    expect(server.registerResource).toHaveBeenCalledTimes(2);
    const names = server.registerResource.mock.calls.map((c) => c[0]);
    expect(names).toContain("project-card");
    expect(names).toContain("project-search");
  });
});
