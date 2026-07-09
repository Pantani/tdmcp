import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createRaytkOpSchema = z.object({
  op_type: z
    .string()
    .min(1)
    .describe(
      "RayTK operator name = the .tox master, e.g. 'sphereSdf', 'raymarchRender3D', 'lookAtCamera', 'pointLight', 'simpleUnion'. See the tdmcp://raytk/operators catalog resource.",
    ),
  category: z
    .string()
    .optional()
    .describe(
      "Optional RayTK category folder hint to speed master resolution, e.g. 'sdf','output','camera','light','combine','material','filter'. Optional because resolution also works by op_type alone.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Path of the parent COMP the new ROP is copied into."),
  name: z
    .string()
    .optional()
    .describe(
      "Optional node name for the new ROP. If omitted, TouchDesigner auto-uniques from the master name.",
    ),
  node_x: z.coerce
    .number()
    .optional()
    .describe(
      "nodeCenterX placement of the new ROP. Omit to auto-place to the right of existing siblings (avoids stacking repeated ops at the origin).",
    ),
  node_y: z.coerce
    .number()
    .optional()
    .describe("nodeCenterY placement of the new ROP. Omit to auto-place (defaults to 0)."),
  connect_from: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional path of an existing operator to wire INTO this new op's input (source → new op). Omit for no wire; must be a non-empty path when present.",
    ),
  input_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe(
      "0-based input connector index of the NEW op that connect_from wires into (matches TouchDesigner inputConnectors[]). For raymarchRender3D: 0=scene, 1=camera, 2=light.",
    ),
  library_path: z
    .string()
    .optional()
    .describe(
      "Optional explicit path to the loaded RayTK library COMP (advanced). If omitted, the bridge probes for it — the runtime master path is install-dependent and must be read live, never hardcoded.",
    ),
});
type CreateRaytkOpArgs = z.infer<typeof createRaytkOpSchema>;

interface CreateRaytkOpReport {
  created?: string;
  master_path?: string;
  resolution?: string;
  op_type?: string;
  connected?: boolean;
  warnings: string[];
  fatal?: string;
}

// Instancing a RayTK ROP is standard TouchDesigner COMP.copy(master) placement — the same
// primitive RayTK's own palette uses. The one install-dependent unknown is the master COMP
// path: it lives inside the loaded RayTK library COMP, so it MUST be probed live, never
// hardcoded. Resolution order: (1) an explicit child under a given library_path, (2) RayTK's
// pathsByOpType lookup DAT, (3) a category-folder name search under known namespaces.
const RAYTK_OP_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))

def _resolve_master(p):
    op_type = p["op_type"]
    category = p.get("category")
    library_path = p.get("library_path")
    lib_root = op(library_path) if library_path else None
    # (1) explicit: a master directly under the given library root.
    if lib_root is not None:
        cands = ([category + "/" + op_type] if category else []) + [op_type]
        for cp in cands:
            m = lib_root.op(cp)
            if m is not None and m.isCOMP:
                return m, "explicit"
    # (2) pathsByOpType lookup DAT (RayTK's palette reads op('pathsByOpType')[opType,'path']).
    dat = op("pathsByOpType")
    if dat is None and lib_root is not None:
        dat = lib_root.op("pathsByOpType")
    if dat is None:
        for r in [lib_root, op("/project1/tdmcp_packages"), op("/raytk"), op("/")]:
            if r is None:
                continue
            found = r.findChildren(name="pathsByOpType", maxDepth=12)
            if found:
                dat = found[0]
                break
    if dat is not None:
        master_path = None
        try:
            cell = dat[op_type, "path"]
            if cell is not None:
                master_path = cell.val
        except Exception:
            master_path = None
        if not master_path:
            try:
                for ri in range(dat.numRows):
                    key = dat[ri, 0].val
                    if key == op_type or key.split(".")[-1] == op_type or key.endswith("." + op_type):
                        pc = dat[ri, "path"]
                        if pc is not None:
                            master_path = pc.val
                            break
            except Exception:
                master_path = None
        if master_path:
            m = op(master_path)
            if m is not None:
                return m, "pathsByOpType"
    # (3) category-folder name search under known namespaces (depth-capped: last-resort probe
    #     that must not traverse the whole project tree on large networks).
    best = None
    for r in [lib_root, op("/project1/tdmcp_packages"), op("/raytk"), op("/project1")]:
        if r is None:
            continue
        for c in r.findChildren(name=op_type, maxDepth=14):
            if not c.isCOMP:
                continue
            par = c.parent()
            if category and par is not None and par.name == category:
                return c, "category-search"
            if best is None:
                best = c
    if best is not None:
        return best, "category-search"
    return None, None

def _run(p):
    report = {"op_type": p["op_type"], "warnings": []}
    try:
        master, resolution = _resolve_master(p)
        if master is None:
            report["fatal"] = (
                "RayTK library not loaded / master not found for '" + str(p["op_type"]) + "'. "
                "Stage and load the RayTK .tox first (manage_packages install raytk), then retry."
            )
            return report
        dest = op(p["parent"])
        if dest is None:
            report["fatal"] = "Parent COMP not found: " + str(p["parent"])
            return report
        new_name = p.get("name")
        new_op = dest.copy(master, name=new_name) if new_name else dest.copy(master)
        # Placement: honour explicit coords; otherwise auto-place to the right of existing
        # siblings so repeated create_raytk_op calls don't stack a pile at the origin.
        nx = p.get("node_x")
        ny = p.get("node_y")
        if nx is None or ny is None:
            sibs = [c for c in dest.children if c is not new_op]
            max_x = max([(c.nodeCenterX or 0) for c in sibs], default=0)
            new_op.nodeCenterX = nx if nx is not None else (max_x + 200 if sibs else 0)
            new_op.nodeCenterY = ny if ny is not None else 0
        else:
            new_op.nodeCenterX = nx
            new_op.nodeCenterY = ny
        report["created"] = new_op.path
        report["master_path"] = master.path
        report["resolution"] = resolution
        report["connected"] = False
        cf = p.get("connect_from")
        if cf:
            src = op(cf)
            if src is None:
                report["warnings"].append("connect_from not found: " + str(cf))
            else:
                try:
                    idx = int(p.get("input_index", 0))
                    # RayTK ROPs are COMPs: wire connector-to-connector (the source's OUTPUT
                    # connector into this op's INPUT connector). Passing the OP to connect() is
                    # rejected with "Invalid number or type of arguments".
                    new_op.inputConnectors[idx].connect(src.outputConnectors[0])
                    report["connected"] = True
                except Exception as _e:
                    report["warnings"].append("connect failed: " + str(_e))
    except Exception:
        report["fatal"] = traceback.format_exc().splitlines()[-1]
    return report

print(json.dumps(_run(_p)))
`;

export function buildRaytkOpScript(payload: object): string {
  return buildPayloadScript(RAYTK_OP_SCRIPT, payload);
}

export async function createRaytkOpImpl(ctx: ToolContext, args: CreateRaytkOpArgs) {
  return guardTd(
    async () => {
      const script = buildRaytkOpScript({
        op_type: args.op_type,
        category: args.category ?? null,
        parent: args.parent_path,
        name: args.name ?? null,
        node_x: args.node_x ?? null,
        node_y: args.node_y ?? null,
        connect_from: args.connect_from ?? null,
        input_index: args.input_index,
        library_path: args.library_path ?? null,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<CreateRaytkOpReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create RayTK op '${args.op_type}': ${report.fatal}`, report);
      }
      const connect =
        args.connect_from === undefined
          ? "no input wired"
          : report.connected
            ? `wired ${args.connect_from} → input ${args.input_index}`
            : `input wire skipped (${report.warnings.join("; ") || "unavailable"})`;
      const summary = `Created RayTK op ${report.created} from ${report.master_path} (resolved via ${report.resolution}); ${connect}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateRaytkOp: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_raytk_op",
    {
      title: "Create a RayTK operator (ROP)",
      description:
        "Copy a RayTK ROP master (SDF / camera / light / combine / material / render) into a network and optionally wire an existing op into one of its typed inputs, using the same COMP.copy primitive RayTK's own palette uses. Resolves the install-dependent master path live (RayTK's pathsByOpType lookup, or a category-folder search) — never hardcoded — so it requires the RayTK toolkit staged + loaded first (see manage_packages / the tdmcp://raytk/operators catalog). Complementary to the GLSL create_raymarch_scene: this instances RayTK's own operators instead of authoring a shader.",
      inputSchema: createRaytkOpSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createRaytkOpImpl(ctx, args),
  );
};
