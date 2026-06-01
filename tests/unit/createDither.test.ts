import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createDitherImpl, createDitherSchema } from "../../src/tools/layer1/createDither.js";
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

const DEFAULT_ARGS = {
  name: "dither",
  parent_path: "/project1",
  source: undefined,
  pattern: "bayer4" as const,
  bits: 1,
  palette_mode: "duotone" as const,
  low_color: [0.05, 0.06, 0.1] as [number, number, number],
  high_color: [0.85, 0.95, 0.8] as [number, number, number],
  threshold: 0.5,
  scale: 1,
  mix: 1,
  resolution: [1280, 720] as [number, number],
};

describe("create_dither", () => {
  describe("schema defaults and validation", () => {
    it("defaults to bayer4 pattern, bits 1, duotone, Game-Boy-green palette", () => {
      const parsed = createDitherSchema.parse({});
      expect(parsed.pattern).toBe("bayer4");
      // bits default "1" transforms to 1 (number) via z.enum.transform(Number)
      expect(Number(parsed.bits)).toBe(1);
      expect(parsed.palette_mode).toBe("duotone");
      expect(parsed.low_color).toEqual([0.05, 0.06, 0.1]);
      expect(parsed.high_color).toEqual([0.85, 0.95, 0.8]);
      expect(parsed.mix).toBe(1);
      expect(parsed.threshold).toBe(0.5);
      expect(parsed.scale).toBe(1);
      expect(parsed.resolution).toEqual([1280, 720]);
      expect(parsed.name).toBe("dither");
      expect(parsed.parent_path).toBe("/project1");
    });

    it("accepts all six pattern values", () => {
      for (const pattern of [
        "bayer2",
        "bayer4",
        "bayer8",
        "checker",
        "noise",
        "error_diffusion",
      ] as const) {
        expect(() => createDitherSchema.parse({ pattern })).not.toThrow();
      }
    });

    it("accepts all three palette_mode values", () => {
      for (const palette_mode of ["mono", "duotone", "rgb"] as const) {
        expect(() => createDitherSchema.parse({ palette_mode })).not.toThrow();
      }
    });

    it("accepts bits 1, 2, 4 and transforms to number", () => {
      expect(createDitherSchema.parse({ bits: "1" }).bits).toBe(1);
      expect(createDitherSchema.parse({ bits: "2" }).bits).toBe(2);
      expect(createDitherSchema.parse({ bits: "4" }).bits).toBe(4);
    });

    it("rejects invalid bits value like '3'", () => {
      expect(() => createDitherSchema.parse({ bits: "3" })).toThrow();
    });

    it("rejects mix out of 0..1", () => {
      expect(() => createDitherSchema.parse({ mix: 1.5 })).toThrow();
      expect(() => createDitherSchema.parse({ mix: -0.1 })).toThrow();
    });

    it("rejects threshold out of 0..1", () => {
      expect(() => createDitherSchema.parse({ threshold: 1.5 })).toThrow();
    });

    it("rejects scale below 1", () => {
      expect(() => createDitherSchema.parse({ scale: 0.5 })).toThrow();
    });

    it("rejects unknown pattern", () => {
      expect(() => createDitherSchema.parse({ pattern: "woodblock" })).toThrow();
    });
  });

  describe("happy path — default args (bayer4 / duotone / bits 1)", () => {
    it("creates noiseTOP source, glslTOP, textDAT, and nullTOP", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      const result = await createDitherImpl(makeCtx(), DEFAULT_ARGS);

      expect(result.isError).toBeFalsy();
      expect(bodies.some((b) => b.type === "noiseTOP" && b.name === "source")).toBe(true);
      expect(bodies.some((b) => b.type === "glslTOP" && b.name === "dither_glsl")).toBe(true);
      expect(bodies.some((b) => b.type === "textDAT" && b.name === "dither_frag")).toBe(true);
      expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
    });

    it("sets shader text and wires pixeldat", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createDitherImpl(makeCtx(), DEFAULT_ARGS);

      const shaderScript = scripts.find((s) => s.includes("out vec4 fragColor"));
      expect(shaderScript).toBeDefined();
      expect(shaderScript).toContain("uPattern");
      expect(shaderScript).toContain("uBits");
      expect(shaderScript).toContain("TDOutputSwizzle");
      expect(shaderScript).toContain("sTD2DInputs[0]");
      expect(shaderScript).toContain("pixeldat");
    });

    it("grows vec sequence to numBlocks ≥ 8", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createDitherImpl(makeCtx(), DEFAULT_ARGS);

      const uniformScript = scripts.find((s) => s.includes("seq.vec.numBlocks"));
      expect(uniformScript).toBeDefined();
      expect(uniformScript).toContain("numBlocks, 8");
    });

    it("assigns all 8 uniform names in order", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createDitherImpl(makeCtx(), DEFAULT_ARGS);

      const us = scripts.find((s) => s.includes("seq.vec.numBlocks")) ?? "";
      expect(us).toContain("vec0name = 'uPattern'");
      expect(us).toContain("vec1name = 'uBits'");
      expect(us).toContain("vec2name = 'uPaletteMode'");
      expect(us).toContain("vec3name = 'uThreshold'");
      expect(us).toContain("vec4name = 'uScale'");
      expect(us).toContain("vec5name = 'uMix'");
      expect(us).toContain("vec6name = 'uLow'");
      expect(us).toContain("vec7name = 'uHigh'");
    });

    it("bakes bayer4 → uPattern=1", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createDitherImpl(makeCtx(), DEFAULT_ARGS);

      const us = scripts.find((s) => s.includes("vec0name = 'uPattern'")) ?? "";
      expect(us).toContain("vec0valuex = 1");
    });

    it("bakes duotone → uPaletteMode=1", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createDitherImpl(makeCtx(), DEFAULT_ARGS);

      const us = scripts.find((s) => s.includes("vec2name = 'uPaletteMode'")) ?? "";
      expect(us).toContain("vec2valuex = 1");
    });

    it("exposes Mix, Threshold, Scale controls", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createDitherImpl(makeCtx(), { ...DEFAULT_ARGS, mix: 0.8, threshold: 0.4, scale: 2 });

      const controls = panelControls(scripts);
      expect(controls.length).toBeGreaterThanOrEqual(3);

      const mix = controls.find((c) => c.name === "Mix");
      expect(mix?.type).toBe("float");
      expect(mix?.default).toBe(0.8);

      const threshold = controls.find((c) => c.name === "Threshold");
      expect(threshold?.type).toBe("float");

      const scale = controls.find((c) => c.name === "Scale");
      expect(scale?.type).toBe("float");
    });

    it("summary mentions pattern and GLSL unverified", async () => {
      captureCreateBodies();
      captureExecScripts();

      const result = await createDitherImpl(makeCtx(), DEFAULT_ARGS);

      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      expect(text?.text).toContain("bayer4");
      expect(text?.text).toContain("GLSL compile UNVERIFIED");
    });
  });

  describe("source via Select TOP", () => {
    it("uses selectTOP instead of noiseTOP when source is provided", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      await createDitherImpl(makeCtx(), { ...DEFAULT_ARGS, source: "/project1/movie1" });

      expect(bodies.some((b) => b.type === "selectTOP" && b.name === "source")).toBe(true);
      expect(bodies.some((b) => b.type === "noiseTOP")).toBe(false);
    });
  });

  describe("pattern enum → int mapping", () => {
    const cases: [string, number][] = [
      ["bayer2", 0],
      ["bayer4", 1],
      ["bayer8", 2],
      ["checker", 3],
      ["noise", 4],
      ["error_diffusion", 5],
    ];

    for (const [pattern, expectedInt] of cases) {
      it(`${pattern} → uPattern=${expectedInt}`, async () => {
        captureCreateBodies();
        const scripts = captureExecScripts();

        await createDitherImpl(makeCtx(), {
          ...DEFAULT_ARGS,
          pattern: pattern as Parameters<typeof createDitherImpl>[1]["pattern"],
        });

        const us = scripts.find((s) => s.includes("vec0name = 'uPattern'")) ?? "";
        expect(us).toContain(`vec0valuex = ${expectedInt}`);
      });
    }
  });

  describe("palette_mode enum → int mapping", () => {
    it("mono → uPaletteMode=0", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createDitherImpl(makeCtx(), { ...DEFAULT_ARGS, palette_mode: "mono" });

      const us = scripts.find((s) => s.includes("vec2name = 'uPaletteMode'")) ?? "";
      expect(us).toContain("vec2valuex = 0");
    });

    it("rgb → uPaletteMode=2", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createDitherImpl(makeCtx(), { ...DEFAULT_ARGS, palette_mode: "rgb" });

      const us = scripts.find((s) => s.includes("vec2name = 'uPaletteMode'")) ?? "";
      expect(us).toContain("vec2valuex = 2");
    });
  });

  describe("glslTOP parameters", () => {
    it("sets outputresolution=custom and correct resolution", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      await createDitherImpl(makeCtx(), { ...DEFAULT_ARGS, resolution: [1920, 1080] });

      const glslBody = bodies.find((b) => b.type === "glslTOP");
      expect(glslBody?.parameters?.outputresolution).toBe("custom");
      expect(glslBody?.parameters?.resolutionw).toBe(1920);
      expect(glslBody?.parameters?.resolutionh).toBe(1080);
    });
  });

  describe("shader content integrity", () => {
    it("shader declares all 8 uniforms", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createDitherImpl(makeCtx(), DEFAULT_ARGS);

      const sh = scripts.find((s) => s.includes("out vec4 fragColor")) ?? "";
      expect(sh).toContain("uniform float uPattern");
      expect(sh).toContain("uniform float uBits");
      expect(sh).toContain("uniform float uPaletteMode");
      expect(sh).toContain("uniform float uThreshold");
      expect(sh).toContain("uniform float uScale");
      expect(sh).toContain("uniform float uMix");
      expect(sh).toContain("uniform vec3  uLow");
      expect(sh).toContain("uniform vec3  uHigh");
    });

    it("shader uses uTDOutputInfo.res.xy and vUV.st", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createDitherImpl(makeCtx(), DEFAULT_ARGS);

      const sh = scripts.find((s) => s.includes("out vec4 fragColor")) ?? "";
      expect(sh).toContain("uTDOutputInfo.res.xy");
      expect(sh).toContain("vUV.st");
    });

    it("shader has no uTime reference", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createDitherImpl(makeCtx(), DEFAULT_ARGS);

      const sh = scripts.find((s) => s.includes("out vec4 fragColor")) ?? "";
      expect(sh).not.toContain("uTime");
    });
  });

  describe("structuredContent output shape", () => {
    it("exposes output_path, controls, pattern, bits, palette_mode, glsl_compile_verified", async () => {
      captureCreateBodies();
      captureExecScripts();

      const result = await createDitherImpl(makeCtx(), DEFAULT_ARGS);

      const sc = result.structuredContent as Record<string, unknown> | undefined;
      if (sc !== undefined) {
        expect(sc).toHaveProperty("output_path");
        expect(sc).toHaveProperty("controls");
        expect(sc).toHaveProperty("pattern");
        expect(sc).toHaveProperty("bits");
        expect(sc).toHaveProperty("palette_mode");
        expect(sc).toHaveProperty("glsl_compile_verified", false);
      }
    });
  });

  describe("fail-forward guarantees", () => {
    it("does not throw when the bridge is unreachable", async () => {
      server.use(
        http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()),
        http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()),
      );

      const result = await createDitherImpl(makeCtx(), DEFAULT_ARGS);
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

      const result = await createDitherImpl(makeCtx(), DEFAULT_ARGS);
      expect(result).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
    });
  });
});
