import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectResolumeArenaImpl,
  connectResolumeArenaSchema,
} from "../../src/tools/layer2/connectResolumeArena.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import {
  decodePayload,
  execOk,
  makeCtx,
  parseJsonFence,
  textOf,
} from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectResolumeArenaImpl", () => {
  it("builds a Resolume OSC scaffold payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "resolume_arena",
          container_path: "/project1/resolume_arena",
          nodes: { command_map: "/project1/resolume_arena/command_map" },
          warnings: [],
        });
      }),
    );

    const args = connectResolumeArenaSchema.parse({
      resolume_host: "10.0.0.12",
      send_port: 7002,
      receive_port: 7003,
      deck_count: 2,
      layer_count: 2,
      clip_count: 4,
      preview_mode: "ndi",
      active: true,
    });
    const result = await connectResolumeArenaImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("resolume_arena");
    expect(payload.metadata.resolume_host).toBe("10.0.0.12");
    expect(payload.metadata.preview_mode).toBe("ndi");
    expect(payload.nodes.map((node) => node.name)).toContain("command_map");
    expect(capturedScript).toContain("nodeX");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Resolume OSC scaffold");
    expect(parseJsonFence(result).nodes?.command_map).toContain("command_map");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "resolume_arena", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectResolumeArenaImpl(makeCtx(), connectResolumeArenaSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_resolume_arena failed");
  });

  it("rejects invalid clip counts", () => {
    expect(() => connectResolumeArenaSchema.parse({ clip_count: 0 })).toThrow();
  });
});
