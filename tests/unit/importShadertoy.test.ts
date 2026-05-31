import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  importShadertoyImpl,
  importShadertoySchema,
} from "../../src/tools/layer1/importShadertoy.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  delete process.env.TDMCP_OFFLINE;
  delete process.env.TDMCP_SHADERTOY_KEY;
});
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

interface Recording {
  createdTypes: string[];
  execScripts: string[];
  shadertoyHits: string[];
}

function recordingHandlers(rec: Recording, extra?: ReturnType<typeof http.get>[]) {
  return [
    // Extras (test-specific) come first so they take precedence over the catch-all.
    ...(extra ?? []),
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as { parent_path: string; type: string; name?: string };
      rec.createdTypes.push(body.type);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      rec.execScripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
    // Default: any unexpected Shadertoy hit = failure (tests opt-in via `extra`).
    http.get("https://www.shadertoy.com/api/v1/shaders/:id", ({ request }) => {
      rec.shadertoyHits.push(request.url);
      return HttpResponse.json({ error: "no handler" }, { status: 500 });
    }),
  ];
}

const RAW_SHADER =
  "void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(1.0); }";

describe("importShadertoySchema XOR refine", () => {
  it("rejects both shader_id and url present", () => {
    const result = importShadertoySchema.safeParse({
      shader_id: "XsXXDn",
      url: "https://www.shadertoy.com/view/XsXXDn",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when none of shader_id / url / raw_source are present", () => {
    const result = importShadertoySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts a single raw_source", () => {
    const result = importShadertoySchema.safeParse({ raw_source: RAW_SHADER });
    expect(result.success).toBe(true);
  });
});

describe("importShadertoyImpl — raw_source happy path", () => {
  it("builds GLSL TOP without fetching Shadertoy", async () => {
    const rec: Recording = { createdTypes: [], execScripts: [], shadertoyHits: [] };
    server.use(...recordingHandlers(rec));

    const result = await importShadertoyImpl(ctx(), {
      shader_id: undefined,
      url: undefined,
      raw_source: RAW_SHADER,
      parent_path: "/project1",
      name: "shadertoy",
      resolution: [640, 360],
      pixel_format: "rgba8",
      channels: [],
      expose_mouse_control: false,
      expose_speed_control: true,
      capture_preview: false,
      provenance_override: undefined,
    });

    expect(result.isError).toBeFalsy();
    expect(rec.shadertoyHits).toEqual([]);
    expect(rec.createdTypes).toContain("baseCOMP");
    expect(rec.createdTypes).toContain("glslTOP");
    expect(rec.createdTypes).toContain("textDAT");
    expect(rec.createdTypes).toContain("nullTOP");

    const text = textOf(result);
    expect(text).toMatch(/"dialect": "shadertoy"/);
    expect(text).not.toMatch(/"sourceUrl"/); // raw source has no URL provenance by default
    // Speed control is emitted via the panel-builder Python script.
    expect(rec.execScripts.join("\n")).toMatch(/Speed/);
  });

  it("merges provenance_override on top", async () => {
    const rec: Recording = { createdTypes: [], execScripts: [], shadertoyHits: [] };
    server.use(...recordingHandlers(rec));

    const result = await importShadertoyImpl(ctx(), {
      shader_id: undefined,
      url: undefined,
      raw_source: RAW_SHADER,
      parent_path: "/project1",
      name: "shadertoy",
      resolution: [640, 360],
      pixel_format: "rgba8",
      channels: [],
      expose_mouse_control: false,
      expose_speed_control: true,
      capture_preview: false,
      provenance_override: { title: "My Edit", author: "me" },
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toMatch(/"sourceTitle": "My Edit"/);
    expect(text).toMatch(/"sourceAuthor": "me"/);
  });
});

describe("importShadertoyImpl — URL extraction + API fetch", () => {
  it("extracts shader_id from URL and fetches via the Shadertoy API", async () => {
    const rec: Recording = { createdTypes: [], execScripts: [], shadertoyHits: [] };
    server.use(
      ...recordingHandlers(rec, [
        http.get("https://www.shadertoy.com/api/v1/shaders/:id", ({ params }) => {
          rec.shadertoyHits.push(String(params.id));
          return HttpResponse.json({
            Shader: {
              info: { name: "My Shader", username: "artist1" },
              renderpass: [{ code: RAW_SHADER, type: "image", name: "Image" }],
            },
          });
        }),
      ]),
    );

    const result = await importShadertoyImpl(ctx(), {
      shader_id: undefined,
      url: "https://www.shadertoy.com/view/XsXXDn",
      raw_source: undefined,
      parent_path: "/project1",
      name: "shadertoy",
      resolution: [640, 360],
      pixel_format: "rgba8",
      channels: [],
      expose_mouse_control: false,
      expose_speed_control: true,
      capture_preview: false,
      provenance_override: undefined,
    });

    expect(result.isError).toBeFalsy();
    expect(rec.shadertoyHits).toEqual(["XsXXDn"]);
    const text = textOf(result);
    expect(text).toMatch(/"sourceTitle": "My Shader"/);
    expect(text).toMatch(/"sourceAuthor": "artist1"/);
    expect(text).toMatch(/shadertoy.com\/view\/XsXXDn/);
  });

  it("returns a friendly error for a non-Shadertoy URL", async () => {
    const rec: Recording = { createdTypes: [], execScripts: [], shadertoyHits: [] };
    server.use(...recordingHandlers(rec));

    const result = await importShadertoyImpl(ctx(), {
      shader_id: undefined,
      url: "https://example.com/foo",
      raw_source: undefined,
      parent_path: "/project1",
      name: "shadertoy",
      resolution: [640, 360],
      pixel_format: "rgba8",
      channels: [],
      expose_mouse_control: false,
      expose_speed_control: true,
      capture_preview: false,
      provenance_override: undefined,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Could not extract a Shadertoy ID/);
    expect(rec.createdTypes).toEqual([]);
    expect(rec.shadertoyHits).toEqual([]);
  });

  it("returns a friendly error when the API responds with non-JSON (403 HTML)", async () => {
    const rec: Recording = { createdTypes: [], execScripts: [], shadertoyHits: [] };
    server.use(
      ...recordingHandlers(rec, [
        http.get("https://www.shadertoy.com/api/v1/shaders/:id", () =>
          HttpResponse.text("<html>403 Forbidden</html>", {
            status: 403,
            headers: { "content-type": "text/html" },
          }),
        ),
      ]),
    );

    const result = await importShadertoyImpl(ctx(), {
      shader_id: "XsXXDn",
      url: undefined,
      raw_source: undefined,
      parent_path: "/project1",
      name: "shadertoy",
      resolution: [640, 360],
      pixel_format: "rgba8",
      channels: [],
      expose_mouse_control: false,
      expose_speed_control: true,
      capture_preview: false,
      provenance_override: undefined,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/raw_source/);
    expect(rec.createdTypes).toEqual([]);
  });
});

describe("importShadertoyImpl — TDMCP_OFFLINE", () => {
  beforeEach(() => {
    process.env.TDMCP_OFFLINE = "1";
  });

  it("blocks shader_id fetches when TDMCP_OFFLINE=1", async () => {
    const rec: Recording = { createdTypes: [], execScripts: [], shadertoyHits: [] };
    server.use(...recordingHandlers(rec));

    const result = await importShadertoyImpl(ctx(), {
      shader_id: "XsXXDn",
      url: undefined,
      raw_source: undefined,
      parent_path: "/project1",
      name: "shadertoy",
      resolution: [640, 360],
      pixel_format: "rgba8",
      channels: [],
      expose_mouse_control: false,
      expose_speed_control: true,
      capture_preview: false,
      provenance_override: undefined,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/TDMCP_OFFLINE/);
    expect(textOf(result)).toMatch(/raw_source/);
    expect(rec.shadertoyHits).toEqual([]);
    expect(rec.createdTypes).toEqual([]);
  });

  it("still allows raw_source while offline", async () => {
    const rec: Recording = { createdTypes: [], execScripts: [], shadertoyHits: [] };
    server.use(...recordingHandlers(rec));

    const result = await importShadertoyImpl(ctx(), {
      shader_id: undefined,
      url: undefined,
      raw_source: RAW_SHADER,
      parent_path: "/project1",
      name: "shadertoy",
      resolution: [640, 360],
      pixel_format: "rgba8",
      channels: [],
      expose_mouse_control: false,
      expose_speed_control: true,
      capture_preview: false,
      provenance_override: undefined,
    });

    expect(result.isError).toBeFalsy();
    expect(rec.shadertoyHits).toEqual([]);
  });
});

describe("importShadertoyImpl — multi-pass warning", () => {
  it("uses renderpass[0] and warns about dropped passes", async () => {
    const rec: Recording = { createdTypes: [], execScripts: [], shadertoyHits: [] };
    server.use(
      ...recordingHandlers(rec, [
        http.get("https://www.shadertoy.com/api/v1/shaders/:id", () =>
          HttpResponse.json({
            Shader: {
              info: { name: "Multi", username: "x" },
              renderpass: [
                { code: RAW_SHADER, type: "image", name: "Image" },
                { code: "void main(){}", type: "buffer", name: "Buf A" },
                { code: "void main(){}", type: "buffer", name: "Buf B" },
                { code: "void main(){}", type: "buffer", name: "Buf C" },
              ],
            },
          }),
        ),
      ]),
    );

    const result = await importShadertoyImpl(ctx(), {
      shader_id: "XlfGRj",
      url: undefined,
      raw_source: undefined,
      parent_path: "/project1",
      name: "shadertoy",
      resolution: [640, 360],
      pixel_format: "rgba8",
      channels: [],
      expose_mouse_control: false,
      expose_speed_control: true,
      capture_preview: false,
      provenance_override: undefined,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toMatch(/multi-pass shader: dropped 3 additional passes/);
  });
});

describe("importShadertoyImpl — channel override", () => {
  it("does not create a noiseTOP placeholder when index 0 is overridden to a TD path", async () => {
    const rec: Recording = { createdTypes: [], execScripts: [], shadertoyHits: [] };
    server.use(...recordingHandlers(rec));

    const result = await importShadertoyImpl(ctx(), {
      shader_id: undefined,
      url: undefined,
      raw_source:
        "void mainImage(out vec4 fragColor, in vec2 fragCoord){ fragColor = texture(iChannel0, fragCoord/iResolution.xy); }",
      parent_path: "/project1",
      name: "shadertoy",
      resolution: [640, 360],
      pixel_format: "rgba8",
      channels: [{ index: 0, source: "/project1/cam1" }],
      expose_mouse_control: false,
      expose_speed_control: true,
      capture_preview: false,
      provenance_override: undefined,
    });

    expect(result.isError).toBeFalsy();
    // The placeholder for iChannel0 should NOT have been created.
    expect(rec.createdTypes).not.toContain("noiseTOP");
  });
});
