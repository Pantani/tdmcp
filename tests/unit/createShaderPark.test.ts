import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createShaderParkImpl,
  createShaderParkSchema,
} from "../../src/tools/layer1/createShaderPark.js";
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

interface CreatedBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

function captureBuild(): { scripts: string[]; bodies: CreatedBody[] } {
  const scripts: string[] = [];
  const bodies: CreatedBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedBody;
      bodies.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return { scripts, bodies };
}

function run(args: Partial<z.input<typeof createShaderParkSchema>>) {
  return createShaderParkImpl(makeCtx(), createShaderParkSchema.parse(args));
}

function parseResultData(result: { content: Array<{ type: string; text?: string }> }): {
  container: string;
  output: string;
  code_dat: string;
  pixel_dat: string;
  shader_park: {
    code: string;
    uniform_names: string[];
    custom_uniforms: string[];
    source: string;
  };
} {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  const json = /```json\n([\s\S]+?)\n```/.exec(text)?.[1];
  if (!json) throw new Error("result did not embed a JSON data block");
  return JSON.parse(json);
}

function uniformScriptFor(scripts: string[], uniformName: string): string {
  const nameAssignment = `name = ${JSON.stringify(uniformName)}`;
  const script = scripts.find((s) => s.includes("seq.vec") && s.includes(nameAssignment));
  if (!script) throw new Error(`uniform script did not include ${uniformName}`);
  return script;
}

function uniformBlock(script: string, uniformName: string): string {
  for (const line of script.split("\n")) {
    const match = /^_m\.par\.vec(\d+)name = (.+)$/.exec(line);
    if (!match) continue;
    const [, index, encodedName] = match;
    if (!index || !encodedName) continue;
    if (JSON.parse(encodedName) === uniformName) return `vec${index}`;
  }
  throw new Error(`uniform script did not assign a block for ${uniformName}`);
}

describe("createShaderPark schema", () => {
  it("defaults to a self-contained Shader Park sphere render", () => {
    const parsed = createShaderParkSchema.parse({});
    expect(parsed.name).toBe("shader_park_sculpture");
    expect(parsed.code).toContain("sphere");
    expect(parsed.resolution).toEqual([1280, 720]);
    expect(parsed.camera_z).toBe(4);
    expect(parsed.expose_controls).toBe(true);
    expect(parsed.parent_path).toBe("/project1");
  });
});

describe("createShaderPark build", () => {
  it("creates a renderable GLSL MAT scene from Shader Park code", async () => {
    const { bodies } = captureBuild();
    const result = await run({ code: "sphere(0.45);" });

    expect(bodies.some((b) => b.name === "shader_park_sculpture" && b.type === "baseCOMP")).toBe(
      true,
    );
    for (const type of [
      "geometryCOMP",
      "boxSOP",
      "glslMAT",
      "textDAT",
      "cameraCOMP",
      "lightCOMP",
      "renderTOP",
      "nullTOP",
      "executeDAT",
    ]) {
      expect(
        bodies.some((b) => b.type === type),
        `${type} should be created`,
      ).toBe(true);
    }

    const data = parseResultData(result as never);
    expect(data.container).toBe("/project1/shader_park_sculpture");
    expect(data.output).toBe("/project1/shader_park_sculpture/out1");
    expect(data.shader_park.source).toBe("shader-park-core");
    expect(data.shader_park.uniform_names).toContain("time");
  });

  it("writes both the original Shader Park source and compiled pixel shader into DATs", async () => {
    const { scripts } = captureBuild();
    await run({ code: "let size = input();\nsphere(size);", uniform_values: { size: 0.6 } });

    const sourceScript = scripts.find((s) => s.includes("shaderpark_code") && s.includes(".text"));
    expect(sourceScript).toContain("let size = input()");
    expect(sourceScript).toContain("sphere(size)");

    const pixelScript = scripts.find((s) => s.includes("shaderpark_pixel") && s.includes(".pdat"));
    expect(pixelScript).toContain("uniform float size;");
    expect(pixelScript).toContain("surfaceDistance");
    expect(pixelScript).toContain("_m.par.pdat");
    expect(pixelScript).toContain("shaderpark_vertex");
    expect(pixelScript).toContain("_m.par.vdat");
    expect(pixelScript).toContain("out Vertex");
  });

  it("binds Shader Park uniforms through the GLSL MAT vector sequence", async () => {
    const { scripts } = captureBuild();
    await run({ code: "let size = input();\nsphere(size);", uniform_values: { size: 0.6 } });

    const uniformScript = uniformScriptFor(scripts, "time");
    const timeBlock = uniformBlock(uniformScript, "time");
    const opacityBlock = uniformBlock(uniformScript, "opacity");
    const scaleBlock = uniformBlock(uniformScript, "_scale");
    const mouseBlock = uniformBlock(uniformScript, "mouse");
    const sizeBlock = uniformBlock(uniformScript, "size");

    expect(uniformScript).toContain(`_m.par.${timeBlock}valuex.expr = "absTime.seconds`);
    expect(uniformScript).toContain("parent().par.Speed.eval()");
    expect(uniformScript).toContain(
      `_m.par.${opacityBlock}valuex.expr = "parent().par.Opacity.eval()`,
    );
    expect(uniformScript).toContain(`_m.par.${scaleBlock}valuex.expr = "parent().par.Scale.eval()`);
    expect(uniformScript).toContain(`_m.par.${mouseBlock}name = "mouse"`);
    expect(uniformScript).toContain(`_m.par.${sizeBlock}valuex.expr = "parent().par.Size.eval()`);
    expect(uniformScript).toContain("else 0.6");
  });

  it("uses TD custom-parameter normalization for camelCase Shader Park inputs", async () => {
    const { scripts } = captureBuild();
    await run({
      code: "let ringRadius = input();\nsphere(ringRadius);",
      uniform_values: { ringRadius: 0.7 },
    });

    const uniformScript = scripts.find((s) => s.includes("seq.vec") && s.includes("ringRadius"));
    expect(uniformScript).toBeDefined();
    expect(uniformScript).toContain("parent().par.Ringradius.eval()");
    expect(uniformScript).toContain("hasattr(parent().par, 'Ringradius')");
    expect(uniformScript).not.toContain("parent().par.RingRadius.eval()");
    expect(uniformScript).not.toContain("hasattr(parent().par, 'RingRadius')");
  });

  it("assigns Shader Park material defaults and the base-color sampler", async () => {
    const { scripts } = captureBuild();
    await run({ code: "sphere(0.45);" });

    const uniformScript = uniformScriptFor(scripts, "uBaseColor");
    const shadowStrengthBlock = uniformBlock(uniformScript, "uShadowStrength");
    const baseColorBlock = uniformBlock(uniformScript, "uBaseColor");
    const cameraPositionBlock = uniformBlock(uniformScript, "cameraPosition");
    const useTdLightingBlock = uniformBlock(uniformScript, "useTDLighting");

    expect(uniformScript).toContain(`_m.par.${shadowStrengthBlock}name = "uShadowStrength"`);
    expect(uniformScript).toContain(`_m.par.${baseColorBlock}name = "uBaseColor"`);
    expect(uniformScript).toContain(`_m.par.${cameraPositionBlock}name = "cameraPosition"`);
    expect(uniformScript).toContain(`_m.par.${cameraPositionBlock}valuez.expr`);
    expect(uniformScript).toContain("parent().op('cam').par.tz.eval()");
    expect(uniformScript).toContain(`_m.par.${useTdLightingBlock}name = "useTDLighting"`);
    const samplerScript = scripts.find((s) => s.includes("sampler0name"));
    expect(samplerScript).toContain("base_color_map");
    expect(samplerScript).toContain('sampler0name = "sBaseColorMap"');
  });

  it("merges partial vector uniform overrides with Shader Park defaults", async () => {
    const { scripts } = captureBuild();
    await run({ code: "sphere(0.45);", uniform_values: { uBaseColor: [0.25] } });

    const uniformScript = uniformScriptFor(scripts, "uBaseColor");
    const baseColorBlock = uniformBlock(uniformScript, "uBaseColor");
    expect(uniformScript).toContain(`_m.par.${baseColorBlock}name = "uBaseColor"`);
    expect(uniformScript).toContain(`_m.par.${baseColorBlock}valuex = 0.25`);
    expect(uniformScript).toContain(`_m.par.${baseColorBlock}valuey = 1`);
    expect(uniformScript).toContain(`_m.par.${baseColorBlock}valuez = 1`);
    expect(uniformScript).toContain(`_m.par.${baseColorBlock}valuew = 1`);
  });

  it("exposes standard controls plus custom float inputs when expose_controls is on", async () => {
    const { scripts } = captureBuild();
    await run({ code: "let size = input();\nsphere(size);", uniform_values: { size: 0.6 } });

    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type: string; description?: unknown }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["Speed", "Scale", "Opacity", "StepSize", "Size"]),
    );
    expect(payload.controls.every((control) => control.description === undefined)).toBe(true);
  });

  it("returns an isError result when Shader Park compilation fails", async () => {
    captureBuild();
    const result = await run({ code: "sphere(" });
    expect(result.isError).toBe(true);
    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("expected text error content");
    expect(content.text).toMatch(/Shader Park compile failed/i);
  });
});
