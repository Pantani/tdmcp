import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectReplicatePredictionBridgeImpl,
  connectReplicatePredictionBridgeSchema,
} from "../../src/tools/layer2/connectReplicatePredictionBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectReplicatePredictionBridgeImpl", () => {
  it("builds a Replicate prediction bridge scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "replicate_prediction_bridge",
          container_path: "/project1/replicate_prediction_bridge",
          nodes: { output_map: "/project1/replicate_prediction_bridge/output_map" },
          warnings: [],
        });
      }),
    );

    const args = connectReplicatePredictionBridgeSchema.parse({
      request_mode: "webhook_adapter",
      model_ref: "artist/model:abc123",
      output_mode: "video",
      webhook_url: "ws://127.0.0.1:9021",
    });
    const result = await connectReplicatePredictionBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.model_ref).toBe("artist/model:abc123");
    expect(payload.nodes.find((node) => node.name === "webhook_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(payload.nodes.find((node) => node.name === "output_map")?.table?.join(" ")).toContain(
      "result_url",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Replicate prediction bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({
          kind: "replicate_prediction_bridge",
          warnings: [],
          fatal: "Parent COMP not found",
        }),
      ),
    );

    const result = await connectReplicatePredictionBridgeImpl(
      makeCtx(),
      connectReplicatePredictionBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_replicate_prediction_bridge failed");
  });

  it("rejects invalid polling cadences", () => {
    expect(() => connectReplicatePredictionBridgeSchema.parse({ poll_seconds: 0 })).toThrow();
  });
});
