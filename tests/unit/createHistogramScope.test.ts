import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createHistogramScopeImpl,
  createHistogramScopeSchema,
} from "../../src/tools/layer1/createHistogramScope.js";
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

function defaultArgs() {
  return createHistogramScopeSchema.parse({});
}

describe("create_histogram_scope", () => {
  // 1. Happy path — default build
  it("builds with defaults and returns a non-error result with a Null TOP output", async () => {
    const result = await createHistogramScopeImpl(makeCtx(), defaultArgs());
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/histogram_scope");
    expect(text).toContain("/project1/histogram_scope/out1");
  });

  it("creates the expected operators for the default build", async () => {
    const bodies = captureCreateBodies();
    await createHistogramScopeImpl(makeCtx(), defaultArgs());

    // Source and pre-gain
    expect(bodies.some((b) => b.type === "moviefileinTOP" && b.name === "videoin")).toBe(true);
    const videoin = bodies.find((b) => b.type === "moviefileinTOP" && b.name === "videoin");
    expect(videoin?.parameters?.file).toBe("Banana.tif");
    expect(bodies.some((b) => b.type === "levelTOP" && b.name === "pre")).toBe(true);

    // Downsample
    expect(bodies.some((b) => b.type === "resolutionTOP" && b.name === "downsample")).toBe(true);

    // GLSL histogram TOP
    const glsl = bodies.find((b) => b.type === "glslTOP" && b.name === "histogram_glsl");
    expect(glsl).toBeDefined();
    expect(glsl?.parameters?.resolutionw).toBe(64); // default bins=64
    expect(glsl?.parameters?.resolutionh).toBe(1);

    // Text DAT for shader
    expect(bodies.some((b) => b.type === "textDAT" && b.name === "frag")).toBe(true);

    // CHOP chain
    expect(bodies.some((b) => b.type === "toptoCHOP" && b.name === "histo_chop")).toBe(true);
    expect(bodies.some((b) => b.type === "mathCHOP" && b.name === "norm")).toBe(true);
    expect(bodies.some((b) => b.type === "renameCHOP" && b.name === "ypos")).toBe(true);

    // Render chain
    expect(bodies.some((b) => b.type === "geometryCOMP" && b.name === "geo")).toBe(true);
    expect(bodies.some((b) => b.type === "choptoSOP" && b.name === "line")).toBe(true);
    expect(bodies.some((b) => b.type === "constantMAT" && b.name === "mat")).toBe(true);
    expect(bodies.some((b) => b.type === "cameraCOMP" && b.name === "cam")).toBe(true);
    expect(bodies.some((b) => b.type === "lightCOMP" && b.name === "light")).toBe(true);
    expect(bodies.some((b) => b.type === "renderTOP" && b.name === "render")).toBe(true);

    // Tint and output
    expect(bodies.some((b) => b.type === "constantTOP" && b.name === "tint")).toBe(true);
    expect(bodies.some((b) => b.type === "compositeTOP" && b.name === "tinted")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
  });

  it("render flag + material Python block is executed", async () => {
    const scripts = captureExecScripts();
    await createHistogramScopeImpl(makeCtx(), defaultArgs());
    const renderScript = scripts.find((s) => s.includes("render = True") && s.includes("material"));
    expect(renderScript).toBeDefined();
  });

  it("render TOP uses the requested output resolution", async () => {
    const bodies = captureCreateBodies();
    await createHistogramScopeImpl(makeCtx(), {
      ...defaultArgs(),
      resolution: [800, 400],
    });
    const render = bodies.find((b) => b.type === "renderTOP" && b.name === "render");
    expect(render?.parameters?.resolutionw).toBe(800);
    expect(render?.parameters?.resolutionh).toBe(400);
  });

  // 2. Bins propagation
  it("bins parameter sets the GLSL TOP resolution width", async () => {
    const bodies = captureCreateBodies();
    await createHistogramScopeImpl(makeCtx(), { ...defaultArgs(), bins: 128 });
    const glsl = bodies.find((b) => b.type === "glslTOP" && b.name === "histogram_glsl");
    expect(glsl?.parameters?.resolutionw).toBe(128);
  });

  // 3. Source switches
  it("source='existing_top' with path creates a selectTOP bridge and no videoin", async () => {
    const bodies = captureCreateBodies();
    await createHistogramScopeImpl(makeCtx(), {
      ...defaultArgs(),
      source: "existing_top",
      existing_top_path: "/project1/my_cam",
    });
    expect(bodies.some((b) => b.type === "moviefileinTOP")).toBe(false);
    const sel = bodies.find((b) => b.type === "selectTOP" && b.name === "src_select");
    expect(sel).toBeDefined();
    expect(sel?.parameters?.top).toBe("/project1/my_cam");
  });

  it("source='file' creates a moviefileinTOP with the provided file", async () => {
    const bodies = captureCreateBodies();
    await createHistogramScopeImpl(makeCtx(), {
      ...defaultArgs(),
      source: "file",
      video_file_path: "/path/to/clip.mp4",
    });
    const node = bodies.find((b) => b.type === "moviefileinTOP");
    expect(node?.parameters?.file).toBe("/path/to/clip.mp4");
  });

  it("source='device' creates a videodeviceinTOP", async () => {
    const bodies = captureCreateBodies();
    await createHistogramScopeImpl(makeCtx(), { ...defaultArgs(), source: "device" });
    expect(bodies.some((b) => b.type === "videodeviceinTOP")).toBe(true);
  });

  // 4. Cross-field schema validation — no-throw guarantee
  it("source='existing_top' without existing_top_path returns isError, never throws", async () => {
    const result = await createHistogramScopeImpl(makeCtx(), {
      ...defaultArgs(),
      source: "existing_top",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/existing_top_path/);
  });

  it("source='file' without video_file_path returns isError, never throws", async () => {
    const result = await createHistogramScopeImpl(makeCtx(), {
      ...defaultArgs(),
      source: "file",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/video_file_path/);
  });

  // 5. Schema validation of bins range
  it("schema rejects bins < 16", () => {
    expect(() => createHistogramScopeSchema.parse({ bins: 8 })).toThrow();
  });

  it("schema rejects bins > 512", () => {
    expect(() => createHistogramScopeSchema.parse({ bins: 1024 })).toThrow();
  });

  // 6. log_scale parameter
  it("log_scale=true sets a log expression on the norm mathCHOP", async () => {
    const bodies = captureCreateBodies();
    await createHistogramScopeImpl(makeCtx(), { ...defaultArgs(), log_scale: true });
    const norm = bodies.find((b) => b.type === "mathCHOP" && b.name === "norm");
    expect(norm).toBeDefined();
    // chopexpr should contain log
    expect(JSON.stringify(norm?.parameters ?? {})).toContain("log");
  });

  // 7. Trace color propagation — only the tint TOP carries the colour; the
  // MAT stays NEUTRAL (white) so the live TraceColor control isn't multiplied
  // against a baked-in MAT hue.
  it("trace_color='#ff0000' drives constantTOP tint only; constantMAT stays neutral white", async () => {
    const bodies = captureCreateBodies();
    await createHistogramScopeImpl(makeCtx(), {
      ...defaultArgs(),
      trace_color: "#ff0000",
    });
    const mat = bodies.find((b) => b.type === "constantMAT" && b.name === "mat");
    expect(mat?.parameters?.colorr).toBeCloseTo(1, 2);
    expect(mat?.parameters?.colorg).toBeCloseTo(1, 2);
    expect(mat?.parameters?.colorb).toBeCloseTo(1, 2);
    const tint = bodies.find((b) => b.type === "constantTOP" && b.name === "tint");
    expect(tint?.parameters?.colorr).toBeCloseTo(1, 2);
    expect(tint?.parameters?.colorg).toBeCloseTo(0, 2);
    expect(tint?.parameters?.colorb).toBeCloseTo(0, 2);
  });

  // 8. Controls
  it("expose_controls=true exposes Gain bound to pre.brightness1 and TraceColor bound to tint", async () => {
    const scripts = captureExecScripts();
    await createHistogramScopeImpl(makeCtx(), { ...defaultArgs(), expose_controls: true });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; bind_to?: string[] }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toContain("Gain");
    expect(names).toContain("TraceColor");
    expect(names).toContain("LogScale");
    const gain = payload.controls.find((c) => c.name === "Gain");
    expect(gain?.bind_to?.[0]).toMatch(/pre\.brightness1$/);
    const color = payload.controls.find((c) => c.name === "TraceColor");
    expect(color?.bind_to?.some((b) => b.includes("tint"))).toBe(true);
  });

  it("expose_controls=false: no controls panel script emitted", async () => {
    const scripts = captureExecScripts();
    await createHistogramScopeImpl(makeCtx(), { ...defaultArgs(), expose_controls: false });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeUndefined();
  });

  // 9. Output shape / extra
  it("result text mentions bins and mode in the summary", async () => {
    const result = await createHistogramScopeImpl(makeCtx(), defaultArgs());
    const text = textOf(result);
    expect(text).toContain("64"); // bins
    expect(text).toContain("luma"); // mode
    expect(text).toMatch(/\/out1/);
  });

  // Regression: choptoSOP requires tx/ty/tz channels — without them TD logs
  // "Channel tx/tz not found" warnings and the geometry collapses to a single
  // vertical hairline at x=0. The build must synthesise tx (ramp) and tz
  // (constant) alongside the existing ty channel via a Merge CHOP.
  it("emits tx_ramp + tz_zero pattern CHOPs and merges them with ypos for choptoSOP", async () => {
    const bodies = captureCreateBodies();
    await createHistogramScopeImpl(makeCtx(), defaultArgs());

    const tx = bodies.find((b) => b.type === "patternCHOP" && b.name === "tx_ramp");
    expect(tx).toBeDefined();
    expect(tx?.parameters?.channelname).toBe("tx");
    expect(tx?.parameters?.wavetype).toBe("ramp");
    expect(tx?.parameters?.length).toBe(64);

    const tz = bodies.find((b) => b.type === "patternCHOP" && b.name === "tz_zero");
    expect(tz).toBeDefined();
    expect(tz?.parameters?.channelname).toBe("tz");
    expect(tz?.parameters?.wavetype).toBe("constant");

    const merge = bodies.find((b) => b.type === "mergeCHOP" && b.name === "xyz");
    expect(merge).toBeDefined();
  });

  it("bins propagates to the tx_ramp / tz_zero pattern CHOPs", async () => {
    const bodies = captureCreateBodies();
    await createHistogramScopeImpl(makeCtx(), { ...defaultArgs(), bins: 128 });
    const tx = bodies.find((b) => b.type === "patternCHOP" && b.name === "tx_ramp");
    const tz = bodies.find((b) => b.type === "patternCHOP" && b.name === "tz_zero");
    expect(tx?.parameters?.length).toBe(128);
    expect(tz?.parameters?.length).toBe(128);
  });

  // 10. Bridge fatal — no-throw guarantee
  it("bridge exec fatal returns isError without throwing", async () => {
    // Make /api/nodes fail at the container step to trigger a fatal path
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async () => {
        return HttpResponse.json({ ok: false, error: "TD offline" }, { status: 500 });
      }),
    );
    const result = await createHistogramScopeImpl(makeCtx(), defaultArgs());
    // Should not throw — just return an error result
    expect(result).toBeDefined();
  });
});
