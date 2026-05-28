import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createPoseTrackingImpl,
  createPoseTrackingSchema,
} from "../../src/tools/layer1/createPoseTracking.js";
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
      scripts.push(((await request.json()) as { script: string }).script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

function panelControls(
  scripts: string[],
): Array<{ name: string; type?: string; bind_to?: string[] }> {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  return (
    JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type?: string; bind_to?: string[] }>;
    }
  ).controls;
}

function run(args: Partial<z.input<typeof createPoseTrackingSchema>> = {}) {
  return createPoseTrackingImpl(makeCtx(), createPoseTrackingSchema.parse(args));
}

describe("create_pose_tracking", () => {
  it("builds a synthetic pose chain ending on a Null CHOP plus a keypoints CHOP (no image)", async () => {
    const bodies = captureCreateBodies();
    const result = await run({ source: "synthetic", expose_controls: false });
    expect(result.isError).toBeFalsy();

    // Synthetic source is a Script CHOP (no camera permission).
    expect(bodies.find((b) => b.name === "posein")?.type).toBe("scriptCHOP");
    // Smoothing (sample-preserving Script CHOP) then the canonical pose Null.
    expect(bodies.find((b) => b.name === "smooth")?.type).toBe("scriptCHOP");
    expect(bodies.find((b) => b.name === "pose")?.type).toBe("nullCHOP");
    // Scalar keypoints CHOP for easy binding.
    expect(bodies.find((b) => b.name === "keypoints")?.type).toBe("scriptCHOP");

    // Output is a CHOP, so there is no preview image.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
    const text = textOf(result);
    expect(text).toContain("/project1/pose_tracking/pose");
    expect(text).toContain("keypoints");
  });

  it("defaults to the synthetic source (no device/plugin ops) when none is given", async () => {
    const bodies = captureCreateBodies();
    await run({ expose_controls: false });
    const types = bodies.map((b) => b.type);
    expect(types).toContain("scriptCHOP");
    expect(types).not.toContain("videodeviceinTOP");
    expect(types).not.toContain("oscinCHOP");
  });

  it("installs the synthetic pose and keypoints callbacks (33-landmark generator)", async () => {
    const scripts = captureExecScripts();
    await run({ source: "synthetic", expose_controls: false });
    expect(scripts.some((s) => s.includes("def onCook") && s.includes("appendChan('tx')"))).toBe(
      true,
    );
    expect(scripts.some((s) => s.includes("r_wrist") && s.includes("hand_span"))).toBe(true);
    // A frame cooker keeps the op()-referenced chain live.
    expect(scripts.some((s) => s.includes("onFrameStart") && s.includes("cook(force=True)"))).toBe(
      true,
    );
  });

  it("references the plugin CHOP via a Select CHOP for source='mediapipe'", async () => {
    const bodies = captureCreateBodies();
    await run({
      source: "mediapipe",
      mediapipe_chop_path: "/project1/MediaPipe/pose",
      expose_controls: false,
    });
    const posein = bodies.find((b) => b.name === "posein");
    expect(posein?.type).toBe("selectCHOP");
    expect(posein?.parameters).toMatchObject({ chop: "/project1/MediaPipe/pose" });
  });

  it("creates an OSC In CHOP on the given port for source='osc'", async () => {
    const bodies = captureCreateBodies();
    await run({ source: "osc", osc_port: 7400, expose_controls: false });
    const posein = bodies.find((b) => b.name === "posein");
    expect(posein?.type).toBe("oscinCHOP");
    expect(posein?.parameters).toMatchObject({ port: 7400 });
  });

  it("flips tx via a Math CHOP gain of -1 when mirror is on", async () => {
    const bodies = captureCreateBodies();
    await run({ source: "synthetic", mirror: true, expose_controls: false });
    const mirror = bodies.find((b) => b.name === "mirror");
    expect(mirror?.type).toBe("mathCHOP");
    expect(mirror?.parameters).toMatchObject({ gain: -1 });
    expect(bodies.some((b) => b.name === "mirrored" && b.type === "mergeCHOP")).toBe(true);
  });

  it("exposes a Smoothing knob the smoother reads directly (no bind_to)", async () => {
    const scripts = captureExecScripts();
    await run({ source: "synthetic", expose_controls: true });
    const smoothing = panelControls(scripts).find((c) => c.name === "Smoothing");
    expect(smoothing).toBeDefined();
    expect(smoothing?.bind_to ?? []).toEqual([]);
    // The smoother callback blends with the previous frame (preserving the 33 samples).
    expect(scripts.some((s) => s.includes("prev_vals") && s.includes("scriptOp.copy"))).toBe(true);
  });
});
