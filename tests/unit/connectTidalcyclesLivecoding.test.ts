import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectTidalcyclesLivecodingImpl,
  connectTidalcyclesLivecodingSchema,
} from "../../src/tools/layer2/connectTidalcyclesLivecoding.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectTidalcyclesLivecodingImpl", () => {
  it("builds a TidalCycles OSC scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "tidalcycles_livecoding",
          container_path: "/project1/tidalcycles_livecoding",
          nodes: { pattern_map: "/project1/tidalcycles_livecoding/pattern_map" },
          warnings: [],
        });
      }),
    );

    const args = connectTidalcyclesLivecodingSchema.parse({
      tidal_host: "10.0.0.44",
      orbit_count: 3,
      pattern_count: 5,
    });
    const result = await connectTidalcyclesLivecodingImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("tidalcycles_livecoding");
    expect(payload.metadata.tidal_host).toBe("10.0.0.44");
    expect(payload.nodes.find((node) => node.name === "pattern_map")?.table?.join(" ")).toContain(
      "/tidal/pattern/5",
    );
    expect(payload.nodes.find((node) => node.name === "orbit_map")?.table?.join(" ")).toContain(
      "/dirt/play/2",
    );
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created TidalCycles live-coding scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "tidalcycles_livecoding", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectTidalcyclesLivecodingImpl(
      makeCtx(),
      connectTidalcyclesLivecodingSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_tidalcycles_livecoding failed");
  });

  it("rejects invalid orbit counts", () => {
    expect(() => connectTidalcyclesLivecodingSchema.parse({ orbit_count: 0 })).toThrow();
  });
});
