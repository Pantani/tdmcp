import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createPbrSceneImpl } from "../../src/tools/layer1/createPbrScene.js";
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

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

const baseArgs = {
  shape: "sphere" as const,
  metallic: 0.9,
  roughness: 0.3,
  base_color: [0.8, 0.8, 0.85] as [number, number, number],
  env_color: [0.9, 0.95, 1.0] as [number, number, number],
  rotate: 0,
  expose_controls: true,
  parent_path: "/project1",
};

describe("create_pbr_scene", () => {
  it("builds Geometry + PBR MAT + Environment Light + key Light + Render TOP", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createPbrSceneImpl(makeCtx(), { ...baseArgs });
    expect(result.isError).toBeFalsy();

    // Geometry COMP holding the chosen primitive SOP, nested inside the system container.
    expect(bodies.some((b) => b.name === "geo" && b.type === "geometryCOMP")).toBe(true);
    const shape = bodies.find((b) => b.name === "shape");
    expect(shape?.type).toBe("sphereSOP");
    expect(shape?.parent_path).toMatch(/\/pbrscene\/geo$/);

    // Camera + key light.
    expect(bodies.find((b) => b.name === "cam")?.parameters).toMatchObject({ tz: 5 });
    expect(bodies.some((b) => b.name === "light" && b.type === "lightCOMP")).toBe(true);

    // The output is a wired Null, and a preview image comes back.
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("creates a pbrMAT with base colour, metallic and roughness, assigned to the geo", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await createPbrSceneImpl(makeCtx(), { ...baseArgs, metallic: 0.5, roughness: 0.7 });

    const mat = bodies.find((b) => b.name === "pbr");
    expect(mat?.type).toBe("pbrMAT");
    expect(mat?.parameters).toMatchObject({
      basecolorr: 0.8,
      basecolorg: 0.8,
      basecolorb: 0.85,
      metallic: 0.5,
      roughness: 0.7,
    });
    // The material is assigned to the Geometry COMP via an exec script.
    expect(scripts.some((s) => s.includes("par.material") && s.includes("/pbr"))).toBe(true);
  });

  it("rigs an Environment Light fed by a Constant TOP of env_color for IBL", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    await createPbrSceneImpl(makeCtx(), {
      ...baseArgs,
      env_color: [0.2, 0.4, 0.6],
    });

    const envmap = bodies.find((b) => b.name === "envmap");
    expect(envmap?.type).toBe("constantTOP");
    expect(envmap?.parameters).toMatchObject({ colorr: 0.2, colorg: 0.4, colorb: 0.6 });

    const envlight = bodies.find((b) => b.name === "envlight");
    expect(envlight?.type).toBe("environmentlightCOMP");
    // The env light's image-based-lighting source is the constant TOP.
    expect(String(envlight?.parameters?.envlightmap)).toMatch(/\/envmap$/);
    expect(envlight?.parameters).toMatchObject({ dimmer: 1 });
  });

  it("binds both the key light and the environment light into the Render TOP", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    await createPbrSceneImpl(makeCtx(), { ...baseArgs });

    const render = bodies.find((b) => b.name === "render");
    expect(render?.type).toBe("renderTOP");
    expect(String(render?.parameters?.camera)).toMatch(/\/cam$/);
    expect(String(render?.parameters?.geometry)).toMatch(/\/geo$/);
    // lights is a space-joined string of both light paths.
    const lights = String(render?.parameters?.lights);
    expect(lights).toMatch(/\/light\s/);
    expect(lights).toMatch(/\/envlight$/);
  });

  it("maps the shape enum to the right SOP", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    await createPbrSceneImpl(makeCtx(), { ...baseArgs, shape: "box", expose_controls: false });
    expect(bodies.find((b) => b.name === "shape")?.type).toBe("boxSOP");

    const torusBodies = captureCreateBodies();
    await createPbrSceneImpl(makeCtx(), { ...baseArgs, shape: "torus", expose_controls: false });
    expect(torusBodies.find((b) => b.name === "shape")?.type).toBe("torusSOP");
  });

  it("animates a continuous Y spin via an absTime expression when rotate > 0", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createPbrSceneImpl(makeCtx(), { ...baseArgs, rotate: 45, expose_controls: false });
    expect(scripts.some((s) => s.includes("ry.expr") && s.includes("absTime.seconds * 45"))).toBe(
      true,
    );
  });

  it("does not emit a spin expression when rotate is 0", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createPbrSceneImpl(makeCtx(), { ...baseArgs, rotate: 0, expose_controls: false });
    expect(scripts.some((s) => s.includes("ry.expr"))).toBe(false);
  });

  it("exposes Metallic, Roughness, BaseColor and Spin controls", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createPbrSceneImpl(makeCtx(), { ...baseArgs });

    const controls = panelControls(scripts);
    expect(controls.map((c) => c.name)).toEqual(["Metallic", "Roughness", "BaseColor", "Spin"]);

    // Float knobs drive the PBR / transform params; the rgb swatch is display-only.
    const metallic = controls.find((c) => c.name === "Metallic");
    expect(metallic?.type).toBe("float");
    expect(metallic?.bind_to?.[0]).toMatch(/\/pbr\.metallic$/);
    expect(controls.find((c) => c.name === "Roughness")?.bind_to?.[0]).toMatch(/\/pbr\.roughness$/);
    expect(controls.find((c) => c.name === "Spin")?.bind_to?.[0]).toMatch(/\/geo\.ry$/);
    expect(controls.find((c) => c.name === "BaseColor")?.type).toBe("rgb");
  });

  it("returns a friendly error (never throws) when the bridge fails", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { message: "TD offline" } }, { status: 503 }),
      ),
    );
    const result = await createPbrSceneImpl(makeCtx(), { ...baseArgs });
    expect(result.isError).toBe(true);
    expect(result.content.some((c) => c.type === "text")).toBe(true);
  });
});
