import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createDomeOutputImpl } from "../../src/tools/layer1/createDomeOutput.js";
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

describe("create_dome_output", () => {
  it("remaps a source TOP to a fisheye dome master via Select → GLSL (Text DAT) → Null", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createDomeOutputImpl(makeCtx(), {
      source_path: "/project1/pano1",
      projection: "fisheye",
      resolution: "2048",
      fov: 180,
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // The master is pulled in through a Select TOP referencing source_path.
    const src = bodies.find((b) => b.name === "src");
    expect(src?.type).toBe("selectTOP");
    expect(src?.parameters).toMatchObject({ top: "/project1/pano1" });

    // A GLSL TOP (square dome master) + the Text DAT holding its shader.
    const remap = bodies.find((b) => b.name === "remap");
    expect(remap?.type).toBe("glslTOP");
    expect(remap?.parameters).toMatchObject({
      outputresolution: "custom",
      resolutionw: 2048,
      resolutionh: 2048,
    });
    expect(bodies.some((b) => b.name === "remap_frag" && b.type === "textDAT")).toBe(true);

    // Ends on a Null.
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);

    // An exec script writes the shader and points the GLSL TOP's pixeldat at the Text DAT.
    expect(scripts.some((s) => s.includes("pixeldat") && s.includes("op("))).toBe(true);
    // The fisheye shader follows the TD GLSL TOP conventions.
    const shaderScript = scripts.find((s) => s.includes("TDOutputSwizzle"));
    expect(shaderScript).toBeDefined();
    expect(shaderScript).toContain("out vec4 fragColor;");
    expect(shaderScript).toContain("sTD2DInputs[0]");

    // A preview image is captured.
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("uses a near-passthrough identity remap for an equirectangular source", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createDomeOutputImpl(makeCtx(), {
      source_path: "/project1/latlong1",
      projection: "equirectangular",
      resolution: "1024",
      fov: 180,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    const src = bodies.find((b) => b.name === "src");
    expect(src?.type).toBe("selectTOP");
    expect(src?.parameters).toMatchObject({ top: "/project1/latlong1" });

    const remap = bodies.find((b) => b.name === "remap");
    expect(remap?.type).toBe("glslTOP");
    expect(remap?.parameters).toMatchObject({ resolutionw: 1024, resolutionh: 1024 });
    expect(bodies.some((b) => b.name === "remap_frag" && b.type === "textDAT")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);

    const shaderScript = scripts.find((s) => s.includes("TDOutputSwizzle"));
    expect(shaderScript).toBeDefined();
    expect(shaderScript).toContain("out vec4 fragColor;");
    expect(shaderScript).toContain("sTD2DInputs[0]");
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });
});
