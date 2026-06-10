import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createAsciiRenderImpl,
  createAsciiRenderSchema,
} from "../../src/tools/layer1/createAsciiRender.js";
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
  name: "ascii",
  parent_path: "/project1",
  source: undefined as string | undefined,
  charset: "  .:-=+*#%@",
  cell_size: 16,
  color_mode: "source-color" as const,
  fg_color: [0.85, 0.95, 0.8] as [number, number, number],
  bg_color: [0.02, 0.03, 0.04] as [number, number, number],
  font: "Courier New",
  mix: 1,
  resolution: [1280, 720] as [number, number],
};

describe("create_ascii_render", () => {
  describe("schema defaults and validation", () => {
    it("defaults match spec", () => {
      const parsed = createAsciiRenderSchema.parse({});
      expect(parsed.name).toBe("ascii");
      expect(parsed.parent_path).toBe("/project1");
      expect(parsed.charset).toBe("  .:-=+*#%@");
      expect(parsed.cell_size).toBe(16);
      expect(parsed.color_mode).toBe("source-color");
      expect(parsed.fg_color).toEqual([0.85, 0.95, 0.8]);
      expect(parsed.bg_color).toEqual([0.02, 0.03, 0.04]);
      expect(parsed.font).toBe("Courier New");
      expect(parsed.mix).toBe(1);
      expect(parsed.resolution).toEqual([1280, 720]);
    });

    it("accepts all three color_mode values", () => {
      for (const color_mode of ["mono", "source-color", "two-color"] as const) {
        expect(() => createAsciiRenderSchema.parse({ color_mode })).not.toThrow();
      }
    });

    it("rejects cell_size below 4 or above 64", () => {
      expect(() => createAsciiRenderSchema.parse({ cell_size: 3 })).toThrow();
      expect(() => createAsciiRenderSchema.parse({ cell_size: 65 })).toThrow();
    });

    it("rejects mix out of 0..1", () => {
      expect(() => createAsciiRenderSchema.parse({ mix: 1.1 })).toThrow();
      expect(() => createAsciiRenderSchema.parse({ mix: -0.1 })).toThrow();
    });
  });

  describe("happy path — defaults (source-color)", () => {
    it("creates noiseTOP source, resolutionTOP cells, textTOP atlas, glslTOP, textDAT, nullTOP", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      const result = await createAsciiRenderImpl(makeCtx(), DEFAULT_ARGS);

      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "noiseTOP" && b.name === "source")).toBe(true);
      expect(bodies.some((b) => b.type === "resolutionTOP" && b.name === "cells")).toBe(true);
      expect(bodies.some((b) => b.type === "textTOP" && b.name === "atlas")).toBe(true);
      expect(bodies.some((b) => b.type === "glslTOP" && b.name === "ascii_glsl")).toBe(true);
      expect(bodies.some((b) => b.type === "textDAT" && b.name === "ascii_frag")).toBe(true);
      expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
    });

    it("summary contains ascii_render and source-color", async () => {
      captureCreateBodies();
      captureExecScripts();

      const result = await createAsciiRenderImpl(makeCtx(), DEFAULT_ARGS);

      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      expect(text?.text).toContain("ascii_render");
      expect(text?.text).toContain("source-color");
    });

    it("output_top_path ends with /out1", async () => {
      captureCreateBodies();
      captureExecScripts();

      const result = await createAsciiRenderImpl(makeCtx(), DEFAULT_ARGS);

      const sc = result.structuredContent as Record<string, unknown> | undefined;
      if (sc !== undefined) {
        expect(String(sc.output_top_path ?? "")).toMatch(/\/out1$/);
        expect(String(sc.atlas_top_path ?? "")).toMatch(/\/atlas$/);
        expect(sc.glsl_compile_verified).toBe(false);
        expect(sc.charset_len).toBe(DEFAULT_ARGS.charset.length);
      }
    });

    it("shader uses sTD2DInputs[0] and sTD2DInputs[1]", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createAsciiRenderImpl(makeCtx(), DEFAULT_ARGS);

      const shaderScript = scripts.find((s) => s.includes("out vec4 fragColor"));
      expect(shaderScript).toBeDefined();
      expect(shaderScript).toContain("sTD2DInputs[0]");
      expect(shaderScript).toContain("sTD2DInputs[1]");
      expect(shaderScript).toContain("TDOutputSwizzle");
      expect(shaderScript).toContain("uCharsetLen");
      expect(shaderScript).toContain("pixeldat");
    });

    it("grows vec sequence to numBlocks >= 6", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createAsciiRenderImpl(makeCtx(), DEFAULT_ARGS);

      const uniformScript = scripts.find((s) => s.includes("seq.vec.numBlocks"));
      expect(uniformScript).toBeDefined();
      expect(uniformScript).toContain("numBlocks, 6");
    });

    it("assigns all 6 uniform names in order", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createAsciiRenderImpl(makeCtx(), DEFAULT_ARGS);

      const us = scripts.find((s) => s.includes("seq.vec.numBlocks")) ?? "";
      expect(us).toContain("vec0name = 'uColorMode'");
      expect(us).toContain("vec1name = 'uCharsetLen'");
      expect(us).toContain("vec2name = 'uMix'");
      expect(us).toContain("vec3name = 'uFg'");
      expect(us).toContain("vec4name = 'uBg'");
      expect(us).toContain("vec5name = 'uCellSize'");
    });

    it("source-color → uColorMode=1", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createAsciiRenderImpl(makeCtx(), DEFAULT_ARGS);

      const us = scripts.find((s) => s.includes("vec0name = 'uColorMode'")) ?? "";
      expect(us).toContain("vec0valuex = 1");
    });

    it("glslTOP outputresolution=custom with correct resolution", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      await createAsciiRenderImpl(makeCtx(), { ...DEFAULT_ARGS, resolution: [1920, 1080] });

      const glslBody = bodies.find((b) => b.type === "glslTOP");
      expect(glslBody?.parameters?.outputresolution).toBe("custom");
      expect(glslBody?.parameters?.resolutionw).toBe(1920);
      expect(glslBody?.parameters?.resolutionh).toBe(1080);
    });
  });

  describe("external source", () => {
    it("uses selectTOP instead of noiseTOP when source is provided", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      await createAsciiRenderImpl(makeCtx(), {
        ...DEFAULT_ARGS,
        source: "/project1/movie1",
      });

      expect(bodies.some((b) => b.type === "selectTOP" && b.name === "source")).toBe(true);
      expect(bodies.some((b) => b.type === "noiseTOP")).toBe(false);
    });

    it("selectTOP top param set to source path", async () => {
      captureCreateBodies();
      const patches: Array<{ path: string; parameters: Record<string, unknown> }> = [];
      server.use(
        http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ params, request }) => {
          const body = (await request.json()) as { parameters: Record<string, unknown> };
          const raw = params.seg;
          const path = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : String(raw ?? ""));
          patches.push({ path, parameters: body.parameters });
          return HttpResponse.json({
            ok: true,
            data: { path, type: "selectTOP", name: "source", parameters: body.parameters },
          });
        }),
      );

      await createAsciiRenderImpl(makeCtx(), {
        ...DEFAULT_ARGS,
        source: "/project1/movie1",
      });

      expect(
        patches.some(
          (p) => p.path === "/project1/ascii/source" && p.parameters.top === "/project1/movie1",
        ),
      ).toBe(true);
    });
  });

  describe("custom charset", () => {
    it("atlas text set to custom charset and charsetLen = 6", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createAsciiRenderImpl(makeCtx(), { ...DEFAULT_ARGS, charset: " .oO0@" });

      const atlasScript = scripts.find((s) => s.includes("_a.par.text"));
      expect(atlasScript).toBeDefined();
      expect(atlasScript).toContain(" .oO0@");

      const uniformScript = scripts.find((s) => s.includes("vec1name = 'uCharsetLen'")) ?? "";
      expect(uniformScript).toContain("vec1valuex = 6");
    });

    it("atlas resolutionw = cell_size * charset_length", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      await createAsciiRenderImpl(makeCtx(), {
        ...DEFAULT_ARGS,
        charset: " .oO0@",
        cell_size: 16,
      });

      const atlasBody = bodies.find((b) => b.type === "textTOP" && b.name === "atlas");
      expect(atlasBody?.parameters?.resolutionw).toBe(16 * 6);
    });
  });

  describe("mono color mode + custom fg/bg", () => {
    it("vec0 = 0 (mono), vec3 = fg, vec4 = bg", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createAsciiRenderImpl(makeCtx(), {
        ...DEFAULT_ARGS,
        color_mode: "mono",
        fg_color: [1, 0, 0],
        bg_color: [0, 0, 0],
      });

      const us = scripts.find((s) => s.includes("vec0name = 'uColorMode'")) ?? "";
      expect(us).toContain("vec0valuex = 0");
      expect(us).toContain("vec3valuex = 1");
      expect(us).toContain("vec3valuey = 0");
      expect(us).toContain("vec3valuez = 0");
      expect(us).toContain("vec4valuex = 0");
      expect(us).toContain("vec4valuey = 0");
      expect(us).toContain("vec4valuez = 0");
    });

    it("two-color → vec0valuex = 2", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createAsciiRenderImpl(makeCtx(), { ...DEFAULT_ARGS, color_mode: "two-color" });

      const us = scripts.find((s) => s.includes("vec0name = 'uColorMode'")) ?? "";
      expect(us).toContain("vec0valuex = 2");
    });
  });

  describe("invalid charset — friendly error", () => {
    it("returns isError:true for charset length 1", async () => {
      captureCreateBodies();
      captureExecScripts();

      const result = await createAsciiRenderImpl(makeCtx(), { ...DEFAULT_ARGS, charset: "x" });

      expect(result.isError).toBe(true);
      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      expect(text?.text).toContain("charset must be 2–32 characters");
    });

    it("returns isError:true for charset length 33", async () => {
      captureCreateBodies();
      captureExecScripts();

      const longCharset = "abcdefghijklmnopqrstuvwxyz1234567"; // 33 chars
      const result = await createAsciiRenderImpl(makeCtx(), {
        ...DEFAULT_ARGS,
        charset: longCharset,
      });

      expect(result.isError).toBe(true);
      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      expect(text?.text).toContain("charset must be 2–32 characters");
    });
  });

  describe("fail-forward guarantees", () => {
    it("does not throw when the bridge is unreachable", async () => {
      server.use(
        http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()),
        http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()),
      );

      const result = await createAsciiRenderImpl(makeCtx(), DEFAULT_ARGS);
      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
    });

    it("always returns a result object with content array", async () => {
      captureCreateBodies();
      server.use(
        http.post(`${TD_BASE}/api/exec`, async () => {
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify({ fatal: "compile error" }) },
          });
        }),
      );

      const result = await createAsciiRenderImpl(makeCtx(), DEFAULT_ARGS);
      expect(result).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
    });
  });
});
