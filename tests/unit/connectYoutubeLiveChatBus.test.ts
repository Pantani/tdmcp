import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectYoutubeLiveChatBusImpl,
  connectYoutubeLiveChatBusSchema,
} from "../../src/tools/layer2/connectYoutubeLiveChatBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectYoutubeLiveChatBusImpl", () => {
  it("builds a YouTube Live Chat bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "youtube_live_chat_bus",
          container_path: "/project1/youtube_live_chat_bus",
          nodes: { message_map: "/project1/youtube_live_chat_bus/message_map" },
          warnings: [],
        });
      }),
    );

    const args = connectYoutubeLiveChatBusSchema.parse({
      channel_id: "channel_123",
      live_chat_id: "chat_456",
      message_count: 4,
      super_chat_tier_count: 2,
    });
    const result = await connectYoutubeLiveChatBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.live_chat_id).toBe("chat_456");
    expect(payload.nodes.find((node) => node.name === "youtube_chat_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "message_map")?.table?.join(" ")).toContain(
      "message_4",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created YouTube Live Chat bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "youtube_live_chat_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectYoutubeLiveChatBusImpl(
      makeCtx(),
      connectYoutubeLiveChatBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_youtube_live_chat_bus failed");
  });

  it("rejects invalid message counts", () => {
    expect(() => connectYoutubeLiveChatBusSchema.parse({ message_count: 0 })).toThrow();
  });
});
