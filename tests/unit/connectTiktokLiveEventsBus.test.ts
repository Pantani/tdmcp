import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectTiktokLiveEventsBusImpl,
  connectTiktokLiveEventsBusSchema,
} from "../../src/tools/layer2/connectTiktokLiveEventsBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectTiktokLiveEventsBusImpl", () => {
  it("builds a TikTok Live events bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "tiktok_live_events_bus",
          container_path: "/project1/tiktok_live_events_bus",
          nodes: { live_event_map: "/project1/tiktok_live_events_bus/live_event_map" },
          warnings: [],
        });
      }),
    );

    const args = connectTiktokLiveEventsBusSchema.parse({
      creator_label: "creator_a",
      event_count: 5,
      gift_tier_count: 2,
    });
    const result = await connectTiktokLiveEventsBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.creator_label).toBe("creator_a");
    expect(payload.nodes.find((node) => node.name === "tiktok_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(
      payload.nodes.find((node) => node.name === "live_event_map")?.table?.join(" "),
    ).toContain("event_5");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created TikTok Live events bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "tiktok_live_events_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectTiktokLiveEventsBusImpl(
      makeCtx(),
      connectTiktokLiveEventsBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_tiktok_live_events_bus failed");
  });

  it("rejects invalid event counts", () => {
    expect(() => connectTiktokLiveEventsBusSchema.parse({ event_count: 0 })).toThrow();
  });
});
