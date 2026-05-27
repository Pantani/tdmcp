import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { create3dSceneImpl } from "../../src/tools/layer1/create3dScene.js";
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

describe("create_3d_scene", () => {
  it("renders a single primitive via Geometry + Camera + Light + Render TOP", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await create3dSceneImpl(makeCtx(), {
      primitive: "sphere",
      instances: 1,
      spin: 0,
      scale_variation: 0,
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.name === "geo" && b.type === "geometryCOMP")).toBe(true);
    const shape = bodies.find((b) => b.name === "shape");
    expect(shape?.type).toBe("sphereSOP");
    // The shape lives inside the Geometry COMP.
    expect(shape?.parent_path).toMatch(/\/scene3d\/geo$/);
    expect(bodies.find((b) => b.name === "cam")?.parameters).toMatchObject({ tz: 5 });
    expect(bodies.some((b) => b.name === "light" && b.type === "lightCOMP")).toBe(true);

    // The Render TOP reads its scene from parameters (paths), not wires.
    const render = bodies.find((b) => b.name === "render");
    expect(render?.type).toBe("renderTOP");
    expect(String(render?.parameters?.camera)).toMatch(/\/cam$/);
    expect(String(render?.parameters?.geometry)).toMatch(/\/geo$/);
    expect(String(render?.parameters?.lights)).toMatch(/\/light$/);

    // Single object → no instancing grid.
    expect(bodies.some((b) => b.name === "points")).toBe(false);
    expect(result.content.some((c) => c.type === "image")).toBe(true);

    const controls = panelControls(scripts).map((c) => c.name);
    expect(controls).toEqual(["RotateY", "Zoom"]);
  });

  it("maps the primitive enum to the right SOP", async () => {
    const bodies = captureCreateBodies();
    await create3dSceneImpl(makeCtx(), {
      primitive: "box",
      instances: 1,
      spin: 0,
      scale_variation: 0,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.find((b) => b.name === "shape")?.type).toBe("boxSOP");
  });

  it("scatters copies over a grid with GPU instancing when instances > 1", async () => {
    const bodies = captureCreateBodies();
    const patched = capturePatchParams();
    await create3dSceneImpl(makeCtx(), {
      primitive: "sphere",
      instances: 4,
      spin: 0,
      scale_variation: 0,
      expose_controls: false,
      parent_path: "/project1",
    });
    // A grid of instance points (4 → 2×2).
    const points = bodies.find((b) => b.name === "points");
    expect(points?.type).toBe("gridSOP");
    expect(points?.parameters).toMatchObject({ rows: 2, cols: 2 });

    // The Geometry COMP is switched into instancing, reading translation from the point Ps.
    const inst = patched.find((p) => p.instancing !== undefined);
    expect(inst).toMatchObject({ instancing: 1, instancetx: "P(0)", instancety: "P(1)" });
    expect(String(inst?.instanceop)).toMatch(/\/points$/);
  });

  it("adds per-instance scale variation via a Point SOP pscale attribute", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const patched = capturePatchParams();
    await create3dSceneImpl(makeCtx(), {
      primitive: "sphere",
      instances: 4,
      spin: 0,
      scale_variation: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(bodies.some((b) => b.name === "pscale" && b.type === "pointSOP")).toBe(true);
    // The pscale attribute is randomised per point and read by instance scale.
    expect(scripts.some((s) => s.includes("dopscale") && s.includes("tdu.rand"))).toBe(true);
    const inst = patched.find((p) => p.instancing !== undefined);
    expect(inst).toMatchObject({
      instancesx: "pscale",
      instancesy: "pscale",
      instancesz: "pscale",
    });
  });

  it("animates per-instance spin with an instancery expression over time", async () => {
    const scripts = captureExecScripts();
    await create3dSceneImpl(makeCtx(), {
      primitive: "sphere",
      instances: 4,
      spin: 90,
      scale_variation: 0,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(
      scripts.some((s) => s.includes("instancery.expr") && s.includes("absTime.seconds * 90")),
    ).toBe(true);
  });
});
