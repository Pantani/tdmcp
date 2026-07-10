import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectHuggingfaceInferenceBridgeImpl,
  connectHuggingfaceInferenceBridgeSchema,
} from "../../src/tools/layer2/connectHuggingfaceInferenceBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectHuggingfaceInferenceBridgeImpl", () => {
  it("builds a Hugging Face inference bridge scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "huggingface_inference_bridge",
          container_path: "/project1/huggingface_inference_bridge",
          nodes: { input_map: "/project1/huggingface_inference_bridge/input_map" },
          warnings: [],
        });
      }),
    );

    const args = connectHuggingfaceInferenceBridgeSchema.parse({
      task: "audio_to_text",
      output_mode: "text",
      input_slot_count: 5,
      token_env_name: "SHOW_HF_TOKEN",
    });
    const result = await connectHuggingfaceInferenceBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.task).toBe("audio_to_text");
    expect(payload.nodes.find((node) => node.name === "hf_client")?.optype).toBe("webclientDAT");
    expect(payload.nodes.find((node) => node.name === "input_map")?.table?.join(" ")).toContain(
      "input_5",
    );
    expect(payload.nodes.find((node) => node.name === "status")?.table?.join(" ")).toContain(
      "SHOW_HF_TOKEN",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Hugging Face inference bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({
          kind: "huggingface_inference_bridge",
          warnings: [],
          fatal: "Parent COMP not found",
        }),
      ),
    );

    const result = await connectHuggingfaceInferenceBridgeImpl(
      makeCtx(),
      connectHuggingfaceInferenceBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_huggingface_inference_bridge failed");
  });

  it("rejects invalid input slot counts", () => {
    expect(() => connectHuggingfaceInferenceBridgeSchema.parse({ input_slot_count: 0 })).toThrow();
  });
});
