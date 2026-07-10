import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectGeojsonFeatureBusImpl,
  connectGeojsonFeatureBusSchema,
} from "../../src/tools/layer2/connectGeojsonFeatureBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectGeojsonFeatureBusImpl", () => {
  it("builds a GeoJSON feature bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "geojson_feature_bus",
          container_path: "/project1/geojson_feature_bus",
          nodes: { feature_map: "/project1/geojson_feature_bus/feature_map" },
          warnings: [],
        });
      }),
    );

    const args = connectGeojsonFeatureBusSchema.parse({
      source_label: "city_shapes",
      feature_count: 5,
      style_rule_count: 2,
    });
    const result = await connectGeojsonFeatureBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.source_label).toBe("city_shapes");
    expect(payload.nodes.find((node) => node.name === "geojson_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "feature_map")?.table?.join(" ")).toContain(
      "feature_5",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created GeoJSON feature bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "geojson_feature_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectGeojsonFeatureBusImpl(
      makeCtx(),
      connectGeojsonFeatureBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_geojson_feature_bus failed");
  });

  it("rejects invalid feature counts", () => {
    expect(() => connectGeojsonFeatureBusSchema.parse({ feature_count: 0 })).toThrow();
  });
});
