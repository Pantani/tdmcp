import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectMadmapperSurfaceImpl,
  connectMadmapperSurfaceSchema,
} from "../../src/tools/layer2/connectMadmapperSurface.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectMadmapperSurfaceImpl", () => {
  it("builds a MadMapper surface-control payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "madmapper_surface",
          container_path: "/project1/madmapper_surface",
          nodes: { surface_map: "/project1/madmapper_surface/surface_map" },
          warnings: [],
        });
      }),
    );

    const args = connectMadmapperSurfaceSchema.parse({
      madmapper_host: "10.0.0.20",
      surface_count: 6,
      media_count: 3,
      source_top_path: "/project1/out1",
      handoff_mode: "ndi",
      active: true,
    });
    const result = await connectMadmapperSurfaceImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("madmapper_surface");
    expect(payload.metadata.surface_count).toBe(6);
    expect(payload.metadata.handoff_mode).toBe("ndi");
    expect(
      payload.nodes.find((node) => node.name === "surface_map")?.table?.length,
    ).toBeGreaterThan(1);
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created MadMapper OSC scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "madmapper_surface", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectMadmapperSurfaceImpl(
      makeCtx(),
      connectMadmapperSurfaceSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_madmapper_surface failed");
  });

  it("rejects invalid OSC ports", () => {
    expect(() => connectMadmapperSurfaceSchema.parse({ send_port: 70000 })).toThrow();
  });
});
