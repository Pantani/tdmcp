import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectRunwayVideoBridgeImpl,
  connectRunwayVideoBridgeSchema,
} from "../../src/tools/layer2/connectRunwayVideoBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectRunwayVideoBridgeImpl", () => {
  it("builds a Runway video bridge scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "runway_video_bridge",
          container_path: "/project1/runway_video_bridge",
          nodes: { prompt_map: "/project1/runway_video_bridge/prompt_map" },
          warnings: [],
        });
      }),
    );

    const args = connectRunwayVideoBridgeSchema.parse({
      generation_mode: "video_to_video",
      input_clip_path: "/show/input.mov",
      prompt_count: 3,
    });
    const result = await connectRunwayVideoBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.input_clip_path).toBe("/show/input.mov");
    expect(payload.nodes.find((node) => node.name === "input_clip")?.optype).toBe("moviefileinTOP");
    expect(payload.nodes.find((node) => node.name === "prompt_map")?.table?.join(" ")).toContain(
      "prompt_3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Runway video bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "runway_video_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectRunwayVideoBridgeImpl(
      makeCtx(),
      connectRunwayVideoBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_runway_video_bridge failed");
  });

  it("rejects invalid prompt counts", () => {
    expect(() => connectRunwayVideoBridgeSchema.parse({ prompt_count: 0 })).toThrow();
  });
});
