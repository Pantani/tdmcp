import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectWebrtcBrowserInputImpl,
  connectWebrtcBrowserInputSchema,
} from "../../src/tools/layer2/connectWebrtcBrowserInput.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectWebrtcBrowserInputImpl", () => {
  it("builds a WebRTC browser input scaffold payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "webrtc_browser_input",
          container_path: "/project1/webrtc_browser_input",
          nodes: { data_channel_map: "/project1/webrtc_browser_input/data_channel_map" },
          warnings: [],
        });
      }),
    );

    const args = connectWebrtcBrowserInputSchema.parse({
      signaling_url: "wss://show.example/signaling",
      room_id: "main-room",
      input_mode: "mixed",
      include_data_channels: true,
      active: true,
    });
    const result = await connectWebrtcBrowserInputImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("webrtc_browser_input");
    expect(payload.metadata.signaling_url).toBe("wss://show.example/signaling");
    expect(payload.metadata.room_id).toBe("main-room");
    expect(
      payload.nodes.find((node) => node.name === "data_channel_map")?.table?.join(" "),
    ).toContain("orientation");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created WebRTC browser input scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "webrtc_browser_input", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectWebrtcBrowserInputImpl(
      makeCtx(),
      connectWebrtcBrowserInputSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_webrtc_browser_input failed");
  });

  it("rejects invalid input modes", () => {
    expect(() => connectWebrtcBrowserInputSchema.parse({ input_mode: "midi" })).toThrow();
  });
});
