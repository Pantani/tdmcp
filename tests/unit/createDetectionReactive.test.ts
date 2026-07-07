import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createDetectionReactiveImpl,
  createDetectionReactiveSchema,
  parseWsUrl,
} from "../../src/tools/layer1/createDetectionReactive.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function captureExec(reportStdout?: string): { scripts: string[]; payloads: unknown[] } {
  const scripts: string[] = [];
  const payloads: unknown[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      const m = body.script.match(/b64decode\("([^"]+)"\)/);
      if (m?.[1]) payloads.push(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")));
      return HttpResponse.json({ ok: true, data: { result: null, stdout: reportStdout ?? "" } });
    }),
  );
  return { scripts, payloads };
}

function okReport(sourceType: string): string {
  return JSON.stringify({
    container: "/project1/detection",
    source: "/project1/detection/detector_ws",
    source_type: sourceType,
    channels_null: "/project1/detection/detections",
    channels: ["presence", "count", "obj1_x", "obj1_y", "obj1_w", "obj1_h", "obj1_score"],
    errors: [],
    warnings: [],
  });
}

const WS_ARGS = {
  name: "detection",
  parent_path: "/project1",
  source: "websocket" as const,
  url: "ws://127.0.0.1:8765",
  model_path: null,
  input_top: null,
  max_objects: 4,
  reconnect_seconds: 2,
};

describe("parseWsUrl", () => {
  it("splits ws:// and wss:// URLs into host + port", () => {
    expect(parseWsUrl("ws://127.0.0.1:8765")).toEqual({ host: "127.0.0.1", port: 8765 });
    expect(parseWsUrl("wss://detector.local:9000/stream")).toEqual({
      host: "detector.local",
      port: 9000,
    });
    expect(parseWsUrl("ws://host-only")).toEqual({ host: "host-only", port: 80 });
  });
});

describe("create_detection_reactive", () => {
  it("builds a websocket detector → Script CHOP → Null CHOP contract", async () => {
    const { scripts, payloads } = captureExec(okReport("DAT"));
    const result = await createDetectionReactiveImpl(makeCtx(), { ...WS_ARGS });
    expect(result.isError).toBeFalsy();

    const payload = payloads[0] as {
      source: string;
      url: string;
      ws_host: string;
      ws_port: number;
      max_objects: number;
    };
    expect(payload.source).toBe("websocket");
    expect(payload.url).toBe("ws://127.0.0.1:8765");
    expect(payload.ws_host).toBe("127.0.0.1");
    expect(payload.ws_port).toBe(8765);
    expect(payload.max_objects).toBe(4);

    expect(scripts[0]).toContain("websocketDAT");
    expect(scripts[0]).toContain("scriptCHOP");
    expect(scripts[0]).toContain("nullCHOP");
    expect(scripts[0]).toContain("onReceiveText");

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("presence");
  });

  it("builds an onnx CPU-inference scaffold with a Select TOP frame source", async () => {
    const { scripts, payloads } = captureExec(okReport("scriptCHOP(onnx)"));
    const result = await createDetectionReactiveImpl(makeCtx(), {
      ...WS_ARGS,
      source: "onnx",
      model_path: "/models/yolo.onnx",
      input_top: "/project1/cam1",
      max_objects: 2,
    });
    expect(result.isError).toBeFalsy();

    const payload = payloads[0] as {
      source: string;
      model_path: string;
      input_top: string;
      max_objects: number;
    };
    expect(payload.source).toBe("onnx");
    expect(payload.model_path).toBe("/models/yolo.onnx");
    expect(payload.input_top).toBe("/project1/cam1");
    expect(payload.max_objects).toBe(2);
    expect(scripts[0]).toContain("onnxruntime");
    expect(scripts[0]).toContain("selectTOP");
  });

  it("applies schema defaults", () => {
    const parsed = createDetectionReactiveSchema.parse({});
    expect(parsed.name).toBe("detection");
    expect(parsed.source).toBe("websocket");
    expect(parsed.url).toBe("ws://127.0.0.1:8765");
    expect(parsed.max_objects).toBe(4);
    expect(parsed.reconnect_seconds).toBe(2);
    expect(parsed.model_path).toBeNull();
  });

  it("rejects out-of-range max_objects", () => {
    expect(() => createDetectionReactiveSchema.parse({ max_objects: 0 })).toThrow();
    expect(() => createDetectionReactiveSchema.parse({ max_objects: 99 })).toThrow();
    expect(() => createDetectionReactiveSchema.parse({ source: "cuda" })).toThrow();
  });

  it("returns isError (never throws) on bridge fatal", async () => {
    captureExec(JSON.stringify({ fatal: "Parent COMP not found: /nope", warnings: [] }));
    const result = await createDetectionReactiveImpl(makeCtx(), {
      ...WS_ARGS,
      parent_path: "/nope",
    });
    expect(result.isError).toBe(true);
  });

  it("returns isError when the bridge is offline", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({ ok: false, error: "offline" }, { status: 502 }),
      ),
    );
    const result = await createDetectionReactiveImpl(makeCtx(), { ...WS_ARGS });
    expect(result.isError).toBe(true);
  });
});
