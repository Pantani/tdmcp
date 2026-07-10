import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectVideoStreamReceiverImpl,
  connectVideoStreamReceiverSchema,
} from "../../src/tools/layer2/connectVideoStreamReceiver.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectVideoStreamReceiverImpl", () => {
  it("builds a video stream receiver scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "video_stream_receiver",
          container_path: "/project1/video_stream_receiver",
          nodes: { stream_out: "/project1/video_stream_receiver/stream_out" },
          warnings: [],
        });
      }),
    );

    const args = connectVideoStreamReceiverSchema.parse({
      url: "srt://10.0.0.2:9000",
      mode: "srt",
      latency_ms: 500,
    });
    const result = await connectVideoStreamReceiverImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.mode).toBe("srt");
    expect(payload.nodes.find((node) => node.name === "stream_in")?.optype).toBe(
      "videostreaminTOP",
    );
    expect(payload.nodes.find((node) => node.name === "stream_map")?.table?.join(" ")).toContain(
      "srt://10.0.0.2:9000",
    );
    expect(payload.connections).toContainEqual({ from: "stream_in", to: "stream_out" });
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created video stream receiver");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "video_stream_receiver", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectVideoStreamReceiverImpl(
      makeCtx(),
      connectVideoStreamReceiverSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_video_stream_receiver failed");
  });

  it("rejects invalid latency values", () => {
    expect(() => connectVideoStreamReceiverSchema.parse({ latency_ms: -1 })).toThrow();
  });
});
