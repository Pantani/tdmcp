import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createBlenderSceneBridgeImpl,
  createBlenderSceneBridgeSchema,
} from "../../src/tools/layer2/createBlenderSceneBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createBlenderSceneBridgeImpl", () => {
  it("builds a Blender scene handoff payload without claiming Blender execution", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "blender_scene_bridge",
          container_path: "/project1/blender_scene_bridge",
          nodes: { handoff_config: "/project1/blender_scene_bridge/handoff_config" },
          warnings: [],
        });
      }),
    );

    const args = createBlenderSceneBridgeSchema.parse({
      handoff_mode: "websocket_json",
      asset_format: "alembic",
      sync_camera: true,
      sync_lights: true,
    });
    const result = await createBlenderSceneBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("blender_scene_bridge");
    expect(payload.metadata.handoff_mode).toBe("websocket_json");
    expect(payload.metadata.asset_format).toBe("alembic");
    expect(payload.warnings.join(" ")).toContain("does not launch Blender");
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created Blender scene bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "blender_scene_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createBlenderSceneBridgeImpl(
      makeCtx(),
      createBlenderSceneBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_blender_scene_bridge failed");
  });

  it("rejects unsupported asset formats", () => {
    expect(() => createBlenderSceneBridgeSchema.parse({ asset_format: "blend" })).toThrow();
  });
});
