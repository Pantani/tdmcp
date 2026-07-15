import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectQrScanBusImpl,
  connectQrScanBusSchema,
} from "../../src/tools/layer2/connectQrScanBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectQrScanBusImpl", () => {
  it("builds a QR scan bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "qr_scan_bus",
          container_path: "/project1/qr_scan_bus",
          nodes: { scan_event_map: "/project1/qr_scan_bus/scan_event_map" },
          warnings: [],
        });
      }),
    );

    const args = connectQrScanBusSchema.parse({
      campaign_label: "treasure_path",
      scan_event_count: 9,
      route_count: 3,
    });
    const result = await connectQrScanBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.campaign_label).toBe("treasure_path");
    expect(payload.nodes.find((node) => node.name === "qr_http_adapter")?.optype).toBe(
      "webclientDAT",
    );
    expect(
      payload.nodes.find((node) => node.name === "scan_event_map")?.table?.join(" "),
    ).toContain("scan_9");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created QR scan bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "qr_scan_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectQrScanBusImpl(makeCtx(), connectQrScanBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_qr_scan_bus failed");
  });

  it("rejects invalid route counts", () => {
    expect(() => connectQrScanBusSchema.parse({ route_count: 0 })).toThrow();
  });
});
