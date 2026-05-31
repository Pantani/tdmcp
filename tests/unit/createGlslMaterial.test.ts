import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createGlslMaterialImpl } from "../../src/tools/layer2/createGlslMaterial.js";
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Captures every `/api/exec` script so tests can assert payload contents. */
function captureScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      scripts.push(((await request.json()) as { script: string }).script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

/** Captures every `/api/nodes` creation so tests can assert on what got built. */
function captureNodes(): Array<{ parent_path: string; type: string; name?: string }> {
  const created: Array<{ parent_path: string; type: string; name?: string }> = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as {
        parent_path: string;
        type: string;
        name?: string;
      };
      created.push(body);
      return HttpResponse.json({
        ok: true,
        data: {
          path: `${body.parent_path}/${body.name}`,
          type: body.type,
          name: body.name,
        },
      });
    }),
  );
  return created;
}

const GOOD_PIXEL = "out vec4 fragColor; void main(){ fragColor = vec4(1.0); }";

describe("create_glsl_material", () => {
  it("creates exactly one glslMAT + one textDAT (pixel) at minimum", async () => {
    const nodes = captureNodes();
    captureScripts();
    const result = await createGlslMaterialImpl(makeCtx(), {
      parent_path: "/project1",
      name: "mat1",
      pixel_shader: GOOD_PIXEL,
      glsl_version: "330",
      two_sided: false,
      lighting_space: "world",
    });
    expect(result.isError).not.toBe(true);
    expect(nodes.filter((n) => n.type === "glslMAT")).toHaveLength(1);
    expect(nodes.filter((n) => n.type === "textDAT")).toHaveLength(1);
    const text = textOf(result);
    expect(text).toContain("/project1/mat1");
    expect(text).toContain("mat1_pix");
  });

  it("creates vertex DAT and references vertexdat when vertex_shader is set", async () => {
    const nodes = captureNodes();
    const scripts = captureScripts();
    await createGlslMaterialImpl(makeCtx(), {
      parent_path: "/project1",
      name: "mat1",
      pixel_shader: GOOD_PIXEL,
      vertex_shader: "void main(){ gl_Position = vec4(0.0); }",
      glsl_version: "330",
      two_sided: false,
      lighting_space: "world",
    });
    expect(nodes.filter((n) => n.type === "textDAT")).toHaveLength(2);
    expect(scripts.join("\n")).toContain("vertexdat");
    expect(scripts.join("\n")).toContain("mat1_vert");
  });

  it("creates geometry DAT and references geometrydat when geometry_shader is set", async () => {
    const nodes = captureNodes();
    const scripts = captureScripts();
    await createGlslMaterialImpl(makeCtx(), {
      parent_path: "/project1",
      name: "mat1",
      pixel_shader: GOOD_PIXEL,
      geometry_shader: "void main(){}",
      glsl_version: "330",
      two_sided: false,
      lighting_space: "world",
    });
    expect(nodes.filter((n) => n.type === "textDAT")).toHaveLength(2);
    expect(scripts.join("\n")).toContain("geometrydat");
    expect(scripts.join("\n")).toContain("mat1_geo");
  });

  it("payload references glsl_version, two_sided, and lighting_space", async () => {
    const scripts = captureScripts();
    await createGlslMaterialImpl(makeCtx(), {
      parent_path: "/project1",
      name: "mat1",
      pixel_shader: GOOD_PIXEL,
      glsl_version: "450",
      two_sided: true,
      lighting_space: "camera",
    });
    const joined = scripts.join("\n");
    expect(joined).toContain("glslversion");
    expect(joined).toContain('"450"');
    expect(joined).toContain("twoside");
    expect(joined).toContain("True");
    expect(joined).toContain("lightingspace");
    expect(joined).toContain('"camera"');
  });

  it("numeric uniform produces a seq.vec block with all components", async () => {
    const scripts = captureScripts();
    await createGlslMaterialImpl(makeCtx(), {
      parent_path: "/project1",
      name: "mat1",
      pixel_shader: GOOD_PIXEL,
      uniforms: [{ name: "uTint", type: "vec4", default_value: "1,0,0,1" }],
      glsl_version: "330",
      two_sided: false,
      lighting_space: "world",
    });
    const bind = scripts.find((s) => s.includes("seq.vec.numBlocks"));
    expect(bind).toBeDefined();
    expect(bind).toContain("vec%dname");
    expect(bind).toContain("vec%dvalue%s");
    expect(bind).toContain('"name":"uTint"');
    // All four components present in the embedded spec list.
    expect(bind).toMatch(/\[\s*1\s*,\s*0\s*,\s*0\s*,\s*1\s*\]/);
  });

  it("sampler uniform with top_path produces a seq.samp block referencing the TOP path", async () => {
    const scripts = captureScripts();
    await createGlslMaterialImpl(makeCtx(), {
      parent_path: "/project1",
      name: "mat1",
      pixel_shader: GOOD_PIXEL,
      uniforms: [{ name: "uTex", type: "sampler2D", top_path: "/project1/movie1" }],
      glsl_version: "330",
      two_sided: false,
      lighting_space: "world",
    });
    const bind = scripts.find((s) => s.includes("seq.samp.numBlocks"));
    expect(bind).toBeDefined();
    expect(bind).toContain("samp%dname");
    expect(bind).toContain("samp%dtop");
    expect(bind).toContain('"name":"uTex"');
    expect(bind).toContain("/project1/movie1");
  });

  it("warns when pixel shader is missing `out vec4 fragColor`", async () => {
    captureScripts();
    const result = await createGlslMaterialImpl(makeCtx(), {
      parent_path: "/project1",
      name: "mat1",
      pixel_shader: "void main(){}",
      glsl_version: "330",
      two_sided: false,
      lighting_space: "world",
    });
    const text = textOf(result);
    expect(text).toContain("fragColor");
  });

  it("returns the documented shape (glslMat, pixelDat, optional vertex/geometry, warnings)", async () => {
    captureScripts();
    const result = await createGlslMaterialImpl(makeCtx(), {
      parent_path: "/project1",
      name: "mat1",
      pixel_shader: GOOD_PIXEL,
      vertex_shader: "void main(){ gl_Position = vec4(0.0); }",
      glsl_version: "330",
      two_sided: false,
      lighting_space: "world",
    });
    const text = textOf(result);
    const json = /```json\n([\s\S]+?)\n```/.exec(text)?.[1];
    expect(json).toBeDefined();
    const parsed = JSON.parse(json as string) as {
      glslMat: { path: string; name: string };
      pixelDat: string;
      vertexDat?: string;
      geometryDat?: string;
      warnings: string[];
    };
    expect(parsed).toMatchObject({
      glslMat: { path: "/project1/mat1", name: "mat1" },
      pixelDat: "/project1/mat1_pix",
      vertexDat: "/project1/mat1_vert",
    });
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });
});
