import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectMidiMpeControllerImpl,
  connectMidiMpeControllerSchema,
} from "../../src/tools/layer2/connectMidiMpeController.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectMidiMpeControllerImpl", () => {
  it("builds a MIDI MPE controller scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "midi_mpe_controller",
          container_path: "/project1/midi_mpe_controller",
          nodes: { expression_map: "/project1/midi_mpe_controller/expression_map" },
          warnings: [],
        });
      }),
    );

    const args = connectMidiMpeControllerSchema.parse({
      device_name: "LinnStrument",
      lower_zone_channels: 8,
      include_output: true,
      expression_count: 5,
    });
    const result = await connectMidiMpeControllerImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.device_name).toBe("LinnStrument");
    expect(payload.nodes.find((node) => node.name === "zone_map")?.table?.join(" ")).toContain(
      "2-9",
    );
    expect(
      payload.nodes.find((node) => node.name === "expression_map")?.table?.join(" "),
    ).toContain("pitchbend");
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created MIDI MPE controller scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "midi_mpe_controller", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectMidiMpeControllerImpl(
      makeCtx(),
      connectMidiMpeControllerSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_midi_mpe_controller failed");
  });

  it("rejects invalid lower-zone channel counts", () => {
    expect(() => connectMidiMpeControllerSchema.parse({ lower_zone_channels: 0 })).toThrow();
  });
});
