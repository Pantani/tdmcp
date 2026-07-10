import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectTuioTouchSurfaceImpl,
  connectTuioTouchSurfaceSchema,
} from "../../src/tools/layer2/connectTuioTouchSurface.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectTuioTouchSurfaceImpl", () => {
  it("builds a TUIO touch surface scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "tuio_touch_surface",
          container_path: "/project1/tuio_touch_surface",
          nodes: { cursor_map: "/project1/tuio_touch_surface/cursor_map" },
          warnings: [],
        });
      }),
    );

    const args = connectTuioTouchSurfaceSchema.parse({
      listen_port: 3334,
      surface_count: 3,
      cursor_count: 4,
      include_raw_osc: false,
    });
    const result = await connectTuioTouchSurfaceImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.listen_port).toBe(3334);
    expect(payload.nodes.find((node) => node.name === "tuio_in")?.optype).toBe("tuioinDAT");
    expect(payload.nodes.find((node) => node.name === "raw_osc")?.optype).toBe("oscinDAT");
    expect(payload.nodes.find((node) => node.name === "surface_map")?.table?.join(" ")).toContain(
      "panel_3",
    );
    expect(payload.nodes.find((node) => node.name === "cursor_map")?.table?.join(" ")).toContain(
      "cursor3_state",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created TUIO touch surface");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "tuio_touch_surface", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectTuioTouchSurfaceImpl(
      makeCtx(),
      connectTuioTouchSurfaceSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_tuio_touch_surface failed");
  });

  it("rejects invalid cursor counts", () => {
    expect(() => connectTuioTouchSurfaceSchema.parse({ cursor_count: 0 })).toThrow();
  });
});
