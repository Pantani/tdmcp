import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { findTdNodesImpl, findTdNodesSchema } from "../../src/tools/layer3/findTdNodes.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function ctx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2_000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function structured(result: Awaited<ReturnType<typeof findTdNodesImpl>>) {
  return result.structuredContent as Record<string, unknown>;
}

const searchReport = {
  root: "/project1",
  nodes: [
    { path: "/project1/a_noise", name: "a_noise", type: "noiseTOP", family: "TOP" },
    { path: "/project1/z_noise", name: "z_noise", type: "nullTOP", family: "TOP" },
  ],
  metadata: {
    scanned: 8,
    matched: 2,
    returned: 2,
    truncated: false,
    scan_truncated: false,
    count_complete: true,
    stop_reason: "completed",
  },
};

describe("find_td_nodes bridge-side search", () => {
  it("uses only the compact endpoint and forwards bounded filters", async () => {
    let topologyCalls = 0;
    let query: URLSearchParams | undefined;
    server.use(
      http.get(`${TD_BASE}/api/nodes/search`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({ ok: true, data: searchReport });
      }),
      http.get(`${TD_BASE}/api/network/:seg/topology`, () => {
        topologyCalls += 1;
        return HttpResponse.json({ ok: true, data: { nodes: [], connections: [] } });
      }),
    );

    const result = await findTdNodesImpl(ctx(), {
      parent_path: "/project1",
      pattern: "*noise*",
      type: "TOP",
      type_match: "partial",
      family: "TOP",
      recursive: true,
      max_depth: 4,
      path_only: false,
      limit: 20,
      node_scan_limit: 900,
      time_limit_ms: 300,
    });

    expect(result.isError).toBeFalsy();
    expect(topologyCalls).toBe(0);
    expect(query?.get("root")).toBe("/project1");
    expect(query?.get("pattern")).toBe("*noise*");
    expect(query?.get("type_match")).toBe("contains");
    expect(query?.get("max_depth")).toBe("4");
    expect(structured(result)).toMatchObject({
      source: "bridge_search",
      count: 2,
      truncated: false,
      matches: searchReport.nodes,
      search_metadata: searchReport.metadata,
    });
  });

  it("uses only structured topology when the route is missing", async () => {
    let topologyCalls = 0;
    server.use(
      http.get(`${TD_BASE}/api/nodes/search`, () =>
        HttpResponse.json(
          {
            ok: false,
            error: { code: "invalid_input", message: "Unsupported GET /api/nodes/search" },
          },
          { status: 400 },
        ),
      ),
      http.get(`${TD_BASE}/api/network/:seg/topology`, () => {
        topologyCalls += 1;
        return HttpResponse.json({
          ok: true,
          data: {
            nodes: [
              { path: "/project1/z_noise", name: "z_noise", type: "noiseTOP" },
              { path: "/project1/a_noise", name: "a_noise", type: "noiseTOP" },
            ],
            connections: [],
          },
        });
      }),
    );

    const result = await findTdNodesImpl(ctx(), {
      parent_path: "/project1",
      recursive: true,
      path_only: true,
      limit: 1,
    });

    expect(topologyCalls).toBe(1);
    expect(structured(result)).toMatchObject({
      source: "legacy_structured_fallback",
      paths: ["/project1/a_noise"],
      count: 2,
      truncated: true,
      warnings: [expect.stringContaining("transferred recursive structured topology")],
    });
  });

  it("recognizes the old-router /search node collision but surfaces real validation", async () => {
    let topologyCalls = 0;
    server.use(
      http.get(`${TD_BASE}/api/nodes/search`, () =>
        HttpResponse.json(
          {
            ok: false,
            error: { code: "operator_not_found", message: "Node not found: /search" },
          },
          { status: 400 },
        ),
      ),
      http.get(`${TD_BASE}/api/network/:seg/topology`, () => {
        topologyCalls += 1;
        return HttpResponse.json({ ok: true, data: { nodes: [], connections: [] } });
      }),
    );
    const fallback = await findTdNodesImpl(ctx(), {
      parent_path: "/project1",
      recursive: true,
      path_only: true,
      limit: 10,
    });
    expect(fallback.isError).toBeFalsy();
    expect(topologyCalls).toBe(1);

    server.use(
      http.get(`${TD_BASE}/api/nodes/search`, () =>
        HttpResponse.json(
          {
            ok: false,
            error: { code: "invalid_input", message: "limit must be between 1 and 200" },
          },
          { status: 400 },
        ),
      ),
    );
    const rejected = await findTdNodesImpl(ctx(), {
      parent_path: "/project1",
      recursive: true,
      path_only: true,
      limit: 10,
    });
    expect(rejected.isError).toBe(true);
    expect(topologyCalls).toBe(1);
  });

  it("rejects contradictory depth before any bridge call", async () => {
    let calls = 0;
    server.use(
      http.get(`${TD_BASE}/api/nodes/search`, () => {
        calls += 1;
        return HttpResponse.json({ ok: true, data: searchReport });
      }),
    );
    const result = await findTdNodesImpl(ctx(), {
      parent_path: "/project1",
      recursive: false,
      max_depth: 2,
      path_only: false,
      limit: 10,
    });
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });

  it("bounds legacy text and rejects unsupported metacharacters in new globs", () => {
    expect(findTdNodesSchema.safeParse({ pattern: "x".repeat(257) }).success).toBe(false);
    expect(findTdNodesSchema.safeParse({ name_glob: "bad?glob" }).success).toBe(false);
    expect(findTdNodesSchema.safeParse({ path_glob: "bad[glob" }).success).toBe(false);
    expect(findTdNodesSchema.safeParse({ pattern: "literal?pattern" }).success).toBe(true);
  });
});
