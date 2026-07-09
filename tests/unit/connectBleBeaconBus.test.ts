import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectBleBeaconBusImpl,
  connectBleBeaconBusSchema,
} from "../../src/tools/layer2/connectBleBeaconBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectBleBeaconBusImpl", () => {
  it("builds a BLE beacon bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "ble_beacon_bus",
          container_path: "/project1/ble_beacon_bus",
          nodes: { beacon_map: "/project1/ble_beacon_bus/beacon_map" },
          warnings: [],
        });
      }),
    );

    const args = connectBleBeaconBusSchema.parse({
      site_label: "lobby",
      beacon_count: 8,
      zone_count: 3,
    });
    const result = await connectBleBeaconBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.site_label).toBe("lobby");
    expect(payload.nodes.find((node) => node.name === "ble_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(payload.nodes.find((node) => node.name === "beacon_map")?.table?.join(" ")).toContain(
      "beacon_8",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created BLE beacon bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "ble_beacon_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectBleBeaconBusImpl(makeCtx(), connectBleBeaconBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_ble_beacon_bus failed");
  });

  it("rejects invalid zone counts", () => {
    expect(() => connectBleBeaconBusSchema.parse({ zone_count: 0 })).toThrow();
  });
});
