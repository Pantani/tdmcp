import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createParticleSystemImpl } from "../../src/tools/layer1/createParticleSystem.js";
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

describe("createParticleSystemImpl", () => {
  it("creates the full particle chain: geometryCOMP → sphereSOP emitter → particleSOP → renderTOP → out1", async () => {
    const bodies = captureCreateBodies();
    const result = await createParticleSystemImpl(makeCtx(), {
      emitter_shape: "sphere",
      particle_count: 1000,
      forces: ["noise"],
      render_style: "sprites",
      lifetime: 3,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // Geometry COMP wraps the SOP chain.
    expect(bodies.find((b) => b.name === "geo")?.type).toBe("geometryCOMP");
    // Sphere emitter inside geo.
    expect(bodies.find((b) => b.name === "emitter")?.type).toBe("sphereSOP");
    // Particle SOP seeded with lifetime.
    const particle = bodies.find((b) => b.name === "particle");
    expect(particle?.type).toBe("particleSOP");
    expect(particle?.parameters).toMatchObject({ life: 3 });
    // Renderer and output.
    expect(bodies.some((b) => b.name === "render" && b.type === "renderTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("maps each emitter shape to the correct SOP type", async () => {
    for (const [shape, expectedType] of [
      ["circle", "circleSOP"],
      ["line", "lineSOP"],
      ["mesh", "boxSOP"],
    ] as const) {
      const bodies = captureCreateBodies();
      await createParticleSystemImpl(makeCtx(), {
        emitter_shape: shape,
        particle_count: 100,
        forces: [],
        render_style: "sprites",
        lifetime: 2,
        expose_controls: false,
        parent_path: "/project1",
      });
      expect(bodies.find((b) => b.name === "emitter")?.type).toBe(expectedType);
    }
  });

  it("uses pointspriteMAT for sprites and constantMAT for non-sprite styles", async () => {
    const sprBodies = captureCreateBodies();
    await createParticleSystemImpl(makeCtx(), {
      emitter_shape: "sphere",
      particle_count: 100,
      forces: [],
      render_style: "sprites",
      lifetime: 2,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(sprBodies.some((b) => b.name === "mat" && b.type === "pointspriteMAT")).toBe(true);

    const ptsBodies = captureCreateBodies();
    await createParticleSystemImpl(makeCtx(), {
      emitter_shape: "sphere",
      particle_count: 100,
      forces: [],
      render_style: "points",
      lifetime: 2,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(ptsBodies.some((b) => b.name === "mat" && b.type === "constantMAT")).toBe(true);
  });

  it("includes gravity in the Python dynamics script when the gravity force is requested", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createParticleSystemImpl(makeCtx(), {
      emitter_shape: "sphere",
      particle_count: 1000,
      forces: ["gravity"],
      render_style: "sprites",
      lifetime: 3,
      expose_controls: false,
      parent_path: "/project1",
    });
    // The gravity force maps to externaly=-0.6 in the Particle SOP dynamics Python.
    const dynScript = scripts.find((s) => s.includes("externaly"));
    expect(dynScript).toBeDefined();
    expect(dynScript).toContain("-0.6");
  });

  it("exposes Drag, Turbulence, Gravity, and Lifetime panel controls when expose_controls is true", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createParticleSystemImpl(makeCtx(), {
      emitter_shape: "sphere",
      particle_count: 1000,
      forces: ["gravity", "noise"],
      render_style: "sprites",
      lifetime: 3,
      expose_controls: true,
      parent_path: "/project1",
    });
    const names = panelControls(scripts).map((c) => c.name);
    expect(names).toContain("Drag");
    expect(names).toContain("Turbulence");
    expect(names).toContain("Gravity");
    expect(names).toContain("Lifetime");
  });

  it("includes emitter shape, count, and render style in the summary", async () => {
    captureCreateBodies();
    const result = await createParticleSystemImpl(makeCtx(), {
      emitter_shape: "sphere",
      particle_count: 5000,
      forces: [],
      render_style: "sprites",
      lifetime: 3,
      expose_controls: false,
      parent_path: "/project1",
    });
    const text = textOf(result);
    expect(text).toContain("sphere");
    expect(text).toContain("5000");
    expect(text).toContain("sprites");
  });
});
