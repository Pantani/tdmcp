import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createVectorLinesImpl,
  createVectorLinesSchema,
  registerCreateVectorLines,
} from "../../src/tools/layer1/createVectorLines.js";
import { layer1Registrars } from "../../src/tools/layer1/index.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

interface PatchedNodeBody {
  path: string;
  parameters: Record<string, unknown>;
}

interface PanelControl {
  name: string;
  type?: string;
  default?: unknown;
  min?: number;
  max?: number;
  menu_items?: string[];
  bind_to?: string[];
}

interface VectorLinesReport {
  container: string;
  source_path: string;
  prep_path: string;
  snapshot_path: string;
  trace_sop: string;
  vectors_output: string;
  output_path: string;
  controls?: { added: string[]; bound: number };
  warnings: string[];
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

function defaultArgs(): Parameters<typeof createVectorLinesImpl>[1] {
  return createVectorLinesSchema.parse({});
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

function captureParameterPatches(): PatchedNodeBody[] {
  const patches: PatchedNodeBody[] = [];
  server.use(
    http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ params, request }) => {
      const body = (await request.json()) as { parameters: Record<string, unknown> };
      const raw = params.seg;
      const path = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : String(raw ?? ""));
      patches.push({ path, parameters: body.parameters });
      return HttpResponse.json({
        ok: true,
        data: { path, type: "unknown", name: path.split("/").at(-1), parameters: body.parameters },
      });
    }),
  );
  return patches;
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

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

function textJson(result: Awaited<ReturnType<typeof createVectorLinesImpl>>): VectorLinesReport {
  const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  const match = /```json\n([\s\S]+?)\n```/.exec(text?.text ?? "");
  expect(match?.[1]).toBeDefined();
  return JSON.parse(match?.[1] ?? "{}") as VectorLinesReport;
}

describe("create_vector_lines", () => {
  it("registers the tool with the expected annotations and schema", () => {
    const calls: Array<{ name: string; config: Record<string, unknown> }> = [];
    const fakeServer = {
      registerTool(name: string, config: Record<string, unknown>) {
        calls.push({ name, config });
      },
    };

    registerCreateVectorLines(fakeServer as never, makeCtx());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("create_vector_lines");
    expect(calls[0]?.config.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(calls[0]?.config.inputSchema).toBe(createVectorLinesSchema.shape);
  });

  it("is wired into the Layer 1 registrar list", () => {
    const calls: Array<{ name: string; config: Record<string, unknown> }> = [];
    const fakeServer = {
      registerTool(name: string, config: Record<string, unknown>) {
        calls.push({ name, config });
      },
    };

    for (const register of layer1Registrars) register(fakeServer as never, makeCtx());

    expect(calls.some((c) => c.name === "create_vector_lines")).toBe(true);
  });

  it("defaults to safe synthetic, pulse-driven vectorization settings", () => {
    const parsed = createVectorLinesSchema.parse({});
    expect(parsed).toMatchObject({
      name: "vector_lines",
      parent_path: "/project1",
      source: "synthetic",
      mode: "hybrid_foreground",
      analysis_resolution: [640, 360],
      threshold: 0.45,
      pre_blur: 2,
      invert: false,
      remove_borders: true,
      resample: true,
      step_size: 4,
      smooth_shapes: true,
      fit_curves: false,
      line_color: "#49dcb2",
      line_width: 2,
      opacity: 0.9,
      overlay_mode: "over",
      show_source: true,
      expose_controls: true,
    });
  });

  it("rejects invalid ranges and missing source-specific paths", () => {
    expect(() => createVectorLinesSchema.parse({ threshold: 2 })).toThrow();
    expect(() => createVectorLinesSchema.parse({ opacity: -0.1 })).toThrow();
    expect(() => createVectorLinesSchema.parse({ step_size: 0 })).toThrow();
    expect(() => createVectorLinesSchema.parse({ source: "existing_top" })).toThrow();
    expect(() => createVectorLinesSchema.parse({ source: "file" })).toThrow();
  });

  it("creates the synthetic source, prep chain, frozen frame, trace/render chain, and outputs", async () => {
    const bodies = captureCreateBodies();
    const patches = captureParameterPatches();
    const scripts = captureExecScripts();

    const result = await createVectorLinesImpl(makeCtx(), defaultArgs());

    expect(result.isError).toBeFalsy();
    const byName = new Map(bodies.map((b) => [b.name, b]));
    expect(byName.get("vector_lines")?.type).toBe("baseCOMP");
    expect(byName.get("source_noise")?.type).toBe("noiseTOP");
    expect(byName.get("fit_source")?.type).toBe("fitTOP");
    expect(byName.get("source_display")?.type).toBe("nullTOP");
    expect(byName.get("monochrome")?.type).toBe("monochromeTOP");
    expect(byName.get("pre_blur")?.type).toBe("blurTOP");
    expect(byName.get("mask")?.type).toBe("thresholdTOP");
    expect(byName.get("invert")?.type).toBe("levelTOP");
    expect(byName.get("prep_out")?.type).toBe("nullTOP");
    expect(byName.get("frozen_frame")?.type).toBe("moviefileinTOP");
    expect(byName.get("trace1")?.type).toBe("traceSOP");
    expect(byName.get("vector_geo")?.type).toBe("geometryCOMP");
    expect(byName.get("wire")?.type).toBe("wireframeMAT");
    expect(byName.get("cam")?.type).toBe("cameraCOMP");
    expect(byName.get("render_vectors")?.type).toBe("renderTOP");
    expect(byName.get("vectors_opacity")?.type).toBe("levelTOP");
    expect(byName.get("vectors_out")?.type).toBe("nullTOP");
    expect(byName.get("overlay")?.type).toBe("compositeTOP");
    expect(byName.get("out1")?.type).toBe("nullTOP");

    expect(
      patches.some((p) => p.path.endsWith("/fit_source") && p.parameters.resolutionw === 640),
    ).toBe(true);
    expect(patches.some((p) => p.path.endsWith("/mask") && p.parameters.threshold === 0.45)).toBe(
      true,
    );
    expect(
      patches.some((p) => p.path.endsWith("/overlay") && p.parameters.operand === "over"),
    ).toBe(true);
    expect(scripts.some((s) => s.includes("def onPulse(par)") && s.includes("prep_out"))).toBe(
      true,
    );
  });

  it("uses Select TOP for existing TOP source and does not create camera/file inputs", async () => {
    const bodies = captureCreateBodies();
    captureParameterPatches();
    captureExecScripts();

    await createVectorLinesImpl(makeCtx(), {
      ...defaultArgs(),
      source: "existing_top",
      existing_top_path: "/project1/movie1",
    });

    expect(bodies.some((b) => b.type === "selectTOP" && b.name === "source_select")).toBe(true);
    expect(bodies.some((b) => b.type === "videodeviceinTOP")).toBe(false);
    expect(bodies.some((b) => b.type === "moviefileinTOP" && b.name === "source_file")).toBe(false);
  });

  it("creates a Video Device In TOP only when camera source is explicitly requested", async () => {
    const bodies = captureCreateBodies();
    captureParameterPatches();
    captureExecScripts();

    await createVectorLinesImpl(makeCtx(), {
      ...defaultArgs(),
      source: "camera",
      camera_device: "FaceTime HD Camera",
    });

    expect(bodies.some((b) => b.type === "videodeviceinTOP" && b.name === "source_camera")).toBe(
      true,
    );
    expect(bodies.some((b) => b.type === "noiseTOP" && b.name === "source_noise")).toBe(false);
  });

  it("maps args into prep, trace, opacity, overlay, and callback behavior", async () => {
    captureCreateBodies();
    const patches = captureParameterPatches();
    const scripts = captureExecScripts();

    await createVectorLinesImpl(makeCtx(), {
      ...defaultArgs(),
      threshold: 0.72,
      pre_blur: 6,
      remove_borders: false,
      smooth_shapes: false,
      opacity: 0.55,
      overlay_mode: "screen",
      step_size: 8,
      line_color: "#ff8800",
      line_width: 5,
    });

    expect(patches.some((p) => p.path.endsWith("/pre_blur") && p.parameters.size === 6)).toBe(true);
    expect(patches.some((p) => p.path.endsWith("/mask") && p.parameters.threshold === 0.72)).toBe(
      true,
    );
    expect(
      patches.some((p) => p.path.endsWith("/vectors_opacity") && p.parameters.opacity === 0.55),
    ).toBe(true);
    expect(
      patches.some((p) => p.path.endsWith("/overlay") && p.parameters.operand === "screen"),
    ).toBe(true);

    const setup = scripts.find((s) => s.includes("TRACE_PARAM_VALUES"));
    expect(setup).toContain("'thresh': 0.72");
    expect(setup).toContain("'delborder': 0");
    expect(setup).toContain("'dosmooth': 0");
    expect(setup).toContain("'step': 8");
    expect(setup).toContain("#ff8800");
    expect(setup).toContain("linewidth");
  });

  it("exposes the vectorize pulse and core controls", async () => {
    captureCreateBodies();
    captureParameterPatches();
    const scripts = captureExecScripts();

    await createVectorLinesImpl(makeCtx(), defaultArgs());

    const controls = panelControls(scripts);
    expect(controls.find((c) => c.name === "Vectorize")?.type).toBe("pulse");
    expect(controls.find((c) => c.name === "Threshold")?.default).toBe(0.45);
    expect(controls.find((c) => c.name === "PreBlur")?.default).toBe(2);
    expect(controls.find((c) => c.name === "StepSize")?.default).toBe(4);
    expect(controls.find((c) => c.name === "OverlayMode")?.menu_items).toEqual([
      "over",
      "add",
      "screen",
      "multiply",
    ]);
    expect(controls.find((c) => c.name === "ShowSource")?.type).toBe("toggle");
  });

  it("returns the expected vector-line paths and warnings", async () => {
    captureCreateBodies();
    captureParameterPatches();
    captureExecScripts();

    const result = await createVectorLinesImpl(makeCtx(), defaultArgs());
    const report = textJson(result);

    expect(report.container).toBe("/project1/vector_lines");
    expect(report.source_path).toBe("/project1/vector_lines/source_noise");
    expect(report.prep_path).toBe("/project1/vector_lines/prep_out");
    expect(report.snapshot_path).toContain("tdmcp_snapshots/vector_lines/vector_lines_latest.png");
    expect(report.trace_sop).toBe("/project1/vector_lines/trace1");
    expect(report.vectors_output).toBe("/project1/vector_lines/vectors_out");
    expect(report.output_path).toBe("/project1/vector_lines/out1");
    expect(report.warnings.join("\n")).toContain("Trace SOP source parameter");
  });

  it("returns isError and does not throw when the bridge is unreachable", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()),
      http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()),
    );

    const result = await createVectorLinesImpl(makeCtx(), defaultArgs());
    expect(result).toBeDefined();
    expect(result.isError).toBe(true);
  });
});
