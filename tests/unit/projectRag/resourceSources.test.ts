import { describe, expect, it, vi } from "vitest";
import type { ProjectRagService, ProjectSourceStatus } from "../../../src/projectRag/index.js";
import { registerProjectRagSourcesResource } from "../../../src/resources/projectRagSourcesResource.js";
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

function makeService(sources: ProjectSourceStatus[]): ProjectRagService {
  return {
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
    listSources: async () => sources,
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
  };
}

describe("projectRag sources resource", () => {
  it("does NOT register when ctx.projectRag is undefined", () => {
    const server = fakeServer();
    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stub.
    registerProjectRagSourcesResource(server as any, emptyCtx());
    expect(server.registerResource).not.toHaveBeenCalled();
  });

  it("registers tdmcp://project/sources and returns the listSources envelope", async () => {
    const server = fakeServer();
    const sources: ProjectSourceStatus[] = [
      { name: "derivative", displayName: "Derivative", status: "ready" },
      {
        name: "matthewragan",
        displayName: "Matthew Ragan",
        status: "planned",
        reason: "not configured yet",
      },
    ];
    const ctx: ResourceContext = { ...emptyCtx(), projectRag: makeService(sources) };
    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stub.
    registerProjectRagSourcesResource(server as any, ctx);

    expect(server.registerResource).toHaveBeenCalledTimes(1);
    const call = server.registerResource.mock.calls[0];
    if (call === undefined) throw new Error("registerResource was not called");
    expect(call[0]).toBe("project-sources");
    expect(call[1]).toBe("tdmcp://project/sources");
    expect(call[2]).toMatchObject({ mimeType: "application/json" });

    const handler = call[3] as (uri: URL) => Promise<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>;
    const result = await handler(new URL("tdmcp://project/sources"));
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.mimeType).toBe("application/json");
    const payload = JSON.parse(result.contents[0]?.text ?? "{}") as {
      sources: ProjectSourceStatus[];
    };
    expect(payload).toEqual({ sources });
  });

  it("returns an empty sources array when listSources is empty", async () => {
    const server = fakeServer();
    const ctx: ResourceContext = { ...emptyCtx(), projectRag: makeService([]) };
    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stub.
    registerProjectRagSourcesResource(server as any, ctx);

    const handler = server.registerResource.mock.calls[0]?.[3] as (uri: URL) => Promise<{
      contents: Array<{ text: string }>;
    }>;
    const result = await handler(new URL("tdmcp://project/sources"));
    const payload = JSON.parse(result.contents[0]?.text ?? "{}") as {
      sources: ProjectSourceStatus[];
    };
    expect(payload).toEqual({ sources: [] });
  });
});
