import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createBodyBubblesImpl,
  createBodyBubblesSchema,
} from "../../src/tools/layer1/createBodyBubbles.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

interface PanelControl {
  name: string;
  type?: string;
  default?: unknown;
  bind_to?: string[];
}

interface BatchOperation {
  action: string;
  source_path?: string;
  target_path?: string;
  source_output?: number;
  target_input?: number;
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function captureCreateBodies(): CreatedNodeBody[] {
  const bodies: CreatedNodeBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedNodeBody;
      bodies.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
  );
  return bodies;
}

function captureExecScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

function captureBatchOperations(): BatchOperation[] {
  const operations: BatchOperation[] = [];
  server.use(
    http.post(`${TD_BASE}/api/batch`, async ({ request }) => {
      const body = (await request.json()) as { operations: BatchOperation[] };
      operations.push(...body.operations);
      return HttpResponse.json({
        ok: true,
        data: { results: body.operations.map((op) => ({ action: op.action, ok: true })) },
      });
    }),
  );
  return operations;
}

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

const BASE_ARGS = {
  name: "body_bubbles",
  parent_path: "/project1",
  hand_chop_path: "/project1/mp_hand_adapter/hand",
  body_chop_path: "/project1/mp_body_adapter/pose",
  camera_top_path: "/project1/MediaPipe/video",
  show_camera_background: true,
  hide_camera_tracking_overlays: true,
  camera_opacity: 1,
  bubble_count: 45,
  lifetime_seconds: 30,
  emit_on_open_palm: true,
  floor_bounce: 0.12,
  wall_bounce: 0.68,
  gravity: 0.28,
  body_radius: 0.11,
  hand_emit_rate: 8,
  palm_open_threshold: 0.08,
  drag: 0.95,
  buoyancy: 0.04,
  skeleton_impulse: 0.65,
  bubble_repulsion: 0.18,
  tracking_smoothing: 0.55,
  fallback_to_pose_wrists: false,
  show_body_contour: true,
  body_contour_width: 4,
  output_resolution: [1280, 720] as [number, number],
  expose_controls: true,
};

describe("create_body_bubbles", () => {
  it("builds a MediaPipe-ready bubble physics network with a rendered output", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const batchOperations = captureBatchOperations();

    const result = await createBodyBubblesImpl(makeCtx(), { ...BASE_ARGS });

    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "scriptCHOP" && b.name === "bubble_sim")).toBe(true);
    expect(bodies.some((b) => b.type === "scriptSOP" && b.name === "bubble_sop")).toBe(true);
    expect(bodies.some((b) => b.type === "geometryCOMP" && b.name === "bubbles_geo")).toBe(true);
    expect(bodies.some((b) => b.type === "scriptSOP" && b.name === "body_outline_sop")).toBe(true);
    expect(bodies.some((b) => b.type === "geometryCOMP" && b.name === "body_outline_geo")).toBe(
      true,
    );
    expect(bodies.some((b) => b.type === "selectTOP" && b.name === "camera_select")).toBe(true);
    expect(bodies.some((b) => b.type === "fitTOP" && b.name === "camera_fit")).toBe(true);
    expect(bodies.some((b) => b.type === "levelTOP" && b.name === "camera_level")).toBe(true);
    expect(bodies.some((b) => b.type === "compositeTOP" && b.name === "camera_composite")).toBe(
      true,
    );
    expect(bodies.some((b) => b.type === "renderTOP" && b.name === "render")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
    const render = bodies.find((b) => b.type === "renderTOP" && b.name === "render");
    expect(String(render?.parameters?.geometry)).toContain("/project1/body_bubbles/bubbles_geo");
    expect(String(render?.parameters?.geometry)).toContain(
      "/project1/body_bubbles/body_outline_geo",
    );

    const callbackScript = scripts.join("\n");
    expect(callbackScript).toContain("LIFETIME = 30.0");
    expect(callbackScript).toContain("COUNT = 45");
    expect(callbackScript).toContain("OPEN_THRESHOLD = 0.08");
    expect(callbackScript).toContain("open_palm");
    expect(callbackScript).toContain("palm_spread");
    expect(callbackScript).toContain("FALLBACK_TO_POSE_WRISTS = False");
    expect(callbackScript).toContain("pose_wrist_fallback");
    expect(callbackScript).toContain("BODY_CONTOUR_PATH");
    expect(callbackScript).toContain("BODY_OUTLINE_CHAINS");
    expect(callbackScript).toContain("BODY_CONTOUR_HOLD_SECONDS = 0.0");
    expect(callbackScript).toContain("BODY_CONTOUR_CONFIDENCE_THRESHOLD = 0.35");
    expect(callbackScript).toContain("BODY_CONFIDENCE_THRESHOLD = 0.35");
    expect(callbackScript).toContain("BODY_MIN_HEIGHT = 0.55");
    expect(callbackScript).toContain("BODY_CONTOUR_MIN_HEIGHT = 0.55");
    expect(callbackScript).toContain("c.cook(force=True)");
    expect(callbackScript).toContain("pose.cook(force=True)");
    expect(callbackScript).toContain("_has_body_anchor");
    expect(callbackScript).toContain("_has_pose_anchor");
    expect(callbackScript).toContain("Showoverlays");
    expect(callbackScript).toContain("floor_y");
    expect(callbackScript).toContain("body_radius");
    expect(callbackScript).toContain("screen_x");
    expect(callbackScript).toContain("DRAG = 0.95");
    expect(callbackScript).toContain("BUOYANCY = 0.04");
    expect(callbackScript).toContain("SKELETON_IMPULSE = 0.65");
    expect(callbackScript).toContain("BUBBLE_REPULSION = 0.18");
    expect(callbackScript).toContain("TRACKING_SMOOTHING = 0.55");
    expect(callbackScript).toContain("BODY_BUBBLES_STATE_");
    expect(callbackScript).toContain("BODY_CONTOUR_STATE_");
    expect(callbackScript).toContain("_finger_extension_score");
    expect(callbackScript).toContain("_separate_bubbles");
    expect(callbackScript).toContain("_smooth_points");
    expect(batchOperations).toContainEqual(
      expect.objectContaining({
        action: "connect",
        source_path: "/project1/body_bubbles/render",
        target_path: "/project1/body_bubbles/camera_composite",
        target_input: 0,
      }),
    );
    expect(batchOperations).toContainEqual(
      expect.objectContaining({
        action: "connect",
        source_path: "/project1/body_bubbles/camera_level",
        target_path: "/project1/body_bubbles/camera_composite",
        target_input: 1,
      }),
    );

    const text = textOf(result);
    expect(text).toContain("body-interactive bubble");
    expect(text).toContain("camera /project1/MediaPipe/video");
    expect(text).toContain("/project1/mp_hand_adapter/hand");
    expect(text).toContain("/project1/mp_body_adapter/pose");
  });

  it("exposes live controls for emission and physics tuning", async () => {
    const scripts = captureExecScripts();

    await createBodyBubblesImpl(makeCtx(), { ...BASE_ARGS });

    const controls = panelControls(scripts);
    expect(controls.find((c) => c.name === "EmitRate")?.default).toBe(8);
    expect(controls.find((c) => c.name === "PalmThreshold")?.default).toBe(0.08);
    expect(controls.find((c) => c.name === "Gravity")?.default).toBe(0.28);
    expect(controls.find((c) => c.name === "BodyRadius")?.default).toBe(0.11);
    expect(controls.find((c) => c.name === "Drag")?.default).toBe(0.95);
    expect(controls.find((c) => c.name === "Buoyancy")?.default).toBe(0.04);
    expect(controls.find((c) => c.name === "SkeletonImpulse")?.default).toBe(0.65);
    expect(controls.find((c) => c.name === "BubbleRepulsion")?.default).toBe(0.18);
    expect(controls.find((c) => c.name === "TrackingSmoothing")?.default).toBe(0.55);
    expect(controls.find((c) => c.name === "Lifetime")?.default).toBe(30);
    expect(controls.find((c) => c.name === "WallBounce")?.default).toBe(0.68);
    expect(controls.find((c) => c.name === "FloorBounce")?.default).toBe(0.12);
    expect(controls.find((c) => c.name === "BodyContour")?.default).toBe(1);
    expect(controls.find((c) => c.name === "ContourWidth")?.default).toBe(4);
    expect(controls.find((c) => c.name === "CameraOpacity")?.default).toBe(1);
  });

  it("validates inputs and applies installation-friendly defaults", () => {
    const defaults = createBodyBubblesSchema.parse({});
    expect(defaults.name).toBe("body_bubbles");
    expect(defaults.camera_top_path).toBe("/project1/MediaPipe/video");
    expect(defaults.show_camera_background).toBe(true);
    expect(defaults.hide_camera_tracking_overlays).toBe(true);
    expect(defaults.camera_opacity).toBe(1);
    expect(defaults.bubble_count).toBe(45);
    expect(defaults.lifetime_seconds).toBe(30);
    expect(defaults.emit_on_open_palm).toBe(true);
    expect(defaults.fallback_to_pose_wrists).toBe(false);
    expect(defaults.hand_emit_rate).toBe(8);
    expect(defaults.palm_open_threshold).toBe(0.08);
    expect(defaults.gravity).toBe(0.28);
    expect(defaults.body_radius).toBe(0.11);
    expect(defaults.wall_bounce).toBe(0.68);
    expect(defaults.floor_bounce).toBe(0.12);
    expect(defaults.drag).toBe(0.95);
    expect(defaults.buoyancy).toBe(0.04);
    expect(defaults.skeleton_impulse).toBe(0.65);
    expect(defaults.bubble_repulsion).toBe(0.18);
    expect(defaults.tracking_smoothing).toBe(0.55);
    expect(defaults.show_body_contour).toBe(true);
    expect(defaults.body_contour_width).toBe(4);
    expect(defaults.output_resolution).toEqual([1280, 720]);

    expect(() => createBodyBubblesSchema.parse({ bubble_count: 0 })).toThrow();
    expect(() => createBodyBubblesSchema.parse({ lifetime_seconds: 0 })).toThrow();
    expect(() => createBodyBubblesSchema.parse({ floor_bounce: 2 })).toThrow();
    expect(() => createBodyBubblesSchema.parse({ camera_opacity: 2 })).toThrow();
    expect(() => createBodyBubblesSchema.parse({ body_contour_width: -1 })).toThrow();
    expect(() => createBodyBubblesSchema.parse({ palm_open_threshold: 0 })).toThrow();
    expect(() => createBodyBubblesSchema.parse({ drag: -1 })).toThrow();
    expect(() => createBodyBubblesSchema.parse({ tracking_smoothing: 1 })).toThrow();
    expect(() => createBodyBubblesSchema.parse({ output_resolution: [0, 720] })).toThrow();
  });
});
