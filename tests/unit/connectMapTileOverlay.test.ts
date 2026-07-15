import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectMapTileOverlayImpl,
  connectMapTileOverlaySchema,
} from "../../src/tools/layer2/connectMapTileOverlay.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectMapTileOverlayImpl", () => {
  it("builds a map tile overlay scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "map_tile_overlay",
          container_path: "/project1/map_tile_overlay",
          nodes: { tile_layer_map: "/project1/map_tile_overlay/tile_layer_map" },
          warnings: [],
        });
      }),
    );

    const args = connectMapTileOverlaySchema.parse({
      provider: "maptiler",
      style_id: "dark",
      zoom_level: 10,
      layer_count: 3,
    });
    const result = await connectMapTileOverlayImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.provider).toBe("maptiler");
    expect(payload.nodes.find((node) => node.name === "tile_manifest_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(
      payload.nodes.find((node) => node.name === "tile_layer_map")?.table?.join(" "),
    ).toContain("layer_3");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created map tile overlay");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "map_tile_overlay", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectMapTileOverlayImpl(
      makeCtx(),
      connectMapTileOverlaySchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_map_tile_overlay failed");
  });

  it("rejects invalid zoom levels", () => {
    expect(() => connectMapTileOverlaySchema.parse({ zoom_level: 23 })).toThrow();
  });
});
