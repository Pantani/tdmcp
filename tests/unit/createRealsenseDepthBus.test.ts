import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createRealsenseDepthBusImpl,
  createRealsenseDepthBusSchema,
} from "../../src/tools/layer2/createRealsenseDepthBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createRealsenseDepthBusImpl", () => {
  it("builds a RealSense depth bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "realsense_depth_bus",
          container_path: "/project1/realsense_depth_bus",
          nodes: { depth_out: "/project1/realsense_depth_bus/depth_out" },
          warnings: [],
        });
      }),
    );

    const args = createRealsenseDepthBusSchema.parse({
      source_mode: "realsense_top",
      serial_number: "f123",
      resolution: "1280x720",
      include_pointcloud: true,
    });
    const result = await createRealsenseDepthBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.serial_number).toBe("f123");
    expect(payload.nodes.find((node) => node.name === "depth_source")?.optype).toBe("realsenseTOP");
    expect(payload.nodes.find((node) => node.name === "stream_config")?.table?.join(" ")).toContain(
      "1280",
    );
    expect(payload.connections).toContainEqual({ from: "depth_source", to: "depth_out" });
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created RealSense depth bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "realsense_depth_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createRealsenseDepthBusImpl(
      makeCtx(),
      createRealsenseDepthBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_realsense_depth_bus failed");
  });

  it("rejects invalid source modes", () => {
    expect(() => createRealsenseDepthBusSchema.parse({ source_mode: "kinect" })).toThrow();
  });
});
