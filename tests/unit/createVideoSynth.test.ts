import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createVideoSynthImpl } from "../../src/tools/layer1/createVideoSynth.js";
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

/** Records every POST /api/nodes body so a test can assert what nodes were created. */
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

/** Records every POST /api/exec script so a test can assert which Python steps ran. */
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

describe("create_video_synth", () => {
  it("builds a lissajous oscillator system inside a container with a GLSL TOP + shader text", async () => {
    const bodies = captureCreateBodies();
    const result = await createVideoSynthImpl(makeCtx(), {
      mode: "lissajous",
      speed: 1,
      freq_x: 3,
      freq_y: 2,
      scale: 1,
      resolution: [1280, 720],
      expose_controls: false,
      parent_path: "/project1",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // System container + Null TOP output path.
    expect(text).toContain("/project1/video_synth_lissajous");
    expect(text).toContain("/project1/video_synth_lissajous/out1");
    expect(text).toContain("lissajous");

    // A GLSL TOP and a Text DAT (to hold the fragment source) are created.
    expect(bodies.some((b) => b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "textDAT")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP")).toBe(true);
  });

  it("builds a distinct shader and out path for the interference mode", async () => {
    const result = await createVideoSynthImpl(makeCtx(), {
      mode: "interference",
      speed: 1,
      freq_x: 3,
      freq_y: 2,
      scale: 1,
      resolution: [1280, 720],
      expose_controls: false,
      parent_path: "/project1",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/video_synth_interference");
    expect(text).toContain("/project1/video_synth_interference/out1");
    expect(text).toContain("interference");
  });

  it("writes a self-contained fragment that obeys the TD GLSL TOP rules", async () => {
    const scripts = captureExecScripts();
    await createVideoSynthImpl(makeCtx(), {
      mode: "scanlines",
      speed: 1,
      freq_x: 3,
      freq_y: 2,
      scale: 1,
      resolution: [1280, 720],
      expose_controls: false,
      parent_path: "/project1",
    });
    // The fragment shader is pushed into the Text DAT and pointed at via pixeldat.
    const shaderScript = scripts.find((s) => s.includes("pixeldat"));
    expect(shaderScript).toBeDefined();
    // Required GLSL TOP idioms (no built-in uTime; explicit output; swizzled write).
    expect(shaderScript).toContain("out vec4 fragColor");
    expect(shaderScript).toContain("uniform float uTime");
    expect(shaderScript).toContain("TDOutputSwizzle");
  });

  it("binds the oscillator uniforms (uTime/uScale/uFreqX/uFreqY/uColor) via the GLSL TOP sequences", async () => {
    const scripts = captureExecScripts();
    await createVideoSynthImpl(makeCtx(), {
      mode: "lissajous",
      speed: 2,
      freq_x: 4,
      freq_y: 5,
      scale: 1,
      resolution: [1280, 720],
      expose_controls: false,
      parent_path: "/project1",
    });
    const bind = scripts.find((s) => s.includes("vec0name"));
    expect(bind).toBeDefined();
    // uTime evolves via a guarded Speed lookup; the oscillator frequencies + scale bind too.
    expect(bind).toContain("'uTime'");
    expect(bind).toContain("absTime.seconds");
    expect(bind).toContain("parent().par.Speed.eval()");
    expect(bind).toContain("'uFreqX'");
    expect(bind).toContain("parent().par.Freqx.eval()");
    expect(bind).toContain("'uFreqY'");
    expect(bind).toContain("parent().par.Freqy.eval()");
    expect(bind).toContain("'uScale'");
    // uColor is bound on the Colors sequence reading the RGB swatch components directly.
    expect(bind).toContain("'uColor'");
    expect(bind).toContain("parent().par.Colorr.eval()");
  });

  it("exposes Speed / FreqX / FreqY / Scale / Color controls when expose_controls is on", async () => {
    const scripts = captureExecScripts();
    await createVideoSynthImpl(makeCtx(), {
      mode: "interference",
      speed: 1,
      freq_x: 3,
      freq_y: 2,
      scale: 1,
      resolution: [1280, 720],
      expose_controls: true,
      parent_path: "/project1",
    });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type: string }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Speed", "FreqX", "FreqY", "Scale", "Color"]));
    expect(payload.controls.find((c) => c.name === "Color")?.type).toBe("rgb");
  });

  it("parses a hex color and skips the control panel when expose_controls is off", async () => {
    const scripts = captureExecScripts();
    const result = await createVideoSynthImpl(makeCtx(), {
      mode: "lissajous",
      speed: 1,
      freq_x: 3,
      freq_y: 2,
      scale: 1,
      color: "#ff8800",
      resolution: [1280, 720],
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(scripts.some((s) => s.includes("appendCustomPage"))).toBe(false);
    // The parsed color (0xff/0x88/0x00 → 1, ~0.533, 0) feeds the uColor fallback.
    const bind = scripts.find((s) => s.includes("color0rgbr"));
    expect(bind).toContain("else 1");
    expect(bind).toContain("else 0");
  });
});
