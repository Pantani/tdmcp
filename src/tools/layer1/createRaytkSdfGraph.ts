import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const SDF_PRIMITIVES = ["sphereSdf", "boxSdf", "boxFrameSdf", "torusSdf"] as const;
const OPERATIONS = ["none", "simpleUnion"] as const;

const RAYTK_SDF_GRAPH_GUIDANCE =
  "RayTK library not found in the project. Stage it with manage_packages install raytk, " +
  "then load the staged .tox from /project1/tdmcp_packages. RayTK 0.46 requires " +
  "TouchDesigner 2025.30770+.";

export const createRaytkSdfGraphSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path where the RayTK SDF graph container is created."),
  name: z
    .string()
    .default("raytk_sdf_graph")
    .describe("Name of the container COMP created for the graph."),
  primary: z
    .enum(SDF_PRIMITIVES)
    .default("sphereSdf")
    .describe("Primary RayTK SDF primitive ROP copied from the loaded RayTK library."),
  secondary: z
    .enum(SDF_PRIMITIVES)
    .optional()
    .describe("Optional second RayTK SDF primitive, combined with primary by simpleUnion."),
  operation: z
    .enum(OPERATIONS)
    .default("none")
    .describe("Combination operation. A provided secondary upgrades none to simpleUnion."),
  material: z
    .boolean()
    .default(true)
    .describe("Insert a RayTK basicMat between the SDF chain and renderer."),
  camera: z.boolean().default(true).describe("Add a RayTK lookAtCamera wired to renderer input 1."),
  light: z.boolean().default(true).describe("Add a RayTK pointLight wired to renderer input 2."),
  render_resolution: z
    .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
    .default([1280, 720])
    .describe(
      "RayTK renderer resolution [width, height]. Defaults to 1280x720 to avoid TouchDesigner Non-Commercial render-size warnings.",
    ),
  output_name: z
    .string()
    .default("out1")
    .describe("Name of the native Null TOP receiving the renderer output."),
});

type CreateRaytkSdfGraphArgs = z.infer<typeof createRaytkSdfGraphSchema>;
type RaytkSdfPrimitive = (typeof SDF_PRIMITIVES)[number];
type RaytkSdfOperation = (typeof OPERATIONS)[number];

interface RaytkOpSpec {
  optype: string;
  category: string;
  role: "sdf_primary" | "sdf_secondary" | "union" | "material" | "render" | "camera" | "light";
  name: string;
  nodeX: number;
  nodeY: number;
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

const RAYTK_SDF_GRAPH_TEMPLATE = `
# create_raytk_sdf_graph copy-wire pass
import json, base64, traceback
report = {
    "ok": False,
    "library_loaded": False,
    "created": [],
    "render_path": None,
    "scene_tail_path": None,
    "output_name": None,
    "output_path": None,
    "unresolved": [],
    "warnings": [],
    "guidance": None,
}
try:
    _payload = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
    report["output_name"] = _payload.get("output_name")
    report["output_path"] = _payload.get("output_path")
    _render_resolution = _payload.get("render_resolution") or [1280, 720]
    _container = op(_payload["container"])
    _ops = _payload["ops"]
    _root = op("/")
    if _container is None:
        raise ValueError("container not found: %s" % _payload["container"])

    def _find_master(optype, category):
        try:
            for _dat in _root.findChildren(name="pathsByOpType", maxDepth=12):
                for _r in range(_dat.numRows):
                    _key = str(_dat[_r, 0])
                    if _key == optype or _key.endswith("." + optype):
                        _cell = None
                        try:
                            _cell = _dat[_r, "path"]
                        except Exception:
                            _cell = None
                        if _cell is None:
                            try:
                                _cell = _dat[_r, 1]
                            except Exception:
                                _cell = None
                        if _cell is not None:
                            _cand = op(str(_cell))
                            if _cand is not None:
                                return _cand
        except Exception as _e:
            report["warnings"].append("pathsByOpType lookup failed for %s: %s" % (optype, _e))
        try:
            _cat = None
            _other = None
            for _m in _root.findChildren(name=optype, maxDepth=14):
                _p = _m.path.lower()
                if ("raytk" in _p) or ("/operators/" in _p):
                    if ("/operators/%s/" % category) in _p or ("/%s/" % category) in _p:
                        _cat = _m
                        break
                    if _other is None:
                        _other = _m
            return _cat or _other
        except Exception as _e:
            report["warnings"].append("findChildren fallback failed for %s: %s" % (optype, _e))
        return None

    _by_role = {}
    for _spec in _ops:
        _optype = _spec["optype"]
        _category = _spec["category"]
        _role = _spec["role"]
        _master = _find_master(_optype, _category)
        if _master is None:
            report["unresolved"].append(_optype)
            report["warnings"].append(
                "RayTK master '%s' (%s) not found - is the library loaded?" % (_optype, _category)
            )
            continue
        try:
            _new = _container.copy(_master, name=_spec.get("name") or _optype)
        except Exception as _e:
            report["unresolved"].append(_optype)
            report["warnings"].append("Copy of '%s' failed: %s" % (_optype, _e))
            continue
        try:
            _new.nodeX = float(_spec.get("nodeX", 0.0))
            _new.nodeY = float(_spec.get("nodeY", 0.0))
        except Exception as _e:
            report["warnings"].append("Layout of '%s' failed: %s" % (_new.path, _e))
        _by_role[_role] = _new
        report["created"].append({"opType": _optype, "name": _new.name, "path": _new.path})

    def _safe(fn, label):
        try:
            fn()
        except Exception as _e:
            report["warnings"].append("Wire %s failed: %s" % (label, _e))

    def _wire(src, dst, idx, label):
        _safe(lambda: dst.inputConnectors[idx].connect(src.outputConnectors[0]), label)

    _prim = _by_role.get("sdf_primary")
    _sec = _by_role.get("sdf_secondary")
    _union = _by_role.get("union")
    _material = _by_role.get("material")
    _render = _by_role.get("render")
    _camera = _by_role.get("camera")
    _light = _by_role.get("light")

    if _union is not None and _prim is not None:
        _wire(_prim, _union, 0, "primary->union[0]")
    if _union is not None and _sec is not None:
        _wire(_sec, _union, 1, "secondary->union[1]")

    _scene = _union if _union is not None else _prim
    if _payload.get("secondary") and _payload.get("operation") == "simpleUnion" and _union is None:
        report["warnings"].append("simpleUnion was requested but was not created; using primary SDF.")
    if _material is not None and _scene is not None:
        _wire(_scene, _material, 0, "scene->material[0]")
        _scene = _material
    if _scene is not None:
        report["scene_tail_path"] = _scene.path
    else:
        report["warnings"].append("No SDF scene source was created for the renderer.")

    if _render is not None and _scene is not None:
        _wire(_scene, _render, 0, "scene->render[0]")
    if _render is not None and _camera is not None:
        _wire(_camera, _render, 1, "camera->render[1]")
    if _render is not None and _light is not None:
        _wire(_light, _render, 2, "light->render[2]")

    if _render is not None:
        try:
            _resx = max(1, int(_render_resolution[0]))
            _resy = max(1, int(_render_resolution[1]))
            if hasattr(_render.par, "Resolution"):
                _safe(lambda: setattr(_render.par, "Resolution", [_resx, _resy]), "render Resolution")
            elif hasattr(_render.par, "resolution"):
                _safe(lambda: setattr(_render.par, "resolution", [_resx, _resy]), "render resolution")
            else:
                report["warnings"].append("RayTK renderer has no Resolution parameter; resolution left at library default.")
        except Exception as _e:
            report["warnings"].append("RayTK renderer resolution setup failed: %s" % _e)
        report["render_path"] = _render.path
        report["library_loaded"] = True
        report["ok"] = True
    else:
        report["library_loaded"] = False
        report["ok"] = False
        report["guidance"] = (
            "RayTK library not found in the project. Stage it with manage_packages install raytk, "
            "then load the staged .tox from /project1/tdmcp_packages. RayTK 0.46 requires "
            "TouchDesigner 2025.30770+."
        )
except Exception as _e:
    report["warnings"].append("RayTK SDF graph build error: %s" % _e)
    report["warnings"].append(traceback.format_exc())
    report["guidance"] = (
        "RayTK library not found in the project. Stage it with manage_packages install raytk, "
        "then load the staged .tox from /project1/tdmcp_packages. RayTK 0.46 requires "
        "TouchDesigner 2025.30770+."
    )

print(json.dumps(report))
result = report
`;

function effectiveOperation(args: CreateRaytkSdfGraphArgs): RaytkSdfOperation {
  if (!args.secondary) return "none";
  return args.operation === "none" ? "simpleUnion" : args.operation;
}

function sdfSpec(
  optype: RaytkSdfPrimitive,
  role: "sdf_primary" | "sdf_secondary",
  name: string,
  nodeY: number,
): RaytkOpSpec {
  return { optype, category: "sdf", role, name, nodeX: -800, nodeY };
}

function buildOpSpecs(args: CreateRaytkSdfGraphArgs, operation: RaytkSdfOperation): RaytkOpSpec[] {
  const secondary = args.secondary;
  const useUnion = secondary !== undefined && operation === "simpleUnion";
  const ops: RaytkOpSpec[] = [
    sdfSpec(args.primary, "sdf_primary", "primary_sdf", useUnion ? 120 : 0),
  ];

  if (useUnion) {
    ops.push(sdfSpec(secondary, "sdf_secondary", "secondary_sdf", -120));
    ops.push({
      optype: "simpleUnion",
      category: "combine",
      role: "union",
      name: "union1",
      nodeX: -560,
      nodeY: 0,
    });
  }
  if (args.material) {
    ops.push({
      optype: "basicMat",
      category: "material",
      role: "material",
      name: "mat1",
      nodeX: -360,
      nodeY: 0,
    });
  }
  if (args.camera) {
    ops.push({
      optype: "lookAtCamera",
      category: "camera",
      role: "camera",
      name: "camera1",
      nodeX: -360,
      nodeY: 180,
    });
  }
  if (args.light) {
    ops.push({
      optype: "pointLight",
      category: "light",
      role: "light",
      name: "light1",
      nodeX: -360,
      nodeY: -180,
    });
  }
  ops.push({
    optype: "raymarchRender3D",
    category: "output",
    role: "render",
    name: "render1",
    nodeX: -160,
    nodeY: 0,
  });
  return ops;
}

function describeChain(args: CreateRaytkSdfGraphArgs, operation: RaytkSdfOperation): string {
  const parts: string[] = [args.primary];
  if (args.secondary && operation === "simpleUnion") {
    parts.push(`simpleUnion(${args.secondary})`);
  }
  if (args.material) parts.push("basicMat");
  parts.push("raymarchRender3D");

  const extras: string[] = [];
  if (args.camera) extras.push("lookAtCamera");
  if (args.light) extras.push("pointLight");
  return extras.length ? `${parts.join(" -> ")} with ${extras.join(" + ")}` : parts.join(" -> ");
}

function errorData(
  args: CreateRaytkSdfGraphArgs,
  operation: RaytkSdfOperation,
  containerPath: string,
  outputPath: string,
  report: RaytkSdfGraphReport,
  warnings: string[],
) {
  return {
    container: containerPath,
    output: outputPath,
    primary: args.primary,
    secondary: args.secondary,
    operation,
    raytk: {
      library_loaded: report.library_loaded,
      created: report.created,
      render_path: report.render_path,
      scene_tail_path: report.scene_tail_path,
      output_name: report.output_name,
      output_path: report.output_path,
      unresolved: report.unresolved,
      warnings,
      guidance: report.guidance ?? RAYTK_SDF_GRAPH_GUIDANCE,
    },
  };
}

export async function createRaytkSdfGraphImpl(ctx: ToolContext, args: CreateRaytkSdfGraphArgs) {
  return runBuild(async () => {
    const operation = effectiveOperation(args);
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const out = await builder.add("nullTOP", args.output_name);
    const payload = {
      container: builder.containerPath,
      output_name: args.output_name,
      output_path: out,
      primary: args.primary,
      secondary: args.secondary ?? null,
      requested_operation: args.operation,
      operation,
      material: args.material,
      camera: args.camera,
      light: args.light,
      render_resolution: args.render_resolution,
      ops: buildOpSpecs(args, operation),
    };
    const script = buildPayloadScript(RAYTK_SDF_GRAPH_TEMPLATE, payload);

    let report: RaytkSdfGraphReport;
    try {
      const exec = await ctx.client.executePythonScript(script, true);
      report = parsePythonReport<RaytkSdfGraphReport>(exec.stdout);
    } catch (err) {
      return errorResult(`RayTK SDF graph build failed: ${friendlyTdError(err)}`, {
        container: builder.containerPath,
        output: out,
        primary: args.primary,
        secondary: args.secondary,
        operation,
      });
    }

    builder.warnings.push(...report.warnings);
    if (report.guidance) builder.warnings.push(report.guidance);

    if (!report.render_path) {
      if (!report.guidance) builder.warnings.push(RAYTK_SDF_GRAPH_GUIDANCE);
      await builder.layout();
      return errorResult(
        "RayTK SDF graph not built: no RayTK renderer was created. " +
          "Run manage_packages install raytk and load the staged .tox.",
        errorData(args, operation, builder.containerPath, out, report, builder.warnings),
      );
    }

    await builder.connect(report.render_path, out);
    builder.warnings.push(
      "raymarchRender3D compiles its shader on a background thread; the preview may be black " +
        "or incomplete until the renderer finishes compiling.",
    );

    return finalize(ctx, {
      summary:
        `Built a RayTK SDF graph in ${builder.containerPath}; output ${out} ` +
        `(${describeChain(args, operation)}).`,
      builder,
      outputPath: out,
      controls: [],
      capturePreviewImage: true,
      extra: {
        primary: args.primary,
        secondary: args.secondary,
        operation,
        material: args.material,
        camera: args.camera,
        light: args.light,
        render_resolution: args.render_resolution,
        raytk: {
          library_loaded: report.library_loaded,
          created: report.created,
          render_path: report.render_path,
          scene_tail_path: report.scene_tail_path,
          unresolved: report.unresolved,
        },
      },
    });
  });
}

export const registerCreateRaytkSdfGraph: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_raytk_sdf_graph",
    {
      title: "Create RayTK SDF graph",
      description:
        "Build a RayTK SDF graph from copied RayTK ROP masters: primary SDF, optional " +
        "secondary SDF through simpleUnion, optional basicMat, lookAtCamera, pointLight, " +
        "raymarchRender3D, and a native Null TOP output. Requires RayTK to be staged with " +
        "manage_packages install raytk and loaded from the staged .tox.",
      inputSchema: createRaytkSdfGraphSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createRaytkSdfGraphImpl(ctx, args),
  );
};
