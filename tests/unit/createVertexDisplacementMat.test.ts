import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createVertexDisplacementMatImpl,
  createVertexDisplacementMatSchema,
} from "../../src/tools/layer1/createVertexDisplacementMat.js";
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
  amount: 0.25,
  frequency: 2.5,
  speed: 0.3,
  demo_subdivisions: 140,
  demo_color: [0.6, 0.75, 0.95] as [number, number, number],
  expose_controls: true,
  parent_path: "/project1",
};

describe("create_vertex_displacement_mat", () => {
  it("builds a demo sphere + glslMAT + render when target_geo is omitted", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createVertexDisplacementMatImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.type === "glslMAT" && b.name === "displace")).toBe(true);
    expect(bodies.some((b) => b.type === "sphereSOP")).toBe(true);
    expect(bodies.some((b) => b.type === "renderTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
  });

  it("builds no demo render chain when target_geo is given (assign-only)", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createVertexDisplacementMatImpl(makeCtx(), {
      ...DEFAULT_ARGS,
      target_geo: "/project1/myGeo",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "glslMAT")).toBe(true);
    expect(bodies.some((b) => b.type === "sphereSOP")).toBe(false);
    expect(bodies.some((b) => b.type === "renderTOP")).toBe(false);
  });

  it("emits a sampler-bound vertex shader when texture_path is set, noise otherwise", async () => {
    captureCreateBodies();
    const noiseScripts = captureExecScripts();
    await createVertexDisplacementMatImpl(makeCtx(), { ...DEFAULT_ARGS });
    const noiseVert = noiseScripts.find((s) => s.includes("vnoise("));
    expect(noiseVert).toBeDefined();
    expect(noiseScripts.some((s) => s.includes("sampler0name"))).toBe(false);

    server.resetHandlers();
    captureCreateBodies();
    const texScripts = captureExecScripts();
    await createVertexDisplacementMatImpl(makeCtx(), {
      ...DEFAULT_ARGS,
      texture_path: "/project1/tex1",
    });
    expect(texScripts.some((s) => s.includes("sampler0name"))).toBe(true);
    expect(texScripts.some((s) => s.includes("texture(sDisp"))).toBe(true);
  });

  it("exposes defaults and validates ranges at the schema boundary", () => {
    const parsed = createVertexDisplacementMatSchema.parse({});
    expect(parsed.amount).toBe(0.25);
    expect(parsed.frequency).toBe(2.5);
    expect(parsed.demo_subdivisions).toBe(140);
    expect(() => createVertexDisplacementMatSchema.parse({ amount: -1 })).toThrow();
    expect(() => createVertexDisplacementMatSchema.parse({ demo_subdivisions: 4 })).toThrow();
    expect(() => createVertexDisplacementMatSchema.parse({ frequency: 0 })).toThrow();
  });

  it("never throws and returns an isError result when node creation fails (bridge fatal)", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "TouchDesigner is offline" }, { status: 502 }),
      ),
    );
    const result = await createVertexDisplacementMatImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBe(true);
  });
});
