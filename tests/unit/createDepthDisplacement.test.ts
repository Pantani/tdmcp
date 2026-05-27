import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createDepthDisplacementImpl } from "../../src/tools/layer1/createDepthDisplacement.js";
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

describe("create_depth_displacement", () => {
  it("builds a grid relief displaced by a luminance map via a GLSL material", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createDepthDisplacementImpl(makeCtx(), {
      source: "synthetic",
      subdivisions: 100,
      depth: 1,
      invert: false,
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // Default synthetic source → an animated Noise TOP named "videoin".
    const videoin = bodies.find((b) => b.name === "videoin");
    expect(videoin?.type).toBe("noiseTOP");
    expect(scripts.some((s) => s.includes("videoin") && s.includes("absTime.seconds"))).toBe(true);

    // The height map (monochrome luminance) the material samples.
    expect(bodies.some((b) => b.name === "heightmap" && b.type === "monochromeTOP")).toBe(true);

    // Geometry COMP holding a subdivided grid, flagged render + display.
    expect(bodies.some((b) => b.name === "geo" && b.type === "geometryCOMP")).toBe(true);
    const surface = bodies.find((b) => b.name === "surface");
    expect(surface?.type).toBe("gridSOP");
    expect(surface?.parent_path).toMatch(/\/depth_displacement\/geo$/);
    expect(surface?.parameters).toMatchObject({ rows: 100, cols: 100 });
    expect(scripts.some((s) => s.includes("surface") && s.includes("_s.render = True"))).toBe(true);

    // A displacement material is created and assigned to the geo.
    const mat = bodies.find((b) => b.name === "displace");
    expect(mat?.type).toBe("glslMAT");
    expect(scripts.some((s) => s.includes("par.material") && s.includes("/displace"))).toBe(true);

    // The vertex shader offsets P.z by sampled luminance × the depth uniform, the GLSL MAT gets
    // both a vertex (vdat) and a pixel (pdat) stage, and sampler 0 points at the height map.
    expect(scripts.some((s) => s.includes("p.z += lum * uDepth"))).toBe(true);
    expect(scripts.some((s) => s.includes("par.vdat") && s.includes("par.pdat"))).toBe(true);
    expect(scripts.some((s) => s.includes("sampler0top") && s.includes("/heightmap"))).toBe(true);

    // Execute DAT keep-alive cooking each frame.
    const cooker = bodies.find((b) => b.name === "cooker");
    expect(cooker?.type).toBe("executeDAT");
    expect(scripts.some((s) => s.includes("cooker") && s.includes("framestart"))).toBe(true);

    // Render TOP reads its scene from parameters (paths), not wires.
    const render = bodies.find((b) => b.name === "render");
    expect(render?.type).toBe("renderTOP");
    expect(String(render?.parameters?.camera)).toMatch(/\/cam$/);
    expect(String(render?.parameters?.geometry)).toMatch(/\/geo$/);
    expect(String(render?.parameters?.lights)).toMatch(/\/light$/);

    // Output Null + a captured preview image.
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);

    const controls = panelControls(scripts).map((c) => c.name);
    expect(controls).toEqual(["Depth", "Zoom"]);
  });

  it("honors invert in the depth uniform seed", async () => {
    const scripts = captureExecScripts();
    captureCreateBodies();
    await createDepthDisplacementImpl(makeCtx(), {
      source: "synthetic",
      subdivisions: 100,
      depth: 1,
      invert: true,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(scripts.some((s) => s.includes("uInvert") && s.includes("vec1valuex = 1"))).toBe(true);
  });

  it("uses a Movie File In source when source='file'", async () => {
    const bodies = captureCreateBodies();
    await createDepthDisplacementImpl(makeCtx(), {
      source: "file",
      movie_file_path: "/clips/depth.mov",
      subdivisions: 64,
      depth: 2,
      invert: false,
      expose_controls: false,
      parent_path: "/project1",
    });
    const videoin = bodies.find((b) => b.name === "videoin");
    expect(videoin?.type).toBe("moviefileinTOP");
    expect(videoin?.parameters).toMatchObject({ file: "/clips/depth.mov", play: 1 });
    // Grid resolution follows subdivisions.
    expect(bodies.find((b) => b.name === "surface")?.parameters).toMatchObject({
      rows: 64,
      cols: 64,
    });
  });
});
