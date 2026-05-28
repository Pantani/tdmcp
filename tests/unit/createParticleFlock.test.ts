import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createParticleFlockImpl } from "../../src/tools/layer1/createParticleFlock.js";
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

// Records PATCH parameter bodies so tests can assert params set after node creation
// (e.g. the Geometry COMP's instancing parameters).
function capturePatchParams(): Array<Record<string, unknown>> {
  const patched: Array<Record<string, unknown>> = [];
  server.use(
    http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ request }) => {
      const body = (await request.json()) as { parameters: Record<string, unknown> };
      patched.push(body.parameters);
      return HttpResponse.json({
        ok: true,
        data: { path: "/p", type: "geometryCOMP", name: "geo", parameters: body.parameters },
      });
    }),
  );
  return patched;
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

describe("create_particle_flock", () => {
  it("builds position + velocity feedback loops feeding TOP-instanced geometry", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const patched = capturePatchParams();
    const result = await createParticleFlockImpl(makeCtx(), {
      count: 64,
      separation: 1.0,
      alignment: 1.0,
      cohesion: 1.0,
      speed: 1.0,
      color: [0.4, 0.8, 1.0],
      point_size: 0.02,
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // Two feedback TOPs: one for velocity, one for position.
    expect(bodies.some((b) => b.name === "vel_fb" && b.type === "feedbackTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "pos_fb" && b.type === "feedbackTOP")).toBe(true);

    // Two GLSL TOPs, both custom count×count RGBA32float data buffers.
    const velUpdate = bodies.find((b) => b.name === "vel_update");
    const posUpdate = bodies.find((b) => b.name === "pos_update");
    expect(velUpdate?.type).toBe("glslTOP");
    expect(posUpdate?.type).toBe("glslTOP");
    for (const buf of [velUpdate, posUpdate]) {
      expect(buf?.parameters).toMatchObject({
        outputresolution: "custom",
        resolutionw: 64,
        resolutionh: 64,
        format: "rgba32float",
      });
    }

    // A textDAT carries each shader, wired via pixeldat.
    expect(bodies.some((b) => b.name === "vel_frag" && b.type === "textDAT")).toBe(true);
    expect(bodies.some((b) => b.name === "pos_frag" && b.type === "textDAT")).toBe(true);
    expect(scripts.some((s) => s.includes("pixeldat") && s.includes("vel_frag"))).toBe(true);
    expect(scripts.some((s) => s.includes("pixeldat") && s.includes("pos_frag"))).toBe(true);

    // Both feedback loops are closed via feedbackTOP.par.top.
    expect(scripts.some((s) => s.includes(".par.top") && s.includes("vel_update"))).toBe(true);
    expect(scripts.some((s) => s.includes(".par.top") && s.includes("pos_update"))).toBe(true);

    // A Geometry COMP holds a tiny dot, flagged for render + display.
    expect(bodies.some((b) => b.name === "geo" && b.type === "geometryCOMP")).toBe(true);
    const dot = bodies.find((b) => b.name === "dot");
    expect(dot?.type).toBe("sphereSOP");
    expect(dot?.parent_path).toMatch(/\/particle_flock\/geo$/);
    expect(scripts.some((s) => s.includes("render = True") && s.includes("display = True"))).toBe(
      true,
    );

    // The Geometry COMP is switched into instancing, reading from the position TOP.
    const inst = patched.find((p) => p.instancing !== undefined);
    expect(inst).toMatchObject({ instancing: 1 });
    expect(String(inst?.instanceop)).toMatch(/\/pos_update$/);

    // The Render TOP reads camera / geometry / lights (from parameters, not wires).
    const render = bodies.find((b) => b.name === "render");
    expect(render?.type).toBe("renderTOP");
    expect(String(render?.parameters?.camera)).toMatch(/\/cam$/);
    expect(String(render?.parameters?.geometry)).toMatch(/\/geo$/);
    expect(String(render?.parameters?.lights)).toMatch(/\/light$/);

    // Output null + a captured preview image.
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);

    const controls = panelControls(scripts).map((c) => c.name);
    expect(controls).toEqual(["Separation", "Alignment", "Cohesion", "Speed"]);
  });

  it("embeds the three boids rules + speed into the velocity shader and binds them as uniforms", async () => {
    const scripts = captureExecScripts();
    await createParticleFlockImpl(makeCtx(), {
      count: 32,
      separation: 1.0,
      alignment: 1.0,
      cohesion: 1.0,
      speed: 1.0,
      color: [0.4, 0.8, 1.0],
      point_size: 0.02,
      expose_controls: false,
      parent_path: "/project1",
    });
    const velFragScript = scripts.find((s) => s.includes("vel_frag") && s.includes(".text"));
    expect(velFragScript).toBeDefined();
    // The three boids rules and the cruise speed appear as named uniforms in the shader.
    expect(velFragScript).toContain("uSeparation");
    expect(velFragScript).toContain("uAlignment");
    expect(velFragScript).toContain("uCohesion");
    expect(velFragScript).toContain("uSpeed");
    // The velocity shader reads the position field (input 1) as the neighbour source.
    expect(velFragScript).toContain("sTD2DInputs[1]");
    // The uniforms are bound via the GLSL TOP vec sequence (named + seeded).
    expect(scripts.some((s) => s.includes('vec0name = "uSeparation"') && s.includes("uRes"))).toBe(
      true,
    );
  });

  it("wires the position feedback into the velocity shader's second input (neighbour field)", async () => {
    const bodies = captureCreateBodies();
    const result = await createParticleFlockImpl(makeCtx(), {
      count: 16,
      separation: 0.5,
      alignment: 1.5,
      cohesion: 0.8,
      speed: 2.0,
      color: [1, 0, 0],
      point_size: 0.03,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // pos_fb must be created before vel_update so it can be wired into vel_update's input 1.
    const posFbIdx = bodies.findIndex((b) => b.name === "pos_fb");
    const velUpdateIdx = bodies.findIndex((b) => b.name === "vel_update");
    expect(posFbIdx).toBeGreaterThanOrEqual(0);
    expect(velUpdateIdx).toBeGreaterThan(posFbIdx);
  });

  it("scales the buffers with `count` (agents = count²)", async () => {
    const bodies = captureCreateBodies();
    const result = await createParticleFlockImpl(makeCtx(), {
      count: 32,
      separation: 1.0,
      alignment: 1.0,
      cohesion: 1.0,
      speed: 1.0,
      color: [0.4, 0.8, 1.0],
      point_size: 0.02,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const posUpdate = bodies.find((b) => b.name === "pos_update");
    expect(posUpdate?.parameters).toMatchObject({ resolutionw: 32, resolutionh: 32 });
    // agents = 32² = 1024 is reported in the summary.
    const text = result.content.find((c) => c.type === "text");
    expect(text?.type === "text" && text.text).toContain("1024");
  });

  it("tints the dot material from the requested color", async () => {
    const bodies = captureCreateBodies();
    await createParticleFlockImpl(makeCtx(), {
      count: 16,
      separation: 1.0,
      alignment: 1.0,
      cohesion: 1.0,
      speed: 1.0,
      color: [0.1, 0.2, 0.9],
      point_size: 0.02,
      expose_controls: false,
      parent_path: "/project1",
    });
    const mat = bodies.find((b) => b.name === "mat" && b.type === "constantMAT");
    expect(mat?.parameters).toMatchObject({ colorr: 0.1, colorg: 0.2, colorb: 0.9 });
  });

  it("omits the control panel when expose_controls is false", async () => {
    const scripts = captureExecScripts();
    await createParticleFlockImpl(makeCtx(), {
      count: 16,
      separation: 1.0,
      alignment: 1.0,
      cohesion: 1.0,
      speed: 1.0,
      color: [0.4, 0.8, 1.0],
      point_size: 0.02,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(panelControls(scripts)).toEqual([]);
  });

  it("returns a friendly isError result when the bridge is unreachable", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()),
      http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()),
    );
    const result = await createParticleFlockImpl(makeCtx(), {
      count: 64,
      separation: 1.0,
      alignment: 1.0,
      cohesion: 1.0,
      speed: 1.0,
      color: [0.4, 0.8, 1.0],
      point_size: 0.02,
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
  });
});
