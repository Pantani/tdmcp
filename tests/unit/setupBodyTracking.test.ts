import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  setupBodyTrackingImpl,
  setupBodyTrackingSchema,
} from "../../src/tools/layer1/setupBodyTracking.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
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

/** Detects the engine load/adapter script (which carries the loadTox call + tox path). */
function isLoadScript(script: string): boolean {
  return script.includes("loadTox") || script.includes("MediaPipe.tox");
}

/** Mocks the bridge: the load/adapter script returns `report`; all other exec calls return empty. */
function mockBridge(report: Record<string, unknown>): {
  bodies: CreatedNodeBody[];
  scripts: string[];
} {
  const bodies: CreatedNodeBody[] = [];
  const scripts: string[] = [];
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
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const script = ((await request.json()) as { script: string }).script;
      scripts.push(script);
      const stdout = isLoadScript(script) ? JSON.stringify(report) : "";
      return HttpResponse.json({ ok: true, data: { result: null, stdout } });
    }),
  );
  return { bodies, scripts };
}

function run(args: Partial<z.input<typeof setupBodyTrackingSchema>> = {}) {
  return setupBodyTrackingImpl(makeCtx(), setupBodyTrackingSchema.parse(args));
}

describe("setup_body_tracking", () => {
  it("loads the engine, builds the JSON→CHOP adapter, and a skeleton", async () => {
    const { bodies, scripts } = mockBridge({
      engine: "/project1/MediaPipe",
      pose_dat: "/project1/MediaPipe/pose",
      adapter_pose: "/project1/mp_adapter/pose",
    });
    const result = await run({ tox_path: "/x/MediaPipe.tox", build_skeleton: true });
    expect(result.isError).toBeFalsy();

    // The load script targeted the engine tox and started the timeline.
    const loadScript = scripts.find(isLoadScript);
    expect(loadScript).toBeDefined();
    expect(loadScript).toContain("MediaPipe.tox");
    expect(loadScript).toContain("time.play");
    // The adapter callback (built inside the same script) parses the engine's JSON pose.
    expect(loadScript).toContain("poseResults");
    expect(loadScript).toContain("screen_x");
    expect(loadScript).toContain("screen_y");
    expect(loadScript).toContain("TRACKING_SMOOTHING");
    expect(loadScript).toContain("SCREEN_HOLD_SECONDS");

    // A skeleton SOP was built from the adapter's pose CHOP.
    expect(bodies.some((b) => b.name === "skeleton" && b.type === "scriptSOP")).toBe(true);
    // The skeleton's preview image is surfaced.
    expect(result.content.some((c) => c.type === "image")).toBe(true);
    // The summary references the loaded engine.
    expect(textOf(result)).toContain("/project1/MediaPipe");
  });

  it("skips the skeleton when build_skeleton is false", async () => {
    const { bodies } = mockBridge({
      engine: "/project1/MediaPipe",
      pose_dat: "/project1/MediaPipe/pose",
      adapter_pose: "/project1/mp_adapter/pose",
    });
    const result = await run({ tox_path: "/x/MediaPipe.tox", build_skeleton: false });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "scriptSOP")).toBe(false);
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("guides the user to install the engine when the tox is missing", async () => {
    mockBridge({ error: "tox_missing" });
    const result = await run({ tox_path: "/nope/MediaPipe.tox" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("tdmcp install mediapipe-touchdesigner");
  });

  it("tells the user to enable Pose when no pose JSON DAT is found", async () => {
    mockBridge({ engine: "/project1/MediaPipe", pose_dat: null });
    const result = await run({ tox_path: "/x/MediaPipe.tox" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("enable Pose");
  });
});
