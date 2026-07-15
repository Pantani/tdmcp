import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createHokuyoLidarBusImpl,
  createHokuyoLidarBusSchema,
} from "../../src/tools/layer2/createHokuyoLidarBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createHokuyoLidarBusImpl", () => {
  it("builds a Hokuyo LiDAR bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        capturedScript = String(body.script ?? "");
        expect(body.return_output).toBe(true);
        return execOk({
          kind: "hokuyo_lidar_bus",
          container_path: "/project1/hokuyo_lidar_bus",
          nodes: { zone_map: "/project1/hokuyo_lidar_bus/zone_map" },
          warnings: [],
        });
      }),
    );

    const args = createHokuyoLidarBusSchema.parse({
      interface_mode: "serial",
      serial_port: "/dev/tty.usbmodem",
      scan_zones: 4,
      start_step: 10,
      end_step: 500,
    });
    const result = await createHokuyoLidarBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.interface_mode).toBe("serial");
    expect(payload.metadata.serial_port).toBe("/dev/tty.usbmodem");
    expect(payload.nodes.find((node) => node.name === "zone_map")?.table?.join(" ")).toContain(
      "presence_zone_4",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Hokuyo LiDAR bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "hokuyo_lidar_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createHokuyoLidarBusImpl(makeCtx(), createHokuyoLidarBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_hokuyo_lidar_bus failed");
  });

  it("rejects invalid scan zone counts", () => {
    expect(() => createHokuyoLidarBusSchema.parse({ scan_zones: 0 })).toThrow();
  });
});
