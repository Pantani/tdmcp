import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createVideoScopesImpl,
  createVideoScopesSchema,
} from "../../src/tools/layer1/createVideoScopes.js";
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

function defaultArgs() {
  return createVideoScopesSchema.parse({});
}

describe("create_video_scopes", () => {
  // 1. Defaults build
  it("builds with defaults and returns a non-error result with a Null TOP output", async () => {
    const result = await createVideoScopesImpl(makeCtx(), defaultArgs());
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/video_scopes");
    expect(text).toContain("/project1/video_scopes/out1");
  });

  it("creates the expected operators for the default all-panels build", async () => {
    const bodies = captureCreateBodies();
    await createVideoScopesImpl(makeCtx(), defaultArgs());

    // Level TOP pre-gain stage
    expect(bodies.some((b) => b.type === "levelTOP" && b.name === "pre")).toBe(true);

    // Waveform panel: mono → analyze → toptoCHOP → renameCHOP → choptoSOP → renderTOP
    expect(bodies.some((b) => b.type === "monochromeTOP" && b.name === "wave_lum")).toBe(true);
    expect(bodies.some((b) => b.type === "analyzeTOP" && b.name === "wave_an")).toBe(true);
    expect(bodies.some((b) => b.type === "toptoCHOP" && b.name === "wave_chop")).toBe(true);
    expect(bodies.some((b) => b.type === "renameCHOP" && b.name === "wave_ypos")).toBe(true);
    expect(bodies.some((b) => b.type === "choptoSOP" && b.name === "wave_line")).toBe(true);
    expect(bodies.some((b) => b.type === "renderTOP" && b.name === "wave_render")).toBe(true);

    // Parade panel — three channel isolations
    expect(bodies.some((b) => b.type === "renderTOP" && b.name === "parade_render")).toBe(true);
    expect(bodies.some((b) => b.type === "geometryCOMP" && b.name === "parade_geo")).toBe(true);

    // Vectorscope panel
    expect(bodies.some((b) => b.type === "glslTOP" && b.name === "vec_yuv")).toBe(true);
    expect(bodies.some((b) => b.type === "toptoCHOP" && b.name === "vec_chop")).toBe(true);
    expect(bodies.some((b) => b.type === "choptoSOP" && b.name === "vec_pts")).toBe(true);
    expect(bodies.some((b) => b.type === "renderTOP" && b.name === "vec_render")).toBe(true);

    // Histogram panel is dropped in TD 099 (histogramCHOP absent)
    expect(bodies.some((b) => b.type === "histogramCHOP")).toBe(false);
    expect(bodies.some((b) => b.name === "hist_lum")).toBe(false);
    expect(bodies.some((b) => b.name === "hist_render")).toBe(false);

    // Layout + final Null TOP
    expect(bodies.some((b) => b.type === "layoutTOP" && b.name === "panels")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
  });

  // 2. Source switch
  it("source='existing_top' does NOT create a source node", async () => {
    const bodies = captureCreateBodies();
    await createVideoScopesImpl(makeCtx(), {
      ...defaultArgs(),
      source: "existing_top",
      existing_top_path: "/project1/my_cam",
    });
    expect(bodies.some((b) => b.type === "moviefileinTOP")).toBe(false);
    expect(bodies.some((b) => b.type === "videodeviceinTOP")).toBe(false);
  });

  it("source='file' creates a moviefileinTOP", async () => {
    const bodies = captureCreateBodies();
    await createVideoScopesImpl(makeCtx(), {
      ...defaultArgs(),
      source: "file",
      video_file_path: "/path/to/clip.mp4",
    });
    const node = bodies.find((b) => b.type === "moviefileinTOP");
    expect(node).toBeDefined();
    expect(node?.parameters?.file).toBe("/path/to/clip.mp4");
  });

  it("source='test_pattern' creates a moviefileinTOP with Banana.tif", async () => {
    const bodies = captureCreateBodies();
    await createVideoScopesImpl(makeCtx(), { ...defaultArgs(), source: "test_pattern" });
    const node = bodies.find((b) => b.type === "moviefileinTOP");
    expect(node).toBeDefined();
    expect(node?.parameters?.file).toBe("Banana.tif");
  });

  it("source='device' creates a videodeviceinTOP", async () => {
    const bodies = captureCreateBodies();
    await createVideoScopesImpl(makeCtx(), { ...defaultArgs(), source: "device" });
    expect(bodies.some((b) => b.type === "videodeviceinTOP")).toBe(true);
  });

  // 3. Panel toggles
  it("enable_vectorscope=false: no vectorscope chain operators created", async () => {
    const bodies = captureCreateBodies();
    await createVideoScopesImpl(makeCtx(), {
      ...defaultArgs(),
      enable_vectorscope: false,
    });
    expect(bodies.some((b) => b.type === "glslTOP")).toBe(false);
    expect(bodies.some((b) => b.name === "vec_chop")).toBe(false);
    expect(bodies.some((b) => b.name === "vec_pts")).toBe(false);
    expect(bodies.some((b) => b.name === "vec_render")).toBe(false);
    // Other two panels still built (histogram dropped in TD 099)
    expect(bodies.some((b) => b.name === "wave_render")).toBe(true);
    expect(bodies.some((b) => b.name === "parade_render")).toBe(true);
  });

  it("all panels disabled: still creates a container and out1 with no error", async () => {
    const result = await createVideoScopesImpl(makeCtx(), {
      ...defaultArgs(),
      enable_waveform: false,
      enable_parade: false,
      enable_vectorscope: false,
      enable_histogram: false,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/video_scopes/out1");
  });

  // 4. Layout modes
  it("layout='row' creates a layoutTOP with horizontal align", async () => {
    const bodies = captureCreateBodies();
    await createVideoScopesImpl(makeCtx(), { ...defaultArgs(), layout: "row" });
    const layoutNode = bodies.find((b) => b.type === "layoutTOP" && b.name === "panels");
    expect(layoutNode).toBeDefined();
    expect(layoutNode?.parameters?.align).toBe("horizontal");
  });

  it("layout='column' creates a layoutTOP with vertical align", async () => {
    const bodies = captureCreateBodies();
    await createVideoScopesImpl(makeCtx(), { ...defaultArgs(), layout: "column" });
    const layoutNode = bodies.find((b) => b.type === "layoutTOP" && b.name === "panels");
    expect(layoutNode).toBeDefined();
    expect(layoutNode?.parameters?.align).toBe("vertical");
  });

  it("layout='grid_2x2' creates a layoutTOP with grid align and 2 columns", async () => {
    const bodies = captureCreateBodies();
    await createVideoScopesImpl(makeCtx(), { ...defaultArgs(), layout: "grid_2x2" });
    const layoutNode = bodies.find((b) => b.type === "layoutTOP" && b.name === "panels");
    expect(layoutNode).toBeDefined();
    expect(layoutNode?.parameters?.align).toBe("grid");
    expect(layoutNode?.parameters?.columns).toBe(2);
  });

  // 5. Controls exposed
  it("expose_controls=true embeds Gain/TraceColor/Show controls in the panel script", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await createVideoScopesImpl(makeCtx(), { ...defaultArgs(), expose_controls: true });
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
    expect(names).toContain("ShowWaveform");
    expect(names).toContain("ShowParade");
    expect(names).toContain("ShowVectorscope");
    expect(names).not.toContain("ShowHistogram"); // histogram panel dropped in TD 099
    const gain = payload.controls.find((c) => c.name === "Gain");
    expect(gain?.bind_to?.[0]).toMatch(/pre\.brightness1$/);
  });

  it("expose_controls=false: no controls in result", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await createVideoScopesImpl(makeCtx(), { ...defaultArgs(), expose_controls: false });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeUndefined();
  });

  // 6. Output shape
  it("outputPath ends in /out1 and result mentions enabled panel names (no histogram — TD 099)", async () => {
    const result = await createVideoScopesImpl(makeCtx(), defaultArgs());
    const text = textOf(result);
    expect(text).toMatch(/\/out1/);
    expect(text).toContain("waveform");
    expect(text).toContain("parade");
    expect(text).toContain("vectorscope");
    // histogram panel is silently skipped (histogramCHOP absent in TD 099)
    expect(text).toContain("histogramCHOP");
  });

  // 7. Hex color parsing
  it("trace_color='#ff0000' propagates to waveform tint constantTOP (r≈1, g≈0, b≈0)", async () => {
    const bodies = captureCreateBodies();
    await createVideoScopesImpl(makeCtx(), {
      ...defaultArgs(),
      trace_color: "#ff0000",
    });
    const waveTint = bodies.find((b) => b.type === "constantTOP" && b.name === "wave_tint");
    expect(waveTint).toBeDefined();
    expect(waveTint?.parameters?.colorr).toBeCloseTo(1, 2);
    expect(waveTint?.parameters?.colorg).toBeCloseTo(0, 2);
    expect(waveTint?.parameters?.colorb).toBeCloseTo(0, 2);

    // histogram panel dropped in TD 099 — no hist_tint node
    const histTint = bodies.find((b) => b.type === "constantTOP" && b.name === "hist_tint");
    expect(histTint).toBeUndefined();
  });
});
