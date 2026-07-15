import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createRaytkSdfGraphImpl,
  createRaytkSdfGraphSchema,
} from "../../src/tools/layer1/createRaytkSdfGraph.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
}

interface RaytkSdfGraphReport {
  ok: boolean;
  library_loaded: boolean;
  created: Array<{ opType: string; name: string; path: string }>;
  render_path: string | null;
  scene_tail_path: string | null;
  output_name: string | null;
  output_path: string | null;
  unresolved: string[];
  warnings: string[];
  guidance: string | null;
}

interface PayloadOp {
  optype: string;
  category: string;
  role: string;
  name: string;
  nodeX: number;
  nodeY: number;
}

interface GraphPayload {
  container: string;
  output_name: string;
  output_path: string;
  primary: string;
  secondary: string | null;
  requested_operation: string;
  operation: string;
  material: boolean;
  camera: boolean;
  light: boolean;
  render_resolution: [number, number];
  ops: PayloadOp[];
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

function mockExec(report: RaytkSdfGraphReport): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      const isCopyWire = body.script.includes("create_raytk_sdf_graph copy-wire pass");
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: isCopyWire ? JSON.stringify(report) : "" },
      });
    }),
  );
  return scripts;
}

function decodeGraphPayload(scripts: string[]): GraphPayload | undefined {
  const script = scripts.find((s) => s.includes("create_raytk_sdf_graph copy-wire pass"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(script ?? "")?.[1];
  if (b64 === undefined) return undefined;
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as GraphPayload;
}

function loadedReport(overrides: Partial<RaytkSdfGraphReport> = {}): RaytkSdfGraphReport {
  return {
    ok: true,
    library_loaded: true,
    created: [
      { opType: "sphereSdf", name: "primary_sdf", path: "/project1/raytk_sdf_graph/primary_sdf" },
      { opType: "basicMat", name: "mat1", path: "/project1/raytk_sdf_graph/mat1" },
      {
        opType: "raymarchRender3D",
        name: "render1",
        path: "/project1/raytk_sdf_graph/render1",
      },
    ],
    render_path: "/project1/raytk_sdf_graph/render1",
    scene_tail_path: "/project1/raytk_sdf_graph/mat1",
    output_name: "out1",
    output_path: "/project1/raytk_sdf_graph/out1",
    unresolved: [],
    warnings: [],
    guidance: null,
    ...overrides,
  };
}

function resultText(result: Awaited<ReturnType<typeof createRaytkSdfGraphImpl>>): string {
  const block = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return block?.text ?? "";
}

describe("create_raytk_sdf_graph", () => {
  it("parses schema defaults", () => {
    const parsed = createRaytkSdfGraphSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("raytk_sdf_graph");
    expect(parsed.primary).toBe("sphereSdf");
    expect(parsed.secondary).toBeUndefined();
    expect(parsed.operation).toBe("none");
    expect(parsed.material).toBe(true);
    expect(parsed.camera).toBe(true);
    expect(parsed.light).toBe(true);
    expect(parsed.render_resolution).toEqual([1280, 720]);
    expect(parsed.output_name).toBe("out1");
  });

  it("sends the normalized graph payload and creates only the container plus native output", async () => {
    const bodies = captureCreateBodies();
    const scripts = mockExec(
      loadedReport({
        created: [
          { opType: "boxSdf", name: "primary_sdf", path: "/project1/custom_graph/primary_sdf" },
          {
            opType: "torusSdf",
            name: "secondary_sdf",
            path: "/project1/custom_graph/secondary_sdf",
          },
          { opType: "simpleUnion", name: "union1", path: "/project1/custom_graph/union1" },
          { opType: "basicMat", name: "mat1", path: "/project1/custom_graph/mat1" },
          { opType: "lookAtCamera", name: "camera1", path: "/project1/custom_graph/camera1" },
          { opType: "pointLight", name: "light1", path: "/project1/custom_graph/light1" },
          {
            opType: "raymarchRender3D",
            name: "render1",
            path: "/project1/custom_graph/render1",
          },
        ],
        render_path: "/project1/custom_graph/render1",
        scene_tail_path: "/project1/custom_graph/mat1",
        output_name: "beauty",
        output_path: "/project1/custom_graph/beauty",
      }),
    );

    const result = await createRaytkSdfGraphImpl(
      makeCtx(),
      createRaytkSdfGraphSchema.parse({
        name: "custom_graph",
        primary: "boxSdf",
        secondary: "torusSdf",
        operation: "none",
        output_name: "beauty",
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(bodies).toContainEqual({
      parent_path: "/project1",
      type: "baseCOMP",
      name: "custom_graph",
    });
    expect(bodies).toContainEqual({
      parent_path: "/project1/custom_graph",
      type: "nullTOP",
      name: "beauty",
    });
    expect(bodies).toHaveLength(2);

    const payload = decodeGraphPayload(scripts);
    expect(payload).toBeDefined();
    if (!payload) throw new Error("copy-wire payload was not captured");
    expect(payload).toMatchObject({
      container: "/project1/custom_graph",
      output_name: "beauty",
      output_path: "/project1/custom_graph/beauty",
      primary: "boxSdf",
      secondary: "torusSdf",
      requested_operation: "none",
      operation: "simpleUnion",
      material: true,
      camera: true,
      light: true,
      render_resolution: [1280, 720],
    });

    const optypes = payload.ops.map((op) => op.optype);
    expect(optypes).toEqual([
      "boxSdf",
      "torusSdf",
      "simpleUnion",
      "basicMat",
      "lookAtCamera",
      "pointLight",
      "raymarchRender3D",
    ]);
    expect(payload.ops.find((op) => op.role === "sdf_primary")).toMatchObject({
      nodeX: -800,
      nodeY: 120,
    });
    expect(payload.ops.find((op) => op.role === "render")).toMatchObject({
      nodeX: -160,
      nodeY: 0,
    });

    const copyWireScript = scripts.find((script) =>
      script.includes("create_raytk_sdf_graph copy-wire pass"),
    );
    expect(copyWireScript).toContain('setattr(_render.par, "Resolution"');
  });

  it("summarizes the container and output paths on success", async () => {
    mockExec(loadedReport());
    const result = await createRaytkSdfGraphImpl(makeCtx(), createRaytkSdfGraphSchema.parse({}));
    const text = resultText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Built a RayTK SDF graph in /project1/raytk_sdf_graph");
    expect(text).toContain("output /project1/raytk_sdf_graph/out1");
    expect(text).toContain('"render_path": "/project1/raytk_sdf_graph/render1"');
  });

  it("returns isError for a no-render report without throwing", async () => {
    mockExec(
      loadedReport({
        ok: false,
        library_loaded: false,
        created: [],
        render_path: null,
        scene_tail_path: null,
        unresolved: ["sphereSdf", "raymarchRender3D"],
        guidance:
          "RayTK library not found in the project. Stage it with manage_packages install raytk, then load the staged .tox from /project1/tdmcp_packages.",
      }),
    );

    const result = await createRaytkSdfGraphImpl(makeCtx(), createRaytkSdfGraphSchema.parse({}));
    const text = resultText(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("RayTK SDF graph not built");
    expect(text).toContain("manage_packages install raytk");
    expect(text).toContain('"render_path": null');
    expect(text).toContain('"unresolved": [');
  });
});
