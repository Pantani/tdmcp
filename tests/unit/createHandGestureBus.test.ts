import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createHandGestureBusImpl,
  createHandGestureBusSchema,
  registerCreateHandGestureBus,
} from "../../src/tools/layer2/createHandGestureBus.js";
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

function gestureReport(over: Record<string, unknown> = {}) {
  return {
    container_path: "/project1/hand_gesture_bus",
    source: "synthetic",
    hand_chop: "/project1/hand_gesture_bus/synthetic_hands",
    gesture_chop: "/project1/hand_gesture_bus/gesture",
    gesture_bus: "/project1/hand_gesture_bus/gesture_bus",
    state_dat: "/project1/hand_gesture_bus/state_json",
    channels: [
      "on",
      "has_hand",
      "active_hand",
      "palm_open",
      "palm_x",
      "palm_y",
      "float_x",
      "float_y",
      "palm_size",
      "palm_rot",
      "palm_confidence",
      "held_tracking",
      "pinch_active",
      "pinch_power",
      "pinch_measured",
      "pinch_near",
      "pinch_close",
      "pinch_x",
      "pinch_y",
      "scale_target",
      "light_gain",
      "audio_level",
    ],
    controls: [],
    warnings: [],
    errors: [],
    ...over,
  };
}

function mockExecReports(reports: Array<Record<string, unknown>>): { scripts: string[] } {
  const scripts: string[] = [];
  const queue = [...reports];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      const report = queue.shift() ?? {};
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
  return { scripts };
}

function run(args: Partial<z.input<typeof createHandGestureBusSchema>> = {}) {
  return createHandGestureBusImpl(makeCtx(), createHandGestureBusSchema.parse(args));
}

describe("create_hand_gesture_bus", () => {
  it("schema defaults build a synthetic, two-hand gesture bus", () => {
    const parsed = createHandGestureBusSchema.parse({});
    expect(parsed.source).toBe("synthetic");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.comp_name).toBe("hand_gesture_bus");
    expect(parsed.max_hands).toBe(2);
    expect(parsed.coordinate_space).toBe("world");
    expect(parsed.mirror).toBe(true);
    expect(parsed.smoothing).toBe(0.46);
    expect(parsed.fast_smoothing).toBe(0.82);
    expect(parsed.pinch_arm_seconds).toBe(0.11);
    expect(parsed.pinch_threshold).toBe(0.38);
    expect(parsed.active_hand_lock).toBe(true);
  });

  it("rejects an inverted pinch distance range", () => {
    const parsed = createHandGestureBusSchema.safeParse({
      pinch_close_dist: 0.2,
      pinch_open_dist: 0.1,
    });
    expect(parsed.success).toBe(false);
  });

  it("synthetic mode sends one payload and returns the gesture bus channels", async () => {
    const { scripts } = mockExecReports([gestureReport()]);
    const result = await run({
      smoothing: 0.5,
      fast_smoothing: 0.8,
      hold_seconds: 0.2,
      pinch_threshold: 0.42,
    });

    expect(result.isError).toBeFalsy();
    expect(scripts).toHaveLength(1);
    expect(textOf(result)).toContain("Hand gesture bus ready");
    expect(textOf(result)).toContain("palm");
    expect(textOf(result)).toContain("pinch");

    const payload = decodePayload(scripts[0] as string);
    expect(payload.source).toBe("synthetic");
    expect(payload.hand_chop).toBe("/project1/mp_hand_adapter/hand");
    expect(payload.smoothing).toBe(0.5);
    expect(payload.fast_smoothing).toBe(0.8);
    expect(payload.hold_seconds).toBe(0.2);
    expect(payload.pinch_threshold).toBe(0.42);

    expect(scripts[0]).toContain("SYNTHETIC_CB");
    expect(scripts[0]).toContain("gesture_bus");
    expect(scripts[0]).toContain("pinch_measured");
    expect(scripts[0]).toContain("PINCH_ARM_SECONDS");
    expect(scripts[0]).toContain("active_hand");
    expect(scripts[0]).toContain("if pars is not None and len(pars) > 0:");
    expect(scripts[0]).not.toContain("if pars:");
    expect(scripts[0]).toContain("if default is None:");
    expect(scripts[0]).toContain("_place_comp_in_grid(parent, comp)");
    expect(scripts[0]).toContain("comp.nodeY = -((k % rows) * cell_h)");
    expect(scripts[0]).toContain('_safe_destroy_child(comp, "synthetic_hands_callbacks")');
    expect(scripts[0]).toContain('_safe_destroy_child(comp, "gesture_callbacks")');
  });

  it("existing_chop mode uses the supplied hand CHOP and does not run setup first", async () => {
    const { scripts } = mockExecReports([
      gestureReport({
        source: "existing_chop",
        hand_chop: "/project1/custom_hand/out1",
      }),
    ]);

    const result = await run({
      source: "existing_chop",
      hand_chop_path: "/project1/custom_hand/out1",
      max_hands: 1,
      expose_controls: false,
    });

    expect(result.isError).toBeFalsy();
    expect(scripts).toHaveLength(1);
    const payload = decodePayload(scripts[0] as string);
    expect(payload.source).toBe("existing_chop");
    expect(payload.hand_chop).toBe("/project1/custom_hand/out1");
    expect(payload.max_hands).toBe(1);
    expect(payload.expose_controls).toBe(false);
    expect(scripts[0]).toContain('sx = _sample(chop, "screen_x", idx, None)');
    expect(scripts[0]).toContain("if default is None:");
  });

  it("requires hand_chop_path for existing_chop mode", async () => {
    const result = await createHandGestureBusImpl(
      makeCtx(),
      createHandGestureBusSchema.parse({ source: "existing_chop" }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("hand_chop_path is required");
  });

  it("mediapipe mode runs setup_hand_tracking first and forwards the adapter CHOP", async () => {
    const { scripts } = mockExecReports([
      {
        engine: "/project1/MediaPipe",
        hand_dat: "/project1/MediaPipe/hand",
        adapter_hand: "/project1/mp_hand_adapter/hand",
        max_hands: 2,
        coordinate_space: "world",
      },
      gestureReport({
        source: "mediapipe",
        hand_chop: "/project1/hand_gesture_bus/hand_in",
      }),
    ]);

    const result = await run({
      source: "mediapipe",
      tox_path: "/x/MediaPipe.tox",
      coordinate_space: "image",
    });

    expect(result.isError).toBeFalsy();
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain("HAND_COUNT = 2");
    expect(scripts[0]).toContain("/x/MediaPipe.tox");
    const payload = decodePayload(scripts[1] as string);
    expect(payload.source).toBe("mediapipe");
    expect(payload.hand_chop).toBe("/project1/mp_hand_adapter/hand");
    expect(payload.coordinate_space).toBe("image");
  });

  it("embeds active-hand locking, dropped-frame hold, and measured-vs-active pinch logic", async () => {
    const { scripts } = mockExecReports([gestureReport()]);
    await run();

    const script = scripts[0] as string;
    expect(script).toContain("Activehandlock");
    expect(script).toContain("last_state");
    expect(script).toContain("held_tracking");
    expect(script).toContain("pinch_measured");
    expect(script).toContain("pinch_power");
    expect(script).toContain("strong and now - arm_start");
  });

  it("fatal reports return isError with the structured report", async () => {
    mockExecReports([gestureReport({ fatal: "Parent COMP not found: /missing" })]);
    const result = await run({ parent_path: "/missing" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
    expect(textOf(result)).toContain('"fatal"');
  });

  it("registered handler enforces refined pinch distance validation", () => {
    let handler: ((args: Record<string, unknown>) => unknown) | undefined;
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, captured: typeof handler) => {
        handler = captured;
      },
    };

    registerCreateHandGestureBus(fakeServer as never, makeCtx());

    expect(() =>
      handler?.({
        pinch_close_dist: 0.2,
        pinch_open_dist: 0.1,
      }),
    ).toThrow(/pinch_open_dist must be greater than pinch_close_dist/);
  });

  it("bridge connection errors return an error result without throwing", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        return HttpResponse.error();
      }),
    );

    const result = await run();
    expect(result.isError).toBe(true);
    expect(typeof textOf(result)).toBe("string");
  });
});
