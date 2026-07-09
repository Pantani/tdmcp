import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createViosoWarpPanelImpl,
  createViosoWarpPanelSchema,
} from "../../src/tools/layer2/createViosoWarpPanel.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createViosoWarpPanelImpl", () => {
  it("builds a VIOSO warp panel scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "vioso_warp_panel",
          container_path: "/project1/vioso_warp_panel",
          nodes: { blend_zone_map: "/project1/vioso_warp_panel/blend_zone_map" },
          warnings: [],
        });
      }),
    );

    const args = createViosoWarpPanelSchema.parse({
      config_file: "/calibration/vioso.vwf",
      projector_index: 2,
      blend_zone_count: 5,
    });
    const result = await createViosoWarpPanelImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.projector_index).toBe(2);
    expect(payload.nodes.find((node) => node.name === "vioso_warp")?.optype).toBe("viosoTOP");
    expect(
      payload.nodes.find((node) => node.name === "blend_zone_map")?.table?.join(" "),
    ).toContain("blend_5");
    expect(payload.connections).toContainEqual({ from: "vioso_warp", to: "warp_out" });
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created VIOSO warp panel");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "vioso_warp_panel", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createViosoWarpPanelImpl(makeCtx(), createViosoWarpPanelSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_vioso_warp_panel failed");
  });

  it("rejects invalid blend zone counts", () => {
    expect(() => createViosoWarpPanelSchema.parse({ blend_zone_count: 0 })).toThrow();
  });
});
