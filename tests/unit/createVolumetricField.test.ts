import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createVolumetricFieldImpl } from "../../src/tools/layer1/createVolumetricField.js";
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
  menuOptions?: string[];
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

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

describe("createVolumetricFieldImpl", () => {
  it("defaults: creates noiseTOP, cacheTOP, glslTOP viewer and nullTOP with slice_count=16 and smoke palette", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createVolumetricFieldImpl(makeCtx(), {
      parent_path: "/project1",
      name: "volumetric_field",
      density: 0.5,
      turbulence: 0.4,
      color_map: "smoke",
      slice_count: 16,
      expose_controls: true,
    });

    expect(result.isError).toBeFalsy();

    // Core nodes present
    expect(bodies.some((b) => b.name === "noise1" && b.type === "noiseTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "slice_stack" && b.type === "cacheTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "viewer" && b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);

    // cacheTOP cachesize = 16
    const cache = bodies.find((b) => b.name === "slice_stack");
    expect(cache?.parameters?.cachesize).toBe(16);

    // pixeldat wiring present
    expect(scripts.some((s) => s.includes("pixeldat"))).toBe(true);

    // Exposed controls include Density, Turbulence, ColorMap
    const controls = panelControls(scripts);
    expect(controls.some((c) => c.name === "Density")).toBe(true);
    expect(controls.some((c) => c.name === "Turbulence")).toBe(true);
    expect(controls.some((c) => c.name === "ColorMap")).toBe(true);

    // Summary mentions smoke and 16
    const text = textOf(result);
    expect(text).toContain("smoke");
    expect(text).toContain("16");
  });

  it("slice_count=4: cacheTOP cachesize=4 and uSliceCountF uniform set to 4", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createVolumetricFieldImpl(makeCtx(), {
      parent_path: "/project1",
      name: "volumetric_field",
      density: 0.5,
      turbulence: 0.4,
      color_map: "smoke",
      slice_count: 4,
      expose_controls: false,
    });

    expect(result.isError).toBeFalsy();

    const cache = bodies.find((b) => b.name === "slice_stack");
    expect(cache?.parameters?.cachesize).toBe(4);

    // Python uniform script should set vec2valuex = 4 (uSliceCountF)
    expect(scripts.some((s) => s.includes("uSliceCountF") && s.includes("4"))).toBe(true);
  });

  it("color_map=nebula: uColorMapF set to index 1, summary contains nebula", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();

    const result = await createVolumetricFieldImpl(makeCtx(), {
      parent_path: "/project1",
      name: "volumetric_field",
      density: 0.5,
      turbulence: 0.4,
      color_map: "nebula",
      slice_count: 16,
      expose_controls: false,
    });

    expect(result.isError).toBeFalsy();

    // vec3valuex = 1 (nebula index)
    expect(scripts.some((s) => s.includes("uColorMapF") && s.includes("vec3valuex = 1"))).toBe(
      true,
    );

    const text = textOf(result);
    expect(text).toContain("nebula");
  });

  it("turbulence=0: displaceTOP is NOT created; noise period = 7 (upper bound)", async () => {
    const bodies = captureCreateBodies();

    const result = await createVolumetricFieldImpl(makeCtx(), {
      parent_path: "/project1",
      name: "volumetric_field",
      density: 0.5,
      turbulence: 0,
      color_map: "smoke",
      slice_count: 16,
      expose_controls: false,
    });

    expect(result.isError).toBeFalsy();

    // No displace TOP when turbulence === 0
    expect(bodies.some((b) => b.type === "displaceTOP")).toBe(false);

    // noise1 period: (1 - 0) * 6 + 1 = 7
    const noise = bodies.find((b) => b.name === "noise1");
    expect(noise?.parameters?.period).toBe(7);
  });

  it("Zod rejection: slice_count=100 and density=2 are rejected without bridge calls", async () => {
    const bodies = captureCreateBodies();

    // slice_count=100 exceeds max=32
    const r1 = await createVolumetricFieldImpl(makeCtx(), {
      parent_path: "/project1",
      name: "volumetric_field",
      density: 0.5,
      turbulence: 0.4,
      color_map: "smoke",
      slice_count: 100,
      expose_controls: false,
    });
    expect(r1.isError).toBe(true);
    expect(bodies).toHaveLength(0);

    // density=2 exceeds max=1
    const r2 = await createVolumetricFieldImpl(makeCtx(), {
      parent_path: "/project1",
      name: "volumetric_field",
      density: 2,
      turbulence: 0.4,
      color_map: "smoke",
      slice_count: 16,
      expose_controls: false,
    });
    expect(r2.isError).toBe(true);
    expect(bodies).toHaveLength(0);
  });
});
