import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectWhisperTranscriptionBusImpl,
  connectWhisperTranscriptionBusSchema,
} from "../../src/tools/layer2/connectWhisperTranscriptionBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectWhisperTranscriptionBusImpl", () => {
  it("builds a Whisper transcription bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "whisper_transcription_bus",
          container_path: "/project1/whisper_transcription_bus",
          nodes: { segment_map: "/project1/whisper_transcription_bus/segment_map" },
          warnings: [],
        });
      }),
    );

    const args = connectWhisperTranscriptionBusSchema.parse({
      source_mode: "audio_device",
      language_hint: "pt",
      segment_count: 3,
    });
    const result = await connectWhisperTranscriptionBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.language_hint).toBe("pt");
    expect(payload.nodes.find((node) => node.name === "audio_in")?.optype).toBe(
      "audiodeviceinCHOP",
    );
    expect(payload.nodes.find((node) => node.name === "segment_map")?.table?.join(" ")).toContain(
      "segment_3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Whisper transcription bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "whisper_transcription_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectWhisperTranscriptionBusImpl(
      makeCtx(),
      connectWhisperTranscriptionBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_whisper_transcription_bus failed");
  });

  it("rejects invalid segment counts", () => {
    expect(() => connectWhisperTranscriptionBusSchema.parse({ segment_count: 0 })).toThrow();
  });
});
