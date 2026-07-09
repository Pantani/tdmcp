import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectWifiPresenceBusImpl,
  connectWifiPresenceBusSchema,
} from "../../src/tools/layer2/connectWifiPresenceBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectWifiPresenceBusImpl", () => {
  it("builds a Wi-Fi presence bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "wifi_presence_bus",
          container_path: "/project1/wifi_presence_bus",
          nodes: { occupancy_map: "/project1/wifi_presence_bus/occupancy_map" },
          warnings: [],
        });
      }),
    );

    const args = connectWifiPresenceBusSchema.parse({
      site_label: "main_hall",
      zone_count: 5,
      dwell_bucket_count: 3,
    });
    const result = await connectWifiPresenceBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.site_label).toBe("main_hall");
    expect(payload.nodes.find((node) => node.name === "wifi_http_adapter")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "occupancy_map")?.table?.join(" ")).toContain(
      "zone_5",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Wi-Fi presence bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "wifi_presence_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectWifiPresenceBusImpl(
      makeCtx(),
      connectWifiPresenceBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_wifi_presence_bus failed");
  });

  it("rejects invalid dwell bucket counts", () => {
    expect(() => connectWifiPresenceBusSchema.parse({ dwell_bucket_count: 0 })).toThrow();
  });
});
