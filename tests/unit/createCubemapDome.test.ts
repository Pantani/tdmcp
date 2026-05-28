import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createCubemapDomeImpl } from "../../src/tools/layer1/createCubemapDome.js";
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
  projection: "fisheye" as const,
  fov: 180,
  resolution: "2048" as const,
  expose_controls: true,
  name: "cubemap_dome",
  parent_path: "/project1",
};

describe("create_cubemap_dome", () => {
  it("renders a test scene as a cube map, then samplerCube-remaps it to a fisheye dome master", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createCubemapDomeImpl(makeCtx(), { ...baseArgs });
    expect(result.isError).toBeFalsy();

    // A renderable 3D test scene: Geometry COMP + sphere + camera + light + Render TOP.
    expect(bodies.some((b) => b.name === "geo" && b.type === "geometryCOMP")).toBe(true);
    const shape = bodies.find((b) => b.name === "shape");
    expect(shape?.type).toBe("sphereSOP");
    // The sphere is pushed off the cube origin so the camera sees it as an object, not from inside.
    expect(shape?.parameters?.tx).toBe(3);
    expect(bodies.some((b) => b.name === "cam" && b.type === "cameraCOMP")).toBe(true);
    expect(bodies.some((b) => b.name === "light" && b.type === "lightCOMP")).toBe(true);

    // The Render TOP renders in cube-map mode — it outputs a real cube-map texture directly,
    // so no separate Cube Map TOP is needed (one render = all six faces).
    const render = bodies.find((b) => b.name === "render");
    expect(render?.type).toBe("renderTOP");
    expect(String(render?.parameters?.camera)).toMatch(/\/cam$/);
    expect(String(render?.parameters?.geometry)).toMatch(/\/geo$/);
    expect(render?.parameters?.rendermode).toBe("cubemap");
    // The broken Cube Map TOP path is gone: the render is the cube source itself.
    expect(bodies.some((b) => b.type === "cubemapTOP")).toBe(false);

    // A GLSL TOP (square dome master) + the Text DAT holding its shader.
    const remap = bodies.find((b) => b.name === "remap");
    expect(remap?.type).toBe("glslTOP");
    expect(remap?.parameters).toMatchObject({
      outputresolution: "custom",
      resolutionw: 2048,
      resolutionh: 2048,
    });
    expect(bodies.some((b) => b.name === "remap_frag" && b.type === "textDAT")).toBe(true);

    // Ends on a Null.
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);

    // An exec script writes the shader and points the GLSL TOP's pixeldat at the Text DAT.
    expect(scripts.some((s) => s.includes("pixeldat") && s.includes("op("))).toBe(true);

    // The fisheye shader samples the cube map by direction and follows the TD GLSL TOP conventions.
    const shaderScript = scripts.find((s) => s.includes("TDOutputSwizzle"));
    expect(shaderScript).toBeDefined();
    expect(shaderScript).toContain("out vec4 fragColor;");
    expect(shaderScript).toContain("sTDCubeInputs[0]");
    // Cube maps are sampled by a 3D direction, not a 2D latlong source.
    expect(shaderScript).not.toContain("sTD2DInputs");
    // Fisheye clips the unit disc to black.
    expect(shaderScript).toContain("r > 1.0");

    // A preview image is captured.
    expect(result.content.some((c) => c.type === "image")).toBe(true);

    // Fisheye uses fov, so the summary prose states it.
    const text = result.content.find((c) => c.type === "text");
    const summaryLine = text?.type === "text" ? text.text.split("\n")[0] : "";
    expect(summaryLine).toContain("(fov 180°)");
  });

  it("samples the cube map by direction for an equirectangular sweep (no disc clip)", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createCubemapDomeImpl(makeCtx(), {
      ...baseArgs,
      projection: "equirectangular",
      resolution: "1024",
    });
    expect(result.isError).toBeFalsy();

    const shaderScript = scripts.find((s) => s.includes("TDOutputSwizzle"));
    expect(shaderScript).toBeDefined();
    expect(shaderScript).toContain("out vec4 fragColor;");
    expect(shaderScript).toContain("sTDCubeInputs[0]");
    // Equirectangular sweeps longitude/latitude — no fisheye disc clip.
    expect(shaderScript).not.toContain("r > 1.0");
    expect(shaderScript).toContain("lon");

    // fov is ignored for equirectangular, so the summary prose must NOT state "(fov …°)".
    // (The structured JSON block still carries the fov key; only the prose suffix is conditional.)
    const text = result.content.find((c) => c.type === "text");
    const summaryLine = text?.type === "text" ? text.text.split("\n")[0] : "";
    expect(summaryLine).not.toContain("fov");
    expect(summaryLine).toContain("equirectangular master");
  });

  it("honours the resolution enum on the GLSL dome master", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    await createCubemapDomeImpl(makeCtx(), { ...baseArgs, resolution: "4096" });
    expect(bodies.find((b) => b.name === "remap")?.parameters).toMatchObject({
      resolutionw: 4096,
      resolutionh: 4096,
    });
  });

  it("pulls an existing cube-map source through a Select TOP and skips the test scene", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createCubemapDomeImpl(makeCtx(), {
      ...baseArgs,
      source: "/project1/myCube",
    });
    expect(result.isError).toBeFalsy();

    const src = bodies.find((b) => b.name === "src");
    expect(src?.type).toBe("selectTOP");
    expect(src?.parameters).toMatchObject({ top: "/project1/myCube" });

    // No test scene is built when a source is supplied.
    expect(bodies.some((b) => b.name === "render")).toBe(false);
    expect(bodies.some((b) => b.name === "cube")).toBe(false);
    expect(bodies.some((b) => b.name === "geo")).toBe(false);

    // Still produces the GLSL remap → Null dome master.
    expect(bodies.some((b) => b.name === "remap" && b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
  });

  it("exposes a live Fov knob and a Rotation knob bound to the shader uniforms", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createCubemapDomeImpl(makeCtx(), { ...baseArgs });

    const controls = panelControls(scripts);
    expect(controls.map((c) => c.name)).toEqual(["Rotation", "Fov"]);

    const fov = controls.find((c) => c.name === "Fov");
    expect(fov?.type).toBe("float");
    expect(fov?.default).toBe(180);
    expect(fov?.bind_to?.[0]).toMatch(/\/remap\.vec1valuex$/);

    const rotation = controls.find((c) => c.name === "Rotation");
    expect(rotation?.bind_to?.[0]).toMatch(/\/remap\.vec0valuex$/);

    // The uniform blocks are raised on the GLSL TOP's Vectors page and named.
    expect(scripts.some((s) => s.includes("seq.vec") && s.includes('vec1name = "uFov"'))).toBe(
      true,
    );
  });

  it("exposes only a Rotation knob for equirectangular (Fov is inert)", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createCubemapDomeImpl(makeCtx(), { ...baseArgs, projection: "equirectangular" });
    const controls = panelControls(scripts);
    expect(controls.map((c) => c.name)).toEqual(["Rotation"]);
  });

  it("returns a friendly error (never throws) when the bridge fails", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { message: "TD offline" } }, { status: 503 }),
      ),
    );
    const result = await createCubemapDomeImpl(makeCtx(), { ...baseArgs });
    expect(result.isError).toBe(true);
    expect(result.content.some((c) => c.type === "text")).toBe(true);
  });
});
