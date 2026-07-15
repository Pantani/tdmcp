import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectRvcVoiceConversionBusImpl,
  connectRvcVoiceConversionBusSchema,
} from "../../src/tools/layer2/connectRvcVoiceConversionBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectRvcVoiceConversionBusImpl", () => {
  it("builds an RVC voice conversion bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "rvc_voice_conversion_bus",
          container_path: "/project1/rvc_voice_conversion_bus",
          nodes: { speaker_map: "/project1/rvc_voice_conversion_bus/speaker_map" },
          warnings: [],
        });
      }),
    );

    const args = connectRvcVoiceConversionBusSchema.parse({
      source_mode: "websocket_chunks",
      speaker_count: 3,
      transpose_semitones: 7,
    });
    const result = await connectRvcVoiceConversionBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.transpose_semitones).toBe(7);
    expect(payload.nodes.find((node) => node.name === "rvc_ws")?.optype).toBe("websocketDAT");
    expect(payload.nodes.find((node) => node.name === "speaker_map")?.table?.join(" ")).toContain(
      "speaker_3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created RVC voice conversion bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "rvc_voice_conversion_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectRvcVoiceConversionBusImpl(
      makeCtx(),
      connectRvcVoiceConversionBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_rvc_voice_conversion_bus failed");
  });

  it("rejects invalid transpose values", () => {
    expect(() => connectRvcVoiceConversionBusSchema.parse({ transpose_semitones: 32 })).toThrow();
  });
});
