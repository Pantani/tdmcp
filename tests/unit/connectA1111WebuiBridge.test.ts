import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectA1111WebuiBridgeImpl,
  connectA1111WebuiBridgeSchema,
} from "../../src/tools/layer2/connectA1111WebuiBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectA1111WebuiBridgeImpl", () => {
  it("builds an A1111 WebUI bridge scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "a1111_webui_bridge",
          container_path: "/project1/a1111_webui_bridge",
          nodes: { prompt_slots: "/project1/a1111_webui_bridge/prompt_slots" },
          warnings: [],
        });
      }),
    );

    const args = connectA1111WebuiBridgeSchema.parse({
      endpoint_kind: "controlnet",
      prompt_slot_count: 3,
      include_controlnet: true,
    });
    const result = await connectA1111WebuiBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.endpoint_kind).toBe("controlnet");
    expect(payload.nodes.find((node) => node.name === "webui_client")?.optype).toBe("webclientDAT");
    expect(payload.nodes.find((node) => node.name === "prompt_slots")?.table?.join(" ")).toContain(
      "prompt_3",
    );
    expect(payload.nodes.find((node) => node.name === "result_map")?.table?.join(" ")).toContain(
      "control_image",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created A1111 WebUI bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "a1111_webui_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectA1111WebuiBridgeImpl(
      makeCtx(),
      connectA1111WebuiBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_a1111_webui_bridge failed");
  });

  it("rejects invalid prompt counts", () => {
    expect(() => connectA1111WebuiBridgeSchema.parse({ prompt_slot_count: 0 })).toThrow();
  });
});
