import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createRaytkOpImpl, createRaytkOpSchema } from "../../src/tools/layer3/createRaytkOp.js";
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
    logger: silentLogger,
  } as unknown as ToolContext;
}

interface RaytkPayload {
  op_type: string;
  category: string | null;
  parent: string;
  name: string | null;
  node_x: number;
  node_y: number;
  connect_from: string | null;
  input_index: number;
  library_path: string | null;
}

/** Override /api/exec to capture the payload embedded in the script and return a report. */
function mockExec(report: object): { payload: () => RaytkPayload | undefined } {
  let captured: string | undefined;
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      captured = body.script;
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
  return {
    payload: () => {
      const b64 = /b64decode\("([^"]+)"\)/.exec(captured ?? "")?.[1];
      if (b64 === undefined) return undefined;
      return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as RaytkPayload;
    },
  };
}

describe("create_raytk_op", () => {
  it("builds the bridge payload from the schema fields and reports the created op", async () => {
    const exec = mockExec({
      created: "/project1/sphereSdf1",
      master_path: "/project1/tdmcp_packages/raytk/sdf/sphereSdf",
      resolution: "pathsByOpType",
      op_type: "sphereSdf",
      connected: false,
      warnings: [],
    });

    const result: CallToolResult = await createRaytkOpImpl(makeCtx(), {
      op_type: "sphereSdf",
      category: "sdf",
      parent_path: "/project1",
      node_x: 200,
      node_y: -50,
      input_index: 0,
    });

    expect(result.isError).toBeFalsy();

    const payload = exec.payload();
    expect(payload).toBeDefined();
    expect(payload?.op_type).toBe("sphereSdf");
    expect(payload?.category).toBe("sdf");
    expect(payload?.parent).toBe("/project1");
    expect(payload?.node_x).toBe(200);
    expect(payload?.node_y).toBe(-50);
    expect(payload?.input_index).toBe(0);
    expect(payload?.connect_from).toBeNull();

    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("/project1/sphereSdf1");
    expect(text).toContain("pathsByOpType");
  });

  it("passes connect_from + input_index through and reports the wire", async () => {
    const exec = mockExec({
      created: "/project1/raymarchRender3D1",
      master_path: "/raytk/output/raymarchRender3D",
      resolution: "category-search",
      op_type: "raymarchRender3D",
      connected: true,
      warnings: [],
    });

    const result = await createRaytkOpImpl(makeCtx(), {
      op_type: "raymarchRender3D",
      parent_path: "/project1",
      node_x: 0,
      node_y: 0,
      connect_from: "/project1/sphereSdf1",
      input_index: 1,
    });

    expect(result.isError).toBeFalsy();
    const payload = exec.payload();
    expect(payload?.connect_from).toBe("/project1/sphereSdf1");
    expect(payload?.input_index).toBe(1);

    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("wired /project1/sphereSdf1 → input 1");
  });

  it("surfaces a fatal report as an isError result without throwing", async () => {
    mockExec({ warnings: [], fatal: "RayTK library not loaded" });

    const result = await createRaytkOpImpl(makeCtx(), {
      op_type: "sphereSdf",
      parent_path: "/project1",
      node_x: 0,
      node_y: 0,
      input_index: 0,
    });

    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("RayTK library not loaded");
  });

  it("reports a connect warning when the source could not be wired", async () => {
    mockExec({
      created: "/project1/pointLight1",
      master_path: "/raytk/light/pointLight",
      resolution: "explicit",
      op_type: "pointLight",
      connected: false,
      warnings: ["connect_from not found: /project1/missing"],
    });

    const result = await createRaytkOpImpl(makeCtx(), {
      op_type: "pointLight",
      parent_path: "/project1",
      node_x: 0,
      node_y: 0,
      connect_from: "/project1/missing",
      input_index: 0,
    });

    expect(result.isError).toBeFalsy();
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("input wire skipped");
    expect(text).toContain("connect_from not found");
  });

  it("requires op_type (empty args fail schema validation)", () => {
    expect(() => createRaytkOpSchema.parse({})).toThrow();
    // A valid minimal call parses and applies defaults.
    const parsed = createRaytkOpSchema.parse({ op_type: "boxSdf" });
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.node_x).toBe(0);
    expect(parsed.input_index).toBe(0);
  });
});
