import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  setupHandTrackingImpl,
  setupHandTrackingSchema,
} from "../../src/tools/layer2/setupHandTracking.js";
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

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function _captureExecScript(): { scripts: string[] } {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string; return_stdout?: boolean };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return { scripts };
}

function mockExecWithReport(report: Record<string, unknown>): { scripts: string[] } {
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

describe("setup_hand_tracking", () => {
  it("happy path defaults — builds adapter and returns summary", async () => {
    const { scripts } = mockExecWithReport({
      engine: "/project1/MediaPipe",
      hand_dat: "/project1/MediaPipe/hand",
      adapter_hand: "/project1/mp_hand_adapter/hand",
      max_hands: 2,
      coordinate_space: "world",
    });

    const result = await setupHandTrackingImpl(makeCtx(), {
      tox_path: "/x/MediaPipe.tox",
      parent_path: "/project1",
      max_hands: 2,
      coordinate_space: "world",
      adapter_name: "mp_hand_adapter",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/mp_hand_adapter/hand");
    expect(text).toContain("21 landmarks");

    const script = scripts[0];
    expect(script).toBeDefined();
    expect(script).toContain("HAND_COUNT = 2");
    expect(script).toContain("SPACE =");
    expect(script).toContain("mp_hand_adapter");
    expect(script).toContain("hand_cb");
    expect(script).toContain("worldLandmarks");
  });

  it("tox_missing — guides user to install", async () => {
    mockExecWithReport({ error: "tox_missing" });

    const result = await setupHandTrackingImpl(makeCtx(), {
      tox_path: "/nope/MediaPipe.tox",
      parent_path: "/project1",
      max_hands: 2,
      coordinate_space: "world",
      adapter_name: "mp_hand_adapter",
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("tdmcp install mediapipe-touchdesigner");
    expect(text).toContain("/nope/MediaPipe.tox");
  });

  it("parent_missing — returns friendly error", async () => {
    mockExecWithReport({ error: "parent_missing" });

    const result = await setupHandTrackingImpl(makeCtx(), {
      tox_path: "/x/MediaPipe.tox",
      parent_path: "/project99",
      max_hands: 2,
      coordinate_space: "world",
      adapter_name: "mp_hand_adapter",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("/project99");
  });

  it("hand_dat_missing — tells user to enable Hands", async () => {
    mockExecWithReport({ error: "hand_dat_missing", engine: "/project1/MediaPipe" });

    const result = await setupHandTrackingImpl(makeCtx(), {
      tox_path: "/x/MediaPipe.tox",
      parent_path: "/project1",
      max_hands: 2,
      coordinate_space: "world",
      adapter_name: "mp_hand_adapter",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("enable Hands");
  });

  it("max_hands=1 image space — script contains correct constants and centred-wrist branch", async () => {
    const { scripts } = mockExecWithReport({
      engine: "/project1/MediaPipe",
      hand_dat: "/project1/MediaPipe/hand",
      adapter_hand: "/project1/mp_hand_adapter/hand",
      max_hands: 1,
      coordinate_space: "image",
    });

    const result = await setupHandTrackingImpl(makeCtx(), {
      tox_path: "/x/MediaPipe.tox",
      parent_path: "/project1",
      max_hands: 1,
      coordinate_space: "image",
      adapter_name: "mp_hand_adapter",
    });

    expect(result.isError).toBeFalsy();

    const script = scripts[0];
    expect(script).toContain("HAND_COUNT = 1");
    expect(script).toContain(`SPACE = "image"`);
    // Centred-on-wrist branch uses cx/cy
    expect(script).toContain("cx");
    expect(script).toContain("cy");
  });

  it("bridge connection error — returns errorResult without throwing", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        return HttpResponse.error();
      }),
    );

    const result = await setupHandTrackingImpl(makeCtx(), {
      tox_path: "/x/MediaPipe.tox",
      parent_path: "/project1",
      max_hands: 2,
      coordinate_space: "world",
      adapter_name: "mp_hand_adapter",
    });

    expect(result.isError).toBe(true);
    // Must not throw — isError should be set
    const text = textOf(result);
    expect(typeof text).toBe("string");
  });

  it("schema — rejects max_hands > 2 and defaults coordinate_space to world", () => {
    expect(setupHandTrackingSchema.safeParse({ max_hands: 3 }).success).toBe(false);

    const parsed = setupHandTrackingSchema.parse({});
    expect(parsed.coordinate_space).toBe("world");
    expect(parsed.max_hands).toBe(2);
    expect(parsed.adapter_name).toBe("mp_hand_adapter");
    expect(parsed.parent_path).toBe("/project1");
  });

  it("samples count in result text reflects max_hands*21", async () => {
    mockExecWithReport({
      engine: "/project1/MediaPipe",
      hand_dat: "/project1/MediaPipe/hand",
      adapter_hand: "/project1/mp_hand_adapter/hand",
      max_hands: 1,
      coordinate_space: "world",
    });

    const result = await setupHandTrackingImpl(makeCtx(), {
      tox_path: "/x/MediaPipe.tox",
      parent_path: "/project1",
      max_hands: 1,
      coordinate_space: "world",
      adapter_name: "mp_hand_adapter",
    });

    expect(result.isError).toBeFalsy();
    // 1 * 21 = 21 samples
    expect(textOf(result)).toContain("21 samples");
  });
});
