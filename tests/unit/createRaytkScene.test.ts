import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createRaytkSceneImpl,
  createRaytkSceneSchema,
  SDF_PRIMITIVES,
} from "../../src/tools/layer1/createRaytkScene.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

interface RaytkSceneReport {
  ok: boolean;
  library_loaded: boolean;
  created: Array<{ opType: string; name: string; path: string }>;
  render_path: string | null;
  scene_tail_path: string | null;
  unresolved: string[];
  warnings: string[];
  guidance: string | null;
}

interface OpSpec {
  optype: string;
  category: string;
  role: string;
  name: string;
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

/**
 * Installs an /api/exec handler that returns `report` (as a JSON line in stdout) for the
 * RayTK copy/wire pass — identified by the script containing `pathsByOpType`/`.copy(` — and an
 * empty stdout for every other exec call (control panel, error check). Captures all scripts.
 */
function mockExec(report: RaytkSceneReport): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      const isCopyWire = body.script.includes("pathsByOpType") || body.script.includes(".copy(");
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: isCopyWire ? JSON.stringify(report) : "" },
      });
    }),
  );
  return scripts;
}

/** Decodes the `ops[]` payload out of the copy/wire exec script's base64 blob. */
function copyWireOps(scripts: string[]): OpSpec[] {
  const script = scripts.find((s) => s.includes("pathsByOpType"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(script ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { ops: OpSpec[] };
  return payload.ops;
}

function loadedReport(overrides: Partial<RaytkSceneReport> = {}): RaytkSceneReport {
  return {
    ok: true,
    library_loaded: true,
    created: [
      { opType: "sphereSdf", name: "sphereSdf", path: "/project1/raytk_scene_sphereSdf/sphereSdf" },
      {
        opType: "raymarchRender3D",
        name: "render1",
        path: "/project1/raytk_scene_sphereSdf/render1",
      },
    ],
    render_path: "/project1/raytk_scene_sphereSdf/render1",
    scene_tail_path: "/project1/raytk_scene_sphereSdf/sphereSdf",
    unresolved: [],
    warnings: [],
    guidance: null,
    ...overrides,
  };
}

function resultText(result: Awaited<ReturnType<typeof createRaytkSceneImpl>>): string {
  const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return block?.text ?? "";
}

describe("create_raytk_scene", () => {
  describe("create bodies (RayTK ops are copied, never POSTed as native types)", () => {
    it("creates the baseCOMP container + native Null TOP, and no RayTK op node", async () => {
      const bodies = captureCreateBodies();
      mockExec(loadedReport());
      const result = await createRaytkSceneImpl(makeCtx(), createRaytkSceneSchema.parse({}));
      expect(result.isError).toBeFalsy();

      const container = bodies.find((b) => b.type === "baseCOMP");
      expect(container?.name).toBe("raytk_scene_sphereSdf");
      expect(bodies.some((b) => b.type === "nullTOP" && b.name === "out1")).toBe(true);

      // No RayTK op is ever created via /api/nodes — they are copied by the Python pass.
      expect(bodies.every((b) => !SDF_PRIMITIVES.includes(b.type as never))).toBe(true);
      expect(bodies.some((b) => b.type === "raymarchRender3D")).toBe(false);
      expect(bodies.some((b) => b.type === "simpleUnion")).toBe(false);
    });
  });

  describe("copy/wire payload reflects the enabled flags", () => {
    it("default → sphereSdf + raymarchRender3D only (no union/material/camera/light)", async () => {
      const scripts = mockExec(loadedReport());
      await createRaytkSceneImpl(makeCtx(), createRaytkSceneSchema.parse({}));
      const ops = copyWireOps(scripts);
      const optypes = ops.map((o) => o.optype);
      expect(optypes).toContain("sphereSdf");
      expect(optypes).toContain("raymarchRender3D");
      expect(optypes).not.toContain("simpleUnion");
      expect(optypes).not.toContain("basicMat");
      expect(optypes).not.toContain("lookAtCamera");
      expect(optypes).not.toContain("pointLight");
    });

    it("union_with inserts a simpleUnion of the two SDFs", async () => {
      const scripts = mockExec(loadedReport());
      await createRaytkSceneImpl(
        makeCtx(),
        createRaytkSceneSchema.parse({ sdf_primitive: "sphereSdf", union_with: "boxSdf" }),
      );
      const optypes = copyWireOps(scripts).map((o) => o.optype);
      expect(optypes).toContain("sphereSdf");
      expect(optypes).toContain("boxSdf");
      expect(optypes).toContain("simpleUnion");
    });

    it("material / add_camera / add_light add basicMat / lookAtCamera / pointLight", async () => {
      const scripts = mockExec(loadedReport());
      await createRaytkSceneImpl(
        makeCtx(),
        createRaytkSceneSchema.parse({ material: true, add_camera: true, add_light: true }),
      );
      const ops = copyWireOps(scripts);
      const optypes = ops.map((o) => o.optype);
      expect(optypes).toContain("basicMat");
      expect(optypes).toContain("lookAtCamera");
      expect(optypes).toContain("pointLight");
      // Each op carries its RayTK category so the resolver can folder-match.
      expect(ops.find((o) => o.optype === "basicMat")?.category).toBe("material");
      expect(ops.find((o) => o.optype === "lookAtCamera")?.category).toBe("camera");
      expect(ops.find((o) => o.optype === "pointLight")?.category).toBe("light");
      expect(ops.find((o) => o.optype === "raymarchRender3D")?.category).toBe("output");
    });

    it("the copy/wire template copies masters and wires typed connectors", async () => {
      const scripts = mockExec(loadedReport());
      await createRaytkSceneImpl(
        makeCtx(),
        createRaytkSceneSchema.parse({ add_camera: true, add_light: true }),
      );
      const script = scripts.find((s) => s.includes("pathsByOpType")) ?? "";
      expect(script).toContain(".copy(");
      expect(script).toContain("pathsByOpType");
      // Renderer inputs: 0 = scene, 1 = camera, 2 = light.
      expect(script).toContain("inputConnectors[0].connect");
      expect(script).toContain("inputConnectors[1].connect");
      expect(script).toContain("inputConnectors[2].connect");
    });
  });

  describe("render → Null wiring", () => {
    it("connects the renderer output to out1 when render_path is set (no empty-Null warning)", async () => {
      mockExec(loadedReport());
      const result = await createRaytkSceneImpl(makeCtx(), createRaytkSceneSchema.parse({}));
      const text = resultText(result);
      expect(text).toContain("Built a RayTK scene");
      expect(text).not.toContain("the Null TOP is empty");
      // Honesty warning about async shader compile is always present when the renderer exists.
      expect(text).toContain("background thread");
    });
  });

  describe("fail-forward when the RayTK library is not loaded", () => {
    it("does not error, says the scene was not built, and surfaces the load guidance", async () => {
      mockExec(
        loadedReport({
          ok: false,
          library_loaded: false,
          created: [],
          render_path: null,
          scene_tail_path: null,
          unresolved: ["sphereSdf", "raymarchRender3D"],
          guidance:
            "RayTK library not found in the project. Stage it (manage_packages install raytk) then load the staged .tox (namespace /project1/tdmcp_packages). RayTK 0.46 requires TouchDesigner 2025.30770+.",
        }),
      );
      const result = await createRaytkSceneImpl(makeCtx(), createRaytkSceneSchema.parse({}));
      expect(result.isError).toBeFalsy();
      const text = resultText(result);
      expect(text).toContain("RayTK scene not built");
      expect(text).toContain("manage_packages install raytk");
      expect(text).toContain('"library_loaded": false');
      expect(text).toContain("the Null TOP is empty");
    });
  });

  describe("schema", () => {
    it("defaults sdf_primitive/material/add_camera/add_light and honors name", () => {
      const parsed = createRaytkSceneSchema.parse({});
      expect(parsed.sdf_primitive).toBe("sphereSdf");
      expect(parsed.material).toBe(false);
      expect(parsed.add_camera).toBe(false);
      expect(parsed.add_light).toBe(false);
      expect(parsed.parent_path).toBe("/project1");
      expect(createRaytkSceneSchema.parse({ name: "my_scene" }).name).toBe("my_scene");
    });

    it("rejects an unknown sdf_primitive", () => {
      expect(() => createRaytkSceneSchema.parse({ sdf_primitive: "blobSdf" })).toThrow();
    });
  });
});
