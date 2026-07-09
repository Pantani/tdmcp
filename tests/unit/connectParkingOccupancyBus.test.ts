import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectParkingOccupancyBusImpl,
  connectParkingOccupancyBusSchema,
} from "../../src/tools/layer2/connectParkingOccupancyBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectParkingOccupancyBusImpl", () => {
  it("builds a parking occupancy bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "parking_occupancy_bus",
          container_path: "/project1/parking_occupancy_bus",
          nodes: { zone_occupancy: "/project1/parking_occupancy_bus/zone_occupancy" },
          warnings: [],
        });
      }),
    );

    const args = connectParkingOccupancyBusSchema.parse({
      lot_label: "north_lot",
      zone_count: 4,
      capacity: 200,
      sensor_count: 8,
    });
    const result = await connectParkingOccupancyBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.lot_label).toBe("north_lot");
    expect(payload.nodes.find((node) => node.name === "parking_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(
      payload.nodes.find((node) => node.name === "zone_occupancy")?.table?.join(" "),
    ).toContain("zone_4");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created parking occupancy bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "parking_occupancy_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectParkingOccupancyBusImpl(
      makeCtx(),
      connectParkingOccupancyBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_parking_occupancy_bus failed");
  });

  it("rejects invalid capacity", () => {
    expect(() => connectParkingOccupancyBusSchema.parse({ capacity: 0 })).toThrow();
  });
});
