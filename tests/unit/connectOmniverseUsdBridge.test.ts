import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectOmniverseUsdBridgeImpl,
  connectOmniverseUsdBridgeSchema,
} from "../../src/tools/layer2/connectOmniverseUsdBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectOmniverseUsdBridgeImpl", () => {
  it("builds an Omniverse USD bridge scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "omniverse_usd_bridge",
          container_path: "/project1/omniverse_usd_bridge",
          nodes: { layer_map: "/project1/omniverse_usd_bridge/layer_map" },
          warnings: [],
        });
      }),
    );

    const args = connectOmniverseUsdBridgeSchema.parse({
      sync_mode: "nucleus_live",
      nucleus_url: "omniverse://nucleus.local/Shows/a",
      layer_count: 5,
      variant_count: 2,
    });
    const result = await connectOmniverseUsdBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.nucleus_url).toBe("omniverse://nucleus.local/Shows/a");
    expect(payload.nodes.find((node) => node.name === "nucleus_status")?.optype).toBe(
      "webclientDAT",
    );
    expect(payload.nodes.find((node) => node.name === "layer_map")?.table?.join(" ")).toContain(
      "layer_5",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Omniverse USD bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "omniverse_usd_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectOmniverseUsdBridgeImpl(
      makeCtx(),
      connectOmniverseUsdBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_omniverse_usd_bridge failed");
  });

  it("rejects invalid layer counts", () => {
    expect(() => connectOmniverseUsdBridgeSchema.parse({ layer_count: 0 })).toThrow();
  });
});
