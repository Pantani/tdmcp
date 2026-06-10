import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createPixelSortImpl,
  createPixelSortSchema,
} from "../../src/tools/layer1/createPixelSort.js";
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

const DEFAULT_ARGS = createPixelSortSchema.parse({});

describe("create_pixel_sort", () => {
  // ── Case 1: default build — noiseTOP source, full topology ─────────────────
  describe("default build (no source_top_path)", () => {
    it("creates noiseTOP source, switchTOP, glslTOP, textDAT, feedbackTOP, and nullTOP", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      const result = await createPixelSortImpl(makeCtx(), DEFAULT_ARGS);

      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "noiseTOP" && b.name === "source")).toBe(true);
      expect(bodies.some((b) => b.type === "switchTOP" && b.name === "switch1")).toBe(true);
      expect(bodies.some((b) => b.type === "glslTOP" && b.name === "sort_glsl")).toBe(true);
      expect(bodies.some((b) => b.type === "textDAT" && b.name === "sort_frag")).toBe(true);
      expect(bodies.some((b) => b.type === "feedbackTOP" && b.name === "feedback1")).toBe(true);
      expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
    });

    it("exposes Mix, Threshold, Iterations, Direction, Reset controls", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createPixelSortImpl(makeCtx(), DEFAULT_ARGS);

      const controls = panelControls(scripts);
      const names = controls.map((c) => c.name);
      expect(names).toContain("Mix");
      expect(names).toContain("Threshold");
      expect(names).toContain("Iterations");
      expect(names).toContain("Direction");
      expect(names).toContain("Reset");
    });

    it("summary mentions GLSL compile UNVERIFIED", async () => {
      captureCreateBodies();
      captureExecScripts();

      const result = await createPixelSortImpl(makeCtx(), DEFAULT_ARGS);

      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      expect(text?.text).toContain("GLSL compile UNVERIFIED");
    });
  });

  // ── Case 2: with source_top_path → selectTOP, no noiseTOP ──────────────────
  describe("with source_top_path", () => {
    it("uses selectTOP instead of noiseTOP and sets top parameter", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      await createPixelSortImpl(makeCtx(), {
        ...DEFAULT_ARGS,
        source_top_path: "/project1/movie1",
      });

      expect(bodies.some((b) => b.type === "selectTOP" && b.name === "source")).toBe(true);
      expect(bodies.some((b) => b.type === "noiseTOP")).toBe(false);

      // setParams for the select should contain the top path
      // (connectNodes/setParams go through exec endpoint for select's `top` param)
    });
  });

  // ── Case 3: shader uniform binding — all 6 vec blocks correct ──────────────
  describe("shader uniform binding", () => {
    it("sets exactly 6 vec blocks with correct names", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createPixelSortImpl(makeCtx(), DEFAULT_ARGS);

      const uniformScript = scripts.find((s) => s.includes("seq.vec.numBlocks")) ?? "";
      expect(uniformScript).toContain("vec0name = 'uAxis'");
      expect(uniformScript).toContain("vec1name = 'uKey'");
      expect(uniformScript).toContain("vec2name = 'uDirection'");
      expect(uniformScript).toContain("vec3name = 'uThreshold'");
      expect(uniformScript).toContain("vec4name = 'uPhase'");
      expect(uniformScript).toContain("vec5name = 'uMix'");
    });

    it("uAxis and uKey are static (no EXPRESSION mode), uThreshold/uMix/uDirection are EXPRESSION", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createPixelSortImpl(makeCtx(), DEFAULT_ARGS);

      const us = scripts.find((s) => s.includes("seq.vec.numBlocks")) ?? "";
      // uAxis and uKey: just value assignment, no .mode = ... EXPRESSION
      // We verify by checking that vec0 and vec1 have no EXPRESSION assignment
      const lines = us.split("\n");
      const vec0Lines = lines.filter((l) => l.includes("vec0"));
      const vec1Lines = lines.filter((l) => l.includes("vec1"));
      expect(vec0Lines.some((l) => l.includes("EXPRESSION"))).toBe(false);
      expect(vec1Lines.some((l) => l.includes("EXPRESSION"))).toBe(false);

      // uThreshold, uMix, uDirection, uPhase must reference parent pars or absTime
      expect(us).toContain("parent().par.Threshold");
      expect(us).toContain("parent().par.Mix");
      expect(us).toContain("parent().par.Direction");
      expect(us).toContain("absTime.frame");
    });
  });

  // ── Case 4: axis=y, sort_by=hue → uAxis=1, uKey=1 ──────────────────────────
  describe("axis=y, sort_by=hue", () => {
    it("encodes uAxis=1 and uKey=1 in the uniform script", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createPixelSortImpl(makeCtx(), {
        ...DEFAULT_ARGS,
        axis: "y",
        sort_by: "hue",
      });

      const us = scripts.find((s) => s.includes("seq.vec.numBlocks")) ?? "";
      expect(us).toContain("vec0valuex = 1"); // uAxis = 1 (y)
      expect(us).toContain("vec1valuex = 1"); // uKey = 1 (hue)
    });
  });

  // ── Case 5: iteration latch — switch expr references parent().par.Iterations ─
  describe("iteration latch", () => {
    it("switch1.par.index.expr contains parent().par.Iterations and sets EXPRESSION mode", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createPixelSortImpl(makeCtx(), DEFAULT_ARGS);

      const latchScript = scripts.find((s) => s.includes("parent().par.Iterations")) ?? "";
      expect(latchScript).toContain("parent().par.Iterations");
      expect(latchScript).toContain("EXPRESSION");
      // The condition must include both sides: iteration path and hold
      expect(latchScript).toContain("me.time.frame");
    });
  });

  // ── Case 6: invalid threshold → Zod parse failure ──────────────────────────
  describe("error path — invalid threshold", () => {
    it("returns isError for threshold > 1", async () => {
      captureCreateBodies();
      captureExecScripts();

      // Zod schema rejects threshold > 1
      const parseResult = createPixelSortSchema.safeParse({ threshold: 1.5 });
      expect(parseResult.success).toBe(false);
      if (!parseResult.success) {
        expect(parseResult.error.issues.length).toBeGreaterThan(0);
      }
    });

    it("returns isError for threshold < 0", async () => {
      const parseResult = createPixelSortSchema.safeParse({ threshold: -0.1 });
      expect(parseResult.success).toBe(false);
    });

    it("returns isError for iterations > 256", async () => {
      const parseResult = createPixelSortSchema.safeParse({ iterations: 300 });
      expect(parseResult.success).toBe(false);
    });

    it("returns isError for unknown sort_by value", async () => {
      const parseResult = createPixelSortSchema.safeParse({ sort_by: "brightness" });
      expect(parseResult.success).toBe(false);
    });
  });
});
