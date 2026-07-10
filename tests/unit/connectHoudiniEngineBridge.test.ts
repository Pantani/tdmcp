import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectHoudiniEngineBridgeImpl,
  connectHoudiniEngineBridgeSchema,
} from "../../src/tools/layer2/connectHoudiniEngineBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectHoudiniEngineBridgeImpl", () => {
  it("builds a Houdini Engine bridge scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "houdini_engine_bridge",
          container_path: "/project1/houdini_engine_bridge",
          nodes: { parameter_map: "/project1/houdini_engine_bridge/parameter_map" },
          warnings: [],
        });
      }),
    );

    const args = connectHoudiniEngineBridgeSchema.parse({
      handoff_mode: "websocket_json",
      hda_file: "/show/fx.hda",
      asset_format: "usd",
      parameter_count: 3,
    });
    const result = await connectHoudiniEngineBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.hda_file).toBe("/show/fx.hda");
    expect(payload.nodes.find((node) => node.name === "houdini_ws")?.optype).toBe("websocketDAT");
    expect(payload.nodes.find((node) => node.name === "parameter_map")?.table?.join(" ")).toContain(
      "parm_3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Houdini Engine bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "houdini_engine_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectHoudiniEngineBridgeImpl(
      makeCtx(),
      connectHoudiniEngineBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_houdini_engine_bridge failed");
  });

  it("rejects invalid parameter counts", () => {
    expect(() => connectHoudiniEngineBridgeSchema.parse({ parameter_count: 0 })).toThrow();
  });
});
