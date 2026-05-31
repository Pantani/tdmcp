import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  applyGlslTopMappingImpl,
  applyShadertoyUniforms,
  buildIsfMapping,
  glslTopMappingSchema,
  mapIsfFragmentToFragment,
  mapShadertoyMainImageToFragment,
} from "../../src/tools/foundation/glslTopMapping.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function ctx(): ToolContext {
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

describe("mapShadertoyMainImageToFragment", () => {
  it("renames mainImage → main, computes fragCoord, wraps last fragColor with TDOutputSwizzle", () => {
    const src = `void mainImage(out vec4 outColor, in vec2 fragCoord) {
  outColor = vec4(fragCoord / iResolution.xy, 0.0, 1.0);
}`;
    const { fragment, declaredUniforms } = mapShadertoyMainImageToFragment(src);
    expect(fragment).toMatch(/void main\(\)/);
    expect(fragment).toMatch(/vec2 fragCoord = vUV\.st \* iResolution\.xy;/);
    expect(fragment).toMatch(/TDOutputSwizzle\(/);
    expect(fragment).toMatch(/out vec4 outColor;/);
    expect(declaredUniforms).toContain("iTime");
    expect(declaredUniforms).toContain("iResolution");
  });

  it("falls back with a warning when mainImage signature is missing", () => {
    const src = `// no mainImage, no main\nvec3 nope = vec3(0);`;
    const { fragment, warnings } = mapShadertoyMainImageToFragment(src);
    expect(warnings.length).toBeGreaterThan(0);
    expect(fragment).toMatch(/void main\(\)/);
    expect(fragment).toMatch(/TDOutputSwizzle/);
  });

  it("strips #version and precision lines", () => {
    const src = `#version 300 es
precision highp float;
void mainImage(out vec4 c, in vec2 f){ c = vec4(1.0); }`;
    const { fragment } = mapShadertoyMainImageToFragment(src);
    expect(fragment).not.toMatch(/#version/);
    expect(fragment).not.toMatch(/precision/);
  });
});

describe("mapIsfFragmentToFragment (macro shim)", () => {
  it("prepends IMG_NORM_PIXEL / RENDERSIZE macros and declares fragColor", () => {
    const src = `void main(){ gl_FragColor = vec4(1.0); }`;
    const { fragment } = mapIsfFragmentToFragment(src, []);
    expect(fragment).toMatch(/#define IMG_NORM_PIXEL/);
    expect(fragment).toMatch(/#define RENDERSIZE/);
    expect(fragment).toMatch(/out vec4 fragColor;/);
    expect(fragment).toMatch(/TDOutputSwizzle/);
  });

  it("aliases ISF image inputs to iChannelN", () => {
    const { fragment } = mapIsfFragmentToFragment(
      `void main(){ fragColor = IMG_THIS_PIXEL(inputImage); }`,
      [{ NAME: "inputImage", TYPE: "image" }],
    );
    expect(fragment).toMatch(/#define inputImage iChannel0/);
  });
});

describe("buildIsfMapping + applyShadertoyUniforms sugar", () => {
  it("translates ISF inputs into uniforms + controls + channels", () => {
    const mapping = buildIsfMapping({
      fragment: "void main(){ fragColor = vec4(brightness); }",
      inputs: [
        { NAME: "brightness", TYPE: "float", DEFAULT: 0.5 },
        { NAME: "tint", TYPE: "color", DEFAULT: [1, 0, 0, 1] },
        { NAME: "src", TYPE: "image" },
      ],
    });
    expect(mapping.uniforms.find((u) => u.name === "brightness")?.kind).toBe("float");
    expect(mapping.uniforms.find((u) => u.name === "tint")?.kind).toBe("color");
    expect(mapping.channels[0]?.index).toBe(0);
    expect(mapping.controls.some((c) => c.name === "Brightness")).toBe(true);
    expect(mapping.provenance.dialect).toBe("isf");
    // color INPUTs must be expression-bound to the RGB control's r/g/b sub-pars
    // so changing the swatch at runtime drives the shader (not just build-time).
    const tint = mapping.uniforms.find((u) => u.name === "tint");
    expect(Array.isArray(tint?.expr)).toBe(true);
    expect((tint?.expr as string[])[0]).toMatch(/parent\(\)\.par\.Tintr\.eval\(\)/);
    expect((tint?.expr as string[])[1]).toMatch(/parent\(\)\.par\.Tintg\.eval\(\)/);
    expect((tint?.expr as string[])[2]).toMatch(/parent\(\)\.par\.Tintb\.eval\(\)/);
  });

  it("sanitizes camelCase ISF input names so uniform exprs match TD's par naming", () => {
    const mapping = buildIsfMapping({
      fragment: "void main(){}",
      inputs: [{ NAME: "inputGain", TYPE: "float", DEFAULT: 0.5 }],
    });
    // create_control_panel lowercases everything after the first letter:
    // "inputGain" -> "Inputgain" (NOT "InputGain"). The uniform expr must match.
    expect(mapping.controls.some((c) => c.name === "Inputgain")).toBe(true);
    const u = mapping.uniforms.find((x) => x.name === "inputGain");
    expect(u?.expr).toBe("parent().par.Inputgain.eval()");
  });

  it("applyShadertoyUniforms produces translated fragment + Speed control + warnings empty for happy path", () => {
    const mapping = applyShadertoyUniforms({
      fragment: "void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(1.0); }",
    });
    expect(mapping.fragment).toMatch(/TDOutputSwizzle/);
    expect(mapping.controls.find((c) => c.name === "Speed")).toBeDefined();
    expect(mapping.uniforms.find((u) => u.name === "iTime")).toBeDefined();
    expect(mapping.provenance.dialect).toBe("shadertoy");
    expect(mapping.warnings).toEqual([]);
  });
});

describe("glslTopMappingSchema", () => {
  it("parses a known-good mapping", () => {
    const mapping = applyShadertoyUniforms({
      fragment: "void mainImage(out vec4 c, in vec2 f){ c = vec4(0.0); }",
    });
    expect(() => glslTopMappingSchema.parse(mapping)).not.toThrow();
  });

  it("rejects a bad uniform kind", () => {
    const bad = {
      fragment: "x",
      uniforms: [{ name: "u", kind: "matrix", value: 0 }],
      channels: [],
      controls: [],
      provenance: { dialect: "raw" },
      warnings: [],
    };
    expect(() => glslTopMappingSchema.parse(bad)).toThrow();
  });
});

describe("applyGlslTopMappingImpl", () => {
  it("errors when fragment is empty", async () => {
    const result = await applyGlslTopMappingImpl(ctx(), {
      mapping: {
        fragment: "",
        uniforms: [],
        channels: [],
        controls: [],
        provenance: { dialect: "raw" },
        warnings: [],
      },
      parent_path: "/project1",
      name: "glsl_mapping",
      resolution: [1280, 720],
      pixel_format: "rgba8",
      expose_controls: true,
      capture_preview: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/empty/i);
  });

  it("creates GLSL TOP + textDAT + nullTOP + a noiseTOP per used iChannel and runs the pixeldat + seq.vec scripts", async () => {
    const createdTypes: string[] = [];
    const execScripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as {
          parent_path: string;
          type: string;
          name?: string;
        };
        createdTypes.push(body.type);
        const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${name}`, type: body.type, name },
        });
      }),
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        execScripts.push(body.script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const mapping = applyShadertoyUniforms({
      fragment:
        "void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = texture(iChannel0, fragCoord/iResolution.xy); }",
    });

    const result = await applyGlslTopMappingImpl(ctx(), {
      mapping,
      parent_path: "/project1",
      name: "glsl_mapping",
      resolution: [640, 360],
      pixel_format: "rgba8",
      expose_controls: true,
      capture_preview: false,
    });

    expect(result.isError).toBeFalsy();
    expect(createdTypes).toContain("baseCOMP");
    expect(createdTypes).toContain("glslTOP");
    expect(createdTypes).toContain("textDAT");
    expect(createdTypes).toContain("nullTOP");
    expect(createdTypes).toContain("noiseTOP"); // default placeholder for iChannel0
    const joined = execScripts.join("\n");
    expect(joined).toMatch(/pixeldat/);
    expect(joined).toMatch(/seq\.vec/);

    const text = textOf(result);
    expect(text).toMatch(/glsl_mapping/);
    expect(text).toMatch(/shadertoy/);
  });
});
