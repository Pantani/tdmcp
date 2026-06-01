import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createJfaVoronoiImpl,
  createJfaVoronoiSchema,
} from "../../src/tools/layer1/createJfaVoronoi.js";
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

function captureBuild(): {
  scripts: string[];
  createdTypes: string[];
  createdNames: string[];
  connects: Array<{ source: string; target: string; sourceOutput: number; targetInput: number }>;
} {
  const scripts: string[] = [];
  const createdTypes: string[] = [];
  const createdNames: string[] = [];
  const connects: Array<{
    source: string;
    target: string;
    sourceOutput: number;
    targetInput: number;
  }> = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as { parent_path: string; type: string; name?: string };
      createdTypes.push(body.type);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      createdNames.push(name);
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      // Crude parse of fallback connect-via-exec payloads to record (source, target, in-idx).
      const m =
        /op\('([^']+)'\)[\s\S]*?op\('([^']+)'\)[\s\S]*?inputConnectors\[(\d+)\]\.connect\(\s*[A-Za-z_]+\.outputConnectors\[(\d+)\]/.exec(
          body.script,
        );
      if (m?.[1] && m[2] && m[3] !== undefined && m[4] !== undefined) {
        connects.push({
          source: m[1],
          target: m[2],
          targetInput: Number(m[3]),
          sourceOutput: Number(m[4]),
        });
      }
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
    http.post(`${TD_BASE}/api/batch`, async ({ request }) => {
      const body = (await request.json()) as {
        operations?: Array<{
          action?: string;
          source_path?: string;
          target_path?: string;
          source_output?: number;
          target_input?: number;
        }>;
      };
      const results: Array<{ ok: boolean }> = [];
      for (const op of body.operations ?? []) {
        if (op.action === "connect") {
          connects.push({
            source: String(op.source_path ?? ""),
            target: String(op.target_path ?? ""),
            sourceOutput: Number(op.source_output ?? 0),
            targetInput: Number(op.target_input ?? 0),
          });
        }
        results.push({ ok: true });
      }
      return HttpResponse.json({ ok: true, data: { results } });
    }),
  );
  return { scripts, createdTypes, createdNames, connects };
}

function run(args: Partial<z.input<typeof createJfaVoronoiSchema>>) {
  return createJfaVoronoiImpl(makeCtx(), createJfaVoronoiSchema.parse(args));
}

function parseResultData(result: { content: Array<{ type: string; text?: string }> }): {
  container: string;
  output: string;
  jfa_passes: number;
  palette_mode: string;
  scene_resolution: [number, number];
  warnings?: string[];
} {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  const json = /```json\n([\s\S]+?)\n```/.exec(text)?.[1];
  if (!json) throw new Error("result did not embed a JSON data block");
  return JSON.parse(json);
}

describe("createJfaVoronoi schema", () => {
  it("applies the spec'd defaults", () => {
    const parsed = createJfaVoronoiSchema.parse({});
    expect(parsed.seed_count).toBe(48);
    expect(parsed.speed).toBe(0.25);
    expect(parsed.palette_mode).toBe("random");
    expect(parsed.edge_thickness).toBe(0.004);
    expect(parsed.edge_color).toBe("#000000");
    expect(parsed.jitter).toBe(0.6);
    expect(parsed.color_a).toBe("#ff3366");
    expect(parsed.color_b).toBe("#33ccff");
    expect(parsed.resolution).toEqual([1280, 720]);
    expect(parsed.step_count).toBe(0);
    expect(parsed.expose_controls).toBe(true);
    expect(parsed.parent_path).toBe("/project1");
  });

  it("accepts every palette mode and rejects unknown ones", () => {
    for (const m of ["random", "from_image", "duotone"]) {
      expect(createJfaVoronoiSchema.parse({ palette_mode: m }).palette_mode).toBe(m);
    }
    expect(() => createJfaVoronoiSchema.parse({ palette_mode: "rainbow" })).toThrow();
  });

  it("clamps seed_count and step_count to their ranges", () => {
    expect(() => createJfaVoronoiSchema.parse({ seed_count: 2 })).toThrow();
    expect(() => createJfaVoronoiSchema.parse({ seed_count: 1024 })).toThrow();
    expect(() => createJfaVoronoiSchema.parse({ step_count: -1 })).toThrow();
    expect(() => createJfaVoronoiSchema.parse({ step_count: 20 })).toThrow();
  });
});

describe("createJfaVoronoi build topology", () => {
  it("creates the seeds + jfa_init + auto K passes + color_pass + out1 chain at defaults", async () => {
    const { createdTypes, createdNames } = captureBuild();
    const result = await run({});

    // baseCOMP container + the GLSL TOPs and Text DATs.
    expect(createdTypes).toContain("baseCOMP");
    expect(createdTypes.filter((t) => t === "glslTOP").length).toBeGreaterThanOrEqual(4);
    expect(createdTypes).toContain("textDAT");
    expect(createdTypes).toContain("nullTOP");

    // Named nodes present.
    for (const expected of [
      "seeds_uv",
      "seeds_col",
      "jfa_init",
      "jfa_step_frag",
      "color_pass",
      "out1",
    ]) {
      expect(createdNames).toContain(expected);
    }

    // Default resolution 1280x720 → ceil(log2(1280)) = 11 JFA passes.
    const passes = createdNames.filter((n) => /^jfa_pass_\d+$/.test(n));
    expect(passes.length).toBe(11);
    expect(passes).toContain("jfa_pass_0");
    expect(passes).toContain("jfa_pass_10");

    const data = parseResultData(result as never);
    expect(data.jfa_passes).toBe(11);
    expect(data.scene_resolution).toEqual([1280, 720]);
    expect(data.container).toMatch(/\/project1\/jfa_voronoi/);
    expect(data.output).toMatch(/\/out1$/);
  });

  it("always wires color_pass input 2 (sTD2DInputs[2]) so the GLSL shader compiles in every palette_mode", async () => {
    // random: no palette_src is created, seeds_col must back-stop input 2.
    const cap1 = captureBuild();
    await run({ palette_mode: "random" });
    expect(cap1.createdNames).not.toContain("palette_src");
    const colorPassIn2_random = cap1.connects.filter(
      (c) => /\/color_pass$/.test(c.target) && c.targetInput === 2,
    );
    expect(colorPassIn2_random.length).toBe(1);
    expect(colorPassIn2_random[0]?.source).toMatch(/\/seeds_col$/);

    // duotone: same back-stop (no palette image).
    const cap2 = captureBuild();
    await run({ palette_mode: "duotone" });
    expect(cap2.createdNames).not.toContain("palette_src");
    const colorPassIn2_duo = cap2.connects.filter(
      (c) => /\/color_pass$/.test(c.target) && c.targetInput === 2,
    );
    expect(colorPassIn2_duo.length).toBe(1);
    expect(colorPassIn2_duo[0]?.source).toMatch(/\/seeds_col$/);

    // from_image with a real path: palette_src Select TOP drives input 2.
    const cap3 = captureBuild();
    await run({ palette_mode: "from_image", palette_image: "/project1/some_image" });
    expect(cap3.createdNames).toContain("palette_src");
    const colorPassIn2_img = cap3.connects.filter(
      (c) => /\/color_pass$/.test(c.target) && c.targetInput === 2,
    );
    expect(colorPassIn2_img.length).toBe(1);
    expect(colorPassIn2_img[0]?.source).toMatch(/\/palette_src$/);

    // from_image with NO image path: still wired (seeds_col back-stop) so the shader compiles.
    const cap4 = captureBuild();
    await run({ palette_mode: "from_image", palette_image: "" });
    expect(cap4.createdNames).not.toContain("palette_src");
    const colorPassIn2_none = cap4.connects.filter(
      (c) => /\/color_pass$/.test(c.target) && c.targetInput === 2,
    );
    expect(colorPassIn2_none.length).toBe(1);
    expect(colorPassIn2_none[0]?.source).toMatch(/\/seeds_col$/);
  });

  it("honours an explicit step_count override (no auto-derivation)", async () => {
    const { createdNames } = captureBuild();
    await run({ step_count: 4 });
    const passes = createdNames.filter((n) => /^jfa_pass_\d+$/.test(n));
    expect(passes.length).toBe(4);
  });

  it("wires each JFA pass to the previous pass with halving uStep values", async () => {
    const { scripts } = captureBuild();
    await run({ step_count: 4, resolution: [512, 512] });
    // Step values for 4 passes: 8, 4, 2, 1 (Math.pow(2, K-1-i) with floor 1).
    const stepExpressions = scripts.filter((s) => s.includes("vec0name = 'uStep'"));
    expect(stepExpressions.length).toBeGreaterThanOrEqual(4);
    const joined = stepExpressions.join("\n");
    expect(joined).toContain('vec0valuex.expr = "8"');
    expect(joined).toContain('vec0valuex.expr = "4"');
    expect(joined).toContain('vec0valuex.expr = "2"');
    expect(joined).toContain('vec0valuex.expr = "1"');
  });
});

describe("createJfaVoronoi shaders + uniforms", () => {
  it("writes the seed shaders, jfa shaders, and color shader into Text DATs", async () => {
    const { scripts } = captureBuild();
    await run({});
    const all = scripts.join("\n");
    expect(all).toContain("out vec4 fragColor;");
    expect(all).toContain("TDOutputSwizzle");
    // Seeds: hash drift body.
    expect(all).toContain("uniform float uJitter;");
    expect(all).toContain("hash21");
    // JFA: ping-pong sampling with uStep.
    expect(all).toContain("uniform float uStep;");
    expect(all).toContain("texelFetch(sTD2DInputs[0]");
    // Color: edge detection.
    expect(all).toContain("uEdgeThickness");
    expect(all).toContain("uEdgeColor");
  });

  it("binds defensive uniform expressions on the seeds_uv GLSL TOP", async () => {
    const { scripts } = captureBuild();
    await run({});
    const seedsUvScript = scripts.find(
      (s) => s.includes("seeds_uv") && s.includes("vec0name = 'uTime'"),
    );
    expect(seedsUvScript).toBeDefined();
    expect(seedsUvScript).toContain("absTime.seconds");
    expect(seedsUvScript).toContain("hasattr(parent().par, 'Speed')");
    expect(seedsUvScript).toContain("vec1name = 'uJitter'");
    expect(seedsUvScript).toContain("vec2name = 'uSeedCount'");
  });

  it("encodes palette_mode='duotone' as the constant fallback 2 when expose_controls is off", async () => {
    const { scripts } = captureBuild();
    await run({ palette_mode: "duotone", expose_controls: false });
    // The defensive expression's `else <fallback>` should contain the duotone code 2.
    const seedsColScript = scripts.find(
      (s) => s.includes("seeds_col") && s.includes("vec1name = 'uPaletteMode'"),
    );
    expect(seedsColScript).toBeDefined();
    expect(seedsColScript).toContain("hasattr(parent().par, 'Palettemode')");
    expect(seedsColScript).toContain("else 2");
  });

  it("encodes palette_mode='random' as fallback 0", async () => {
    const { scripts } = captureBuild();
    await run({ palette_mode: "random", expose_controls: false });
    const seedsColScript = scripts.find(
      (s) => s.includes("seeds_col") && s.includes("vec1name = 'uPaletteMode'"),
    );
    expect(seedsColScript).toBeDefined();
    expect(seedsColScript).toContain("else 0");
  });
});

describe("createJfaVoronoi controls", () => {
  it("exposes the 8 spec'd controls with the right types when expose_controls=true", async () => {
    const { scripts } = captureBuild();
    await run({ expose_controls: true });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type: string }>;
    };
    const byName = new Map(payload.controls.map((c) => [c.name, c.type]));
    expect(byName.get("PaletteMode")).toBe("menu");
    expect(byName.get("SeedCount")).toBe("int");
    expect(byName.get("Speed")).toBe("float");
    expect(byName.get("Jitter")).toBe("float");
    expect(byName.get("EdgeThickness")).toBe("float");
    expect(byName.get("EdgeColor")).toBe("rgb");
    expect(byName.get("ColorA")).toBe("rgb");
    expect(byName.get("ColorB")).toBe("rgb");
    expect(payload.controls.length).toBe(8);
  });

  it("skips the control panel but keeps uniform expressions when expose_controls=false", async () => {
    const { scripts } = captureBuild();
    await run({ expose_controls: false });
    expect(scripts.some((s) => s.includes("appendCustomPage"))).toBe(false);
    expect(scripts.some((s) => s.includes("hasattr(parent().par, 'Speed')"))).toBe(true);
  });
});

describe("createJfaVoronoi colour parsing", () => {
  it("warns (but still builds) on a malformed color_a", async () => {
    captureBuild();
    const result = await run({ color_a: "not-a-color" });
    const data = parseResultData(result as never);
    expect((data.warnings ?? []).some((w) => /could not parse color_a/i.test(w))).toBe(true);
  });
});
