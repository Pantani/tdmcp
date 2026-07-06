import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createStepRepeatImpl,
  createStepRepeatSchema,
} from "../../src/tools/layer1/createStepRepeat.js";
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
  rows: 4,
  cols: 4,
  gap: 0.05,
  jitter_pos: 0,
  jitter_rot: 0,
  brick_offset: false,
  resolution: [1280, 720] as [number, number],
  parent_path: "/project1",
};

describe("create_step_repeat", () => {
  it("builds a select/moviefilein source → glslTOP tiler → nullTOP chain and summarizes rows×cols", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createStepRepeatImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBeFalsy();

    // No source_path -> falls back to the bundled Mosaic.mp4 test clip.
    const movie = bodies.find((b) => b.type === "moviefileinTOP");
    expect(movie).toBeDefined();
    expect(movie?.parameters?.file).toBe("Mosaic.mp4");
    expect(bodies.some((b) => b.type === "selectTOP")).toBe(false);

    const glsl = bodies.find((b) => b.type === "glslTOP");
    expect(glsl).toBeDefined();

    const out = bodies.find((b) => b.type === "nullTOP" && b.name === "out1");
    expect(out).toBeDefined();

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("4×4");
  });

  it("pulls the source in via selectTOP when source_path is given", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createStepRepeatImpl(makeCtx(), {
      ...DEFAULT_ARGS,
      source_path: "/project1/cam1",
    });
    expect(result.isError).toBeFalsy();

    const select = bodies.find((b) => b.type === "selectTOP");
    expect(select?.parameters?.top).toBe("/project1/cam1");
    expect(bodies.some((b) => b.type === "moviefileinTOP")).toBe(false);
  });

  it("writes the fragment shader and grid/gap/jitter/brick uniforms into the exec scripts", async () => {
    captureCreateBodies();
    const scripts = captureExecScripts();
    await createStepRepeatImpl(makeCtx(), {
      ...DEFAULT_ARGS,
      rows: 6,
      cols: 3,
      gap: 0.1,
      jitter_pos: 0.2,
      jitter_rot: 1.5,
      brick_offset: true,
    });

    const fragScript = scripts.find((s) => s.includes("uJitterRot"));
    expect(fragScript).toBeDefined();
    expect(fragScript).toContain("uGrid");
    expect(fragScript).toContain("uGap");
    expect(fragScript).toContain("uBrickOffset");
    expect(fragScript).toContain("sTD2DInputs[0]");

    const uniformScript = scripts.find((s) => s.includes("_seq.numBlocks"));
    expect(uniformScript).toBeDefined();
    expect(uniformScript).toContain('"name":"uGrid"');
    expect(uniformScript).toContain("[3,6]"); // [cols, rows]
    expect(uniformScript).toContain('"name":"uGap"');
    expect(uniformScript).toContain("[0.1]");
    expect(uniformScript).toContain('"name":"uJitterPos"');
    expect(uniformScript).toContain("[0.2]");
    expect(uniformScript).toContain('"name":"uJitterRot"');
    expect(uniformScript).toContain("[1.5]");
    expect(uniformScript).toContain('"name":"uBrickOffset"');
    expect(uniformScript).toContain("[1]"); // brick_offset true -> 1
  });

  it("gives rows=4, cols=4, gap=0.05 as schema defaults", () => {
    const parsed = createStepRepeatSchema.parse({});
    expect(parsed.rows).toBe(4);
    expect(parsed.cols).toBe(4);
    expect(parsed.gap).toBe(0.05);
    expect(parsed.jitter_pos).toBe(0);
    expect(parsed.jitter_rot).toBe(0);
    expect(parsed.brick_offset).toBe(false);
    expect(parsed.resolution).toEqual([1280, 720]);
    expect(parsed.parent_path).toBe("/project1");
  });

  it("rejects out-of-range rows/cols/gap at the schema boundary", () => {
    expect(() => createStepRepeatSchema.parse({ rows: 0 })).toThrow();
    expect(() => createStepRepeatSchema.parse({ rows: 65 })).toThrow();
    expect(() => createStepRepeatSchema.parse({ gap: 1 })).toThrow();
    expect(() => createStepRepeatSchema.parse({ jitter_rot: 4 })).toThrow();
  });

  it("never throws and returns an isError result when node creation fails (bridge fatal)", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "TouchDesigner is offline" }, { status: 502 }),
      ),
    );
    const result = await createStepRepeatImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBe(true);
  });
});
