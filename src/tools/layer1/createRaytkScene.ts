import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/**
 * `create_raytk_scene` — a Layer-1 artist tool that builds the minimal renderable RayTK
 * node graph (`sphereSdf → raymarchRender3D → Null TOP`) from RayTK's real ROP COMP
 * masters, copied at runtime. It is the node-graph-native complement to
 * `create_raymarch_scene` (which stays the lightweight, no-dependency GLSL path).
 *
 * RayTK ops are NOT native TouchDesigner operator types — they are COMP masters that live
 * inside the loaded RayTK library. They therefore cannot be created with
 * `NetworkBuilder.add(type)` (that would call `createNode('sphereSdf')` and fail). Instead a
 * single reporting Python pass resolves each master (probed live, never hardcoded) and copies
 * it via `dest.copy(master)`, then wires the chain with TD's typed input connectors. The chain
 * terminates in a NATIVE Null TOP (`builder.add("nullTOP", "out1")`), which is the only op the
 * builder tracks/lays-out. If the RayTK library is not loaded the tool fails FORWARD: it
 * returns warnings + a "stage & load RayTK first" message, never a throw, never a claimed
 * render.
 *
 * Requires the RayTK toolkit staged + loaded (`manage_packages install raytk`, then load the
 * `.tox`); RayTK 0.46 requires TouchDesigner 2025.30770+.
 *
 * NOTE (resolver duplication): the master-resolution Python here intentionally mirrors the
 * sibling `create_raytk_op` (Layer 3). It is reimplemented rather than imported to keep this
 * builder's files isolated (parallel builds; W3 may not be merged). If both land, the lead may
 * factor the resolver into a shared Python-string helper.
 */

export const SDF_PRIMITIVES = ["sphereSdf", "boxSdf", "boxFrameSdf", "torusSdf"] as const;

export const createRaytkSceneSchema = z.object({
  sdf_primitive: z
    .enum(SDF_PRIMITIVES)
    .default("sphereSdf")
    .describe(
      "Primary RayTK SDF primitive ROP to raymarch. One of sphereSdf, boxSdf, boxFrameSdf, torusSdf. These are RayTK 'sdf'-category COMP masters copied from the loaded library — not native TouchDesigner operators.",
    ),
  union_with: z
    .enum(SDF_PRIMITIVES)
    .optional()
    .describe(
      "Optional second SDF primitive to combine with sdf_primitive via a RayTK simpleUnion (combine category). Omit for a single primitive. Example: sdf_primitive=sphereSdf + union_with=boxSdf yields a merged blob.",
    ),
  material: z
    .boolean()
    .default(false)
    .describe(
      "Insert a RayTK basicMat (material category) inline between the SDF/union chain and the renderer, so the surface gets a base color/shading instead of the renderer default.",
    ),
  add_camera: z
    .boolean()
    .default(false)
    .describe(
      "Add a RayTK lookAtCamera (camera category) wired into the renderer's Camera input (connector index 1, 0-based). Default false uses the renderer's built-in camera — leave false for the minimal scene.",
    ),
  add_light: z
    .boolean()
    .default(false)
    .describe(
      "Add a RayTK pointLight (light category) wired into the renderer's Light input (connector index 2, 0-based). Default false uses the renderer's built-in light — leave false for the minimal scene.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Name of the container COMP created for the scene. Defaults to 'raytk_scene_<sdf_primitive>'.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the RayTK scene container is created inside."),
});
type CreateRaytkSceneArgs = z.infer<typeof createRaytkSceneSchema>;

/** One RayTK master to copy + wire, with its role in the chain. */
interface RaytkOpSpec {
  optype: string;
  category: string;
  role: "sdf_primary" | "sdf_secondary" | "union" | "material" | "render" | "camera" | "light";
  name: string;
}

/** The structured report the Python pass prints back (last JSON line). */
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

/**
 * Reporting Python pass: resolve each RayTK master probe-first, copy + place it, wire the
 * chain with typed input connectors, and print a JSON report. Guardrails: the whole body is
 * wrapped in try/except so a single failure still prints a report; every `.connect` is in its
 * own try/except (index/type mismatch is a probe-first unknown); all `op`/`/` usage is inside
 * the payload (never module-level).
 *
 * UNVERIFIED — probe live: the `pathsByOpType` key format + loaded-library folder layout, the
 * renderer connector indices (0=scene / 1=camera / 2=light), and simpleUnion/basicMat in/out
 * orientation are from the RayTK guide, not confirmed against a live loaded RayTK 0.46.
 */
const RAYTK_SCENE_TEMPLATE = `
import json, base64, traceback
report = {
    "ok": False,
    "library_loaded": False,
    "created": [],
    "render_path": None,
    "scene_tail_path": None,
    "unresolved": [],
    "warnings": [],
    "guidance": None,
}
try:
    _payload = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
    _container = op(_payload["container"])
    _ops = _payload["ops"]
    _root = op("/")

    def _find_master(optype, category):
        # 1) Prefer the RayTK lookup DAT (keys are fully-qualified, e.g.
        #    "raytk.operators.sdf.sphereSdf") — match a row that == optype or endswith "."+optype.
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
        # 2) Fallback: findChildren by name, filtered to raytk / operators/<category> paths.
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
    # Lay the RayTK chain out in NEGATIVE x so it ends just left of the origin (the last op,
    # raymarchRender3D, lands at x=-200). The native out1 Null is the only builder-tracked node,
    # so finalize()'s layout pins it at the origin; placing the untracked chain to its left keeps
    # out1 sitting AFTER the renderer instead of overlapping the first ROP.
    _x = -float(len(_ops)) * 200.0
    for _spec in _ops:
        _optype = _spec["optype"]
        _category = _spec["category"]
        _role = _spec["role"]
        _master = _find_master(_optype, _category)
        if _master is None:
            report["unresolved"].append(_optype)
            report["warnings"].append(
                "RayTK master '%s' (%s) not found — is the library loaded?" % (_optype, _category)
            )
            continue
        try:
            _new = _container.copy(_master, name=_spec.get("name") or _optype)
        except Exception as _e:
            report["unresolved"].append(_optype)
            report["warnings"].append("Copy of '%s' failed: %s" % (_optype, _e))
            continue
        try:
            _new.nodeCenterX = _x
            _new.nodeCenterY = 0.0
        except Exception:
            pass
        _x += 200.0
        _by_role[_role] = _new
        report["created"].append({"opType": _optype, "name": _new.name, "path": _new.path})

    def _safe(fn, label):
        try:
            fn()
        except Exception as _e:
            report["warnings"].append("Wire %s failed: %s" % (label, _e))

    _prim = _by_role.get("sdf_primary")
    _sec = _by_role.get("sdf_secondary")
    _union = _by_role.get("union")
    _material = _by_role.get("material")
    _render = _by_role.get("render")
    _camera = _by_role.get("camera")
    _light = _by_role.get("light")

    # union: primary -> union input 0, secondary -> union input 1.
    if _union is not None and _prim is not None:
        _safe(lambda: _union.inputConnectors[0].connect(_prim), "primary->union[0]")
    if _union is not None and _sec is not None:
        _safe(lambda: _union.inputConnectors[1].connect(_sec), "secondary->union[1]")

    # scene tail = material else union else primary.
    _scene = _union if _union is not None else _prim
    if _material is not None and _scene is not None:
        _safe(lambda: _material.inputConnectors[0].connect(_scene), "scene->material[0]")
        _scene = _material
    if _scene is not None:
        report["scene_tail_path"] = _scene.path

    # renderer: input 0 = scene, input 1 = camera, input 2 = light.
    if _render is not None and _scene is not None:
        _safe(lambda: _render.inputConnectors[0].connect(_scene), "scene->render[0]")
    if _render is not None and _camera is not None:
        _safe(lambda: _render.inputConnectors[1].connect(_camera), "camera->render[1]")
    if _render is not None and _light is not None:
        _safe(lambda: _render.inputConnectors[2].connect(_light), "light->render[2]")

    if _render is not None:
        report["render_path"] = _render.path
        report["library_loaded"] = True
        report["ok"] = True
    else:
        report["library_loaded"] = False
        report["ok"] = False
        report["guidance"] = (
            "RayTK library not found in the project. Stage it (manage_packages install raytk) "
            "then load the staged .tox (namespace /project1/tdmcp_packages). RayTK 0.46 requires "
            "TouchDesigner 2025.30770+."
        )
except Exception as _e:
    report["warnings"].append("RayTK scene build error: %s" % _e)
    report["warnings"].append(traceback.format_exc())

print(json.dumps(report))
result = report
`;

/** Builds the ordered op list to copy + wire, left→right, per the enabled flags. */
function buildOpSpecs(args: CreateRaytkSceneArgs): RaytkOpSpec[] {
  const ops: RaytkOpSpec[] = [
    { optype: args.sdf_primitive, category: "sdf", role: "sdf_primary", name: "sdf_primary" },
  ];
  if (args.union_with) {
    ops.push({
      optype: args.union_with,
      category: "sdf",
      role: "sdf_secondary",
      name: "sdf_secondary",
    });
    ops.push({ optype: "simpleUnion", category: "combine", role: "union", name: "union1" });
  }
  if (args.material) {
    ops.push({ optype: "basicMat", category: "material", role: "material", name: "mat1" });
  }
  if (args.add_camera) {
    ops.push({ optype: "lookAtCamera", category: "camera", role: "camera", name: "camera1" });
  }
  if (args.add_light) {
    ops.push({ optype: "pointLight", category: "light", role: "light", name: "light1" });
  }
  ops.push({ optype: "raymarchRender3D", category: "output", role: "render", name: "render1" });
  return ops;
}

/** Human summary of the built chain, for the response text. */
function describeChain(args: CreateRaytkSceneArgs): string {
  const parts: string[] = [args.sdf_primitive];
  if (args.union_with) parts.push(`∪ ${args.union_with} (simpleUnion)`);
  if (args.material) parts.push("basicMat");
  parts.push("raymarchRender3D");
  const extras: string[] = [];
  if (args.add_camera) extras.push("lookAtCamera");
  if (args.add_light) extras.push("pointLight");
  const suffix = extras.length ? ` + ${extras.join(" + ")}` : " (built-in camera + light)";
  return `${parts.join(" → ")}${suffix}`;
}

export async function createRaytkSceneImpl(ctx: ToolContext, args: CreateRaytkSceneArgs) {
  return runBuild(async () => {
    const name = args.name ?? `raytk_scene_${args.sdf_primitive}`;
    const builder = await createSystemContainer(ctx, args.parent_path, name);

    const script = buildPayloadScript(RAYTK_SCENE_TEMPLATE, {
      container: builder.containerPath,
      ops: buildOpSpecs(args),
    });

    let report: RaytkSceneReport | undefined;
    try {
      const exec = await ctx.client.executePythonScript(script, true);
      report = parsePythonReport<RaytkSceneReport>(exec.stdout);
      builder.warnings.push(...report.warnings);
      if (report.guidance) builder.warnings.push(report.guidance);
    } catch (err) {
      builder.warnings.push(`RayTK copy/wire step failed: ${friendlyTdError(err)}`);
    }

    // Terminate the chain in a native Null TOP (the only op the builder tracks/lays-out).
    const out = await builder.add("nullTOP", "out1");
    if (report?.render_path) {
      await builder.connect(report.render_path, out); // renderer output 0 → null input 0
      // The renderer compiles its shader on a background thread; be honest about the preview.
      builder.warnings.push(
        "raymarchRender3D compiles its shader on a background thread; the captured preview may be black or incomplete if compilation had not finished. A live cook-wait before capture is a probe-first item — do not treat the preview as a confirmed render.",
      );
    } else {
      builder.warnings.push(
        "RayTK renderer was not created (library likely not loaded) — the Null TOP is empty.",
      );
    }

    return finalize(ctx, {
      summary: report?.render_path
        ? `Built a RayTK scene (${describeChain(args)}). Preview may be pre-compile — see warnings.`
        : "RayTK scene not built — load the RayTK library first (see warnings).",
      builder,
      outputPath: out,
      controls: [], // ROP param names UNVERIFIED — no bound controls this wave.
      capturePreviewImage: true,
      extra: {
        sdf_primitive: args.sdf_primitive,
        union_with: args.union_with,
        material: args.material,
        add_camera: args.add_camera,
        add_light: args.add_light,
        raytk: {
          library_loaded: report?.library_loaded ?? false,
          created: report?.created ?? [],
          unresolved: report?.unresolved ?? [],
        },
      },
    });
  });
}

export const registerCreateRaytkScene: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_raytk_scene",
    {
      title: "Create RayTK scene",
      description:
        "Build the minimal renderable RayTK node graph (sphereSdf → raymarchRender3D → Null TOP) from RayTK's real ROP COMP masters, copied at runtime — the node-graph-native complement to create_raymarch_scene (which stays the lightweight, no-dependency GLSL path). Optional flags union a second SDF, insert an inline basicMat, and add an explicit lookAtCamera / pointLight. Requires the RayTK toolkit staged + loaded (manage_packages install raytk, then load the .tox); RayTK 0.46 requires TouchDesigner 2025.30770+. Fails forward with 'stage & load RayTK first' guidance when the library is absent.",
      inputSchema: createRaytkSceneSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createRaytkSceneImpl(ctx, args),
  );
};
