import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createTdNodeImpl } from "../../src/tools/layer3/createTdNode.js";
import { deleteTdNodeImpl } from "../../src/tools/layer3/deleteTdNode.js";
import { getTdInfoImpl } from "../../src/tools/layer3/getTdInfo.js";
import { getTdNodeParametersImpl } from "../../src/tools/layer3/getTdNodeParameters.js";
import { getTdNodesImpl } from "../../src/tools/layer3/getTdNodes.js";
import { updateTdNodeParametersImpl } from "../../src/tools/layer3/updateTdNodeParameters.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, offlineInfoHandler, TD_BASE } from "../helpers/tdMock.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageVersion = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  }
).version;

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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("layer 3 tool handlers", () => {
  it("get_td_info reports connected with bridge info", async () => {
    const result = await getTdInfoImpl(makeCtx());
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("2023.12000");
  });

  it("get_td_info degrades gracefully (not an error) when offline", async () => {
    server.use(offlineInfoHandler);
    const result = await getTdInfoImpl(makeCtx());
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("not reachable");
  });

  it("get_td_info warns when the running bridge is stale vs the build", async () => {
    // The default mock reports bridge_version 0.3.0, older than this build's expected version.
    const result = await getTdInfoImpl(makeCtx());
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("stale");
    expect(textOf(result)).toContain("reload_bridge");
  });

  it("get_td_info does not warn when the bridge version matches the build", async () => {
    server.use(
      http.get(`${TD_BASE}/api/info`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            td_version: "2023.12000",
            python_version: "3.11.1",
            bridge_version: packageVersion,
            build: "2023.12000",
          },
        }),
      ),
    );
    const result = await getTdInfoImpl(makeCtx());
    expect(result.isError).toBeFalsy();
    // The summary line must not warn; the body carries bridge_stale:false.
    expect(textOf(result).split("\n")[0]).not.toContain("stale");
    expect(textOf(result)).toContain('"bridge_stale": false');
  });

  it("create_td_node creates a node and warns on unknown type", async () => {
    const good = await createTdNodeImpl(makeCtx(), { parent_path: "/project1", type: "noiseTOP" });
    expect(textOf(good)).toContain("/project1/noisetop1");

    const bad = await createTdNodeImpl(makeCtx(), { parent_path: "/project1", type: "fooBarTOP" });
    expect(textOf(bad)).toContain("not found in the knowledge base");
  });

  it("create_td_node reports an idempotent reuse when the node already existed", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as { parent_path: string; type: string; name?: string };
        return HttpResponse.json({
          ok: true,
          data: {
            path: `${body.parent_path}/${body.name ?? "noise1"}`,
            type: body.type,
            name: body.name ?? "noise1",
            already_existed: true,
          },
        });
      }),
    );
    const result = await createTdNodeImpl(makeCtx(), {
      parent_path: "/project1",
      type: "noiseTOP",
      name: "noise1",
    });
    expect(textOf(result)).toContain("Reused existing noiseTOP");
    expect(textOf(result)).toContain("already existed");
    expect(textOf(result)).toContain('"already_existed": true');
  });

  it("create_td_node returns a friendly error when offline", async () => {
    server.use(http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()));
    const result = await createTdNodeImpl(makeCtx(), {
      parent_path: "/project1",
      type: "noiseTOP",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot reach TouchDesigner");
  });

  it("get_td_nodes lists child nodes", async () => {
    const result = await getTdNodesImpl(makeCtx(), {
      parent_path: "/project1",
      path_only: false,
      detail_level: "summary",
    });
    const data = JSON.stringify(result.structuredContent);
    expect(data).toContain("noise1");
    expect(data).toContain("null1");
  });

  it("get_td_node_parameters returns all params and I/O by default", async () => {
    const result = await getTdNodeParametersImpl(makeCtx(), {
      path: "/project1/noise1",
      omit_io: false,
    });
    const data = result.structuredContent as {
      parameters: Record<string, unknown>;
      inputs?: unknown;
      outputs?: unknown;
    };
    expect(data.parameters).toHaveProperty("period");
    expect(data.parameters).toHaveProperty("amplitude");
    expect(data).toHaveProperty("inputs");
    expect(data).toHaveProperty("outputs");
  });

  it("get_td_node_parameters projects requested keys and can omit I/O", async () => {
    const result = await getTdNodeParametersImpl(makeCtx(), {
      path: "/project1/noise1",
      keys: ["period"],
      omit_io: true,
    });
    const data = result.structuredContent as {
      parameters: Record<string, unknown>;
      inputs?: unknown;
      outputs?: unknown;
    };
    expect(Object.keys(data.parameters)).toEqual(["period"]);
    expect(data).not.toHaveProperty("inputs");
    expect(data).not.toHaveProperty("outputs");
  });

  it("update_td_node_parameters sets parameters and reports the count", async () => {
    const result = await updateTdNodeParametersImpl(makeCtx(), {
      path: "/project1/noise1",
      parameters: { period: 4, amplitude: 0.5 },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Updated 2 parameter(s)");
    expect(textOf(result)).toContain("/project1/noise1");
  });

  it("get_td_node_parameters includes bounded sequence discovery", async () => {
    server.use(
      http.get(`${TD_BASE}/api/nodes/:seg/params/sequences`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            path: "/project1/constant1",
            sequences: [
              {
                name: "const",
                num_blocks: 2,
                parameters: [{ name: "const1value", value: 7.5, mode: "CONSTANT" }],
              },
            ],
            truncated: true,
            warnings: [],
          },
        }),
      ),
    );

    const result = await getTdNodeParametersImpl(makeCtx(), {
      path: "/project1/constant1",
      omit_io: true,
      include_sequences: true,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("1 sequence(s)");
    expect(result.structuredContent).toMatchObject({
      sequences: [{ name: "const", num_blocks: 2 }],
      sequences_inspected: true,
      sequences_truncated: true,
    });
    expect(textOf(result)).toContain("truncated");
  });

  it("get_td_node_parameters distinguishes skipped sequence inspection", async () => {
    const result = await getTdNodeParametersImpl(makeCtx(), {
      path: "/project1/noise1",
      omit_io: true,
      include_sequences: false,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ sequences_inspected: false });
    expect(result.structuredContent).not.toHaveProperty("sequences");
    expect(textOf(result)).toContain("sequence inspection skipped");
  });

  it("update_td_node_parameters resizes and writes an indexed sequence atomically", async () => {
    server.use(
      http.patch(`${TD_BASE}/api/nodes/:seg/params/sequences`, async ({ request }) => {
        expect(await request.json()).toEqual({
          sequences: { const: 2 },
          parameters: { const1value: 7.5 },
        });
        return HttpResponse.json({
          ok: true,
          data: {
            path: "/project1/constant1",
            resized: [{ name: "const", was: 1, num_blocks: 2 }],
            applied: [{ name: "const1value", value: 7.5 }],
            sequences: [{ name: "const", num_blocks: 2, parameters: [] }],
            rolled_back: false,
            warnings: [],
          },
        });
      }),
    );

    const result = await updateTdNodeParametersImpl(makeCtx(), {
      path: "/project1/constant1",
      parameters: { const1value: 7.5 },
      sequences: { const: 2 },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Resized 1 sequence(s)");
    expect(result.structuredContent).toMatchObject({
      sequence_update: { rolled_back: false, applied: [{ name: "const1value", value: 7.5 }] },
    });
  });

  it("update_td_node_parameters rejects an empty mutation before the bridge", async () => {
    const result = await updateTdNodeParametersImpl(makeCtx(), {
      path: "/project1/constant1",
      parameters: {},
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("at least one parameter value or sequence resize");
  });

  it("delete_td_node removes a node by path", async () => {
    const result = await deleteTdNodeImpl(makeCtx(), { path: "/project1/noise1", mode: "delete" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Deleted /project1/noise1");
  });

  it("delete_td_node mode:'bypass' disables instead of destroying", async () => {
    const result = await deleteTdNodeImpl(makeCtx(), { path: "/project1/noise1", mode: "bypass" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Bypassed /project1/noise1");
    expect(textOf(result)).toContain("not destroyed");
  });

  it("delete_td_node surfaces YOLO mode in its report", async () => {
    const ctx = { ...makeCtx(), yolo: true };
    const result = await deleteTdNodeImpl(ctx, { path: "/project1/noise1", mode: "delete" });
    expect(textOf(result)).toContain("explicit TDMCP_YOLO policy");
  });

  it("delete_td_node returns a friendly error when offline", async () => {
    server.use(http.delete(`${TD_BASE}/api/nodes/:seg`, () => HttpResponse.error()));
    const result = await deleteTdNodeImpl(makeCtx(), { path: "/project1/noise1", mode: "delete" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot reach TouchDesigner");
  });
});
