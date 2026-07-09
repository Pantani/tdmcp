import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectGtfsTransitFeedImpl,
  connectGtfsTransitFeedSchema,
} from "../../src/tools/layer2/connectGtfsTransitFeed.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectGtfsTransitFeedImpl", () => {
  it("builds a GTFS transit feed scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "gtfs_transit_feed",
          container_path: "/project1/gtfs_transit_feed",
          nodes: { route_map: "/project1/gtfs_transit_feed/route_map" },
          warnings: [],
        });
      }),
    );

    const args = connectGtfsTransitFeedSchema.parse({
      agency_label: "metro",
      route_count: 3,
      stop_count: 4,
      prediction_count: 5,
    });
    const result = await connectGtfsTransitFeedImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.agency_label).toBe("metro");
    expect(payload.nodes.find((node) => node.name === "gtfs_realtime_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(
      payload.nodes.find((node) => node.name === "arrival_predictions")?.table?.join(" "),
    ).toContain("arrival_5");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created GTFS transit feed");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "gtfs_transit_feed", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectGtfsTransitFeedImpl(
      makeCtx(),
      connectGtfsTransitFeedSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_gtfs_transit_feed failed");
  });

  it("rejects invalid route counts", () => {
    expect(() => connectGtfsTransitFeedSchema.parse({ route_count: 0 })).toThrow();
  });
});
