import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createRaymarchSceneImpl,
  createRaymarchSceneSchema,
} from "../../src/tools/layer1/createRaymarchScene.js";
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

/** Records every node creation (type) and every exec script the build issues. */
function captureBuild(): { scripts: string[]; createdTypes: string[] } {
  const scripts: string[] = [];
  const createdTypes: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as { parent_path: string; type: string; name?: string };
      createdTypes.push(body.type);
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
  return { scripts, createdTypes };
}

/**
 * Calls the tool the way the MCP framework does: validate the raw args through the schema
 * (applying defaults) before invoking the impl, matching production where the impl only ever
 * sees parsed input.
 */
function run(args: Partial<z.input<typeof createRaymarchSceneSchema>>) {
  return createRaymarchSceneImpl(makeCtx(), createRaymarchSceneSchema.parse(args));
}

/** Pulls the result text payload's JSON block (the `data` object finalize embeds). */
function parseResultData(result: { content: Array<{ type: string; text?: string }> }): {
  container: string;
  output: string;
  scene: string;
  warnings?: string[];
} {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  const json = /```json\n([\s\S]+?)\n```/.exec(text)?.[1];
  if (!json) throw new Error("result did not embed a JSON data block");
  return JSON.parse(json);
}

describe("createRaymarchScene schema", () => {
  it("defaults to sphere_field, 1280x720, and sensible march params", () => {
    const parsed = createRaymarchSceneSchema.parse({});
    expect(parsed.scene).toBe("sphere_field");
    expect(parsed.resolution).toEqual([1280, 720]);
    expect(parsed.camera_z).toBe(4);
    expect(parsed.speed).toBe(1);
    expect(parsed.step_count).toBe(64);
    expect(parsed.intensity).toBe(1);
    expect(parsed.expose_controls).toBe(true);
    expect(parsed.parent_path).toBe("/project1");
  });

  it("accepts every scene name and rejects unknown ones", () => {
    for (const name of ["sphere_field", "menger", "tunnel"]) {
      expect(createRaymarchSceneSchema.parse({ scene: name }).scene).toBe(name);
    }
    expect(() => createRaymarchSceneSchema.parse({ scene: "klein_bottle" })).toThrow();
  });

  it("clamps step_count to the 8..256 integer range", () => {
    expect(() => createRaymarchSceneSchema.parse({ step_count: 4 })).toThrow();
    expect(() => createRaymarchSceneSchema.parse({ step_count: 512 })).toThrow();
    expect(() => createRaymarchSceneSchema.parse({ step_count: 32.5 })).toThrow();
    expect(createRaymarchSceneSchema.parse({ step_count: 128 }).step_count).toBe(128);
  });
});

describe("createRaymarchScene build", () => {
  it("creates a baseCOMP container, a GLSL TOP, a Text DAT and a Null TOP output", async () => {
    const { createdTypes } = captureBuild();
    const result = await run({ scene: "sphere_field" });
    expect(createdTypes).toContain("baseCOMP");
    expect(createdTypes).toContain("glslTOP");
    expect(createdTypes).toContain("textDAT");
    expect(createdTypes).toContain("nullTOP");

    const data = parseResultData(result as never);
    expect(data.scene).toBe("sphere_field");
    expect(data.container).toMatch(/\/project1\/raymarch_scene_sphere_field/);
    expect(data.output).toMatch(/\/out1$/);
  });

  it("writes the selected scene's shader into the Text DAT and points pixeldat at it", async () => {
    const { scripts } = captureBuild();
    await run({ scene: "menger" });
    const textScript = scripts.find((s) => s.includes(".text =") && s.includes("pixeldat"));
    expect(textScript).toBeDefined();
    // The shader follows the verified GLSL-TOP conventions: declares its output, swizzles,
    // and carries its own time uniform (no built-in uTime in TD).
    expect(textScript).toContain("out vec4 fragColor;");
    expect(textScript).toContain("TDOutputSwizzle");
    expect(textScript).toContain("uniform float uTime;");
    expect(textScript).toContain("sceneDist"); // every raymarcher defines an SDF
    // Distinctive to the menger body (a different scene would not contain this).
    expect(textScript).toContain("sdBox");
    expect(textScript).not.toContain("twist"); // that token belongs to the tunnel scene
  });

  it("binds a different shader body when a different scene is chosen", async () => {
    const { scripts } = captureBuild();
    await run({ scene: "tunnel" });
    const textScript = scripts.find((s) => s.includes(".text =") && s.includes("pixeldat"));
    expect(textScript).toBeDefined();
    expect(textScript).toContain("twist"); // tunnel-specific
    expect(textScript).not.toContain("sdBox"); // that token belongs to menger
  });

  it("gates the raymarch loop with a constant ceiling and an int(uSteps) break", async () => {
    const { scripts } = captureBuild();
    await run({ scene: "sphere_field" });
    const textScript = scripts.find((s) => s.includes(".text =") && s.includes("pixeldat"));
    expect(textScript).toBeDefined();
    // GLSL needs a constant for-bound; the live control trims work via an int break.
    expect(textScript).toContain("for(int i = 0; i < 256; i++)");
    expect(textScript).toContain("int(max(uSteps, 1.0))");
  });

  it("binds the scalar uniforms via the Vectors sequence with defensive lookups", async () => {
    const { scripts } = captureBuild();
    await run({ scene: "sphere_field", speed: 2, camera_z: 6, intensity: 1.5 });
    const uniformScript = scripts.find((s) => s.includes("vec0valuex.expr"));
    expect(uniformScript).toBeDefined();
    // uTime advances with absTime, guarded by a live Speed lookup with a constant fallback.
    expect(uniformScript).toContain("vec0name = 'uTime'");
    expect(uniformScript).toContain("absTime.seconds");
    expect(uniformScript).toContain("parent().par.Speed.eval()");
    expect(uniformScript).toContain("hasattr(parent().par, 'Speed')");
    // uCameraZ / uSteps / uIntensity fill the next Vectors blocks, each a defensive lookup
    // against the lowercased control-parameter name.
    expect(uniformScript).toContain("vec1name = 'uCameraZ'");
    expect(uniformScript).toContain("parent().par.Cameraz.eval()");
    expect(uniformScript).toContain("vec2name = 'uSteps'");
    expect(uniformScript).toContain("parent().par.Stepcount.eval()");
    expect(uniformScript).toContain("vec3name = 'uIntensity'");
    expect(uniformScript).toContain("parent().par.Intensity.eval()");
  });

  it("binds uColorA and uColorB via the Colors sequence reading the swatch components", async () => {
    const { scripts } = captureBuild();
    await run({ scene: "sphere_field" });
    const uniformScript = scripts.find((s) => s.includes("color0name = 'uColorA'"));
    expect(uniformScript).toBeDefined();
    expect(uniformScript).toContain("color0rgbr.expr");
    expect(uniformScript).toContain("parent().par.Colorar.eval()");
    expect(uniformScript).toContain("color1name = 'uColorB'");
    expect(uniformScript).toContain("parent().par.Colorbb.eval()");
  });

  it("exposes the six live controls in the panel when expose_controls is on", async () => {
    const { scripts } = captureBuild();
    await run({ scene: "menger", expose_controls: true });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type: string }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["CameraZ", "Speed", "StepCount", "Intensity", "ColorA", "ColorB"]),
    );
    expect(payload.controls.find((c) => c.name === "StepCount")?.type).toBe("int");
    expect(payload.controls.find((c) => c.name === "ColorA")?.type).toBe("rgb");
    expect(payload.controls.find((c) => c.name === "ColorB")?.type).toBe("rgb");
  });

  it("skips the control panel but keeps the uniform expressions when expose_controls is off", async () => {
    const { scripts } = captureBuild();
    await run({ scene: "sphere_field", expose_controls: false });
    expect(scripts.some((s) => s.includes("appendCustomPage"))).toBe(false);
    // The defensive uniform expressions are always written (they fall back to constants).
    expect(scripts.some((s) => s.includes("parent().par.Speed.eval()"))).toBe(true);
  });

  it("parses a hex color and uses it as the uColorA fallback constant", async () => {
    const { scripts } = captureBuild();
    // #ff0000 → r=1.0, g=0.0, b=0.0 as the fallback constants in the uColorA expressions.
    await run({ scene: "tunnel", color_a: "#ff0000" });
    const uniformScript = scripts.find((s) => s.includes("color0rgbr.expr"));
    expect(uniformScript).toBeDefined();
    expect(uniformScript).toContain("else 1");
    expect(uniformScript).toContain("else 0");
  });

  it("warns (but still builds) on a malformed color", async () => {
    captureBuild();
    const result = await run({ scene: "sphere_field", color_a: "not-a-color" });
    const data = parseResultData(result as never);
    expect((data.warnings ?? []).some((w) => /could not parse color_a/i.test(w))).toBe(true);
  });
});
