import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildYoloOnnxTrackerScript,
  createYoloOnnxTrackerImpl,
  createYoloOnnxTrackerSchema,
  type YoloOnnxTrackerReport,
} from "../../src/tools/layer1/createYoloOnnxTracker.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface YoloPayload {
  parent_path: string;
  name: string;
  input_top_path: string | null;
  backend: "external_websocket" | "onnx_script" | "ndi_detections" | "file_watch";
  server_url: string;
  model_path: string | null;
  class_filter: string[];
  max_objects: number;
  confidence_threshold: number;
  active: boolean;
}

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

function run(args: z.input<typeof createYoloOnnxTrackerSchema>) {
  return createYoloOnnxTrackerImpl(makeCtx(), createYoloOnnxTrackerSchema.parse(args));
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function dataOf(result: CallToolResult): YoloOnnxTrackerReport {
  const payload = /```json\n([\s\S]*?)\n```/.exec(textOf(result))?.[1];
  if (payload === undefined) throw new Error("result did not include a JSON code fence");
  return JSON.parse(payload) as YoloOnnxTrackerReport;
}

function decodePayload(script: string): YoloPayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as YoloPayload;
}

function captureExec(report: YoloOnnxTrackerReport): { scripts: string[] } {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
  return { scripts };
}

function successReport(
  backend: YoloPayload["backend"],
  overrides: Partial<YoloOnnxTrackerReport> = {},
): YoloOnnxTrackerReport {
  return {
    container_path: "/project1/yolo_onnx_tracker",
    backend,
    server_url: "ws://127.0.0.1:8766",
    model_path: null,
    input_top_path: null,
    class_filter: [],
    max_objects: 16,
    confidence_threshold: 0.35,
    active: false,
    output_paths: {
      detections_dat: "/project1/yolo_onnx_tracker/detections",
      tracks_out: "/project1/yolo_onnx_tracker/tracks_out",
      annotated_out: "/project1/yolo_onnx_tracker/annotated_out",
    },
    nodes: {
      container: "/project1/yolo_onnx_tracker",
      source_in: "/project1/yolo_onnx_tracker/source_in",
      detections_dat: "/project1/yolo_onnx_tracker/detections",
      tracks_out: "/project1/yolo_onnx_tracker/tracks_out",
      annotated_out: "/project1/yolo_onnx_tracker/annotated_out",
    },
    channels: ["obj0_present", "obj0_x", "obj0_y", "obj0_w", "obj0_h", "obj0_score"],
    warnings: ["Live YOLO detection requires an external detector or onnxruntime."],
    errors: [],
    ...overrides,
  };
}

describe("createYoloOnnxTrackerSchema", () => {
  it("applies defaults and rejects invalid object counts/confidence", () => {
    const parsed = createYoloOnnxTrackerSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("yolo_onnx_tracker");
    expect(parsed.backend).toBe("external_websocket");
    expect(parsed.server_url).toBe("ws://127.0.0.1:8766");
    expect(parsed.class_filter).toEqual([]);
    expect(parsed.max_objects).toBe(16);
    expect(parsed.confidence_threshold).toBe(0.35);
    expect(parsed.active).toBe(false);

    expect(() => createYoloOnnxTrackerSchema.parse({ max_objects: 0 })).toThrow();
    expect(() => createYoloOnnxTrackerSchema.parse({ max_objects: 65 })).toThrow();
    expect(() => createYoloOnnxTrackerSchema.parse({ confidence_threshold: -0.01 })).toThrow();
    expect(() => createYoloOnnxTrackerSchema.parse({ confidence_threshold: 1.01 })).toThrow();
  });

  it("embeds the payload as base64 so quoted paths and model names survive", () => {
    const payload: YoloPayload = {
      parent_path: "/project1",
      name: 'tracker "main"',
      input_top_path: '/project1/camera "A"/out1',
      backend: "onnx_script",
      server_url: "ws://detector.local:8766",
      model_path: '/models/yolo "stage".onnx',
      class_filter: ["person", 'hand "left"'],
      max_objects: 7,
      confidence_threshold: 0.42,
      active: true,
    };

    expect(decodePayload(buildYoloOnnxTrackerScript(payload))).toEqual(payload);
  });
});

describe("createYoloOnnxTrackerImpl", () => {
  it("builds the websocket scaffold and returns stable output paths with warnings", async () => {
    const cap = captureExec(
      successReport("external_websocket", {
        input_top_path: "/project1/camera/out1",
        class_filter: ["person"],
        active: true,
      }),
    );

    const result = await run({
      input_top_path: "/project1/camera/out1",
      backend: "external_websocket",
      server_url: "ws://localhost:8766",
      class_filter: ["person"],
      max_objects: 12,
      confidence_threshold: 0.5,
      active: true,
    });

    expect(result.isError).toBeFalsy();
    const script = cap.scripts[0] ?? "";
    expect(script).toContain("websocketDAT");
    expect(script).toContain("detections_raw");
    expect(script).toContain("nodeX");
    expect(script).toContain("nodeY");
    expect(script).toContain("_place_generated_callbacks");
    expect(script).toContain("result = json.dumps(report)");

    const payload = decodePayload(script);
    expect(payload).toMatchObject({
      backend: "external_websocket",
      input_top_path: "/project1/camera/out1",
      server_url: "ws://localhost:8766",
      class_filter: ["person"],
      max_objects: 12,
      confidence_threshold: 0.5,
      active: true,
    });

    const data = dataOf(result);
    expect(data.output_paths?.detections_dat).toBe("/project1/yolo_onnx_tracker/detections");
    expect(data.output_paths?.tracks_out).toBe("/project1/yolo_onnx_tracker/tracks_out");
    expect(data.output_paths?.annotated_out).toBe("/project1/yolo_onnx_tracker/annotated_out");
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(textOf(result)).toContain("YOLO/ONNX tracker scaffold created");
  });

  it("builds the onnx_script scaffold with model_path and onnxruntime notes", async () => {
    const cap = captureExec(
      successReport("onnx_script", {
        model_path: "/models/yolov8n.onnx",
        class_filter: ["person", "hand"],
      }),
    );

    const result = await run({
      backend: "onnx_script",
      model_path: "/models/yolov8n.onnx",
      class_filter: ["person", "hand"],
      confidence_threshold: 0.6,
      max_objects: 8,
    });

    expect(result.isError).toBeFalsy();
    const script = cap.scripts[0] ?? "";
    expect(script).toContain("scriptCHOP");
    expect(script).toContain("onnxruntime");

    const payload = decodePayload(script);
    expect(payload.backend).toBe("onnx_script");
    expect(payload.model_path).toBe("/models/yolov8n.onnx");
    expect(payload.class_filter).toEqual(["person", "hand"]);
    expect(payload.confidence_threshold).toBe(0.6);
    expect(payload.max_objects).toBe(8);

    const data = dataOf(result);
    expect(data.backend).toBe("onnx_script");
    expect(data.output_paths?.tracks_out).toBe("/project1/yolo_onnx_tracker/tracks_out");
  });

  it("returns isError without throwing when the bridge reports a missing parent", async () => {
    captureExec({
      warnings: [],
      errors: [],
      fatal: "Parent COMP not found: /missing",
    });

    await expect(run({ parent_path: "/missing" })).resolves.toMatchObject({ isError: true });
  });

  it("converts bridge request failures into isError results", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    const result = await run({ backend: "file_watch" });

    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
  });
});
