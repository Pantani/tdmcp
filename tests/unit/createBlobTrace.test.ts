import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createBlobTraceImpl,
  createBlobTraceSchema,
} from "../../src/tools/layer1/createBlobTrace.js";
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
  source: "synthetic" as const,
  threshold: 0.45,
  invert: false,
  pre_blur: 4,
  edge_only: false,
  line_width: 2,
  line_color: [0.1, 1.0, 0.6] as [number, number, number],
  background: [0.02, 0.02, 0.03] as [number, number, number],
  resolution: [1280, 720] as [number, number],
  expose_controls: true,
  parent_path: "/project1",
};

describe("create_blob_trace", () => {
  it("builds mono → blur → threshold mask → traceSOP → wireframe render for the synthetic source", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    const result = await createBlobTraceImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBeFalsy();

    // synthetic -> a scrolling noise, no camera device
    expect(bodies.some((b) => b.type === "noiseTOP" && b.name === "videoin")).toBe(true);
    expect(bodies.some((b) => b.type === "videodeviceinTOP")).toBe(false);

    expect(bodies.some((b) => b.type === "monochromeTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "blurTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "thresholdTOP")).toBe(true);
    expect(bodies.some((b) => b.type === "traceSOP")).toBe(true);
    expect(bodies.some((b) => b.type === "wireframeMAT")).toBe(true);
    expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
  });

  it("adds an Edge TOP before tracing when edge_only=true", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();
    await createBlobTraceImpl(makeCtx(), { ...DEFAULT_ARGS, edge_only: true });
    expect(bodies.some((b) => b.type === "edgeTOP")).toBe(true);
  });

  it("pulls in an existing TOP when source=existing_top and skips creating a source node", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await createBlobTraceImpl(makeCtx(), {
      ...DEFAULT_ARGS,
      source: "existing_top",
      existing_top_path: "/project1/depth1",
    });
    expect(bodies.some((b) => b.type === "noiseTOP")).toBe(false);
    // fit TOP is fed from the existing path via connect (bridge) — trace setup names the mask out
    const traceScript = scripts.find((s) => s.includes("_trace = op("));
    expect(traceScript).toBeDefined();
  });

  it("exposes defaults and validates ranges at the schema boundary", () => {
    const parsed = createBlobTraceSchema.parse({});
    expect(parsed.source).toBe("synthetic");
    expect(parsed.threshold).toBe(0.45);
    expect(parsed.pre_blur).toBe(4);
    expect(parsed.edge_only).toBe(false);
    expect(() => createBlobTraceSchema.parse({ threshold: 2 })).toThrow();
    expect(() => createBlobTraceSchema.parse({ pre_blur: 100 })).toThrow();
    expect(() => createBlobTraceSchema.parse({ line_width: 0 })).toThrow();
  });

  it("never throws and returns an isError result when node creation fails (bridge fatal)", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: "TouchDesigner is offline" }, { status: 502 }),
      ),
    );
    const result = await createBlobTraceImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBe(true);
  });
});
