import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { rebuildNetworkImpl, rebuildNetworkSchema } from "../../src/tools/layer2/rebuildNetwork.js";
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

/** Pull the JSON payload out of a captured buildPayloadScript Python string. */
function decodePayload(script: string): {
  parent_path: string;
  spec: unknown;
  clear_existing: boolean;
} {
  const match = script.match(/b64decode\("([^"]+)"\)/);
  if (!match?.[1]) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

// Parse through the schema so the value matches the impl's (output) arg type —
// defaulted fields (params/inputs/clear_existing/out_index/in_index) are required
// on that type, and parsing fills them in exactly as a real call would.
const TWO_NODE_SPEC = rebuildNetworkSchema.parse({
  parent_path: "/project1",
  spec: {
    root: "/project1/orig",
    nodes: [
      { name: "noise1", type: "noiseTOP", params: { period: { value: 2 } } },
      {
        name: "level1",
        type: "levelTOP",
        params: { brightness1: { mode: "EXPRESSION", expr: "me.time.seconds" } },
        inputs: [{ from: "noise1" }],
      },
    ],
  },
});

describe("rebuildNetworkSchema", () => {
  it("validates a 2-node spec and defaults clear_existing to false", () => {
    const parsed = rebuildNetworkSchema.parse(TWO_NODE_SPEC);
    expect(parsed.clear_existing).toBe(false);
    expect(parsed.spec.nodes).toHaveLength(2);
    // Defaulted per-node fields fill in.
    expect(parsed.spec.nodes[1]?.inputs[0]).toMatchObject({
      from: "noise1",
      out_index: 0,
      in_index: 0,
    });
  });

  it("defaults params/inputs on a minimal node spec", () => {
    const parsed = rebuildNetworkSchema.parse({
      parent_path: "/project1",
      spec: { nodes: [{ name: "a", type: "noiseTOP" }] },
    });
    expect(parsed.spec.nodes[0]?.params).toEqual({});
    expect(parsed.spec.nodes[0]?.inputs).toEqual([]);
    expect(parsed.clear_existing).toBe(false);
  });

  it("rejects a spec missing the nodes array", () => {
    expect(() => rebuildNetworkSchema.parse({ parent_path: "/project1", spec: {} })).toThrow();
  });
});

describe("rebuildNetworkImpl", () => {
  it("sends the parent_path + spec through the payload and summarizes the report", async () => {
    let captured = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        captured = body.script;
        return HttpResponse.json({
          ok: true,
          data: {
            stdout: JSON.stringify({
              parent_path: "/project1",
              created: ["noise1", "level1"],
              wired: 1,
              params_set: 2,
              cleared: 0,
              warnings: [],
            }),
          },
        });
      }),
    );

    const result = await rebuildNetworkImpl(makeCtx(), TWO_NODE_SPEC);
    expect(result.isError).toBeFalsy();

    // The payload carries exactly what we passed in.
    const payload = decodePayload(captured);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.clear_existing).toBe(false);
    const spec = payload.spec as { nodes: Array<{ name: string; type: string }> };
    expect(spec.nodes.map((n) => n.name)).toEqual(["noise1", "level1"]);
    expect(spec.nodes.map((n) => n.type)).toEqual(["noiseTOP", "levelTOP"]);

    const text = (result.content?.[0] as { text: string }).text;
    expect(text).toContain("Rebuilt 2 node(s), 1 wire(s) under /project1");
  });

  it("reports warnings and a cleared count in the summary", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            stdout: JSON.stringify({
              parent_path: "/project1",
              created: ["noise1"],
              wired: 0,
              params_set: 1,
              cleared: 3,
              warnings: ["Unknown operator type 'bogusTOP' for node 'bad1'"],
            }),
          },
        }),
      ),
    );

    const result = await rebuildNetworkImpl(makeCtx(), {
      parent_path: "/project1",
      spec: { nodes: [{ name: "noise1", type: "noiseTOP", params: {}, inputs: [] }] },
      clear_existing: true,
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content?.[0] as { text: string }).text;
    expect(text).toContain("cleared 3 existing");
    expect(text).toContain("1 warning(s)");
  });

  it("returns isError (and does not throw) when the bridge report has a fatal", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            stdout: JSON.stringify({ parent_path: "/nope", fatal: "Parent COMP not found: /nope" }),
          },
        }),
      ),
    );

    const result = await rebuildNetworkImpl(makeCtx(), {
      parent_path: "/nope",
      spec: { nodes: [{ name: "a", type: "noiseTOP", params: {}, inputs: [] }] },
      clear_existing: false,
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text: string }).text;
    expect(text).toContain("rebuild_network failed");
    expect(text).toContain("Parent COMP not found");
  });

  it("returns isError (and does not throw) when TD is unreachable", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
    const result = await rebuildNetworkImpl(makeCtx(), {
      parent_path: "/project1",
      spec: { nodes: [{ name: "a", type: "noiseTOP", params: {}, inputs: [] }] },
      clear_existing: false,
    });
    expect(result.isError).toBe(true);
  });
});
