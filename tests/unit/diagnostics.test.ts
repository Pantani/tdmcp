import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { compareTdNodesImpl } from "../../src/tools/layer3/compareTdNodes.js";
import { findTdNodesImpl } from "../../src/tools/layer3/findTdNodes.js";
import { snapshotTdGraphImpl } from "../../src/tools/layer3/snapshotTdGraph.js";
import { summarizeTdErrorsImpl } from "../../src/tools/layer3/summarizeTdErrors.js";
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

// biome-ignore lint/suspicious/noExplicitAny: tests reach into structuredContent freely.
const sc = (r: { structuredContent?: unknown }): any => r.structuredContent;

describe("find_td_nodes", () => {
  it("filters direct children by operator type", async () => {
    const r = await findTdNodesImpl(makeCtx(), {
      parent_path: "/project1",
      type: "null",
      recursive: false,
      path_only: false,
      limit: 50,
    });
    expect(r.isError).toBeFalsy();
    expect(sc(r).count).toBe(1);
    expect(sc(r).matches[0].path).toBe("/project1/null1");
  });

  it("returns only paths with path_only and respects glob patterns", async () => {
    const r = await findTdNodesImpl(makeCtx(), {
      parent_path: "/project1",
      pattern: "noise*",
      recursive: false,
      path_only: true,
      limit: 50,
    });
    expect(sc(r).paths).toEqual(["/project1/noise1"]);
    expect(sc(r).matches).toBeUndefined();
  });

  it("asks the bridge for a recursive topology and returns nested descendants", async () => {
    let sawRecursive = false;
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/topology`, ({ request }) => {
        sawRecursive = new URL(request.url).searchParams.get("recursive") === "true";
        return HttpResponse.json({
          ok: true,
          data: {
            nodes: [
              { path: "/project1/base1", type: "baseCOMP", name: "base1" },
              { path: "/project1/base1/noise1", type: "noiseTOP", name: "noise1" },
            ],
            connections: [],
          },
        });
      }),
    );
    const r = await findTdNodesImpl(makeCtx(), {
      parent_path: "/project1",
      pattern: "noise*",
      recursive: true,
      path_only: true,
      limit: 50,
    });
    // recursive=true must hit the topology endpoint with ?recursive=true (not the
    // depth-1 /api/nodes listing), and surface a node nested below the root.
    expect(sawRecursive).toBe(true);
    expect(sc(r).paths).toEqual(["/project1/base1/noise1"]);
  });
});

describe("summarize_td_errors", () => {
  it("returns an empty summary when there are no errors", async () => {
    const r = await summarizeTdErrorsImpl(makeCtx(), { path: "/project1", group_by: "message" });
    expect(sc(r).total).toBe(0);
    expect(sc(r).groups).toEqual([]);
  });

  it("clusters errors by message and flags the worst node", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/errors`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            errors: [
              { path: "/project1/a", message: "missing input", type: "error" },
              { path: "/project1/a", message: "missing input", type: "error" },
              { path: "/project1/b", message: "bad expression", type: "warning" },
            ],
          },
        }),
      ),
    );
    const r = await summarizeTdErrorsImpl(makeCtx(), { path: "/project1", group_by: "message" });
    expect(sc(r).total).toBe(3);
    expect(sc(r).groups[0]).toMatchObject({ key: "missing input", count: 2 });
    expect(sc(r).suggestions.join(" ")).toContain("/project1/a");
  });
});

describe("compare_td_nodes", () => {
  it("reports only the differing parameters", async () => {
    server.use(
      http.get(`${TD_BASE}/api/nodes/:seg`, ({ params }) => {
        const p = decodeURIComponent(String(params.seg));
        return HttpResponse.json({
          ok: true,
          data: {
            path: p,
            type: "noiseTOP",
            name: "n",
            parameters: { period: 1, amplitude: p.endsWith("a") ? 1 : 2 },
          },
        });
      }),
    );
    const r = await compareTdNodesImpl(makeCtx(), {
      path_a: "/project1/a",
      path_b: "/project1/b",
      only_diff: true,
    });
    expect(sc(r).differing_count).toBe(1);
    expect(sc(r).differing[0]).toMatchObject({ param: "amplitude", a: 1, b: 2 });
    expect(sc(r).same_count).toBe(1);
    expect(sc(r).identical).toBeUndefined();
  });
});

describe("snapshot_td_graph", () => {
  it("captures nodes and connections, with params only when asked", async () => {
    const bare = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: false,
    });
    expect(sc(bare).nodeCount).toBe(1);
    expect(sc(bare).connectionCount).toBe(0);
    expect(sc(bare).nodes[0].parameters).toBeUndefined();

    const withParams = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: true,
      compact: false,
    });
    expect(sc(withParams).nodes[0].parameters).toMatchObject({ period: 1 });
  });

  it("fails forward: one unreadable node does not sink the whole snapshot", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/topology`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            nodes: [
              { path: "/project1/a", type: "noiseTOP", name: "a" },
              { path: "/project1/b", type: "noiseTOP", name: "b" },
            ],
            connections: [],
          },
        }),
      ),
      http.get(`${TD_BASE}/api/nodes/:seg`, ({ params }) => {
        const p = decodeURIComponent(String(params.seg));
        if (p === "/project1/b") {
          return HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 });
        }
        return HttpResponse.json({
          ok: true,
          data: { path: p, type: "noiseTOP", name: "a", parameters: { period: 1 } },
        });
      }),
    );
    const r = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: true,
      compact: false,
    });
    expect(r.isError).toBeFalsy();
    expect(sc(r).nodeCount).toBe(2);
    const a = sc(r).nodes.find((n: { path: string }) => n.path === "/project1/a");
    const b = sc(r).nodes.find((n: { path: string }) => n.path === "/project1/b");
    expect(a.parameters).toMatchObject({ period: 1 });
    // Unreadable node fails forward: params are left unfetched (not a misleading empty {})
    // and flagged so downstream can't mistake it for "matches the type default".
    expect(b.parameters).toBeUndefined();
    expect(b.params_unfetched).toBe(true);
  });
});
