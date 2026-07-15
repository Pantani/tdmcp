import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectTwitchEventsubBusImpl,
  connectTwitchEventsubBusSchema,
} from "../../src/tools/layer2/connectTwitchEventsubBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectTwitchEventsubBusImpl", () => {
  it("builds a Twitch EventSub bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "twitch_eventsub_bus",
          container_path: "/project1/twitch_eventsub_bus",
          nodes: { event_map: "/project1/twitch_eventsub_bus/event_map" },
          warnings: [],
        });
      }),
    );

    const args = connectTwitchEventsubBusSchema.parse({
      channel_login: "vj_channel",
      event_count: 5,
      reward_count: 2,
    });
    const result = await connectTwitchEventsubBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.channel_login).toBe("vj_channel");
    expect(payload.nodes.find((node) => node.name === "twitch_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(payload.nodes.find((node) => node.name === "event_map")?.table?.join(" ")).toContain(
      "event_5",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Twitch EventSub bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "twitch_eventsub_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectTwitchEventsubBusImpl(
      makeCtx(),
      connectTwitchEventsubBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_twitch_eventsub_bus failed");
  });

  it("rejects invalid event counts", () => {
    expect(() => connectTwitchEventsubBusSchema.parse({ event_count: 0 })).toThrow();
  });
});
