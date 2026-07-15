import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectInfluxdbTimeseriesBridgeImpl,
  connectInfluxdbTimeseriesBridgeSchema,
} from "../../src/tools/layer2/connectInfluxdbTimeseriesBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectInfluxdbTimeseriesBridgeImpl", () => {
  it("builds an InfluxDB time-series bridge scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "influxdb_timeseries_bridge",
          container_path: "/project1/influxdb_timeseries_bridge",
          nodes: { field_map: "/project1/influxdb_timeseries_bridge/field_map" },
          warnings: [],
        });
      }),
    );

    const args = connectInfluxdbTimeseriesBridgeSchema.parse({
      bucket: "venue",
      org: "show_ops",
      measurement_count: 3,
      field_count: 5,
    });
    const result = await connectInfluxdbTimeseriesBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.bucket).toBe("venue");
    expect(payload.nodes.find((node) => node.name === "influx_adapter")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "field_map")?.table?.join(" ")).toContain(
      "timeseries_5",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created InfluxDB time-series bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({
          kind: "influxdb_timeseries_bridge",
          warnings: [],
          fatal: "Parent COMP not found",
        }),
      ),
    );

    const result = await connectInfluxdbTimeseriesBridgeImpl(
      makeCtx(),
      connectInfluxdbTimeseriesBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_influxdb_timeseries_bridge failed");
  });

  it("rejects invalid poll intervals", () => {
    expect(() => connectInfluxdbTimeseriesBridgeSchema.parse({ poll_seconds: 0 })).toThrow();
  });
});
