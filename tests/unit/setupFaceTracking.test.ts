import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  setupFaceTrackingImpl,
  setupFaceTrackingSchema,
} from "../../src/tools/layer2/setupFaceTracking.js";
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

/** Captures the script sent to /api/exec and returns it. */
function captureExecScript(report: Record<string, unknown>): { scripts: string[] } {
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

function run(args: Partial<Parameters<typeof setupFaceTrackingImpl>[1]> = {}) {
  return setupFaceTrackingImpl(makeCtx(), setupFaceTrackingSchema.parse(args));
}

describe("setup_face_tracking", () => {
  it("happy path default 468: builds adapter and returns summary", async () => {
    const { scripts } = captureExecScript({
      engine: "/project1/MediaPipe",
      face_dat: "/project1/MediaPipe/face",
      adapter_face: "/project1/mp_face_adapter/face",
    });

    const result = await run({ tox_path: "/x/MediaPipe.tox" });
    expect(result.isError).toBeFalsy();

    const text = textOf(result);
    expect(text).toContain("mp_face_adapter/face");

    // Parse embedded JSON summary
    const match = text.match(/```json\n([\s\S]+?)\n```/);
    expect(match).toBeTruthy();
    const summary = JSON.parse(match?.[1] ?? "");
    expect(summary.adapter_face_chop).toBe("/project1/mp_face_adapter/face");
    expect(summary.face_json_dat).toBe("/project1/MediaPipe/face");
    expect(summary.engine_loaded).toBe("/project1/MediaPipe");
    expect(summary.num_landmarks).toBe(468);

    // Assert script contains expected content
    const script = scripts[0] ?? "";
    expect(script).toContain("NUM_LMS = 468");
    expect(script).toContain("mp_face_adapter");
    expect(script).toContain("scriptCHOP");
    expect(script).toContain("root.time.play = True");
    expect(script).toContain("/x/MediaPipe.tox");
  });

  it("num_landmarks 478: script contains NUM_LMS = 478", async () => {
    const { scripts } = captureExecScript({
      engine: "/project1/MediaPipe",
      face_dat: "/project1/MediaPipe/face",
      adapter_face: "/project1/mp_face_adapter/face",
    });

    const result = await run({ tox_path: "/x/MediaPipe.tox", num_landmarks: 478 });
    expect(result.isError).toBeFalsy();

    const script = scripts[0] ?? "";
    expect(script).toContain("NUM_LMS = 478");

    const text = textOf(result);
    const match = text.match(/```json\n([\s\S]+?)\n```/);
    const summary = JSON.parse(match?.[1] ?? "");
    expect(summary.num_landmarks).toBe(478);
  });

  it("custom tox_path is quoted in script", async () => {
    const { scripts } = captureExecScript({
      engine: "/project1/MediaPipe",
      face_dat: "/project1/MediaPipe/face",
      adapter_face: "/project1/mp_face_adapter/face",
    });

    await run({ tox_path: "/custom/path/MediaPipe.tox" });

    const script = scripts[0] ?? "";
    expect(script).toContain("/custom/path/MediaPipe.tox");
  });

  it("tox_missing: returns isError with install instructions", async () => {
    captureExecScript({ error: "tox_missing" });

    const result = await run({ tox_path: "/nope/MediaPipe.tox" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("tdmcp install mediapipe-touchdesigner");
  });

  it("parent_missing: returns isError mentioning parent path", async () => {
    captureExecScript({ error: "parent_missing" });

    const result = await run({ tox_path: "/x/MediaPipe.tox", parent_path: "/bad/parent" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("/bad/parent");
  });

  it("missing face DAT: returns isError instructing to enable Face", async () => {
    captureExecScript({ engine: "/project1/MediaPipe", face_dat: null });

    const result = await run({ tox_path: "/x/MediaPipe.tox" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Face");
  });

  // Regression: the torinmb mediapipe-touchdesigner engine renamed its face
  // JSON DAT from `face` → `face_landmarks` → `face_landmark_results`. The
  // tool must probe a list of candidate names and fall back to a regex scan
  // so a future rename does not silently break setup.
  it("script probes the new + legacy face DAT names and uses a regex fallback", async () => {
    const { scripts } = captureExecScript({
      engine: "/project1/MediaPipe",
      face_dat: "/project1/MediaPipe/face_landmark_results",
      adapter_face: "/project1/mp_face_adapter/face",
    });

    await run({ tox_path: "/x/MediaPipe.tox" });
    const script = scripts[0] ?? "";
    expect(script).toContain("face_landmark_results");
    expect(script).toContain("face_landmarks");
    expect(script).toContain("face_json");
    expect(script).toContain("mp_face_landmarks");
    // Regex fallback string for unknown future names
    expect(script).toMatch(/face\.\*\(landmark\|result\|json\)/);
  });

  it("accepts the new face_landmark_results DAT name (engine rename)", async () => {
    captureExecScript({
      engine: "/project1/MediaPipe",
      face_dat: "/project1/MediaPipe/face_landmark_results",
      adapter_face: "/project1/mp_face_adapter/face",
    });
    const result = await run({ tox_path: "/x/MediaPipe.tox" });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    const summary = JSON.parse(text.match(/```json\n([\s\S]+?)\n```/)?.[1] ?? "{}");
    expect(summary.face_json_dat).toBe("/project1/MediaPipe/face_landmark_results");
  });

  it("accepts the legacy face_landmarks DAT name", async () => {
    captureExecScript({
      engine: "/project1/MediaPipe",
      face_dat: "/project1/MediaPipe/face_landmarks",
      adapter_face: "/project1/mp_face_adapter/face",
    });
    const result = await run({ tox_path: "/x/MediaPipe.tox" });
    expect(result.isError).toBeFalsy();
  });

  it("bridge throws TdConnectionError: returns errorResult without throwing", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        return HttpResponse.error();
      }),
    );

    const result = await run({ tox_path: "/x/MediaPipe.tox" });
    expect(result.isError).toBe(true);
    expect(() => result).not.toThrow();
  });
});
