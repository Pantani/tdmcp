import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const RAYTK_EXPR_PRESETS = [
  "sphere_union_box",
  "torus_frame_union",
  "material_study",
  "custom",
] as const;

const raytkExprParameterValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const raytkExprNodeSchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
    .describe("Stable graph node id. Used for edges and as the copied ROP name."),
  op_type: z
    .string()
    .min(1)
    .describe(
      "RayTK ROP master name, e.g. sphereSdf, boxSdf, simpleUnion, basicMat, raymarchRender3D.",
    ),
  category: z
    .string()
    .optional()
    .describe("Optional RayTK category hint, e.g. sdf, combine, material, camera, light, output."),
  label: z.string().optional().describe("Optional human label carried into the report."),
  parameters: z
    .record(z.string(), raytkExprParameterValueSchema)
    .default({})
    .describe(
      "Optional direct RayTK parameter values to try on the copied ROP. Unknown RayTK parameter names become warnings, not hard failures.",
    ),
  node_x: z.coerce
    .number()
    .optional()
    .describe("Optional nodeCenterX override. Omit to auto-layout the graph deterministically."),
  node_y: z.coerce
    .number()
    .optional()
    .describe("Optional nodeCenterY override. Omit to auto-layout the graph deterministically."),
});

const raytkExprEdgeSchema = z.object({
  from: z.string().min(1).describe("Source node id."),
  to: z.string().min(1).describe("Destination node id."),
  input_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("0-based destination input connector index."),
  output_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("0-based source output connector index."),
});

export const raytkExprGraphBuilderSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP path to build inside."),
  name: z.string().default("raytk_expr_graph").describe("Name for the generated graph container."),
  preset: z
    .enum(RAYTK_EXPR_PRESETS)
    .default("sphere_union_box")
    .describe(
      "Starter graph to build when nodes are omitted. Use custom with explicit nodes/edges.",
    ),
  nodes: z
    .array(raytkExprNodeSchema)
    .default([])
    .describe("Custom RayTK ROP graph nodes. Leave empty to use the selected preset."),
  edges: z
    .array(raytkExprEdgeSchema)
    .default([])
    .describe("Custom graph edges. Preset edges are used when nodes are omitted."),
  output_node_id: z
    .string()
    .optional()
    .describe(
      "Node id to expose through out1. Defaults to the renderer added or inferred by the tool.",
    ),
  add_renderer: z
    .boolean()
    .default(true)
    .describe("Append raymarchRender3D when the graph has no output ROP."),
  add_camera: z
    .boolean()
    .default(true)
    .describe("Append lookAtCamera and wire it into renderer input 1 when a renderer exists."),
  add_light: z
    .boolean()
    .default(true)
    .describe("Append pointLight and wire it into renderer input 2 when a renderer exists."),
  add_material: z
    .boolean()
    .default(true)
    .describe("Append basicMat between the SDF/combine tail and renderer when absent."),
  library_path: z
    .string()
    .optional()
    .describe(
      "Optional explicit path to the loaded RayTK library COMP. Omit to probe pathsByOpType and known namespaces live.",
    ),
  capture_preview_image: z
    .boolean()
    .default(true)
    .describe(
      "Capture an inline preview from out1. RayTK shader compile may still be asynchronous.",
    ),
});
type RaytkExprGraphBuilderArgs = z.infer<typeof raytkExprGraphBuilderSchema>;

type RaytkExprPreset = (typeof RAYTK_EXPR_PRESETS)[number];
type RaytkParameterValue = z.infer<typeof raytkExprParameterValueSchema>;

interface RaytkExprNode {
  id: string;
  op_type: string;
  category?: string;
  label?: string;
  parameters: Record<string, RaytkParameterValue>;
  node_x?: number;
  node_y?: number;
}

interface RaytkExprEdge {
  from: string;
  to: string;
  input_index: number;
  output_index: number;
}

interface RaytkExprPayloadNode {
  id: string;
  op_type: string;
  category: string | null;
  label?: string;
  parameters: Record<string, RaytkParameterValue>;
  role: string;
  node_x: number;
  node_y: number;
}

interface NormalizedRaytkExprGraph {
  preset: RaytkExprPreset;
  nodes: RaytkExprPayloadNode[];
  edges: RaytkExprEdge[];
  outputId: string;
  rendererId: string | null;
  description: string;
}

interface RaytkExprGraphReport {
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
  wired: RaytkExprEdge[];
  output_id: string | null;
  output_path: string | null;
  unresolved: string[];
  parameters_applied: Array<{ id: string; param: string }>;
  warnings: string[];
  guidance: string | null;
  fatal?: string;
}

const KNOWN_RAYTK_CATEGORIES: Record<string, string> = {
  sphereSdf: "sdf",
  boxSdf: "sdf",
  boxFrameSdf: "sdf",
  torusSdf: "sdf",
  simpleUnion: "combine",
  basicMat: "material",
  lookAtCamera: "camera",
  pointLight: "light",
  raymarchRender3D: "output",
};

const RAYTK_EXPR_GRAPH_TEMPLATE = `
# raytk_expr_graph_builder
import json, base64, traceback
report = {
    "ok": False,
    "library_loaded": False,
    "container": None,
    "created": [],
    "wired": [],
    "output_id": None,
    "output_path": None,
    "unresolved": [],
    "parameters_applied": [],
    "warnings": [],
    "guidance": None,
}
try:
    _payload = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
    _container = op(_payload["container"])
    _nodes = _payload["nodes"]
    _edges = _payload["edges"]
    _output_id = _payload.get("output_id")
    _library_path = _payload.get("library_path")
    _lib_root = op(_library_path) if _library_path else None
    _root = op("/")
    report["container"] = _container.path if _container is not None else None
    report["output_id"] = _output_id

    def _cell_value(cell):
        if cell is None:
            return None
        try:
            return cell.val
        except Exception:
            return str(cell)

    def _candidate_dats():
        dats = []
        direct = op("pathsByOpType")
        if direct is not None:
            dats.append(direct)
        roots = [_lib_root, op("/project1/tdmcp_packages"), op("/raytk"), op("/project1"), _root]
        for root in roots:
            if root is None:
                continue
            try:
                dats.extend(root.findChildren(name="pathsByOpType", maxDepth=12))
            except Exception:
                pass
        seen = set()
        unique = []
        for dat in dats:
            if dat is None or dat.path in seen:
                continue
            seen.add(dat.path)
            unique.append(dat)
        return unique

    def _resolve_master(optype, category):
        if _lib_root is not None:
            paths = ([category + "/" + optype] if category else []) + [optype]
            for child_path in paths:
                try:
                    master = _lib_root.op(child_path)
                    if master is not None and master.isCOMP:
                        return master, "explicit"
                except Exception:
                    pass

        for dat in _candidate_dats():
            try:
                master_path = None
                try:
                    cell = dat[optype, "path"]
                    master_path = _cell_value(cell)
                except Exception:
                    master_path = None
                if not master_path:
                    for row in range(dat.numRows):
                        key = _cell_value(dat[row, 0])
                        if key == optype or (key and str(key).split(".")[-1] == optype):
                            try:
                                master_path = _cell_value(dat[row, "path"])
                            except Exception:
                                master_path = _cell_value(dat[row, 1])
                            break
                if master_path:
                    master = op(str(master_path))
                    if master is not None:
                        return master, "pathsByOpType"
            except Exception as exc:
                report["warnings"].append("pathsByOpType lookup failed for %s: %s" % (optype, exc))

        best = None
        roots = [_lib_root, op("/project1/tdmcp_packages"), op("/raytk"), op("/project1")]
        for root in roots:
            if root is None:
                continue
            try:
                for cand in root.findChildren(name=optype, maxDepth=14):
                    if not cand.isCOMP:
                        continue
                    path = cand.path.lower()
                    if category and (("/operators/%s/" % category) in path or ("/%s/" % category) in path):
                        return cand, "category-search"
                    if best is None:
                        best = cand
            except Exception as exc:
                report["warnings"].append("category search failed for %s: %s" % (optype, exc))
        if best is not None:
            return best, "category-search"
        return None, None

    def _apply_parameters(new_op, spec):
        for name, value in (spec.get("parameters") or {}).items():
            try:
                par = getattr(new_op.par, name)
                par.val = value
                report["parameters_applied"].append({"id": spec["id"], "param": name})
            except Exception as exc:
                report["warnings"].append(
                    "Parameter %s on %s not applied: %s" % (name, spec["id"], exc)
                )

    if _container is None:
        report["fatal"] = "Container COMP not found: " + str(_payload["container"])
    else:
        _by_id = {}
        for spec in _nodes:
            node_id = spec["id"]
            optype = spec["op_type"]
            category = spec.get("category")
            master, resolution = _resolve_master(optype, category)
            if master is None:
                report["unresolved"].append(node_id)
                report["warnings"].append(
                    "RayTK master '%s' for graph node '%s' not found." % (optype, node_id)
                )
                continue
            try:
                new_op = _container.copy(master, name=node_id)
                new_op.nodeCenterX = float(spec.get("node_x", 0))
                new_op.nodeCenterY = float(spec.get("node_y", 0))
                _apply_parameters(new_op, spec)
                _by_id[node_id] = new_op
                report["created"].append({
                    "id": node_id,
                    "op_type": optype,
                    "category": category,
                    "path": new_op.path,
                    "master_path": master.path,
                    "resolution": resolution,
                })
            except Exception as exc:
                report["unresolved"].append(node_id)
                report["warnings"].append("Copy of graph node '%s' failed: %s" % (node_id, exc))

        def _wire(edge):
            src = _by_id.get(edge["from"])
            dst = _by_id.get(edge["to"])
            if src is None or dst is None:
                report["warnings"].append(
                    "Wire %s -> %s skipped because one endpoint was not created."
                    % (edge["from"], edge["to"])
                )
                return
            try:
                out_idx = int(edge.get("output_index", 0))
                in_idx = int(edge.get("input_index", 0))
                dst.inputConnectors[in_idx].connect(src.outputConnectors[out_idx])
                report["wired"].append({
                    "from": edge["from"],
                    "to": edge["to"],
                    "input_index": in_idx,
                    "output_index": out_idx,
                })
            except Exception as exc:
                report["warnings"].append(
                    "Wire %s -> %s failed: %s" % (edge["from"], edge["to"], exc)
                )

        for edge in _edges:
            _wire(edge)

        output_op = _by_id.get(_output_id)
        if output_op is not None:
            report["output_path"] = output_op.path
            report["library_loaded"] = len(report["created"]) > 0
            report["ok"] = True
        else:
            report["library_loaded"] = len(report["created"]) > 0
            report["ok"] = False

    if not report["ok"] and report["guidance"] is None:
        report["guidance"] = (
            "RayTK graph was not fully built. Stage RayTK with manage_packages install raytk, "
            "load the staged .tox, then retry. RayTK 0.46 requires TouchDesigner 2025.30770+."
        )
except Exception as exc:
    report["fatal"] = str(exc)
    report["warnings"].append(traceback.format_exc())

print(json.dumps(report))
result = report
`;

function inferCategory(opType: string, category?: string): string | undefined {
  return category ?? KNOWN_RAYTK_CATEGORIES[opType];
}

function presetGraph(preset: Exclude<RaytkExprPreset, "custom">): {
  nodes: RaytkExprNode[];
  edges: RaytkExprEdge[];
  tailId: string;
} {
  if (preset === "material_study") {
    return {
      nodes: [
        {
          id: "sphere",
          op_type: "sphereSdf",
          category: "sdf",
          label: "Study surface",
          parameters: {},
        },
      ],
      edges: [],
      tailId: "sphere",
    };
  }

  const primary =
    preset === "torus_frame_union"
      ? { id: "torus", op_type: "torusSdf", label: "Torus" }
      : { id: "sphere", op_type: "sphereSdf", label: "Sphere" };
  const secondary =
    preset === "torus_frame_union"
      ? { id: "frame", op_type: "boxFrameSdf", label: "Box frame" }
      : { id: "box", op_type: "boxSdf", label: "Box" };

  return {
    nodes: [
      { ...primary, category: "sdf", parameters: {} },
      { ...secondary, category: "sdf", parameters: {} },
      {
        id: "union1",
        op_type: "simpleUnion",
        category: "combine",
        label: "Union",
        parameters: {},
      },
    ],
    edges: [
      { from: primary.id, to: "union1", input_index: 0, output_index: 0 },
      { from: secondary.id, to: "union1", input_index: 1, output_index: 0 },
    ],
    tailId: "union1",
  };
}

function uniqueId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) {
    existing.add(base);
    return base;
  }
  let i = 2;
  while (existing.has(`${base}${i}`)) i += 1;
  const id = `${base}${i}`;
  existing.add(id);
  return id;
}

function assertUniqueNodeIds(nodes: readonly RaytkExprNode[]): void {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) throw new Error(`Duplicate RayTK graph node id: ${node.id}`);
    seen.add(node.id);
  }
}

function findRenderer(nodes: readonly RaytkExprNode[]): RaytkExprNode | undefined {
  return nodes.find((node) => node.op_type === "raymarchRender3D" || node.category === "output");
}

function hasEdgeTo(edges: readonly RaytkExprEdge[], to: string, inputIndex: number): boolean {
  return edges.some((edge) => edge.to === to && edge.input_index === inputIndex);
}

function roleFor(node: RaytkExprNode): string {
  const category = inferCategory(node.op_type, node.category);
  if (category) return category;
  if (/render/i.test(node.op_type)) return "output";
  return "rop";
}

function computeDepths(nodes: readonly RaytkExprNode[], edges: readonly RaytkExprEdge[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const depths = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
      const nextDepth = (depths.get(edge.from) ?? 0) + 1;
      if (nextDepth > (depths.get(edge.to) ?? 0)) {
        depths.set(edge.to, nextDepth);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depths;
}

function layoutNodes(nodes: readonly RaytkExprNode[], edges: readonly RaytkExprEdge[]) {
  const depths = computeDepths(nodes, edges);
  const groups = new Map<number, RaytkExprNode[]>();
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    const group = groups.get(depth) ?? [];
    group.push(node);
    groups.set(depth, group);
  }

  return nodes.map((node) => {
    const depth = depths.get(node.id) ?? 0;
    const group = groups.get(depth) ?? [node];
    const index = group.findIndex((entry) => entry.id === node.id);
    const role = roleFor(node);
    const autoY =
      role === "camera"
        ? 220
        : role === "light"
          ? -220
          : role === "material"
            ? -80
            : (index - (group.length - 1) / 2) * 150;
    return {
      ...node,
      category: inferCategory(node.op_type, node.category) ?? null,
      role,
      node_x: node.node_x ?? depth * 220,
      node_y: node.node_y ?? autoY,
    };
  });
}

function normalizeGraph(args: RaytkExprGraphBuilderArgs): NormalizedRaytkExprGraph {
  let nodes: RaytkExprNode[];
  let edges: RaytkExprEdge[];
  let tailId: string;

  if (args.nodes.length > 0) {
    nodes = args.nodes.map((node) => ({
      ...node,
      category: inferCategory(node.op_type, node.category),
    }));
    edges = [...args.edges];
    const lastNodeId = nodes.at(-1)?.id;
    if (!lastNodeId) throw new Error("Custom RayTK expression graphs require at least one node.");
    tailId = args.output_node_id ?? lastNodeId;
  } else {
    if (args.preset === "custom") {
      throw new Error("Custom RayTK expression graphs require at least one node.");
    }
    const graph = presetGraph(args.preset);
    nodes = graph.nodes;
    edges = graph.edges;
    tailId = graph.tailId;
  }

  assertUniqueNodeIds(nodes);
  const ids = new Set(nodes.map((node) => node.id));

  if (args.add_material && !nodes.some((node) => node.op_type === "basicMat")) {
    const materialId = uniqueId("mat1", ids);
    nodes.push({
      id: materialId,
      op_type: "basicMat",
      category: "material",
      label: "Material",
      parameters: {},
    });
    edges.push({ from: tailId, to: materialId, input_index: 0, output_index: 0 });
    tailId = materialId;
  }

  let renderer = findRenderer(nodes);
  if (args.add_renderer && !renderer) {
    const rendererId = uniqueId("render1", ids);
    renderer = {
      id: rendererId,
      op_type: "raymarchRender3D",
      category: "output",
      label: "Raymarch renderer",
      parameters: {},
    };
    nodes.push(renderer);
    edges.push({ from: tailId, to: rendererId, input_index: 0, output_index: 0 });
  } else if (renderer && renderer.id !== tailId && !hasEdgeTo(edges, renderer.id, 0)) {
    edges.push({ from: tailId, to: renderer.id, input_index: 0, output_index: 0 });
  }

  if (renderer && args.add_camera && !hasEdgeTo(edges, renderer.id, 1)) {
    const cameraId =
      nodes.find((node) => inferCategory(node.op_type, node.category) === "camera")?.id ??
      uniqueId("camera1", ids);
    if (!nodes.some((node) => node.id === cameraId)) {
      nodes.push({
        id: cameraId,
        op_type: "lookAtCamera",
        category: "camera",
        label: "Look-at camera",
        parameters: {},
      });
    }
    edges.push({ from: cameraId, to: renderer.id, input_index: 1, output_index: 0 });
  }

  if (renderer && args.add_light && !hasEdgeTo(edges, renderer.id, 2)) {
    const lightId =
      nodes.find((node) => inferCategory(node.op_type, node.category) === "light")?.id ??
      uniqueId("light1", ids);
    if (!nodes.some((node) => node.id === lightId)) {
      nodes.push({
        id: lightId,
        op_type: "pointLight",
        category: "light",
        label: "Point light",
        parameters: {},
      });
    }
    edges.push({ from: lightId, to: renderer.id, input_index: 2, output_index: 0 });
  }

  const finalIds = new Set(nodes.map((node) => node.id));
  const outputId = args.output_node_id ?? renderer?.id ?? tailId;
  if (!finalIds.has(outputId)) throw new Error(`Unknown output_node_id: ${outputId}`);
  for (const edge of edges) {
    if (!finalIds.has(edge.from) || !finalIds.has(edge.to)) {
      throw new Error(`RayTK graph edge references an unknown node: ${edge.from} -> ${edge.to}`);
    }
  }

  const laidOutNodes = layoutNodes(nodes, edges);
  return {
    preset: args.preset,
    nodes: laidOutNodes,
    edges,
    outputId,
    rendererId: renderer?.id ?? null,
    description: `${laidOutNodes.length} RayTK ROPs, ${edges.length} wires, output=${outputId}`,
  };
}

export function buildRaytkExprGraphScript(payload: object): string {
  return buildPayloadScript(RAYTK_EXPR_GRAPH_TEMPLATE, payload);
}

export async function raytkExprGraphBuilderImpl(ctx: ToolContext, args: RaytkExprGraphBuilderArgs) {
  return runBuild(async () => {
    const graph = normalizeGraph(args);
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    const script = buildRaytkExprGraphScript({
      container: builder.containerPath,
      nodes: graph.nodes,
      edges: graph.edges,
      output_id: graph.outputId,
      library_path: args.library_path ?? null,
    });

    let report: RaytkExprGraphReport | undefined;
    try {
      const exec = await ctx.client.executePythonScript(script, true);
      report = parsePythonReport<RaytkExprGraphReport>(exec.stdout);
      builder.warnings.push(...report.warnings);
      if (report.guidance) builder.warnings.push(report.guidance);
      if (report.fatal)
        builder.warnings.push(`RayTK expression graph fatal report: ${report.fatal}`);
    } catch (err) {
      builder.warnings.push(
        `RayTK expression graph copy/wire step failed: ${friendlyTdError(err)}`,
      );
    }

    const out = await builder.add("nullTOP", "out1");
    if (report?.output_path) {
      await builder.connect(report.output_path, out);
      builder.warnings.push(
        "RayTK raymarchRender3D compiles its shader on a background thread; preview capture is not proof of a fully cooked non-black render.",
      );
    } else {
      builder.warnings.push("RayTK expression graph output was not created; out1 is empty.");
    }

    return finalize(ctx, {
      summary: report?.output_path
        ? `Built a RayTK expression graph (${graph.description}).`
        : "RayTK expression graph not built - load the RayTK library first (see warnings).",
      builder,
      outputPath: out,
      capturePreviewImage: args.capture_preview_image,
      controls: [],
      extra: {
        preset: graph.preset,
        graph: {
          nodes: graph.nodes.map((node) => ({
            id: node.id,
            op_type: node.op_type,
            category: node.category,
            node_x: node.node_x,
            node_y: node.node_y,
          })),
          edges: graph.edges,
          output_id: graph.outputId,
          renderer_id: graph.rendererId,
        },
        raytk: {
          library_loaded: report?.library_loaded ?? false,
          created: report?.created ?? [],
          wired: report?.wired ?? [],
          unresolved: report?.unresolved ?? graph.nodes.map((node) => node.id),
          parameters_applied: report?.parameters_applied ?? [],
        },
        live_validation: "UNVERIFIED-raytk-render",
      },
    });
  });
}

export const registerRaytkExprGraphBuilder: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "raytk_expr_graph_builder",
    {
      title: "Build RayTK expression graph",
      description:
        "Build an editable RayTK ROP expression graph from a preset or explicit nodes/edges: copy RayTK masters live via pathsByOpType/category search, wire typed connectors, apply simple parameter values, lay out copied nodes deterministically, and expose the selected output through out1. Complements create_raytk_scene (minimal scene) and create_raytk_op (single ROP). Requires RayTK staged and loaded; offline tests validate payload/registration only, while live render/cook proof remains explicit.",
      inputSchema: raytkExprGraphBuilderSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => raytkExprGraphBuilderImpl(ctx, args),
  );
};
