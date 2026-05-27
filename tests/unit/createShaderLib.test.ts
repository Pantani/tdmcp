import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createShaderLibImpl,
  createShaderLibSchema,
} from "../../src/tools/layer1/createShaderLib.js";
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
 * (applying defaults) before invoking the impl. This keeps the tests honest about defaults
 * and matches production, where the impl only ever sees parsed input.
 */
function run(args: Partial<z.input<typeof createShaderLibSchema>>) {
  return createShaderLibImpl(makeCtx(), createShaderLibSchema.parse(args));
}

/** Pulls the result text payload's JSON block (the `data` object finalize embeds). */
function parseResultData(result: { content: Array<{ type: string; text?: string }> }): {
  container: string;
  output: string;
  shader: string;
} {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  const json = /```json\n([\s\S]+?)\n```/.exec(text)?.[1];
  if (!json) throw new Error("result did not embed a JSON data block");
  return JSON.parse(json);
}

describe("createShaderLib schema", () => {
  it("defaults to the first curated shader and 1280x720", () => {
    const parsed = createShaderLibSchema.parse({});
    expect(parsed.shader).toBe("tunnel");
    expect(parsed.resolution).toEqual([1280, 720]);
    expect(parsed.speed).toBe(1);
    expect(parsed.scale).toBe(1);
    expect(parsed.expose_controls).toBe(true);
    expect(parsed.parent_path).toBe("/project1");
  });

  it("accepts every curated shader name and rejects unknown ones", () => {
    for (const name of ["tunnel", "raymarch_sphere", "fractal", "metaballs", "plasma"]) {
      expect(createShaderLibSchema.parse({ shader: name }).shader).toBe(name);
    }
    expect(() => createShaderLibSchema.parse({ shader: "lissajous" })).toThrow();
  });
});

describe("createShaderLib build", () => {
  it("creates a baseCOMP container, a GLSL TOP, a Text DAT and a Null TOP output", async () => {
    const { createdTypes } = captureBuild();
    const result = await run({ shader: "tunnel" });
    expect(createdTypes).toContain("baseCOMP");
    expect(createdTypes).toContain("glslTOP");
    expect(createdTypes).toContain("textDAT");
    expect(createdTypes).toContain("nullTOP");

    const data = parseResultData(result as never);
    expect(data.shader).toBe("tunnel");
    expect(data.container).toMatch(/\/project1\/shader_lib_tunnel/);
    expect(data.output).toMatch(/\/out1$/);
  });

  it("writes the selected shader's source into the Text DAT and points pixeldat at it", async () => {
    const { scripts } = captureBuild();
    await run({ shader: "metaballs" });
    const textScript = scripts.find((s) => s.includes(".text =") && s.includes("pixeldat"));
    expect(textScript).toBeDefined();
    // The metaballs body is embedded verbatim, declares its output, and swizzles.
    expect(textScript).toContain("out vec4 fragColor;");
    expect(textScript).toContain("TDOutputSwizzle");
    expect(textScript).toContain("uniform float uTime;");
    // Distinctive to the metaballs body (a different shader would not contain this).
    expect(textScript).toContain("field");
    expect(textScript).not.toContain("sceneDist"); // that token belongs to raymarch_sphere
  });

  it("binds a different shader body when a different name is chosen", async () => {
    const { scripts } = captureBuild();
    await run({ shader: "raymarch_sphere" });
    const textScript = scripts.find((s) => s.includes(".text =") && s.includes("pixeldat"));
    expect(textScript).toBeDefined();
    expect(textScript).toContain("sceneDist"); // raymarch-specific helper
    expect(textScript).toContain("TDOutputSwizzle");
  });

  it("binds uTime/uScale/uColor uniforms via the Vectors and Colors sequences with defensive lookups", async () => {
    const { scripts } = captureBuild();
    await run({ shader: "plasma", speed: 2, scale: 1.5 });
    const uniformScript = scripts.find((s) => s.includes("vec0valuex.expr"));
    expect(uniformScript).toBeDefined();
    // uTime advances with absTime, guarded by a live Speed lookup with a constant fallback.
    expect(uniformScript).toContain("vec0name = 'uTime'");
    expect(uniformScript).toContain("absTime.seconds");
    expect(uniformScript).toContain("parent().par.Speed.eval()");
    expect(uniformScript).toContain("hasattr(parent().par, 'Speed')");
    // uScale lives in the second Vectors block, also a defensive lookup.
    expect(uniformScript).toContain("vec1name = 'uScale'");
    expect(uniformScript).toContain("parent().par.Scale.eval()");
    // uColor binds through the Colors sequence, reading the RGB swatch components.
    expect(uniformScript).toContain("color0name = 'uColor'");
    expect(uniformScript).toContain("parent().par.Colorr.eval()");
    expect(uniformScript).toContain("color0rgbb.expr");
  });

  it("exposes Speed, Scale and Color controls in the panel when expose_controls is on", async () => {
    const { scripts } = captureBuild();
    await run({ shader: "fractal", expose_controls: true });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type: string }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Speed", "Scale", "Color"]));
    expect(payload.controls.find((c) => c.name === "Color")?.type).toBe("rgb");
  });

  it("skips the control panel but keeps the uniform expressions when expose_controls is off", async () => {
    const { scripts } = captureBuild();
    await run({ shader: "tunnel", expose_controls: false });
    expect(scripts.some((s) => s.includes("appendCustomPage"))).toBe(false);
    // The defensive uniform expressions are always written (they fall back to constants).
    expect(scripts.some((s) => s.includes("parent().par.Speed.eval()"))).toBe(true);
  });

  it("parses a hex color and uses it as the uColor fallback constants", async () => {
    const { scripts } = captureBuild();
    // #ff0000 → r=1.0, g=0.0, b=0.0 as the fallback constants in the uColor expressions.
    await run({ shader: "plasma", color: "#ff0000" });
    const uniformScript = scripts.find((s) => s.includes("color0rgbr.expr"));
    expect(uniformScript).toBeDefined();
    expect(uniformScript).toContain("else 1");
    expect(uniformScript).toContain("else 0");
  });

  it("warns (but still builds) on a malformed color", async () => {
    captureBuild();
    const result = await run({ shader: "plasma", color: "not-a-color" });
    const data = parseResultData(result as never) as { warnings?: string[] };
    expect((data.warnings ?? []).some((w) => /could not parse color/i.test(w))).toBe(true);
  });
});
