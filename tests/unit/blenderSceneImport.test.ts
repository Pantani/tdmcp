import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  blenderSceneImportImpl,
  blenderSceneImportSchema,
} from "../../src/tools/layer1/blenderSceneImport.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { captureCreateBodies, makeCtx, textOf } from "../helpers/tdToolTestUtils.js";

interface PatchedNodeBody {
  path: string;
  parameters: Record<string, unknown>;
}

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function capturePatchBodies(): PatchedNodeBody[] {
  const bodies: PatchedNodeBody[] = [];
  server.use(
    http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ params, request }) => {
      const body = (await request.json()) as { parameters: Record<string, unknown> };
      const path = `/${String(params.seg).replaceAll(":", "/")}`;
      bodies.push({ path, parameters: body.parameters });
      return HttpResponse.json({
        ok: true,
        data: { path, type: "baseCOMP", name: path.split("/").at(-1), parameters: body.parameters },
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

describe("blender_scene_import", () => {
  it("schema defaults create a named Blender scene container", () => {
    const parsed = blenderSceneImportSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("blender_scene");
    expect(parsed.material_mode).toBe("pbr");
    expect(parsed.expose_controls).toBe(true);
  });

  it("creates a File In SOP, PBR material, lights, camera, render, and output", async () => {
    const bodies = captureCreateBodies(server);
    const patches = capturePatchBodies();
    const result = await blenderSceneImportImpl(makeCtx(), {
      scene_path: "/assets/stage.glb",
      parent_path: "/project1",
      name: "blender_scene",
      import_scale: 1.5,
      rotate_y: 35,
      camera_distance: 7,
      material_mode: "pbr",
      base_color: [0.7, 0.8, 0.9],
      metallic: 0.25,
      roughness: 0.4,
      expose_controls: false,
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("/project1/blender_scene/out1");
    expect(result.content.some((c) => c.type === "image")).toBe(true);

    const fileIn = bodies.find((b) => b.type === "fileinSOP");
    expect(fileIn?.parameters?.file).toBe("/assets/stage.glb");
    const geoPatch = patches.find((body) => body.path.endsWith("/geo"));
    expect(geoPatch?.parameters).toMatchObject({ scale: 1.5, ry: 35 });
    expect(geoPatch?.parameters).not.toHaveProperty("sx");
    expect(geoPatch?.parameters).not.toHaveProperty("sy");
    expect(geoPatch?.parameters).not.toHaveProperty("sz");
    for (const type of [
      "geometryCOMP",
      "pbrMAT",
      "constantTOP",
      "environmentlightCOMP",
      "lightCOMP",
      "cameraCOMP",
      "renderTOP",
      "nullTOP",
    ]) {
      expect(bodies.some((b) => b.type === type)).toBe(true);
    }
  });

  it("falls back to a primitive when scene_path is omitted", async () => {
    const bodies = captureCreateBodies(server);
    const result = await blenderSceneImportImpl(makeCtx(), {
      parent_path: "/project1",
      name: "fallback_scene",
      import_scale: 1,
      rotate_y: 0,
      camera_distance: 6,
      material_mode: "clay",
      base_color: [0.7, 0.7, 0.7],
      metallic: 0.2,
      roughness: 0.5,
      expose_controls: false,
    });

    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "fileinSOP")).toBe(false);
    expect(bodies.some((b) => b.type === "boxSOP")).toBe(true);
    expect(textOf(result)).toContain("fallback primitive");
  });

  it("warns when a .blend path may require exporting from Blender first", async () => {
    const result = await blenderSceneImportImpl(makeCtx(), {
      scene_path: "/assets/show.blend",
      parent_path: "/project1",
      name: "blend_scene",
      import_scale: 1,
      rotate_y: 0,
      camera_distance: 6,
      material_mode: "pbr",
      base_color: [0.8, 0.8, 0.8],
      metallic: 0.1,
      roughness: 0.5,
      expose_controls: false,
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("export glTF, FBX, OBJ, or USD");
  });

  it("exposes live import controls when requested", async () => {
    const scripts = captureExecScripts();
    await blenderSceneImportImpl(makeCtx(), {
      scene_path: "/assets/stage.fbx",
      parent_path: "/project1",
      name: "controlled_scene",
      import_scale: 2,
      rotate_y: 20,
      camera_distance: 8,
      material_mode: "pbr",
      base_color: [0.6, 0.7, 0.8],
      metallic: 0.35,
      roughness: 0.55,
      expose_controls: true,
    });

    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; bind_to?: string[] }>;
    };
    expect(payload.controls.map((c) => c.name)).toEqual(
      expect.arrayContaining(["RotateY", "CameraDistance", "Scale", "Metallic", "Roughness"]),
    );
    expect(payload.controls.find((c) => c.name === "CameraDistance")?.bind_to?.[0]).toMatch(
      /cam\.tz$/,
    );
  });
});
