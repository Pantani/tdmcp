import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectQlabCueStackImpl,
  connectQlabCueStackSchema,
} from "../../src/tools/layer2/connectQlabCueStack.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectQlabCueStackImpl", () => {
  it("builds a QLab OSC cue-stack scaffold payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "qlab_cue_stack",
          container_path: "/project1/qlab_cue_stack",
          nodes: { cue_map: "/project1/qlab_cue_stack/cue_map" },
          warnings: [],
        });
      }),
    );

    const args = connectQlabCueStackSchema.parse({
      qlab_host: "10.0.0.31",
      send_port: 53010,
      receive_port: 53011,
      workspace_id: "main-show",
      cue_count: 4,
      include_transport: true,
      active: true,
    });
    const result = await connectQlabCueStackImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("qlab_cue_stack");
    expect(payload.metadata.qlab_host).toBe("10.0.0.31");
    expect(payload.metadata.workspace_id).toBe("main-show");
    expect(payload.nodes.find((node) => node.name === "cue_map")?.table?.length).toBeGreaterThan(4);
    expect(capturedScript).toContain("nodeX");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created QLab cue-stack scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "qlab_cue_stack", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectQlabCueStackImpl(makeCtx(), connectQlabCueStackSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_qlab_cue_stack failed");
  });

  it("rejects invalid cue counts", () => {
    expect(() => connectQlabCueStackSchema.parse({ cue_count: 0 })).toThrow();
  });
});
