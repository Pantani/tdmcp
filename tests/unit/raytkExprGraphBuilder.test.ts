import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  raytkExprGraphBuilderImpl,
  raytkExprGraphBuilderSchema,
} from "../../src/tools/layer1/raytkExprGraphBuilder.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

interface RaytkExprPayloadNode {
  id: string;
  op_type: string;
  category: string | null;
  role: string;
  parameters: Record<string, string | number | boolean>;
  node_x: number;
  node_y: number;
}

interface RaytkExprPayloadEdge {
  from: string;
  to: string;
  input_index: number;
  output_index: number;
}

interface RaytkExprPayload {
  container: string;
  nodes: RaytkExprPayloadNode[];
  edges: RaytkExprPayloadEdge[];
  output_id: string;
  library_path: string | null;
}

interface RaytkExprReport {
  ok: boolean;
  library_loaded: boolean;
  container: string | null;
  created: Array<{
    id: string;
    op_type: string;
    category: string | null;
    path: string;
    master_path: string;
    resolution: string;
  }>;
  wired: RaytkExprPayloadEdge[];
  output_id: string | null;
  output_path: string | null;
  unresolved: string[];
  parameters_applied: Array<{ id: string; param: string }>;
  warnings: string[];
  guidance: string | null;
  fatal?: string;
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

function loadedReport(overrides: Partial<RaytkExprReport> = {}): RaytkExprReport {
  const created = ["sphere", "box", "union1", "mat1", "camera1", "light1", "render1"].map((id) => ({
    id,
    op_type: id === "render1" ? "raymarchRender3D" : id,
    category: id === "render1" ? "output" : null,
    path: `/project1/raytk_expr_graph/${id}`,
    master_path: `/project1/tdmcp_packages/raytk/${id}`,
    resolution: "pathsByOpType",
  }));
  return {
    ok: true,
    library_loaded: true,
    container: "/project1/raytk_expr_graph",
    created,
    wired: [],
    output_id: "render1",
    output_path: "/project1/raytk_expr_graph/render1",
    unresolved: [],
    parameters_applied: [],
    warnings: [],
    guidance: null,
    ...overrides,
  };
}

function mockExec(report: RaytkExprReport): { payload: () => RaytkExprPayload | undefined } {
  let captured: string | undefined;
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      if (body.script.includes("raytk_expr_graph_builder")) {
        captured = body.script;
        return HttpResponse.json({
          ok: true,
          data: { result: null, stdout: JSON.stringify(report) },
        });
      }
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return {
    payload: () => {
      const b64 = /b64decode\("([^"]+)"\)/.exec(captured ?? "")?.[1];
      if (b64 === undefined) return undefined;
      return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as RaytkExprPayload;
    },
  };
}

describe("raytk_expr_graph_builder", () => {
  it("schema defaults build a renderable preset graph with renderer, camera, light, and material", () => {
    const parsed = raytkExprGraphBuilderSchema.parse({});
    expect(parsed.preset).toBe("sphere_union_box");
    expect(parsed.add_renderer).toBe(true);
    expect(parsed.add_camera).toBe(true);
    expect(parsed.add_light).toBe(true);
    expect(parsed.add_material).toBe(true);
  });

  it("builds the preset payload by copying RayTK ROPs instead of creating native node types", async () => {
    const bodies = captureCreateBodies();
    const exec = mockExec(loadedReport());
    const result = await raytkExprGraphBuilderImpl(
      makeCtx(),
      raytkExprGraphBuilderSchema.parse({}),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Built a RayTK expression graph");
    expect(result.content.some((c) => c.type === "image")).toBe(true);
    expect(
      bodies.some((body) => body.type === "baseCOMP" && body.name === "raytk_expr_graph"),
    ).toBe(true);
    expect(bodies.some((body) => body.type === "nullTOP" && body.name === "out1")).toBe(true);
    expect(
      bodies.every((body) => body.type !== "sphereSdf" && body.type !== "raymarchRender3D"),
    ).toBe(true);

    const payload = exec.payload();
    expect(payload?.output_id).toBe("render1");
    const opTypes = payload?.nodes.map((node) => node.op_type) ?? [];
    expect(opTypes).toEqual(
      expect.arrayContaining([
        "sphereSdf",
        "boxSdf",
        "simpleUnion",
        "basicMat",
        "lookAtCamera",
        "pointLight",
        "raymarchRender3D",
      ]),
    );
    expect(payload?.edges).toContainEqual({
      from: "camera1",
      to: "render1",
      input_index: 1,
      output_index: 0,
    });
    expect(payload?.edges).toContainEqual({
      from: "light1",
      to: "render1",
      input_index: 2,
      output_index: 0,
    });
    expect(payload?.nodes.every((node) => Number.isFinite(node.node_x))).toBe(true);
    expect(payload?.nodes.every((node) => Number.isFinite(node.node_y))).toBe(true);
  });

  it("passes custom graph nodes, edges, parameters, and library path through the bridge payload", async () => {
    const exec = mockExec(
      loadedReport({
        created: [
          {
            id: "shape",
            op_type: "sphereSdf",
            category: "sdf",
            path: "/project1/raytk_expr_graph/shape",
            master_path: "/raytk/sdf/sphereSdf",
            resolution: "explicit",
          },
          {
            id: "render1",
            op_type: "raymarchRender3D",
            category: "output",
            path: "/project1/raytk_expr_graph/render1",
            master_path: "/raytk/output/raymarchRender3D",
            resolution: "explicit",
          },
        ],
        parameters_applied: [{ id: "shape", param: "radius" }],
      }),
    );

    const result = await raytkExprGraphBuilderImpl(
      makeCtx(),
      raytkExprGraphBuilderSchema.parse({
        preset: "custom",
        nodes: [
          {
            id: "shape",
            op_type: "sphereSdf",
            category: "sdf",
            parameters: { radius: 0.42 },
          },
        ],
        add_material: false,
        add_camera: false,
        add_light: false,
        library_path: "/project1/tdmcp_packages/raytk",
      }),
    );

    expect(result.isError).toBeFalsy();
    const payload = exec.payload();
    expect(payload?.library_path).toBe("/project1/tdmcp_packages/raytk");
    expect(payload?.nodes.find((node) => node.id === "shape")?.parameters.radius).toBe(0.42);
    expect(payload?.nodes.map((node) => node.op_type)).toEqual(
      expect.arrayContaining(["sphereSdf", "raymarchRender3D"]),
    );
    expect(payload?.edges).toContainEqual({
      from: "shape",
      to: "render1",
      input_index: 0,
      output_index: 0,
    });
  });

  it("fails forward with load guidance when no RayTK masters resolve", async () => {
    mockExec(
      loadedReport({
        ok: false,
        library_loaded: false,
        created: [],
        wired: [],
        output_path: null,
        unresolved: ["sphere", "box", "union1", "mat1", "camera1", "light1", "render1"],
        guidance:
          "RayTK graph was not fully built. Stage RayTK with manage_packages install raytk, load the staged .tox, then retry. RayTK 0.46 requires TouchDesigner 2025.30770+.",
      }),
    );

    const result = await raytkExprGraphBuilderImpl(
      makeCtx(),
      raytkExprGraphBuilderSchema.parse({}),
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("RayTK expression graph not built");
    expect(text).toContain("manage_packages install raytk");
    expect(text).toContain("UNVERIFIED-raytk-render");
    expect(text).toContain("out1 is empty");
  });
});
