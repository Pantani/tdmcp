import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createFacadeMappingImpl,
  createFacadeMappingSchema,
} from "../../src/tools/layer1/createFacadeMapping.js";
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
  default?: unknown;
  bind_to?: string[];
  menu_items?: string[];
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

function jsonOf(result: CallToolResult): Record<string, unknown> {
  const text = textOf(result);
  const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  if (!json) throw new Error("result did not include a JSON fence");
  return JSON.parse(json) as Record<string, unknown>;
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

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

function defaultArgs() {
  return createFacadeMappingSchema.parse({});
}

describe("create_facade_mapping", () => {
  // Case 1: Defaults (N=2, synthetic, horizontal)
  it("builds a 2-projector synthetic horizontal facade with correct topology", async () => {
    const bodies = captureCreateBodies();
    const result = await createFacadeMappingImpl(makeCtx(), defaultArgs());

    expect(result.isError).toBeFalsy();

    // Base COMP created
    const base = bodies.find((b) => b.type === "baseCOMP" && b.name === "facade_mapping");
    expect(base).toBeTruthy();

    // Source + fanout
    expect(bodies.find((b) => b.name === "source_in")?.type).toBe("noiseTOP");
    expect(bodies.find((b) => b.name === "source_fanout")?.type).toBe("nullTOP");

    // Per-projector operator families (2 of each)
    const crops = bodies.filter((b) => /^proj\d+_crop$/.test(b.name ?? ""));
    expect(crops).toHaveLength(2);

    const warps = bodies.filter((b) => /^proj\d+_warp$/.test(b.name ?? ""));
    expect(warps).toHaveLength(2);

    const ramps = bodies.filter((b) => /^proj\d+_blend_ramp$/.test(b.name ?? ""));
    expect(ramps).toHaveLength(2);

    const masks = bodies.filter((b) => /^proj\d+_blend_mask$/.test(b.name ?? ""));
    expect(masks).toHaveLength(2);

    const levels = bodies.filter((b) => /^proj\d+_level$/.test(b.name ?? ""));
    expect(levels).toHaveLength(2);

    // 2 per-projector output Nulls
    const outNulls = bodies.filter((b) => /^out_proj\d+$/.test(b.name ?? ""));
    expect(outNulls).toHaveLength(2);
    expect(outNulls.map((b) => b.name).sort()).toEqual(["out_proj0", "out_proj1"]);

    // Preview grid + out_facade
    expect(bodies.find((b) => b.name === "facade_preview_grid")?.type).toBe("compositeTOP");
    expect(bodies.find((b) => b.name === "out_facade")?.type).toBe("nullTOP");

    // JSON envelope
    const data = jsonOf(result);
    expect(data.output_top_path).toMatch(/out_facade$/);
    const perProjector = data.per_projector as Array<{ index: number; out: string }>;
    expect(perProjector).toHaveLength(2);
    expect(perProjector[0]?.index).toBe(0);
    expect(perProjector[1]?.index).toBe(1);

    const cal = data.calibration as Record<string, unknown>;
    expect(cal.status).toBe("uncalibrated");
    expect(cal.blend_layout).toBe("horizontal");
    expect(cal.blend_width_px).toBe(192);
    expect(cal.blend_curve).toBe("smoothstep");
    expect(cal.facade_geometry_path).toBeNull();
  });

  // Case 2: N=4 grid layout — 4 branches, correct calibration, 4 brightness controls
  it("builds a 4-projector grid layout with 4 Proj*Brightness controls", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createFacadeMappingImpl(makeCtx(), {
      ...defaultArgs(),
      projector_count: 4,
      blend_layout: "grid",
    });

    expect(result.isError).toBeFalsy();

    const outNulls = bodies.filter((b) => /^out_proj\d+$/.test(b.name ?? ""));
    expect(outNulls).toHaveLength(4);

    const data = jsonOf(result);
    const perProjector = data.per_projector as Array<{ index: number }>;
    expect(perProjector).toHaveLength(4);

    const cal = data.calibration as Record<string, unknown>;
    expect(cal.blend_layout).toBe("grid");

    // 4 Proj{i}Brightness controls in panel
    const controls = panelControls(scripts);
    const brightnessControls = controls.filter((c) => /^Proj\d+Brightness$/.test(c.name));
    expect(brightnessControls).toHaveLength(4);

    // Global controls also present
    expect(controls.find((c) => c.name === "BlendWidth")).toBeTruthy();
    expect(controls.find((c) => c.name === "BlendCurve")).toBeTruthy();
  });

  // Case 3: source_mode='existing_top' without source_top_path — Zod rejects
  it("rejects existing_top source_mode without source_top_path", () => {
    expect(() => createFacadeMappingSchema.parse({ source_mode: "existing_top" })).toThrow();

    // Providing the path is accepted
    const parsed = createFacadeMappingSchema.parse({
      source_mode: "existing_top",
      source_top_path: "/project1/render1",
    });
    expect(parsed.source_top_path).toBe("/project1/render1");
  });

  // Case 4: facade_geometry_path provided — 3D branch per projector
  it("creates renderTOP/cameraCOMP/geometryCOMP per projector when facade_geometry_path is set", async () => {
    const bodies = captureCreateBodies();

    const result = await createFacadeMappingImpl(makeCtx(), {
      ...defaultArgs(),
      projector_count: 2,
      facade_geometry_path: "/project1/my_facade_sop",
    });

    expect(result.isError).toBeFalsy();

    // geometryCOMP per projector
    const geoCOMPs = bodies.filter((b) => /^proj\d+_geo$/.test(b.name ?? ""));
    expect(geoCOMPs).toHaveLength(2);
    expect(geoCOMPs[0]?.type).toBe("geometryCOMP");

    // cameraCOMP per projector
    const camCOMPs = bodies.filter((b) => /^proj\d+_cam$/.test(b.name ?? ""));
    expect(camCOMPs).toHaveLength(2);
    expect(camCOMPs[0]?.type).toBe("cameraCOMP");

    // renderTOP per projector (warp input becomes renderTOP)
    const renderTOPs = bodies.filter((b) => /^proj\d+_render$/.test(b.name ?? ""));
    expect(renderTOPs).toHaveLength(2);
    expect(renderTOPs[0]?.type).toBe("renderTOP");

    // Warning about UNVERIFIED 3D params
    const data = jsonOf(result);
    const warnings = data.warnings as string[];
    expect(warnings.some((w) => w.includes("UNVERIFIED"))).toBe(true);

    // facade_geometry_path reflected in calibration
    const cal = data.calibration as Record<string, unknown>;
    expect(cal.facade_geometry_path).toBe("/project1/my_facade_sop");
  });

  // Case 5: expose_controls=false — no control panel, control_names: []
  it("skips the control panel when expose_controls=false", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createFacadeMappingImpl(makeCtx(), {
      ...defaultArgs(),
      expose_controls: false,
    });

    expect(result.isError).toBeFalsy();

    // No panel script
    const hasPanel = scripts.some((s) => s.includes("appendCustomPage"));
    expect(hasPanel).toBe(false);

    const data = jsonOf(result);
    expect(data.control_names).toEqual([]);
  });
});
