import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createFlowAbstractionImpl,
  createFlowAbstractionSchema,
} from "../../src/tools/layer2/createFlowAbstraction.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function captureNodes(): Array<{ parent_path: string; type: string; name?: string }> {
  const created: Array<{ parent_path: string; type: string; name?: string }> = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as {
        parent_path: string;
        type: string;
        name?: string;
      };
      created.push(body);
      const name = body.name ?? `${body.type}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
  );
  return created;
}

function captureScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      scripts.push(((await request.json()) as { script: string }).script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

function captureParams(): Array<{ path: string; parameters: Record<string, unknown> }> {
  const calls: Array<{ path: string; parameters: Record<string, unknown> }> = [];
  server.use(
    http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ params, request }) => {
      const body = (await request.json()) as { parameters: Record<string, unknown> };
      const raw = params.seg;
      const path = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : String(raw));
      calls.push({ path, parameters: body.parameters });
      return HttpResponse.json({
        ok: true,
        data: { path, type: "glslTOP", name: path.split("/").pop(), parameters: body.parameters },
      });
    }),
  );
  return calls;
}

function captureConnects(): Array<{
  source_path: string;
  target_path: string;
  source_output: number;
  target_input: number;
}> {
  const conns: Array<{
    source_path: string;
    target_path: string;
    source_output: number;
    target_input: number;
  }> = [];
  // Override the default 404 — accept connect calls so we can assert wiring.
  server.use(
    http.post(`${TD_BASE}/api/connect`, async ({ request }) => {
      const body = (await request.json()) as {
        source_path: string;
        target_path: string;
        source_output: number;
        target_input: number;
      };
      conns.push(body);
      return HttpResponse.json({
        ok: true,
        data: {
          source_path: body.source_path,
          target_path: body.target_path,
          source_output: body.source_output,
          target_input: body.target_input,
        },
      });
    }),
  );
  return conns;
}

const baseArgs = {
  parent_path: "/project1",
  name: "fab",
  source: "/project1/movie1",
  strength: 0.8,
  edge: 1.0,
  iterations: 1,
  blur_radius: 3,
  sigma_e: 1.0,
  sigma_r: 1.6,
  tau: 0.99,
  resolution: "input" as const,
};

describe("create_flow_abstraction", () => {
  it("creates two glslTOPs with the expected names parented under parent_path", async () => {
    const nodes = captureNodes();
    captureScripts();
    captureConnects();
    const result = await createFlowAbstractionImpl(makeCtx(), baseArgs);
    expect(result.isError).not.toBe(true);
    const glsls = nodes.filter((n) => n.type === "glslTOP");
    expect(glsls).toHaveLength(2);
    expect(glsls.map((n) => n.name).sort()).toEqual(["fab_etf", "fab_fdog"]);
    expect(glsls.every((n) => n.parent_path === "/project1")).toBe(true);
  });

  it("creates two textDATs and assigns non-empty shader text via exec", async () => {
    captureNodes();
    const scripts = captureScripts();
    captureConnects();
    const result = await createFlowAbstractionImpl(makeCtx(), baseArgs);
    expect(result.isError).not.toBe(true);
    const joined = scripts.join("\n");
    expect(joined).toContain("fab_etf_frag");
    expect(joined).toContain("fab_fdog_frag");
    // Both shaders contain the required GLSL surface.
    const fragColorCount = (joined.match(/out vec4 fragColor/g) ?? []).length;
    expect(fragColorCount).toBeGreaterThanOrEqual(2);
    const swizzleCount = (joined.match(/TDOutputSwizzle/g) ?? []).length;
    expect(swizzleCount).toBeGreaterThanOrEqual(2);
    expect(joined).toContain("pixeldat");
  });

  it("wires Select → ETF[0]; ETF → FDoG[0]; Select → FDoG[1]; FDoG → Null", async () => {
    captureNodes();
    captureScripts();
    const conns = captureConnects();
    await createFlowAbstractionImpl(makeCtx(), baseArgs);
    const has = (s: string, t: string, ti: number) =>
      conns.some((c) => c.source_path === s && c.target_path === t && c.target_input === ti);
    expect(has("/project1/fab_in", "/project1/fab_etf", 0)).toBe(true);
    expect(has("/project1/fab_etf", "/project1/fab_fdog", 0)).toBe(true);
    expect(has("/project1/fab_in", "/project1/fab_fdog", 1)).toBe(true);
    expect(has("/project1/fab_fdog", "/project1/fab_out", 0)).toBe(true);
  });

  it("never creates a feedbackTOP or wires a second input into ETF (single-input pass)", async () => {
    // iterations=1 — no feedback.
    let nodes = captureNodes();
    captureScripts();
    let conns = captureConnects();
    await createFlowAbstractionImpl(makeCtx(), { ...baseArgs, iterations: 1 });
    expect(nodes.some((n) => n.type === "feedbackTOP")).toBe(false);
    expect(conns.some((c) => c.target_path === "/project1/fab_etf" && c.target_input === 1)).toBe(
      false,
    );

    // iterations=4 — still no feedback, still no ETF input-1 wire.
    server.resetHandlers();
    nodes = captureNodes();
    captureScripts();
    conns = captureConnects();
    await createFlowAbstractionImpl(makeCtx(), { ...baseArgs, iterations: 4 });
    expect(nodes.some((n) => n.type === "feedbackTOP")).toBe(false);
    expect(conns.some((c) => c.target_path === "/project1/fab_etf" && c.target_input === 1)).toBe(
      false,
    );
  });

  it("binds live uniforms (uStrength/uEdge/uIterations) with parent-par expressions", async () => {
    captureNodes();
    const scripts = captureScripts();
    captureConnects();
    await createFlowAbstractionImpl(makeCtx(), baseArgs);
    const joined = scripts.join("\n");
    expect(joined).toContain("uStrength");
    expect(joined).toContain("uEdge");
    expect(joined).toContain("uIterations");
    expect(joined).toContain("uRadius");
    expect(joined).toContain("uSigmaE");
    expect(joined).toContain("uSigmaR");
    expect(joined).toContain("uTau");
    expect(joined).toContain("parent().par.Strength");
    expect(joined).toContain("parent().par.Edge");
    expect(joined).toContain("parent().par.Iterations");
    expect(joined).toContain("EXPRESSION");
  });

  it("resolution='1080p' sets outputresolution custom 1920x1080 on both glslTOPs; 'input' leaves it alone", async () => {
    captureNodes();
    captureScripts();
    captureConnects();
    const patches = captureParams();
    await createFlowAbstractionImpl(makeCtx(), { ...baseArgs, resolution: "1080p" });
    const resPatches = patches.filter(
      (p) =>
        (p.path === "/project1/fab_etf" || p.path === "/project1/fab_fdog") &&
        p.parameters.resolutionw === 1920 &&
        p.parameters.resolutionh === 1080 &&
        p.parameters.outputresolution === "custom",
    );
    expect(resPatches).toHaveLength(2);

    // 'input' path — no resolution patch on the glslTOPs.
    server.resetHandlers();
    captureNodes();
    captureScripts();
    captureConnects();
    const patches2 = captureParams();
    await createFlowAbstractionImpl(makeCtx(), { ...baseArgs, resolution: "input" });
    expect(
      patches2.some(
        (p) =>
          (p.path === "/project1/fab_etf" || p.path === "/project1/fab_fdog") &&
          "resolutionw" in p.parameters,
      ),
    ).toBe(false);
  });

  it("returns payload with etf/fdog/out/frags and glsl_compile_verified=false", async () => {
    captureNodes();
    captureScripts();
    captureConnects();
    const result = await createFlowAbstractionImpl(makeCtx(), baseArgs);
    const text = textOf(result);
    const json = /```json\n([\s\S]+?)\n```/.exec(text)?.[1];
    expect(json).toBeDefined();
    const parsed = JSON.parse(json as string) as {
      etf: string;
      fdog: string;
      out: string;
      frags: string[];
      glsl_compile_verified: boolean;
      warnings: string[];
    };
    expect(parsed.etf).toBe("/project1/fab_etf");
    expect(parsed.fdog).toBe("/project1/fab_fdog");
    expect(parsed.out).toBe("/project1/fab_out");
    expect(parsed.frags).toEqual(["/project1/fab_etf_frag", "/project1/fab_fdog_frag"]);
    expect(parsed.glsl_compile_verified).toBe(false);
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });

  it("schema rejects iterations=0 and blur_radius=0", () => {
    expect(() =>
      createFlowAbstractionSchema.parse({
        parent_path: "/project1",
        source: "/project1/movie1",
        iterations: 0,
      }),
    ).toThrow();
    expect(() =>
      createFlowAbstractionSchema.parse({
        parent_path: "/project1",
        source: "/project1/movie1",
        blur_radius: 0,
      }),
    ).toThrow();
  });
});
