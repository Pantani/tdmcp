import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectGpsFleetTrackerImpl,
  connectGpsFleetTrackerSchema,
} from "../../src/tools/layer2/connectGpsFleetTracker.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectGpsFleetTrackerImpl", () => {
  it("builds a GPS fleet tracker scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "gps_fleet_tracker",
          container_path: "/project1/gps_fleet_tracker",
          nodes: { asset_positions: "/project1/gps_fleet_tracker/asset_positions" },
          warnings: [],
        });
      }),
    );

    const args = connectGpsFleetTrackerSchema.parse({
      provider: "owntracks",
      fleet_label: "couriers",
      tracked_asset_count: 4,
      geofence_count: 2,
    });
    const result = await connectGpsFleetTrackerImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.fleet_label).toBe("couriers");
    expect(payload.nodes.find((node) => node.name === "gps_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(
      payload.nodes.find((node) => node.name === "asset_positions")?.table?.join(" "),
    ).toContain("asset_4");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created GPS fleet tracker");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "gps_fleet_tracker", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectGpsFleetTrackerImpl(
      makeCtx(),
      connectGpsFleetTrackerSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_gps_fleet_tracker failed");
  });

  it("rejects invalid tracked asset counts", () => {
    expect(() => connectGpsFleetTrackerSchema.parse({ tracked_asset_count: 0 })).toThrow();
  });
});
