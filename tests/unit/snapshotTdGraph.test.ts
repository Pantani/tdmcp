import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  computeTypeDefaults,
  snapshotTdGraphImpl,
  toCompactNodes,
} from "../../src/tools/layer3/snapshotTdGraph.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

describe("computeTypeDefaults / toCompactNodes (pure)", () => {
  const nodes = [
    { path: "/p/a", type: "noiseTOP", name: "a", parameters: { period: 1, amp: 1 } },
    { path: "/p/b", type: "noiseTOP", name: "b", parameters: { period: 1, amp: 9 } },
    { path: "/p/c", type: "noiseTOP", name: "c", parameters: { period: 1, amp: 1 } },
    { path: "/p/d", type: "blurTOP", name: "d", parameters: { size: 4 } },
  ];

  it("hoists each type's most-common value per parameter", () => {
    const defaults = computeTypeDefaults(nodes);
    // period is always 1; amp is 1 in two of three noiseTOPs → mode is 1.
    expect(defaults.noiseTOP).toEqual({ period: 1, amp: 1 });
    expect(defaults.blurTOP).toEqual({ size: 4 });
  });

  it("delta-encodes nodes and drops parameters that match the type default", () => {
    const defaults = computeTypeDefaults(nodes);
    const compact = toCompactNodes(nodes, defaults);
    const a = compact.find((n) => n.name === "a");
    const b = compact.find((n) => n.name === "b");
    // a matches the default exactly → no parameters block at all.
    expect(a?.parameters).toBeUndefined();
    // b only differs in amp → just that delta is kept.
    expect(b?.parameters).toEqual({ amp: 9 });
  });

  it("keeps nodes without parameters intact", () => {
    const compact = toCompactNodes([{ path: "/p/x", type: "nullTOP", name: "x" }], {});
    expect(compact[0]).toEqual({ path: "/p/x", type: "nullTOP", name: "x" });
  });
});

describe("snapshotTdGraphImpl", () => {
  it("returns a plain snapshot by default (no typeDefaults)", async () => {
    const result = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: false,
    });
    expect(result.isError).toBeFalsy();
    const data = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(data?.compact).toBeUndefined();
    expect(data?.typeDefaults).toBeUndefined();
    expect(data?.nodeCount).toBe(1);
  });

  it("compact mode hoists type defaults and marks compact:true", async () => {
    const result = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: true,
    });
    expect(result.isError).toBeFalsy();
    const data = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(data?.compact).toBe(true);
    // The mock node is a noiseTOP with params {period, amplitude}; they hoist into typeDefaults
    // and the single node carries no delta.
    const typeDefaults = data?.typeDefaults as Record<string, Record<string, unknown>>;
    expect(Object.keys(typeDefaults)).toContain("noiseTOP");
    const nodes = data?.nodes as Array<{ name: string; parameters?: unknown }>;
    expect(nodes[0]?.parameters).toBeUndefined();
  });
});
