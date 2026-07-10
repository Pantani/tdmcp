import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectVdmxWorkspaceImpl,
  connectVdmxWorkspaceSchema,
} from "../../src/tools/layer2/connectVdmxWorkspace.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectVdmxWorkspaceImpl", () => {
  it("builds a VDMX workspace scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "vdmx_workspace",
          container_path: "/project1/vdmx_workspace",
          nodes: { layer_map: "/project1/vdmx_workspace/layer_map" },
          warnings: [],
        });
      }),
    );

    const args = connectVdmxWorkspaceSchema.parse({
      vdmx_host: "10.0.0.55",
      layer_count: 3,
      clip_count: 6,
      preview_mode: "ndi",
    });
    const result = await connectVdmxWorkspaceImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.preview_mode).toBe("ndi");
    expect(payload.nodes.find((node) => node.name === "preview_in")?.optype).toBe("ndiinTOP");
    expect(payload.nodes.find((node) => node.name === "layer_map")?.table?.join(" ")).toContain(
      "/vdmx/layer/3/trigger",
    );
    expect(payload.nodes.find((node) => node.name === "clip_map")?.table?.join(" ")).toContain(
      "/vdmx/clip/6/launch",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created VDMX workspace scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "vdmx_workspace", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectVdmxWorkspaceImpl(makeCtx(), connectVdmxWorkspaceSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_vdmx_workspace failed");
  });

  it("rejects invalid clip counts", () => {
    expect(() => connectVdmxWorkspaceSchema.parse({ clip_count: 0 })).toThrow();
  });
});
