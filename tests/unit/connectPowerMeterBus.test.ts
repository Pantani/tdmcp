import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectPowerMeterBusImpl,
  connectPowerMeterBusSchema,
} from "../../src/tools/layer2/connectPowerMeterBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectPowerMeterBusImpl", () => {
  it("builds a power-meter bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "power_meter_bus",
          container_path: "/project1/power_meter_bus",
          nodes: { circuit_map: "/project1/power_meter_bus/circuit_map" },
          warnings: [],
        });
      }),
    );

    const args = connectPowerMeterBusSchema.parse({
      venue_label: "booth",
      meter_count: 2,
      circuit_count: 6,
      warning_kw: 12.5,
    });
    const result = await connectPowerMeterBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.warning_kw).toBe(12.5);
    expect(payload.nodes.find((node) => node.name === "circuit_map")?.table?.join(" ")).toContain(
      "circuit_6",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created power-meter bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "power_meter_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectPowerMeterBusImpl(makeCtx(), connectPowerMeterBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_power_meter_bus failed");
  });

  it("rejects invalid meter counts", () => {
    expect(() => connectPowerMeterBusSchema.parse({ meter_count: 0 })).toThrow();
  });
});
