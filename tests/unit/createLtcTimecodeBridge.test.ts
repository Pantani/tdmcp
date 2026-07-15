import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createLtcTimecodeBridgeImpl,
  createLtcTimecodeBridgeSchema,
} from "../../src/tools/layer2/createLtcTimecodeBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createLtcTimecodeBridgeImpl", () => {
  it("builds an LTC timecode bridge scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "ltc_timecode_bridge",
          container_path: "/project1/ltc_timecode_bridge",
          nodes: { cue_map: "/project1/ltc_timecode_bridge/cue_map" },
          warnings: [],
        });
      }),
    );

    const args = createLtcTimecodeBridgeSchema.parse({
      mode: "receive_and_generate",
      frame_rate: "25",
      cue_count: 3,
      active: true,
    });
    const result = await createLtcTimecodeBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.frame_rate).toBe("25");
    expect(payload.nodes.find((node) => node.name === "ltc_in")?.optype).toBe("ltcinCHOP");
    expect(payload.nodes.find((node) => node.name === "ltc_out")?.optype).toBe("ltcoutCHOP");
    expect(payload.nodes.find((node) => node.name === "cue_map")?.table?.join(" ")).toContain(
      "01:00:20:00",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created LTC timecode bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "ltc_timecode_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createLtcTimecodeBridgeImpl(
      makeCtx(),
      createLtcTimecodeBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_ltc_timecode_bridge failed");
  });

  it("rejects invalid frame rates", () => {
    expect(() => createLtcTimecodeBridgeSchema.parse({ frame_rate: "27" })).toThrow();
  });
});
