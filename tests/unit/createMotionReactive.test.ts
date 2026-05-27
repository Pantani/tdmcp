import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createMotionReactiveImpl } from "../../src/tools/layer1/createMotionReactive.js";
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
  bind_to?: string[];
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

// Pulls the control specs out of the base64 payload embedded in the panel exec script.
function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

describe("create_motion_reactive", () => {
  it("builds the brightness/motion analysis chain ending on a Null CHOP (no image)", async () => {
    const bodies = captureCreateBodies();
    const result = await createMotionReactiveImpl(makeCtx(), {
      source: "synthetic",
      analysis_resolution: 160,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // Downsize → monochrome, then two branches: brightness and motion.
    const mono = bodies.find((b) => b.name === "mono");
    expect(mono?.type).toBe("monochromeTOP");
    expect(mono?.parameters).toMatchObject({ resolutionw: 160, resolutionh: 160 });

    // brightness = average luminance via an Analyze TOP → toptoCHOP labelled 'brightness'.
    expect(bodies.find((b) => b.name === "bright_a")?.parameters).toMatchObject({ op: "average" });
    const brightC = bodies.find((b) => b.name === "bright_c");
    expect(brightC?.type).toBe("toptoCHOP");
    expect(brightC?.parameters?.r).toBe("brightness");
    // The converter reads its source via the `top` param (not a wire).
    expect(String(brightC?.parameters?.top)).toMatch(/\/bright_a$/);

    // motion = average frame-to-frame difference. A Cache TOP holds the previous frame
    // (outputindex -1, newest is 0) and a Difference TOP subtracts it.
    const cache = bodies.find((b) => b.name === "prevframe");
    expect(cache?.type).toBe("cacheTOP");
    expect(cache?.parameters).toMatchObject({ cachesize: 2, outputindex: -1, active: 1 });
    expect(bodies.some((b) => b.name === "framediff" && b.type === "differenceTOP")).toBe(true);
    expect(bodies.find((b) => b.name === "motion_c")?.parameters?.r).toBe("motion");

    // Merge → Sensitivity Math → Null CHOP bind point.
    expect(bodies.some((b) => b.name === "merged" && b.type === "mergeCHOP")).toBe(true);
    expect(bodies.find((b) => b.name === "sensitivity")?.type).toBe("mathCHOP");
    const features = bodies.find((b) => b.name === "features");
    expect(features?.type).toBe("nullCHOP");

    // The output is a CHOP, so there is no preview image.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
    const text = textOf(result);
    expect(text).toContain("brightness/motion");
    expect(text).toContain("['motion']");
  });

  it("installs an Execute DAT that force-cooks the Null each frame to keep the signal live", async () => {
    const scripts = captureExecScripts();
    await createMotionReactiveImpl(makeCtx(), {
      source: "synthetic",
      analysis_resolution: 160,
      expose_controls: false,
      parent_path: "/project1",
    });
    const cooker = scripts.find(
      (s) => s.includes("onFrameStart") && s.includes("cook(force=True)"),
    );
    expect(cooker).toBeDefined();
    expect(cooker).toContain("features");
  });

  it("uses a self-driving noise TOP for the synthetic source (no device permission)", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await createMotionReactiveImpl(makeCtx(), {
      source: "synthetic",
      analysis_resolution: 128,
      expose_controls: false,
      parent_path: "/project1",
    });
    const videoin = bodies.find((b) => b.name === "videoin");
    expect(videoin?.type).toBe("noiseTOP");
    expect(videoin?.parameters).toMatchObject({ resolutionw: 128, resolutionh: 128 });
    // It scrolls over time so consecutive frames differ (motion reads non-zero).
    expect(scripts.some((s) => s.includes("tz.expr") && s.includes("absTime.seconds"))).toBe(true);
  });

  it("creates a Movie File In for source=file", async () => {
    const bodies = captureCreateBodies();
    await createMotionReactiveImpl(makeCtx(), {
      source: "file",
      movie_file_path: "/clips/loop.mov",
      analysis_resolution: 160,
      expose_controls: false,
      parent_path: "/project1",
    });
    const videoin = bodies.find((b) => b.name === "videoin");
    expect(videoin?.type).toBe("moviefileinTOP");
    expect(videoin?.parameters).toMatchObject({ file: "/clips/loop.mov", play: 1 });
  });

  it("analyses an existing TOP in place without creating any video source node", async () => {
    const bodies = captureCreateBodies();
    await createMotionReactiveImpl(makeCtx(), {
      source: "existing_top",
      existing_top_path: "/project1/render1",
      analysis_resolution: 160,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.name === "videoin")).toBe(false);
    expect(
      bodies.some((b) => ["moviefileinTOP", "noiseTOP", "videodeviceinTOP"].includes(b.type)),
    ).toBe(false);
    // The chain still starts at the monochrome downscale, fed from the existing TOP.
    expect(bodies.some((b) => b.name === "mono")).toBe(true);
  });

  it("exposes a Sensitivity knob bound to the Math CHOP gain when expose_controls is set", async () => {
    const scripts = captureExecScripts();
    await createMotionReactiveImpl(makeCtx(), {
      source: "synthetic",
      analysis_resolution: 160,
      expose_controls: true,
      parent_path: "/project1",
    });
    const sensitivity = panelControls(scripts).find((c) => c.name === "Sensitivity");
    expect(sensitivity?.bind_to?.[0]).toMatch(/sensitivity\.gain$/);
  });
});
