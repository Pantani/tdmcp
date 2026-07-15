import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createUnrealLivelinkBridgeImpl,
  createUnrealLivelinkBridgeSchema,
} from "../../src/tools/layer2/createUnrealLivelinkBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createUnrealLivelinkBridgeImpl", () => {
  it("builds an Unreal Live Link bridge payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "unreal_livelink_bridge",
          container_path: "/project1/unreal_livelink_bridge",
          nodes: { subject_map: "/project1/unreal_livelink_bridge/subject_map" },
          warnings: [],
        });
      }),
    );

    const args = createUnrealLivelinkBridgeSchema.parse({
      mode: "livelink_osc",
      unreal_host: "10.0.0.44",
      subject_name: "main_camera",
      sync_camera: true,
      sync_transform: true,
      preview_mode: "ndi",
      active: true,
    });
    const result = await createUnrealLivelinkBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("unreal_livelink_bridge");
    expect(payload.metadata.unreal_host).toBe("10.0.0.44");
    expect(payload.metadata.subject_name).toBe("main_camera");
    expect(payload.nodes.map((node) => node.name)).toContain("subject_map");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Unreal Live Link scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "unreal_livelink_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createUnrealLivelinkBridgeImpl(
      makeCtx(),
      createUnrealLivelinkBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_unreal_livelink_bridge failed");
  });

  it("rejects invalid preview modes", () => {
    expect(() => createUnrealLivelinkBridgeSchema.parse({ preview_mode: "spout" })).toThrow();
  });
});
