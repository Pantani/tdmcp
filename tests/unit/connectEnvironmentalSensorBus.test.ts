import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectEnvironmentalSensorBusImpl,
  connectEnvironmentalSensorBusSchema,
} from "../../src/tools/layer2/connectEnvironmentalSensorBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectEnvironmentalSensorBusImpl", () => {
  it("builds an environmental sensor bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "environmental_sensor_bus",
          container_path: "/project1/environmental_sensor_bus",
          nodes: {
            environment_readings: "/project1/environmental_sensor_bus/environment_readings",
          },
          warnings: [],
        });
      }),
    );

    const args = connectEnvironmentalSensorBusSchema.parse({
      sensor_profile: "air_quality",
      zone_count: 3,
      sensor_count: 9,
    });
    const result = await connectEnvironmentalSensorBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.sensor_profile).toBe("air_quality");
    expect(
      payload.nodes.find((node) => node.name === "environment_readings")?.table?.join(" "),
    ).toContain("zone_3");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created environmental sensor bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "environmental_sensor_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectEnvironmentalSensorBusImpl(
      makeCtx(),
      connectEnvironmentalSensorBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_environmental_sensor_bus failed");
  });

  it("rejects invalid sensor counts", () => {
    expect(() => connectEnvironmentalSensorBusSchema.parse({ sensor_count: 0 })).toThrow();
  });
});
