import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createSdfTextImpl, createSdfTextSchema } from "../../src/tools/layer1/createSdfText.js";
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
  text: "HELLO",
  font: "Arial",
  bold: true,
  depth: 0.25,
  smoothing: 0.6,
  camera_z: 2.2,
  rotate: 0.0,
  speed: 1,
  step_count: 80,
  intensity: 1,
  fill_color: "#ffd34d",
  edge_color: "#ff5c8a",
  background: "#0a0a12",
  light_direction: [0.4, 0.6, 0.8] as [number, number, number],
  resolution: [1280, 720] as [number, number],
  expose_controls: true,
  parent_path: "/project1",
};

describe("create_sdf_text", () => {
  it("builds a Text TOP glyph mask → GLSL raymarch → null out chain", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createSdfTextImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBeFalsy();

    const textTop = bodies.find((b) => b.type === "textTOP" && b.name === "glyph_mask");
    expect(textTop).toBeDefined();
    expect(textTop?.parameters?.text).toBe("HELLO");

    expect(bodies.some((b) => b.type === "glslTOP" && b.name === "raymarch")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
  });

  it("bakes the light direction constant and depth/smoothing uniforms into the shader/exec", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createSdfTextImpl(makeCtx(), { ...DEFAULT_ARGS, depth: 0.5, smoothing: 1.2 });

    const fragScript = scripts.find((s) => s.includes("sdText") && s.includes("uLightDir"));
    expect(fragScript).toBeDefined();

    const uniformScript = scripts.find((s) => s.includes("vec5valuex ="));
    expect(uniformScript).toBeDefined();
    expect(uniformScript).toContain("vec5valuex = 0.5");
    expect(uniformScript).toContain("uSmoothing");
    expect(uniformScript).toContain("vec6valuex = 1.2");
  });

  it("exposes defaults and validates ranges at the schema boundary", () => {
    const parsed = createSdfTextSchema.parse({});
    expect(parsed.text).toBe("HELLO");
    expect(parsed.depth).toBe(0.25);
    expect(parsed.step_count).toBe(80);
    expect(() => createSdfTextSchema.parse({ text: "" })).toThrow();
    expect(() => createSdfTextSchema.parse({ smoothing: 5 })).toThrow();
    expect(() => createSdfTextSchema.parse({ step_count: 4 })).toThrow();
  });

  it("never throws and returns an isError result when node creation fails (bridge fatal)", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "TouchDesigner is offline" }, { status: 502 }),
      ),
    );
    const result = await createSdfTextImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBe(true);
  });
});
