import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createOusterLidarBusImpl,
  createOusterLidarBusSchema,
} from "../../src/tools/layer2/createOusterLidarBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createOusterLidarBusImpl", () => {
  it("builds an Ouster LiDAR bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "ouster_lidar_bus",
          container_path: "/project1/ouster_lidar_bus",
          nodes: { lidar_out: "/project1/ouster_lidar_bus/lidar_out" },
          warnings: [],
        });
      }),
    );

    const args = createOusterLidarBusSchema.parse({
      device_address: "10.10.1.42",
      ring_count: 32,
      zone_count: 3,
    });
    const result = await createOusterLidarBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.device_address).toBe("10.10.1.42");
    expect(payload.nodes.find((node) => node.name === "ouster_top")?.optype).toBe("ousterTOP");
    expect(payload.nodes.find((node) => node.name === "range_select")?.optype).toBe(
      "ousterselectTOP",
    );
    expect(payload.nodes.find((node) => node.name === "zone_map")?.table?.join(" ")).toContain(
      "lidar_zone_3",
    );
    expect(payload.connections).toContainEqual({ from: "ouster_top", to: "range_select" });
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Ouster LiDAR bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "ouster_lidar_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createOusterLidarBusImpl(makeCtx(), createOusterLidarBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_ouster_lidar_bus failed");
  });

  it("rejects invalid ring counts", () => {
    expect(() => createOusterLidarBusSchema.parse({ ring_count: 8 })).toThrow();
  });
});
