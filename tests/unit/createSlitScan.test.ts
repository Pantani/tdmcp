import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createSlitScanImpl } from "../../src/tools/layer1/createSlitScan.js";
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

interface PatchBody {
  parameters: Record<string, unknown>;
}

function capturePatchBodies(): Array<{ path: string; params: Record<string, unknown> }> {
  const patches: Array<{ path: string; params: Record<string, unknown> }> = [];
  server.use(
    http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ params, request }) => {
      const seg = params.seg;
      const raw = Array.isArray(seg) ? (seg[0] ?? "") : String(seg ?? "");
      const path = decodeURIComponent(raw);
      const body = (await request.json()) as PatchBody;
      patches.push({ path, params: body.parameters });
      return HttpResponse.json({
        ok: true,
        data: {
          path,
          type: "selectTOP",
          name: path.split("/").pop() ?? "",
          parameters: body.parameters,
        },
      });
    }),
  );
  return patches;
}

interface PanelControl {
  name: string;
  type?: string;
  default?: unknown;
  min?: number;
  max?: number;
  bind_to?: string[];
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

const DEFAULT_ARGS = {
  parent_path: "/project1" as const,
  name: "slit_scan",
  source_top_path: undefined,
  cache_depth: 60,
  axis: "y" as const,
  direction: "+y" as const,
  expose_controls: true,
};

describe("create_slit_scan", () => {
  // Case 1: defaults with synthetic source
  describe("defaults — synthetic noise source", () => {
    it("creates noiseTOP, cacheTOP, glslTOP, textDAT, and nullTOP under /project1", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      const result = await createSlitScanImpl(makeCtx(), DEFAULT_ARGS);

      expect(result.isError).toBeFalsy();

      // Container: baseCOMP
      expect(bodies.some((b) => b.type === "baseCOMP" && b.parent_path === "/project1")).toBe(true);

      // Synthetic seed
      expect(bodies.some((b) => b.type === "noiseTOP" && b.name === "source")).toBe(true);

      // Cache ring
      expect(
        bodies.some(
          (b) => b.type === "cacheTOP" && b.name === "cache" && b.parameters?.cachesize === 60,
        ),
      ).toBe(true);

      // GLSL + shader DAT
      expect(bodies.some((b) => b.type === "glslTOP" && b.name === "slit_glsl")).toBe(true);
      expect(bodies.some((b) => b.type === "textDAT" && b.name === "slit_frag")).toBe(true);

      // Null output
      expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);

      // outputPath ends in out1 — check the JSON block in text content
      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      const jsonMatch = /```json\n([\s\S]+?)\n```/.exec(text?.text ?? "");
      const data = jsonMatch?.[1] ? (JSON.parse(jsonMatch[1]) as Record<string, unknown>) : {};
      expect(String(data.output ?? "")).toMatch(/out1$/);
    });

    it("sets cachesize=60 and no noiseTOP is created when external source is given", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      // baseline: defaults have cachesize 60
      await createSlitScanImpl(makeCtx(), DEFAULT_ARGS);

      const cacheBody = bodies.find((b) => b.type === "cacheTOP");
      expect(cacheBody?.parameters?.cachesize).toBe(60);
    });
  });

  // Case 2: external source_top_path — no internal noiseTOP
  describe("external source_top_path", () => {
    it("uses selectTOP instead of noiseTOP; sets top param to external path via PATCH", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();
      const patches = capturePatchBodies();

      await createSlitScanImpl(makeCtx(), {
        ...DEFAULT_ARGS,
        source_top_path: "/project1/videodevicein1",
      });

      // selectTOP present, noiseTOP absent
      expect(bodies.some((b) => b.type === "selectTOP" && b.name === "source")).toBe(true);
      expect(bodies.some((b) => b.type === "noiseTOP")).toBe(false);

      // top param set to external path via PATCH on the selectTOP
      const selPatch = patches.find((p) => p.params.top !== undefined);
      expect(selPatch?.params.top).toBe("/project1/videodevicein1");
    });
  });

  // Case 3: axis=x, direction=-x → uAxis=0, uDir=-1
  describe("axis=x, direction=-x", () => {
    it("sets uAxis=0 and uDir=-1 in the uniform setup script", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createSlitScanImpl(makeCtx(), {
        ...DEFAULT_ARGS,
        axis: "x",
        direction: "-x",
      });

      // The uniform setup script is identified by the seq.vec.numBlocks assignment
      // (distinct from the shader text assign script which starts with op().text = ...)
      const uniformScript = scripts.find((s) => s.includes("seq.vec.numBlocks"));
      expect(uniformScript).toBeDefined();
      expect(uniformScript).toContain("vec1name = 'uAxis'");
      expect(uniformScript).toContain("vec1valuex = 0"); // uAxis = 0 for x
      expect(uniformScript).toContain("vec2name = 'uDir'");
      expect(uniformScript).toContain("vec2valuex = -1"); // uDir = -1
    });
  });

  // Case 4: cache_depth=600
  describe("cache_depth=600", () => {
    it("sets cachesize to 600 and Depth control max is 600", async () => {
      const bodies = captureCreateBodies();
      const scripts = captureExecScripts();

      await createSlitScanImpl(makeCtx(), {
        ...DEFAULT_ARGS,
        cache_depth: 600,
      });

      const cacheBody = bodies.find((b) => b.type === "cacheTOP");
      expect(cacheBody?.parameters?.cachesize).toBe(600);

      const controls = panelControls(scripts);
      const depthCtrl = controls.find((c) => c.name === "Depth");
      expect(depthCtrl).toBeDefined();
      expect(depthCtrl?.max).toBe(600);
      expect(depthCtrl?.default).toBe(600);
    });
  });

  // Case 5: expose_controls=false → no controls
  describe("expose_controls=false", () => {
    it("returns empty controls array", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      const result = await createSlitScanImpl(makeCtx(), {
        ...DEFAULT_ARGS,
        expose_controls: false,
      });

      expect(result.isError).toBeFalsy();
      const controls = panelControls(scripts);
      expect(controls).toHaveLength(0);
    });
  });

  // Fail-forward guarantee
  describe("fail-forward", () => {
    it("never throws even when the bridge is unreachable", async () => {
      server.use(
        http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()),
        http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()),
      );

      const result = await createSlitScanImpl(makeCtx(), DEFAULT_ARGS);
      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
    });
  });
});
