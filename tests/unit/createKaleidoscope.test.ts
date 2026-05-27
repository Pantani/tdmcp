import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createKaleidoscopeImpl } from "../../src/tools/layer1/createKaleidoscope.js";
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// Records every POST /api/nodes body so a test can assert which ops/params were created.
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

// Records every POST /api/exec script so a test can assert which Python steps ran.
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

describe("create_kaleidoscope", () => {
  it("builds a self-contained kaleidoscope (no input) inside a container", async () => {
    const result = await createKaleidoscopeImpl(makeCtx(), {
      segments: 6,
      rotation: 0,
      zoom: 1,
      center_x: 0.5,
      center_y: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/kaleidoscope");
    expect(text).toContain("/project1/kaleidoscope/out1");
    expect(text).toContain("6-fold kaleidoscope");
  });

  it("generates a noise source when no input_path is given", async () => {
    const bodies = captureCreateBodies();
    await createKaleidoscopeImpl(makeCtx(), {
      segments: 8,
      rotation: 0,
      zoom: 1,
      center_x: 0.5,
      center_y: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    const source = bodies.find((b) => b.name === "source");
    expect(source?.type).toBe("noiseTOP");
    // The fold is a GLSL TOP on a fixed RGBA canvas, and the output is a Null TOP.
    expect(bodies.some((b) => b.name === "kaleido" && b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
  });

  it("brings in an existing source via a Select TOP referencing the absolute path", async () => {
    const bodies = captureCreateBodies();
    await createKaleidoscopeImpl(makeCtx(), {
      segments: 6,
      rotation: 0,
      zoom: 1,
      center_x: 0.5,
      center_y: 0.5,
      input_path: "/scene/render1",
      expose_controls: false,
      parent_path: "/project1",
    });
    const source = bodies.find((b) => b.name === "source");
    // Cross-container wiring silently no-ops, so the source is pulled in by path on a Select TOP.
    expect(source?.type).toBe("selectTOP");
    expect(source?.parameters).toMatchObject({ top: "/scene/render1" });
  });

  it("binds the four fold uniforms (segments/rotation/zoom/center) on the GLSL TOP", async () => {
    const scripts = captureExecScripts();
    await createKaleidoscopeImpl(makeCtx(), {
      segments: 6,
      rotation: 0,
      zoom: 1,
      center_x: 0.5,
      center_y: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    const uniformScript = scripts.find((s) => s.includes("seq.vec.numBlocks"));
    expect(uniformScript).toBeDefined();
    for (const name of ["uSegments", "uRotation", "uZoom", "uCenter"]) {
      expect(uniformScript).toContain(name);
    }
    // The vec2 centre uniform drives both components.
    expect(uniformScript).toContain("vec3valuex");
    expect(uniformScript).toContain("vec3valuey");
    // Uniforms read the container's custom parameters so the exposed knobs drive them live.
    expect(uniformScript).toContain("parent().par.Segments");
  });

  it("exposes Segments/Rotation/Zoom/Center controls when expose_controls is on", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await createKaleidoscopeImpl(makeCtx(), {
      segments: 6,
      rotation: 0,
      zoom: 1,
      center_x: 0.5,
      center_y: 0.5,
      expose_controls: true,
      parent_path: "/project1",
    });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["Segments", "Rotation", "Zoom", "Center X", "Center Y"]),
    );
  });

  it("returns an inline preview image (output is a TOP)", async () => {
    const result = await createKaleidoscopeImpl(makeCtx(), {
      segments: 6,
      rotation: 0,
      zoom: 1,
      center_x: 0.5,
      center_y: 0.5,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });
});
