import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createZedDepthBusImpl,
  createZedDepthBusSchema,
} from "../../src/tools/layer2/createZedDepthBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createZedDepthBusImpl", () => {
  it("builds a ZED depth bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        capturedScript = String(body.script ?? "");
        expect(body.return_output).toBe(true);
        return execOk({
          kind: "zed_depth_bus",
          container_path: "/project1/zed_depth_bus",
          nodes: { stream_map: "/project1/zed_depth_bus/stream_map" },
          warnings: [],
        });
      }),
    );

    const args = createZedDepthBusSchema.parse({
      camera_index: 2,
      stream_count: 5,
      body_count: 2,
      include_pointcloud: true,
    });
    const result = await createZedDepthBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.camera_index).toBe(2);
    expect(payload.nodes.find((node) => node.name === "zed_sop")?.optype).toBe("zedSOP");
    expect(payload.nodes.find((node) => node.name === "stream_map")?.table?.join(" ")).toContain(
      "aux_5",
    );
    expect(payload.nodes.find((node) => node.name === "body_map")?.table?.join(" ")).toContain(
      "zed_body_1_",
    );
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created ZED depth bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "zed_depth_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createZedDepthBusImpl(makeCtx(), createZedDepthBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_zed_depth_bus failed");
  });

  it("rejects invalid body counts", () => {
    expect(() => createZedDepthBusSchema.parse({ body_count: -1 })).toThrow();
  });
});
