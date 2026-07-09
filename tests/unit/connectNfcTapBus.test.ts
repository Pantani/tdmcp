import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectNfcTapBusImpl,
  connectNfcTapBusSchema,
} from "../../src/tools/layer2/connectNfcTapBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectNfcTapBusImpl", () => {
  it("builds an NFC tap bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "nfc_tap_bus",
          container_path: "/project1/nfc_tap_bus",
          nodes: { tap_event_map: "/project1/nfc_tap_bus/tap_event_map" },
          warnings: [],
        });
      }),
    );

    const args = connectNfcTapBusSchema.parse({
      installation_label: "plinths",
      station_count: 4,
      tap_event_count: 7,
    });
    const result = await connectNfcTapBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.installation_label).toBe("plinths");
    expect(payload.nodes.find((node) => node.name === "nfc_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(payload.nodes.find((node) => node.name === "tap_event_map")?.table?.join(" ")).toContain(
      "tap_7",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created NFC tap bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "nfc_tap_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectNfcTapBusImpl(makeCtx(), connectNfcTapBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_nfc_tap_bus failed");
  });

  it("rejects invalid tap counts", () => {
    expect(() => connectNfcTapBusSchema.parse({ tap_event_count: 0 })).toThrow();
  });
});
