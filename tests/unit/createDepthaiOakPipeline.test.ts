import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDepthaiOakPipelineImpl,
  createDepthaiOakPipelineSchema,
} from "../../src/tools/layer2/createDepthaiOakPipeline.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createDepthaiOakPipelineImpl", () => {
  it("builds a DepthAI/OAK pipeline scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "depthai_oak_pipeline",
          container_path: "/project1/depthai_oak_pipeline",
          nodes: { oak_device: "/project1/depthai_oak_pipeline/oak_device" },
          warnings: [],
        });
      }),
    );

    const args = createDepthaiOakPipelineSchema.parse({
      device_name: "oak-d-pro",
      stream_count: 4,
      include_depth: true,
      include_tracking: true,
    });
    const result = await createDepthaiOakPipelineImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("depthai_oak_pipeline");
    expect(payload.metadata.device_name).toBe("oak-d-pro");
    expect(payload.nodes.find((node) => node.name === "stream_map")?.table?.join(" ")).toContain(
      "aux_4",
    );
    expect(capturedScript).toContain("nodeX");
    expect(capturedScript).toContain("_place_generated_callbacks");
    expect(textOf(result)).toContain("Created DepthAI/OAK scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "depthai_oak_pipeline", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createDepthaiOakPipelineImpl(
      makeCtx(),
      createDepthaiOakPipelineSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_depthai_oak_pipeline failed");
  });

  it("rejects invalid stream counts", () => {
    expect(() => createDepthaiOakPipelineSchema.parse({ stream_count: 0 })).toThrow();
  });
});
