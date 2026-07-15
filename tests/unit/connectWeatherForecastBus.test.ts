import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectWeatherForecastBusImpl,
  connectWeatherForecastBusSchema,
} from "../../src/tools/layer2/connectWeatherForecastBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectWeatherForecastBusImpl", () => {
  it("builds a weather forecast bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "weather_forecast_bus",
          container_path: "/project1/weather_forecast_bus",
          nodes: { forecast_map: "/project1/weather_forecast_bus/forecast_map" },
          warnings: [],
        });
      }),
    );

    const args = connectWeatherForecastBusSchema.parse({
      provider: "nws",
      location_label: "roof",
      forecast_hour_count: 6,
      alert_count: 2,
    });
    const result = await connectWeatherForecastBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.location_label).toBe("roof");
    expect(payload.nodes.find((node) => node.name === "weather_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "forecast_map")?.table?.join(" ")).toContain(
      "+6h",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created weather forecast bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "weather_forecast_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectWeatherForecastBusImpl(
      makeCtx(),
      connectWeatherForecastBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_weather_forecast_bus failed");
  });

  it("rejects invalid forecast counts", () => {
    expect(() => connectWeatherForecastBusSchema.parse({ forecast_hour_count: 0 })).toThrow();
  });
});
