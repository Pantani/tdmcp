import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectSupercolliderSynthImpl,
  connectSupercolliderSynthSchema,
} from "../../src/tools/layer2/connectSupercolliderSynth.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectSupercolliderSynthImpl", () => {
  it("builds a SuperCollider OSC scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "supercollider_synth",
          container_path: "/project1/supercollider_synth",
          nodes: { synth_map: "/project1/supercollider_synth/synth_map" },
          warnings: [],
        });
      }),
    );

    const args = connectSupercolliderSynthSchema.parse({
      sc_host: "10.0.0.30",
      synth_count: 3,
      bus_count: 5,
    });
    const result = await connectSupercolliderSynthImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.sc_host).toBe("10.0.0.30");
    expect(payload.nodes.find((node) => node.name === "synth_map")?.table?.join(" ")).toContain(
      "/tdmcp/synth/3/trigger",
    );
    expect(payload.nodes.find((node) => node.name === "bus_map")?.table?.join(" ")).toContain(
      "/tdmcp/bus/4",
    );
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created SuperCollider scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "supercollider_synth", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectSupercolliderSynthImpl(
      makeCtx(),
      connectSupercolliderSynthSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_supercollider_synth failed");
  });

  it("rejects invalid bus counts", () => {
    expect(() => connectSupercolliderSynthSchema.parse({ bus_count: 0 })).toThrow();
  });
});
