import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createTerrainImpl, createTerrainSchema } from "../../src/tools/layer1/createTerrain.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
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

const DEFAULT_ARGS = {
  subdivisions: 160,
  height: 0.6,
  noise_period: 2.4,
  drift: 0.15,
  low_color: [0.06, 0.12, 0.05] as [number, number, number],
  high_color: [0.85, 0.82, 0.7] as [number, number, number],
  water: true,
  water_level: 0.12,
  water_color: [0.05, 0.22, 0.35] as [number, number, number],
  fog: true,
  background: [0.5, 0.6, 0.72] as [number, number, number],
  expose_controls: true,
  parent_path: "/project1",
};

describe("create_terrain", () => {
  it("builds a noise heightmap → grid SOP + glslMAT vertex displacement → render chain", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createTerrainImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.type === "noiseTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "gridSOP")).toBe(true);
    expect(bodies.some((b) => b.type === "glslMAT")).toBe(true);
    expect(bodies.some((b) => b.type === "renderTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);

    const grid = bodies.find((b) => b.type === "gridSOP" && b.name === "surface");
    expect(grid?.parameters?.rows).toBe(160);
    expect(grid?.parameters?.cols).toBe(160);
  });

  it("adds a water geometry when water=true and omits it when water=false", async () => {
    const withWater = captureCreateBodies();
    captureExecScripts();
    await createTerrainImpl(makeCtx(), { ...DEFAULT_ARGS, water: true });
    expect(withWater.filter((b) => b.type === "geometryCOMP").length).toBeGreaterThanOrEqual(2);

    server.resetHandlers();
    const noWater = captureCreateBodies();
    captureExecScripts();
    await createTerrainImpl(makeCtx(), { ...DEFAULT_ARGS, water: false });
    expect(noWater.some((b) => b.name === "water_geo")).toBe(false);
  });

  it("writes the height uniform and drift expression into the exec scripts", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createTerrainImpl(makeCtx(), { ...DEFAULT_ARGS, height: 1.5, drift: 0.4 });

    const matScript = scripts.find((s) => s.includes("uHeight"));
    expect(matScript).toBeDefined();
    expect(matScript).toContain("vec0valuex = 1.5");

    const driftScript = scripts.find((s) => s.includes("Drift"));
    expect(driftScript).toBeDefined();
  });

  it("exposes defaults and validates ranges at the schema boundary", () => {
    const parsed = createTerrainSchema.parse({});
    expect(parsed.subdivisions).toBe(160);
    expect(parsed.height).toBe(0.6);
    expect(parsed.water).toBe(true);
    expect(parsed.fog).toBe(true);
    expect(() => createTerrainSchema.parse({ subdivisions: 3 })).toThrow();
    expect(() => createTerrainSchema.parse({ subdivisions: 500 })).toThrow();
    expect(() => createTerrainSchema.parse({ height: -1 })).toThrow();
  });

  it("never throws and returns an isError result when node creation fails (bridge fatal)", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "TouchDesigner is offline" }, { status: 502 }),
      ),
    );
    const result = await createTerrainImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBe(true);
  });
});
