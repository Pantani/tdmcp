import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createFluidSimImpl, createFluidSimSchema } from "../../src/tools/layer1/createFluidSim.js";
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

function defaults(overrides: Partial<Parameters<typeof createFluidSimImpl>[1]> = {}) {
  return createFluidSimSchema.parse({ ...overrides });
}

describe("createFluidSimImpl", () => {
  it("creates the expected node inventory (seeds, feedbacks, GLSL stages, outs)", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createFluidSimImpl(makeCtx(), defaults({ expose_controls: false }));
    expect(result.isError).toBeFalsy();

    const ofType = (t: string) => bodies.filter((b) => b.type === t).length;
    expect(ofType("constantTOP")).toBe(2);
    expect(ofType("feedbackTOP")).toBe(3);
    expect(ofType("glslTOP")).toBe(7);
    expect(ofType("textDAT")).toBe(7);
    expect(ofType("nullTOP")).toBe(2);
    expect(ofType("levelTOP")).toBe(1);

    // Named nodes from the spec topology.
    for (const name of [
      "vel_seed",
      "dye_seed",
      "vel_fb",
      "pressure_fb",
      "dye_fb",
      "advect_vel",
      "splat_force",
      "divergence",
      "jacobi",
      "grad_subtract",
      "advect_dye",
      "splat_dye",
      "vel_out",
      "dye_out",
    ]) {
      expect(bodies.some((b) => b.name === name)).toBe(true);
    }
  });

  it("wires each glslTOP's pixeldat at its sibling textDAT", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await createFluidSimImpl(makeCtx(), defaults({ expose_controls: false }));

    for (const stage of [
      "advect_vel",
      "splat_force",
      "divergence",
      "jacobi",
      "grad_subtract",
      "advect_dye",
      "splat_dye",
    ]) {
      const wired = scripts.some(
        (s) => s.includes(`${stage}_frag`) && s.includes(stage) && s.includes("pixeldat"),
      );
      expect(wired, `pixeldat wired for ${stage}`).toBe(true);
    }
    expect(bodies.length).toBeGreaterThan(0);
    // Each feedbackTOP gets its .par.top set to close the loop.
    for (const fb of ["vel_fb", "pressure_fb", "dye_fb"]) {
      expect(scripts.some((s) => s.includes(fb) && s.includes(".par.top"))).toBe(true);
    }
  });

  it("creates an LFO + nullCHOP for injection_mode='auto', and none for 'static'", async () => {
    const bodiesAuto = captureCreateBodies();
    captureExecScripts();
    await createFluidSimImpl(
      makeCtx(),
      defaults({ injection_mode: "auto", expose_controls: false }),
    );
    expect(bodiesAuto.some((b) => b.type === "lfoCHOP")).toBe(true);
    expect(bodiesAuto.some((b) => b.name === "point_null" && b.type === "nullCHOP")).toBe(true);

    server.resetHandlers();
    const bodiesStatic = captureCreateBodies();
    captureExecScripts();
    await createFluidSimImpl(
      makeCtx(),
      defaults({ injection_mode: "static", expose_controls: false }),
    );
    expect(bodiesStatic.some((b) => b.type === "lfoCHOP")).toBe(false);
  });

  it("creates an audio_null CHOP and folds it into the InjectStrength binding when audio_path is set", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createFluidSimImpl(
      makeCtx(),
      defaults({ audio_path: "/project1/audio_in", injection_mode: "audio" }),
    );
    const controls = panelControls(scripts);
    const strength = controls.find((c) => c.name === "InjectStrength");
    expect(strength).toBeDefined();
    expect(strength?.bind_to?.some((t) => t.includes("audio_null"))).toBe(true);
  });

  it("exposes 8 controls with non-empty bind_to lists", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createFluidSimImpl(makeCtx(), defaults());
    const controls = panelControls(scripts);
    expect(controls).toHaveLength(8);
    for (const c of controls) {
      expect(c.bind_to && c.bind_to.length > 0).toBe(true);
    }
    // PressureIters default reflects the spec's 20 iterations.
    const iters = controls.find((c) => c.name === "PressureIters");
    expect(iters?.default).toBe(20);
  });

  it("uses 512² and 20 Jacobi iterations by default and mentions them in the summary", async () => {
    captureCreateBodies();
    captureExecScripts();
    const result = await createFluidSimImpl(makeCtx(), defaults({ expose_controls: false }));
    const text = textOf(result);
    expect(text).toContain("512");
    expect(text).toContain("20");
    expect(text.toLowerCase()).toContain("fluid");
  });

  it("rejects out-of-range schema inputs", () => {
    expect(() => createFluidSimSchema.parse({ pressure_iterations: 0 })).toThrow();
    expect(() => createFluidSimSchema.parse({ injection_radius: 1.0 })).toThrow();
    expect(() => createFluidSimSchema.parse({ dissipation: 0.5 })).toThrow();
    expect(() => createFluidSimSchema.parse({ resolution: "128" })).toThrow();
  });
});
