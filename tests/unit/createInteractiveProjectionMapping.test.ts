import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createInteractiveProjectionMappingImpl,
  createInteractiveProjectionMappingSchema,
} from "../../src/tools/layer1/createInteractiveProjectionMapping.js";
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

describe("create_interactive_projection_mapping", () => {
  it("keeps the approved public defaults in the schema", () => {
    const parsed = createInteractiveProjectionMappingSchema.parse({});
    expect(parsed.name).toBe("interactive_projection_mapping");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.source).toBe("camera");
    expect(parsed.fallback_to_synthetic).toBe(true);
    expect(parsed.interaction_mode).toBe("hybrid");
    expect(parsed.output_width).toBe(1280);
    expect(parsed.output_height).toBe(720);
    expect(parsed.particle_count).toBe(64);
    expect(parsed.card_count).toBe(5);
    expect(parsed.motion_sensitivity).toBe(4);
    expect(parsed.debug_view).toBe("final");
  });

  it("requires existing_top_path when source is existing_top", () => {
    expect(() =>
      createInteractiveProjectionMappingSchema.parse({ source: "existing_top" }),
    ).toThrow();
    expect(
      createInteractiveProjectionMappingSchema.parse({
        source: "existing_top",
        existing_top_path: "/project1/render1",
      }).existing_top_path,
    ).toBe("/project1/render1");
  });

  it("builds a synthetic-safe TOP network with named debug and output paths", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createInteractiveProjectionMappingImpl(makeCtx(), {
      name: "ipm_test",
      parent_path: "/project1",
      source: "synthetic",
      camera_index: 0,
      fallback_to_synthetic: true,
      interaction_mode: "hybrid",
      analysis_resolution: 192,
      output_width: 960,
      output_height: 540,
      particle_count: 32,
      card_count: 4,
      motion_sensitivity: 1.5,
      repel_radius: 0.2,
      trail_decay: 0.82,
      blob_threshold: 0.58,
      max_blobs: 6,
      dot_color: "#8ff4f2",
      card_color: "#ff2f9a",
      background_color: "#05100e",
      projection_brightness: 0.75,
      debug_view: "final",
      expose_controls: true,
    });

    expect(result.isError).toBeFalsy();

    const source = bodies.find((b) => b.name === "camera_in");
    expect(source?.type).toBe("noiseTOP");
    expect(source?.parameters).toMatchObject({ resolutionw: 192, resolutionh: 192 });
    expect(
      scripts.some(
        (s) => s.includes("camera_in") && s.includes("op(") && s.includes("absTime.seconds * 2"),
      ),
    ).toBe(true);

    expect(bodies.find((b) => b.name === "camera_debug")?.type).toBe("nullTOP");
    expect(bodies.find((b) => b.name === "analysis_plane")?.type).toBe("monochromeTOP");
    expect(bodies.find((b) => b.name === "analysis_debug")?.type).toBe("nullTOP");
    expect(bodies.find((b) => b.name === "motion_field")?.type).toBe("blurTOP");
    expect(bodies.find((b) => b.name === "motion_field")?.parameters).toMatchObject({
      size: 3,
    });
    expect(bodies.find((b) => b.name === "motion_prev")?.parameters).toMatchObject({
      cachesize: 2,
      replaceindex: 0,
      outputindex: -1,
    });
    expect(scripts.some((s) => s.includes("motion_prev") && s.includes("replaceindex"))).toBe(true);
    expect(bodies.find((b) => b.name === "presence_edges")?.type).toBe("edgeTOP");
    expect(bodies.find((b) => b.name === "presence_mask")?.type).toBe("thresholdTOP");
    expect(bodies.find((b) => b.name === "presence_mask")?.parameters).toMatchObject({
      threshold: 0.12,
    });
    expect(bodies.find((b) => b.name === "presence_field")?.type).toBe("blurTOP");
    expect(bodies.find((b) => b.name === "presence_gain")?.parameters).toMatchObject({
      brightness1: 0.25,
    });
    expect(bodies.find((b) => b.name === "interaction_field")?.type).toBe("compositeTOP");
    expect(bodies.find((b) => b.name === "interaction_field")?.parameters).toMatchObject({
      operand: "maximum",
    });
    expect(bodies.find((b) => b.name === "motion_hold_feedback")?.type).toBe("feedbackTOP");
    expect(bodies.find((b) => b.name === "motion_hold_decay")?.type).toBe("levelTOP");
    expect(bodies.find((b) => b.name === "motion_hold_decay")?.parameters).toMatchObject({
      brightness1: 0.92,
      opacity: 0.92,
    });
    expect(bodies.find((b) => b.name === "motion_hold_mix")?.type).toBe("compositeTOP");
    expect(bodies.find((b) => b.name === "motion_hold_mix")?.parameters).toMatchObject({
      operand: "maximum",
    });
    expect(bodies.find((b) => b.name === "motion_debug")?.type).toBe("nullTOP");
    expect(
      scripts.some((s) => s.includes("motion_hold_feedback") && s.includes("motion_hold_mix")),
    ).toBe(true);
    expect(bodies.find((b) => b.name === "motion_cooker")?.type).toBe("executeDAT");
    expect(scripts.some((s) => s.includes("motion_debug") && s.includes("onFrameStart"))).toBe(
      true,
    );
    expect(bodies.find((b) => b.name === "blob_mask")?.type).toBe("thresholdTOP");
    expect(bodies.find((b) => b.name === "blob_debug")?.type).toBe("nullTOP");
    expect(bodies.find((b) => b.name === "visual_out")?.type).toBe("nullTOP");
    expect(bodies.find((b) => b.name === "projection_map")?.type).toBe("cornerpinTOP");
    expect(bodies.find((b) => b.name === "mapped_out")?.type).toBe("nullTOP");
    expect(bodies.find((b) => b.name === "debug_switch")?.type).toBe("switchTOP");
    expect(bodies.find((b) => b.name === "projection_brightness")?.parameters).toMatchObject({
      brightness1: 0.75,
    });
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");

    const controls = panelControls(scripts);
    expect(controls.map((c) => c.name)).toEqual([
      "Sensitivity",
      "TrailDecay",
      "BlobThreshold",
      "ProjectionBrightness",
      "Calibration",
      "DebugView",
    ]);
    expect(controls.find((c) => c.name === "DebugView")?.menu_items).toEqual([
      "final",
      "camera",
      "analysis",
      "motion",
      "blobs",
      "calibration",
      "visual",
    ]);

    const data = jsonOf(result);
    expect(data.output).toBe("/project1/ipm_test/out1");
    expect(data.output_top_path).toBe("/project1/ipm_test/out1");
    expect(data.debug_paths).toMatchObject({
      camera: "/project1/ipm_test/camera_debug",
      analysis: "/project1/ipm_test/analysis_debug",
      motion: "/project1/ipm_test/motion_debug",
      blobs: "/project1/ipm_test/blob_debug",
      visual: "/project1/ipm_test/visual_out",
      mapped: "/project1/ipm_test/mapped_out",
    });
    expect(data.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Synthetic source"),
        expect.stringContaining("Blob/post-it tracking"),
        expect.stringContaining("Calibration corners"),
      ]),
    );
    expect(textOf(result)).toContain("interactive projection mapping");
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("returns isError and does not throw when the bridge is unreachable", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "TD is offline" }, { status: 500 }),
      ),
    );

    let result: CallToolResult | undefined;
    await expect(
      (async () => {
        result = await createInteractiveProjectionMappingImpl(makeCtx(), {
          name: "interactive_projection_mapping",
          parent_path: "/project1",
          source: "synthetic",
          camera_index: 0,
          fallback_to_synthetic: true,
          interaction_mode: "hybrid",
          analysis_resolution: 256,
          output_width: 1280,
          output_height: 720,
          particle_count: 64,
          card_count: 5,
          motion_sensitivity: 1,
          repel_radius: 0.18,
          trail_decay: 0.88,
          blob_threshold: 0.55,
          max_blobs: 8,
          dot_color: "#8ff4f2",
          card_color: "#ff2f9a",
          background_color: "#05100e",
          projection_brightness: 0.85,
          debug_view: "final",
          expose_controls: true,
        });
      })(),
    ).resolves.not.toThrow();
    expect(result?.isError).toBe(true);
  });
});
