import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createMeshWarpImpl } from "../../src/tools/layer1/createMeshWarp.js";
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
// (e.g. the Geometry COMP's material parameter).
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

describe("create_mesh_warp", () => {
  it("builds a textured deformable grid rendered via Geometry + Camera + Light + Render TOP", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const patched = capturePatchParams();
    const result = await createMeshWarpImpl(makeCtx(), {
      source_path: "/project1/movie1",
      rows: 20,
      cols: 20,
      warp: "bulge",
      amount: 0.3,
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // Source TOP comes in through a Select TOP pointing at source_path.
    const src = bodies.find((b) => b.name === "src");
    expect(src?.type).toBe("selectTOP");
    expect(src?.parameters).toMatchObject({ top: "/project1/movie1" });

    // Geometry COMP holding the grid surface.
    expect(bodies.some((b) => b.name === "geo" && b.type === "geometryCOMP")).toBe(true);
    const surface = bodies.find((b) => b.name === "surface");
    expect(surface?.type).toBe("gridSOP");
    expect(surface?.parameters).toMatchObject({ rows: 20, cols: 20 });
    expect(surface?.parent_path).toMatch(/\/mesh_warp\/geo$/);

    // A non-flat warp adds a Point SOP that deforms the grid.
    const deform = bodies.find((b) => b.name === "deform");
    expect(deform?.type).toBe("pointSOP");
    expect(deform?.parent_path).toMatch(/\/mesh_warp\/geo$/);
    // The deform pushes each point's Z via a per-point tz expression (me.inputPoint).
    expect(scripts.some((s) => s.includes("tz.expr") && s.includes("me.inputPoint"))).toBe(true);

    // Constant MAT created, its color map pointed at the src TOP, and assigned to the geo.
    expect(bodies.some((b) => b.name === "mat" && b.type === "constantMAT")).toBe(true);
    expect(scripts.some((s) => s.includes("par.colormap") && s.includes("/mesh_warp/src"))).toBe(
      true,
    );
    const mat = patched.find((p) => p.material !== undefined);
    expect(String(mat?.material)).toMatch(/\/mesh_warp\/mat$/);

    // The Render TOP reads its scene from parameters (paths), not wires.
    const render = bodies.find((b) => b.name === "render");
    expect(render?.type).toBe("renderTOP");
    expect(String(render?.parameters?.camera)).toMatch(/\/cam$/);
    expect(String(render?.parameters?.geometry)).toMatch(/\/geo$/);
    expect(String(render?.parameters?.lights)).toMatch(/\/light$/);

    // Output Null + a preview image.
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);

    // Only Zoom is exposed as a clean binding (WarpAmount is an expression, not faked).
    const controls = panelControls(scripts).map((c) => c.name);
    expect(controls).toEqual(["Zoom"]);
  });

  it("maps each warp shape to a distinct per-point Z expression", async () => {
    const waveScripts = captureExecScripts();
    await createMeshWarpImpl(makeCtx(), {
      source_path: "/project1/movie1",
      rows: 10,
      cols: 10,
      warp: "wave",
      amount: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(waveScripts.some((s) => s.includes("tz.expr") && s.includes("sin("))).toBe(true);

    server.resetHandlers();
    const cylScripts = captureExecScripts();
    await createMeshWarpImpl(makeCtx(), {
      source_path: "/project1/movie1",
      rows: 10,
      cols: 10,
      warp: "cylinder",
      amount: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(cylScripts.some((s) => s.includes("tz.expr") && s.includes("cos("))).toBe(true);
  });

  it("skips the deform Point SOP when warp is flat", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createMeshWarpImpl(makeCtx(), {
      source_path: "/project1/movie1",
      rows: 8,
      cols: 8,
      warp: "flat",
      amount: 0.3,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // No deform Point SOP for a flat surface.
    expect(bodies.some((b) => b.name === "deform")).toBe(false);
    expect(scripts.some((s) => s.includes("tz.expr"))).toBe(false);

    // The grid itself is the rendered surface, still textured by the Constant MAT.
    expect(bodies.some((b) => b.name === "surface" && b.type === "gridSOP")).toBe(true);
    expect(bodies.some((b) => b.name === "mat" && b.type === "constantMAT")).toBe(true);
  });
});
