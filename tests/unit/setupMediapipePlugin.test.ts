import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  setupMediapipePluginImpl,
  setupMediapipePluginSchema,
} from "../../src/tools/layer1/setupMediapipePlugin.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Wave-4 fix: setupMediapipePluginImpl pre-checks candidate .tox paths on the Node
// side and short-circuits BEFORE the bridge call when none exist on disk. Tests
// that need the bridge to be reached must point tox_path at a real on-disk fixture
// so the precheck passes and the msw mock fires.
const TMP_DIR = mkdtempSync(join(tmpdir(), "tdmcp-mediapipe-test-"));
const FIXTURE_TOX = join(TMP_DIR, "MediaPipe.tox");
writeFileSync(FIXTURE_TOX, "stub");
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function textOf(result: Awaited<ReturnType<typeof setupMediapipePluginImpl>>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Mock the /api/exec endpoint to return the given report JSON as stdout. */
function mockExec(report: Record<string, unknown>, capturedScripts?: string[]): void {
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      capturedScripts?.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
}

function run(args: Parameters<typeof setupMediapipePluginSchema.parse>[0] = {}) {
  return setupMediapipePluginImpl(makeCtx(), setupMediapipePluginSchema.parse(args));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setup_mediapipe_plugin", () => {
  // Case 1: happy path — defaults (hand + body)
  it("happy path defaults: hand+body enabled, returns correct envelope", async () => {
    const scripts: string[] = [];
    mockExec(
      {
        container_path: "/project1/MediaPipe",
        dropped_tox_path:
          "/home/user/tdmcp-packages/mediapipe-touchdesigner/release/toxes/MediaPipe.tox",
        exports: {
          face_chop: null,
          hand_chop: "/project1/MediaPipe/hand",
          body_chop: "/project1/MediaPipe/pose",
          segmentation_top: null,
        },
        enabled: { face: false, hand: true, body: true, segmentation: false },
        video_source: { par: "Camera", value: "live webcam" },
        warnings: [],
      },
      scripts,
    );

    const result = await run({
      tox_path: FIXTURE_TOX,
      enable_hand: true,
      enable_body: true,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/MediaPipe");
    expect(text).toContain("hand");
    expect(text).toContain("body");

    // Assert the timeline-play instruction is dispatched in one of the bridge scripts
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.some((s) => s.includes("time.play"))).toBe(true);
  });

  // Case 2: all four modalities enabled
  it("all four enabled: sets all four pars and returns all export keys", async () => {
    const scripts: string[] = [];
    mockExec(
      {
        container_path: "/project1/MediaPipe",
        dropped_tox_path:
          "/home/user/tdmcp-packages/mediapipe-touchdesigner/release/toxes/MediaPipe.tox",
        exports: {
          face_chop: "/project1/MediaPipe/face",
          hand_chop: "/project1/MediaPipe/hand",
          body_chop: "/project1/MediaPipe/pose",
          segmentation_top: "/project1/MediaPipe/segmentation",
        },
        enabled: { face: true, hand: true, body: true, segmentation: true },
        video_source: { par: "Camera", value: "live webcam" },
        warnings: [],
      },
      scripts,
    );

    const result = await run({
      tox_path: FIXTURE_TOX,
      enable_face: true,
      enable_hand: true,
      enable_body: true,
      enable_segmentation: true,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("face");
    expect(text).toContain("hand");
    expect(text).toContain("body");
    expect(text).toContain("segmentation");

    // Assert payload carries all four flags (in the configure-pass script)
    const combined = scripts.join("\n");
    expect(combined).toContain("enable_face");
    expect(combined).toContain("enable_hand");
    expect(combined).toContain("enable_body");
    expect(combined).toContain("enable_segmentation");
  });

  // Case 3: no-flag refinement — Zod error before any bridge call
  it("all flags false: throws ZodError before any bridge call", () => {
    expect(() =>
      setupMediapipePluginSchema.parse({
        enable_face: false,
        enable_hand: false,
        enable_body: false,
        enable_segmentation: false,
      }),
    ).toThrow(ZodError);
  });

  // Case 4: missing tox — engine not found via the shared dropExternalTox helper.
  // The helper recognises `no_candidate_found`; the wrapper enriches with the install hint.
  it("missing tox: surfaces install hint in error message", async () => {
    mockExec({
      error: "no_candidate_found",
      candidates_checked: ["/nonexistent/MediaPipe.tox"],
      warnings: [],
    });

    const result = await run({
      tox_path: "/nonexistent/MediaPipe.tox",
      enable_hand: true,
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("tdmcp install mediapipe-touchdesigner");
  });

  // Case 5: video-source par fallback — Camera missing, Source present
  it("video-source fallback: Camera missing, Source used, warning reported", async () => {
    mockExec({
      container_path: "/project1/MediaPipe",
      dropped_tox_path:
        "/home/user/tdmcp-packages/mediapipe-touchdesigner/release/toxes/MediaPipe.tox",
      exports: {
        face_chop: null,
        hand_chop: "/project1/MediaPipe/hand",
        body_chop: "/project1/MediaPipe/pose",
        segmentation_top: null,
      },
      enabled: { face: false, hand: true, body: true, segmentation: false },
      video_source: { par: "Source", value: "/Users/user/clips/test.mov" },
      warnings: ["Camera par missing; used Source"],
    });

    const result = await run({
      tox_path: FIXTURE_TOX,
      enable_hand: true,
      enable_body: true,
      source_video_path: "/Users/user/clips/test.mov",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // video_source.par must be "Source"
    expect(text).toContain('"par": "Source"');
    // warning must be surfaced
    expect(text).toContain("Camera par missing; used Source");
  });
});
