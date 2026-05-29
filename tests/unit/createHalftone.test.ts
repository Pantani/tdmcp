import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createHalftoneImpl, createHalftoneSchema } from "../../src/tools/layer1/createHalftone.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

interface PanelControl {
  name: string;
  type?: string;
  default?: unknown;
  min?: number;
  max?: number;
  bind_to?: string[];
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

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

describe("create_halftone", () => {
  describe("schema defaults and validation", () => {
    it("defaults to dots style, 6px dot_size, 15° angle, mix 1.0, 1280×720", () => {
      const parsed = createHalftoneSchema.parse({});
      expect(parsed.style).toBe("dots");
      expect(parsed.dot_size).toBe(6);
      expect(parsed.angle).toBe(15);
      expect(parsed.mix).toBe(1);
      expect(parsed.resolution).toEqual([1280, 720]);
      expect(parsed.name).toBe("halftone");
      expect(parsed.parent_path).toBe("/project1");
    });

    it("rejects mix out of 0..1", () => {
      expect(() => createHalftoneSchema.parse({ mix: 1.5 })).toThrow();
      expect(() => createHalftoneSchema.parse({ mix: -0.1 })).toThrow();
    });

    it("rejects dot_size below 1", () => {
      expect(() => createHalftoneSchema.parse({ dot_size: 0 })).toThrow();
    });

    it("rejects an unknown style", () => {
      expect(() => createHalftoneSchema.parse({ style: "woodblock" })).toThrow();
    });

    it("accepts all four valid styles", () => {
      for (const style of ["dots", "cmyk", "dither", "posterize"] as const) {
        expect(() => createHalftoneSchema.parse({ style })).not.toThrow();
      }
    });
  });

  describe("happy path — dots style (default)", () => {
    it("creates a glslTOP, textDAT, source noiseTOP, and nullTOP", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      const result = await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "dots",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });

      expect(result.isError).toBeFalsy();

      // Must create a glslTOP
      expect(bodies.some((b) => b.type === "glslTOP" && b.name === "halftone_glsl")).toBe(true);
      // Must create the companion Text DAT for the shader
      expect(bodies.some((b) => b.type === "textDAT" && b.name === "halftone_frag")).toBe(true);
      // Must create a Null output
      expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);
      // Without a source path, should create a noise source
      expect(bodies.some((b) => b.type === "noiseTOP" && b.name === "source")).toBe(true);
    });

    it("sets the shader text and wires pixeldat to the text DAT", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "dots",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });

      // Find the script that sets the shader text
      const shaderScript = scripts.find((s) => s.includes("out vec4 fragColor"));
      expect(shaderScript).toBeDefined();
      // The shader must contain the core halftone logic identifiers
      expect(shaderScript).toContain("sTD2DInputs[0]");
      expect(shaderScript).toContain("TDOutputSwizzle");
      expect(shaderScript).toContain("uStyle");
      expect(shaderScript).toContain("uDotSize");
      expect(shaderScript).toContain("uAngle");
      expect(shaderScript).toContain("uMix");
      // pixeldat must be wired
      expect(shaderScript).toContain("pixeldat");
    });

    it("binds the four uniforms via the vec sequence", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "dots",
        dot_size: 8,
        angle: 30,
        mix: 0.75,
        resolution: [1280, 720],
      });

      const uniformScript = scripts.find((s) => s.includes("seq.vec.numBlocks"));
      expect(uniformScript).toBeDefined();
      // 4 blocks allocated
      expect(uniformScript).toContain("numBlocks, 4");
      // uStyle block name
      expect(uniformScript).toContain("vec0name = 'uStyle'");
      // uStyle for dots style must be 0
      expect(uniformScript).toContain("vec0valuex = 0");
      // uDotSize name
      expect(uniformScript).toContain("vec1name = 'uDotSize'");
      // uDotSize value (8 from arg)
      expect(uniformScript).toContain("8");
      // uAngle name
      expect(uniformScript).toContain("vec2name = 'uAngle'");
      // uAngle value (30 from arg)
      expect(uniformScript).toContain("30");
      // uMix name
      expect(uniformScript).toContain("vec3name = 'uMix'");
      // uMix value (0.75 from arg)
      expect(uniformScript).toContain("0.75");
    });

    it("exposes Mix, DotSize, and Angle controls on the container", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "dots",
        dot_size: 6,
        angle: 15,
        mix: 0.8,
        resolution: [1280, 720],
      });

      const controls = panelControls(scripts);
      expect(controls.length).toBeGreaterThanOrEqual(3);

      const mix = controls.find((c) => c.name === "Mix");
      expect(mix?.type).toBe("float");
      expect(mix?.default).toBe(0.8);

      const dotSize = controls.find((c) => c.name === "DotSize");
      expect(dotSize?.type).toBe("float");

      const angle = controls.find((c) => c.name === "Angle");
      expect(angle?.type).toBe("float");
    });

    it("returns a summary text mentioning the style and GLSL unverified note", async () => {
      captureCreateBodies();
      captureExecScripts();

      const result = await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "dots",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });

      const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
      expect(text?.text).toContain("dots");
      expect(text?.text).toContain("GLSL compile UNVERIFIED");
    });
  });

  describe("source via Select TOP", () => {
    it("uses a selectTOP instead of noiseTOP when source is provided", async () => {
      const bodies = captureCreateBodies();
      captureExecScripts();

      await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: "/project1/render1",
        style: "cmyk",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });

      expect(bodies.some((b) => b.type === "selectTOP" && b.name === "source")).toBe(true);
      expect(bodies.some((b) => b.type === "noiseTOP")).toBe(false);
    });
  });

  describe("cmyk style", () => {
    it("sets uStyle to 1 for cmyk", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "cmyk",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });

      const uniformScript = scripts.find((s) => s.includes("vec0name = 'uStyle'"));
      expect(uniformScript).toContain("vec0valuex = 1");
    });
  });

  describe("dither style", () => {
    it("sets uStyle to 2 for dither", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "dither",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });

      const uniformScript = scripts.find((s) => s.includes("vec0name = 'uStyle'"));
      expect(uniformScript).toContain("vec0valuex = 2");
    });
  });

  describe("posterize style", () => {
    it("sets uStyle to 3 for posterize", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "posterize",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });

      const uniformScript = scripts.find((s) => s.includes("vec0name = 'uStyle'"));
      expect(uniformScript).toContain("vec0valuex = 3");
    });
  });

  describe("fail-forward / no-throw guarantees", () => {
    it("does not throw when the bridge exec returns a stdout with a fatal key", async () => {
      captureCreateBodies();
      server.use(
        http.post(`${TD_BASE}/api/exec`, async () => {
          return HttpResponse.json({
            ok: true,
            data: {
              result: null,
              stdout: JSON.stringify({ fatal: "glslTOP creation failed", warnings: [] }),
            },
          });
        }),
      );

      // Layer 1 tools: python() / connect() failures surface as warnings, not throws.
      // runBuild converts any top-level TdError into errorResult — never an exception.
      const result = await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "dots",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });
      expect(result).toBeDefined();
      // The handler must always return a result object (never throw)
      expect(Array.isArray(result.content)).toBe(true);
    });

    it("returns isError: true and does not throw when the bridge is unreachable", async () => {
      // Override all bridge calls to return network errors
      server.use(
        http.post(`${TD_BASE}/api/nodes`, () => HttpResponse.error()),
        http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()),
      );

      const result = await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "dots",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });
      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
    });

    it("bad schema input: mix > 1 is rejected before the handler runs", () => {
      expect(() => createHalftoneSchema.parse({ mix: 2 })).toThrow();
    });

    it("bad schema input: dot_size of 0 is rejected", () => {
      expect(() => createHalftoneSchema.parse({ dot_size: 0 })).toThrow();
    });
  });

  describe("shader content integrity", () => {
    it("shader declares uniforms matching the four bindings", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "dots",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });

      const shaderScript = scripts.find((s) => s.includes("out vec4 fragColor"));
      expect(shaderScript).toContain("uniform int   uStyle");
      expect(shaderScript).toContain("uniform float uDotSize");
      expect(shaderScript).toContain("uniform float uAngle");
      expect(shaderScript).toContain("uniform float uMix");
    });

    it("shader does not reference undefined globals (no uTime)", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "dots",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });

      const shaderScript = scripts.find((s) => s.includes("out vec4 fragColor")) ?? "";
      // The shader must NOT reference uTime (not a built-in TD GLSL global)
      expect(shaderScript).not.toContain("uTime");
    });

    it("shader uses vUV.st for UV coords, not gl_FragCoord", async () => {
      captureCreateBodies();
      const scripts = captureExecScripts();

      await createHalftoneImpl(makeCtx(), {
        name: "halftone",
        parent_path: "/project1",
        source: undefined,
        style: "dots",
        dot_size: 6,
        angle: 15,
        mix: 1,
        resolution: [1280, 720],
      });

      const shaderScript = scripts.find((s) => s.includes("out vec4 fragColor")) ?? "";
      expect(shaderScript).toContain("vUV.st");
    });
  });
});
