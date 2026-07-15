import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createArtnetDiscoveryPanelImpl,
  createArtnetDiscoveryPanelSchema,
} from "../../src/tools/layer2/createArtnetDiscoveryPanel.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createArtnetDiscoveryPanelImpl", () => {
  it("builds an Art-Net discovery panel scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "artnet_discovery_panel",
          container_path: "/project1/artnet_discovery_panel",
          nodes: { device_map: "/project1/artnet_discovery_panel/device_map" },
          warnings: [],
        });
      }),
    );

    const args = createArtnetDiscoveryPanelSchema.parse({
      net: 2,
      subnet: 3,
      universe_count: 3,
      device_count: 4,
      include_dmx_monitor: false,
    });
    const result = await createArtnetDiscoveryPanelImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.net).toBe(2);
    expect(payload.nodes.find((node) => node.name === "artnet_devices")?.optype).toBe("artnetDAT");
    expect(payload.nodes.find((node) => node.name === "dmx_monitor")?.optype).toBe("dmxinCHOP");
    expect(payload.nodes.find((node) => node.name === "device_map")?.table?.join(" ")).toContain(
      "node_4",
    );
    expect(payload.nodes.find((node) => node.name === "universe_map")?.table?.join(" ")).toContain(
      "dmx_universe_2",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Art-Net discovery panel");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "artnet_discovery_panel", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createArtnetDiscoveryPanelImpl(
      makeCtx(),
      createArtnetDiscoveryPanelSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_artnet_discovery_panel failed");
  });

  it("rejects invalid subnet values", () => {
    expect(() => createArtnetDiscoveryPanelSchema.parse({ subnet: 16 })).toThrow();
  });
});
