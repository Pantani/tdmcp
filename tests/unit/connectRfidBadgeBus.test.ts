import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectRfidBadgeBusImpl,
  connectRfidBadgeBusSchema,
} from "../../src/tools/layer2/connectRfidBadgeBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectRfidBadgeBusImpl", () => {
  it("builds an RFID badge bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "rfid_badge_bus",
          container_path: "/project1/rfid_badge_bus",
          nodes: { badge_event_map: "/project1/rfid_badge_bus/badge_event_map" },
          warnings: [],
        });
      }),
    );

    const args = connectRfidBadgeBusSchema.parse({
      venue_label: "north_gallery",
      reader_count: 3,
      badge_event_count: 5,
    });
    const result = await connectRfidBadgeBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.venue_label).toBe("north_gallery");
    expect(payload.nodes.find((node) => node.name === "rfid_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(
      payload.nodes.find((node) => node.name === "badge_event_map")?.table?.join(" "),
    ).toContain("badge_event_5");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created RFID badge bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "rfid_badge_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectRfidBadgeBusImpl(makeCtx(), connectRfidBadgeBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_rfid_badge_bus failed");
  });

  it("rejects invalid reader counts", () => {
    expect(() => connectRfidBadgeBusSchema.parse({ reader_count: 0 })).toThrow();
  });
});
