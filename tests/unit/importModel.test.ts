import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { importModelImpl } from "../../src/tools/layer1/importModel.js";
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

// Records every POST /api/nodes body so a test can assert which ops/params a build asked for.
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

describe("import_model", () => {
  it("builds a Geo/Camera/Light/Render scaffold ending in a Null TOP and previews it", async () => {
    const result = await importModelImpl(makeCtx(), {
      model_path: "/models/teapot.obj",
      rotate_y: 0,
      zoom: 5,
      scale: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/model");
    expect(text).toContain("/project1/model/out1");
    // The output is a TOP and a preview image is captured (capturePreviewImage defaults on).
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("creates a File In SOP pointing at model_path when one is given", async () => {
    const bodies = captureCreateBodies();
    await importModelImpl(makeCtx(), {
      model_path: "/models/teapot.obj",
      rotate_y: 0,
      zoom: 5,
      scale: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    const fileIn = bodies.find((b) => b.type === "fileinSOP");
    expect(fileIn).toBeDefined();
    expect(fileIn?.parameters?.file).toBe("/models/teapot.obj");
    // The renderable scaffold ops are all present.
    for (const type of ["geometryCOMP", "cameraCOMP", "lightCOMP", "renderTOP", "nullTOP"]) {
      expect(bodies.some((b) => b.type === type)).toBe(true);
    }
  });

  it("falls back to a primitive SOP (no File In SOP) when model_path is omitted", async () => {
    const bodies = captureCreateBodies();
    const result = await importModelImpl(makeCtx(), {
      rotate_y: 0,
      zoom: 5,
      scale: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "fileinSOP")).toBe(false);
    // A default primitive SOP is dropped in so the network still renders with no dependency.
    expect(bodies.some((b) => b.type === "sphereSOP")).toBe(true);
    expect(textOf(result)).toContain("no model_path");
  });

  it("strips the geometryCOMP's default torus before populating it", async () => {
    const scripts = captureExecScripts();
    await importModelImpl(makeCtx(), {
      model_path: "/models/teapot.obj",
      rotate_y: 0,
      zoom: 5,
      scale: 1,
      expose_controls: false,
      parent_path: "/project1",
    });
    // A fresh geometryCOMP ships with a default torus1 that would render over the model;
    // the builder must clear the COMP's children right after creating it.
    const cleared = scripts.some((s) => s.includes(".children") && s.includes(".destroy()"));
    expect(cleared).toBe(true);
  });

  it("exposes RotateY / Zoom / Scale knobs bound to the geo and camera when controls are on", async () => {
    const scripts = captureExecScripts();
    await importModelImpl(makeCtx(), {
      model_path: "/models/teapot.obj",
      rotate_y: 45,
      zoom: 8,
      scale: 2,
      expose_controls: true,
      parent_path: "/project1",
    });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; bind_to?: string[] }>;
    };
    const names = payload.controls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["RotateY", "Zoom", "Scale"]));
    const rotate = payload.controls.find((c) => c.name === "RotateY");
    expect(rotate?.bind_to?.[0]).toMatch(/geo\.ry$/);
    const zoom = payload.controls.find((c) => c.name === "Zoom");
    expect(zoom?.bind_to?.[0]).toMatch(/cam\.tz$/);
  });
});
