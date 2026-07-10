import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectAisVesselBusImpl,
  connectAisVesselBusSchema,
} from "../../src/tools/layer2/connectAisVesselBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectAisVesselBusImpl", () => {
  it("builds an AIS vessel bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "ais_vessel_bus",
          container_path: "/project1/ais_vessel_bus",
          nodes: { vessel_map: "/project1/ais_vessel_bus/vessel_map" },
          warnings: [],
        });
      }),
    );

    const args = connectAisVesselBusSchema.parse({
      waterway_label: "bay",
      vessel_count: 5,
      zone_count: 2,
      route_count: 3,
    });
    const result = await connectAisVesselBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.waterway_label).toBe("bay");
    expect(payload.nodes.find((node) => node.name === "ais_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(payload.nodes.find((node) => node.name === "vessel_map")?.table?.join(" ")).toContain(
      "vessel_5",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created AIS vessel bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "ais_vessel_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectAisVesselBusImpl(makeCtx(), connectAisVesselBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_ais_vessel_bus failed");
  });

  it("rejects invalid vessel counts", () => {
    expect(() => connectAisVesselBusSchema.parse({ vessel_count: 0 })).toThrow();
  });
});
