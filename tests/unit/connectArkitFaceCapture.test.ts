import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectArkitFaceCaptureImpl,
  connectArkitFaceCaptureSchema,
} from "../../src/tools/layer2/connectArkitFaceCapture.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectArkitFaceCaptureImpl", () => {
  it("builds an ARKit face-capture scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "arkit_face_capture",
          container_path: "/project1/arkit_face_capture",
          nodes: { blendshape_map: "/project1/arkit_face_capture/blendshape_map" },
          warnings: [],
        });
      }),
    );

    const args = connectArkitFaceCaptureSchema.parse({
      receive_port: 12000,
      face_count: 2,
      blendshape_count: 8,
      active: true,
    });
    const result = await connectArkitFaceCaptureImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.receive_port).toBe(12000);
    expect(
      payload.nodes.find((node) => node.name === "blendshape_map")?.table?.join(" "),
    ).toContain("jawOpen");
    expect(
      payload.nodes.find((node) => node.name === "head_transform_map")?.table?.join(" "),
    ).toContain("/arkit/face/1/head/rz");
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created ARKit face-capture scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "arkit_face_capture", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectArkitFaceCaptureImpl(
      makeCtx(),
      connectArkitFaceCaptureSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_arkit_face_capture failed");
  });

  it("rejects invalid blendshape counts", () => {
    expect(() => connectArkitFaceCaptureSchema.parse({ blendshape_count: 0 })).toThrow();
  });
});
