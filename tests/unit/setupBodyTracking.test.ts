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

/** Mocks the bridge: the loadTox/find script returns `report`; all other exec calls return empty. */
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
      const stdout = script.includes("loadTox") ? JSON.stringify(report) : "";
      return HttpResponse.json({ ok: true, data: { result: null, stdout } });
    }),
  );
  return { bodies, scripts };
}

function run(args: Partial<z.input<typeof setupBodyTrackingSchema>> = {}) {
  return setupBodyTrackingImpl(makeCtx(), setupBodyTrackingSchema.parse(args));
}

describe("setup_body_tracking", () => {
  it("loads the plugin, finds the pose CHOP, and wires pose tracking to it", async () => {
    const { bodies, scripts } = mockBridge({
      loaded: "/project1/mediapipe_pose",
      pose_chop: "/project1/mediapipe_pose/select1",
      chans: ["tx", "ty", "tz"],
      samples: 33,
    });
    const result = await run({ tox_path: "/x/pose_tracking.tox", build_skeleton: false });
    expect(result.isError).toBeFalsy();

    // It ran a loadTox script pointed at the given tox path.
    expect(scripts.some((s) => s.includes("loadTox") && s.includes("/x/pose_tracking.tox"))).toBe(
      true,
    );
    // pose tracking was built with source='mediapipe' pointing at the discovered CHOP.
    const posein = bodies.find((b) => b.name === "posein");
    expect(posein?.type).toBe("selectCHOP");
    expect(posein?.parameters).toMatchObject({ chops: "/project1/mediapipe_pose/select1" });
    expect(textOf(result)).toContain("/project1/mediapipe_pose");
  });

  it("also builds a skeleton (and returns its preview) when build_skeleton is true", async () => {
    const { bodies, scripts } = mockBridge({
      loaded: "/project1/mediapipe_pose",
      pose_chop: "/project1/mediapipe_pose/select1",
      chans: ["tx", "ty", "tz"],
      samples: 33,
    });
    const result = await run({ tox_path: "/x/pose_tracking.tox", build_skeleton: true });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.name === "skeleton" && b.type === "scriptSOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
    // The skeleton references the tracking output via a Select CHOP (existing_chop source).
    expect(scripts.length).toBeGreaterThan(0);
  });

  it("guides the user to install the plugin when the tox is missing", async () => {
    mockBridge({ error: "tox_missing" });
    const result = await run({ tox_path: "/nope/pose_tracking.tox" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("tdmcp install torinmb/mediapipe-touchdesigner");
  });

  it("reports when no pose CHOP is found inside the loaded plugin", async () => {
    mockBridge({ error: "pose_chop_not_found", loaded: "/project1/mediapipe_pose" });
    const result = await run({ tox_path: "/x/pose_tracking.tox" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("enable Pose");
  });
});
