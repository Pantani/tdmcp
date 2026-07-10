import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createLivoxLidarBusImpl,
  createLivoxLidarBusSchema,
} from "../../src/tools/layer2/createLivoxLidarBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createLivoxLidarBusImpl", () => {
  it("builds a Livox LiDAR bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "livox_lidar_bus",
          container_path: "/project1/livox_lidar_bus",
          nodes: { zone_map: "/project1/livox_lidar_bus/zone_map" },
          warnings: [],
        });
      }),
    );

    const args = createLivoxLidarBusSchema.parse({
      adapter_mode: "udp_json",
      device_address: "10.0.0.25",
      zone_count: 4,
    });
    const result = await createLivoxLidarBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.device_address).toBe("10.0.0.25");
    expect(payload.nodes.find((node) => node.name === "livox_udp")?.optype).toBe("udpinDAT");
    expect(payload.nodes.find((node) => node.name === "zone_map")?.table?.join(" ")).toContain(
      "livox_zone_4",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Livox LiDAR bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "livox_lidar_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createLivoxLidarBusImpl(makeCtx(), createLivoxLidarBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_livox_lidar_bus failed");
  });

  it("rejects invalid zone counts", () => {
    expect(() => createLivoxLidarBusSchema.parse({ zone_count: 0 })).toThrow();
  });
});
