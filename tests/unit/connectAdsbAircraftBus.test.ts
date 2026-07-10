import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectAdsbAircraftBusImpl,
  connectAdsbAircraftBusSchema,
} from "../../src/tools/layer2/connectAdsbAircraftBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectAdsbAircraftBusImpl", () => {
  it("builds an ADS-B aircraft bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "adsb_aircraft_bus",
          container_path: "/project1/adsb_aircraft_bus",
          nodes: { aircraft_map: "/project1/adsb_aircraft_bus/aircraft_map" },
          warnings: [],
        });
      }),
    );

    const args = connectAdsbAircraftBusSchema.parse({
      provider: "tar1090",
      airspace_label: "downtown",
      aircraft_count: 6,
      altitude_band_count: 3,
    });
    const result = await connectAdsbAircraftBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.airspace_label).toBe("downtown");
    expect(payload.nodes.find((node) => node.name === "adsb_client")?.optype).toBe("webclientDAT");
    expect(payload.nodes.find((node) => node.name === "aircraft_map")?.table?.join(" ")).toContain(
      "aircraft_6",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created ADS-B aircraft bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "adsb_aircraft_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectAdsbAircraftBusImpl(
      makeCtx(),
      connectAdsbAircraftBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_adsb_aircraft_bus failed");
  });

  it("rejects invalid aircraft counts", () => {
    expect(() => connectAdsbAircraftBusSchema.parse({ aircraft_count: 0 })).toThrow();
  });
});
