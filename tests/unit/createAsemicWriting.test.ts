import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createAsemicWritingImpl,
  createAsemicWritingSchema,
} from "../../src/tools/layer1/createAsemicWriting.js";
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
  rows: 8,
  glyphs: 14,
  strokes: 5,
  jitter: 0.55,
  slant: 0.12,
  lift_chance: 0.25,
  thickness: 0.004,
  ink_color: [0.9, 0.9, 0.92] as [number, number, number],
  background: [0.06, 0.05, 0.07] as [number, number, number],
  seed: 1,
  parent_path: "/project1",
};

describe("create_asemic_writing", () => {
  it("builds a Script SOP pen → Tube SOP → ortho render chain", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createAsemicWritingImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBeFalsy();

    expect(bodies.some((b) => b.type === "scriptSOP" && b.name === "write")).toBe(true);
    expect(bodies.some((b) => b.type === "tubeSOP")).toBe(true);
    expect(bodies.some((b) => b.type === "constantMAT")).toBe(true);
    expect(bodies.some((b) => b.type === "renderTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
  });

  it("writes the config JSON and the cook callback into the exec scripts", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createAsemicWritingImpl(makeCtx(), { ...DEFAULT_ARGS, rows: 6, glyphs: 10 });

    const cfgScript = scripts.find((s) => s.includes("glyphs") && s.includes("10"));
    expect(cfgScript).toBeDefined();
    expect(cfgScript).toContain("rows");
    expect(cfgScript).toContain("6");

    const cbScript = scripts.find((s) => s.includes("def cook(scriptOp)"));
    expect(cbScript).toBeDefined();
    expect(cbScript).toContain("appendPoly");
  });

  it("exposes defaults and validates ranges at the schema boundary", () => {
    const parsed = createAsemicWritingSchema.parse({});
    expect(parsed.rows).toBe(8);
    expect(parsed.glyphs).toBe(14);
    expect(parsed.strokes).toBe(5);
    expect(parsed.seed).toBe(1);
    expect(() => createAsemicWritingSchema.parse({ rows: 0 })).toThrow();
    expect(() => createAsemicWritingSchema.parse({ glyphs: 100 })).toThrow();
    expect(() => createAsemicWritingSchema.parse({ slant: 2 })).toThrow();
  });

  it("never throws and returns an isError result when node creation fails (bridge fatal)", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "TouchDesigner is offline" }, { status: 502 }),
      ),
    );
    const result = await createAsemicWritingImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBe(true);
  });
});
