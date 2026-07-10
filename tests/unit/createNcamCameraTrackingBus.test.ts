import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createNcamCameraTrackingBusImpl,
  createNcamCameraTrackingBusSchema,
} from "../../src/tools/layer2/createNcamCameraTrackingBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createNcamCameraTrackingBusImpl", () => {
  it("builds an NCAM camera tracking bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "ncam_camera_tracking_bus",
          container_path: "/project1/ncam_camera_tracking_bus",
          nodes: { camera_map: "/project1/ncam_camera_tracking_bus/camera_map" },
          warnings: [],
        });
      }),
    );

    const args = createNcamCameraTrackingBusSchema.parse({
      camera_count: 2,
      lens_profile_count: 3,
      include_video_top: false,
    });
    const result = await createNcamCameraTrackingBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.include_video_top).toBe(false);
    expect(payload.nodes.find((node) => node.name === "ncam_chop")?.optype).toBe("ncamCHOP");
    expect(payload.nodes.find((node) => node.name === "ncam_top")).toBeUndefined();
    expect(payload.nodes.find((node) => node.name === "camera_map")?.table?.join(" ")).toContain(
      "camera_2",
    );
    expect(payload.nodes.find((node) => node.name === "lens_map")?.table?.join(" ")).toContain(
      "lens_3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created NCAM camera tracking bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "ncam_camera_tracking_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createNcamCameraTrackingBusImpl(
      makeCtx(),
      createNcamCameraTrackingBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_ncam_camera_tracking_bus failed");
  });

  it("rejects invalid camera counts", () => {
    expect(() => createNcamCameraTrackingBusSchema.parse({ camera_count: 0 })).toThrow();
  });
});
