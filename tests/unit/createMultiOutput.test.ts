import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createMultiOutputImpl } from "../../src/tools/layer1/createMultiOutput.js";
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

describe("create_multi_output", () => {
  it("fans a master into N abutting horizontal tiles (no overlap → no blend)", async () => {
    const bodies = captureCreateBodies();
    const result = await createMultiOutputImpl(makeCtx(), {
      source_path: "/project1/master",
      count: 2,
      layout: "horizontal",
      overlap: 0,
      resolution: "1080p",
      as_windows: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // Master pulled in once through a Select TOP.
    const src = bodies.find((b) => b.name === "src");
    expect(src?.type).toBe("selectTOP");
    expect(src?.parameters).toMatchObject({ top: "/project1/master" });

    // Two crop tiles split the [0,1] range in half on the horizontal axis.
    const tile1 = bodies.find((b) => b.name === "tile1");
    expect(tile1?.type).toBe("cropTOP");
    expect(tile1?.parameters).toMatchObject({
      cropleft: 0,
      cropright: 0.5,
      cropbottom: 0,
      croptop: 1,
      cropleftunit: "fraction",
      resolutionw: 1920,
      resolutionh: 1080,
    });
    const tile2 = bodies.find((b) => b.name === "tile2");
    expect(tile2?.parameters).toMatchObject({ cropleft: 0.5, cropright: 1 });

    // No edge-blend nodes when overlap is 0.
    expect(bodies.some((b) => b.type === "glslTOP")).toBe(false);
    expect(bodies.filter((b) => b.type === "nullTOP").map((b) => b.name)).toEqual(["out1", "out2"]);

    const text = textOf(result);
    expect(text).toContain('"blended": false');
    expect(text).not.toContain("edge-blend");
  });

  it("slices vertically when layout=vertical (top/bottom crops, full width)", async () => {
    const bodies = captureCreateBodies();
    await createMultiOutputImpl(makeCtx(), {
      source_path: "/project1/master",
      count: 2,
      layout: "vertical",
      overlap: 0,
      resolution: "1080p",
      as_windows: false,
      parent_path: "/project1",
    });
    const tile1 = bodies.find((b) => b.name === "tile1");
    // Vertical: full width (left 0, right 1), split on the bottom/top axis.
    expect(tile1?.parameters).toMatchObject({
      cropleft: 0,
      cropright: 1,
      cropbottom: 0,
      croptop: 0.5,
    });
    const tile2 = bodies.find((b) => b.name === "tile2");
    expect(tile2?.parameters).toMatchObject({ cropbottom: 0.5, croptop: 1 });
  });

  it("widens tiles into neighbours and adds a GLSL feather per shared seam when overlap > 0", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await createMultiOutputImpl(makeCtx(), {
      source_path: "/project1/master",
      count: 2,
      layout: "horizontal",
      overlap: 0.2,
      resolution: "1080p",
      as_windows: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    // overlap 0.2 of a half-tile = 0.1 of source: tile1 widens right edge to 0.6, tile2 left to 0.4.
    const tile1 = bodies.find((b) => b.name === "tile1");
    expect(tile1?.parameters?.cropright).toBeCloseTo(0.6);
    const tile2 = bodies.find((b) => b.name === "tile2");
    expect(tile2?.parameters?.cropleft).toBeCloseTo(0.4);

    // Each interior seam gets a Text DAT + GLSL TOP feather.
    expect(bodies.some((b) => b.name === "blend1" && b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "blend2" && b.type === "glslTOP")).toBe(true);

    // The feather shader is a linear clamp on the seam axis, wired in via pixeldat.
    const shaderStep = scripts.find((s) => s.includes("fragColor") && s.includes("pixeldat"));
    expect(shaderStep).toBeDefined();
    expect(shaderStep).toContain("clamp");
    expect(shaderStep).toContain("vUV.s");

    const text = textOf(result);
    expect(text).toContain('"blended": true');
    expect(text).toContain("edge-blend (overlap 0.2)");
  });

  it("creates a borderless, closed Window COMP per tile when as_windows is set", async () => {
    const bodies = captureCreateBodies();
    await createMultiOutputImpl(makeCtx(), {
      source_path: "/project1/master",
      count: 2,
      layout: "horizontal",
      overlap: 0,
      resolution: "1080p",
      as_windows: true,
      parent_path: "/project1",
    });
    const win1 = bodies.find((b) => b.name === "win1");
    expect(win1?.type).toBe("windowCOMP");
    expect(win1?.parameters).toMatchObject({ borders: 0, winopen: 0, winoffsetx: 0 });
    const win2 = bodies.find((b) => b.name === "win2");
    // Second window offset by one projector width across the desktop.
    expect(win2?.parameters).toMatchObject({ winoffsetx: 1920, winoffsety: 0 });
  });
});
