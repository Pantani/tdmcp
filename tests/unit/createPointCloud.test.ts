import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createPointCloudImpl } from "../../src/tools/layer1/createPointCloud.js";
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

describe("create_point_cloud", () => {
  it("builds source → depth map → packed position TOP → TOP-instanced geometry → render (synthetic default)", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const patched = capturePatchParams();
    const result = await createPointCloudImpl(makeCtx(), {
      source: "synthetic",
      resolution: 128,
      depth_scale: 1,
      point_size: 0.02,
      rotate: 0,
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // Synthetic source is an animated Noise TOP feeding a monochrome depth map.
    expect(bodies.some((b) => b.name === "src" && b.type === "noiseTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "heightmap" && b.type === "monochromeTOP")).toBe(true);

    // The position-pack GLSL TOP is a custom resolution×resolution RGBA32float buffer.
    const posPack = bodies.find((b) => b.name === "pos_pack");
    expect(posPack?.type).toBe("glslTOP");
    expect(posPack?.parameters).toMatchObject({
      outputresolution: "custom",
      resolutionw: 128,
      resolutionh: 128,
      format: "rgba32float",
    });

    // A textDAT carries the pack shader, wired via pixeldat.
    expect(bodies.some((b) => b.name === "pos_frag" && b.type === "textDAT")).toBe(true);
    expect(scripts.some((s) => s.includes("pixeldat") && s.includes("pos_frag"))).toBe(true);

    // A Geometry COMP holds a tiny sphere dot (inside the geo), flagged render + display.
    expect(bodies.some((b) => b.name === "geo" && b.type === "geometryCOMP")).toBe(true);
    const dot = bodies.find((b) => b.name === "dot");
    expect(dot?.type).toBe("sphereSOP");
    expect(dot?.parent_path).toMatch(/\/point_cloud\/geo$/);
    expect(dot?.parameters).toMatchObject({ radx: 0.02, rady: 0.02, radz: 0.02 });
    expect(scripts.some((s) => s.includes("render = True") && s.includes("display = True"))).toBe(
      true,
    );

    // The Geometry COMP is switched into instancing, reading XYZ from the position TOP's RGB.
    const inst = patched.find((p) => p.instancing !== undefined);
    expect(inst).toMatchObject({
      instancing: 1,
      instancetx: "r",
      instancety: "g",
      instancetz: "b",
    });
    expect(String(inst?.instanceop)).toMatch(/\/pos_pack$/);
    expect(String(inst?.instancetop)).toMatch(/\/pos_pack$/);

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
    expect(controls).toEqual(["DepthScale", "PointSize", "Spin"]);
  });

  it("scales the cloud with `resolution` (count = resolution²)", async () => {
    const bodies = captureCreateBodies();
    const result = await createPointCloudImpl(makeCtx(), {
      source: "synthetic",
      resolution: 64,
      depth_scale: 1,
      point_size: 0.02,
      rotate: 0,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const posPack = bodies.find((b) => b.name === "pos_pack");
    expect(posPack?.parameters).toMatchObject({ resolutionw: 64, resolutionh: 64 });
    // count = 64² is reported in the structured payload.
    const text = result.content.find((c) => c.type === "text");
    expect(text?.type === "text" && text.text).toContain("4096");
  });

  it("packs depth into the position shader's B channel via a uDepth uniform", async () => {
    const scripts = captureExecScripts();
    await createPointCloudImpl(makeCtx(), {
      source: "synthetic",
      resolution: 32,
      depth_scale: 2,
      point_size: 0.02,
      rotate: 0,
      expose_controls: false,
      parent_path: "/project1",
    });
    // The shader sources Z from luminance and exposes uDepth.
    const fragScript = scripts.find((s) => s.includes("pos_frag") && s.includes(".text"));
    expect(fragScript).toBeDefined();
    expect(fragScript).toContain("uDepth");
    expect(fragScript).toContain("lum");
    // The uniform block is named on the Vectors sequence.
    expect(scripts.some((s) => s.includes('vec0name = "uDepth"'))).toBe(true);
  });

  it("installs a Y-spin time expression on the geometry when rotate > 0", async () => {
    const scripts = captureExecScripts();
    await createPointCloudImpl(makeCtx(), {
      source: "synthetic",
      resolution: 32,
      depth_scale: 1,
      point_size: 0.02,
      rotate: 30,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(
      scripts.some(
        (s) => s.includes(".par.ry.expr") && s.includes("absTime.seconds") && s.includes("30"),
      ),
    ).toBe(true);
  });

  it("stays self-contained on the synthetic path (no camera/movie source)", async () => {
    const bodies = captureCreateBodies();
    await createPointCloudImpl(makeCtx(), {
      source: "synthetic",
      resolution: 32,
      depth_scale: 1,
      point_size: 0.02,
      rotate: 0,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.type === "videodeviceinTOP")).toBe(false);
    expect(bodies.some((b) => b.type === "moviefileinTOP")).toBe(false);
  });

  it("uses a Video Device In source when source='camera'", async () => {
    const bodies = captureCreateBodies();
    const result = await createPointCloudImpl(makeCtx(), {
      source: "camera",
      resolution: 32,
      depth_scale: 1,
      point_size: 0.02,
      rotate: 0,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.name === "src" && b.type === "videodeviceinTOP")).toBe(true);
  });

  it("returns a friendly isError result (never throws) when the bridge fails", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );
    const result = await createPointCloudImpl(makeCtx(), {
      source: "synthetic",
      resolution: 32,
      depth_scale: 1,
      point_size: 0.02,
      rotate: 0,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
  });
});
